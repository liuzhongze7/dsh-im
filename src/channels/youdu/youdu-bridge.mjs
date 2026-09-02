import { askInWorkspaceSession } from '../shared/workspace-session.mjs';
import {
  setLastMessageFailure,
  messageFailureText,
} from '../shared/message-failure.mjs';
import {
  prefetchInboundFiles,
  hasInboundFiles,
  inboundFileUserMessage,
} from '../shared/inbound-file.mjs';
import {
  hasInboundImages,
  imagePromptUserMessage,
  imagePromptDiagnostic,
} from '../shared/image-prompt.mjs';
import {
  promptContentForInboundMessage,
} from '../shared/semantic/reply-reference.mjs';
import { t } from '../shared/i18n.mjs';
import { parseInboundMessage } from './inbound.mjs';

/**
 * 有度(Youdu) 最小闭环 bridge：收到 msg_callback 帧 → 解析 text → 交给共享层
 * askInWorkspaceSession（自动创建/绑定/复用 Harness 会话）→ 通过 respond_msg
 * 把回复回传给有度。
 *
 * 传入的 bot 需要满足：
 *  - sendReply(target, text, options): Promise<void>
 *  - sendMessage(chatId, text, options): Promise<void>   （主动投递/连接测试）
 */
export function createYouduBridgeStatus() {
  return {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastError: null,
    lastMessageError: null,
  };
}

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 会话路由 key：私聊用 senderId，群聊用 chatId（最小闭环只处理私聊）。 */
function conversationKey(message) {
  return message.kind === 'group' ? `group:${message.chatId}` : `direct:${message.senderId}`;
}

export class YouduBridge {
  #bot;
  #harness;
  #state;
  #status;
  #logger;
  #replyTimeoutMs;
  #signal;
  #queues = new Map();

  constructor({
    bot,
    harness,
    state,
    status = createYouduBridgeStatus(),
    logger = console,
    replyTimeoutMs = 600_000,
    signal,
  }) {
    if (!bot || typeof bot.sendReply !== 'function') throw new TypeError('Youdu bot client is required');
    if (!harness || !state) throw new TypeError('Harness client and state store are required');
    this.#bot = bot;
    this.#harness = harness;
    this.#state = state;
    this.#status = status;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#signal = signal;
  }

  get status() {
    return structuredClone(this.#status);
  }

  /** 处理一条入站消息帧；返回 Promise（入队串行，防止并发写会话）。 */
  accept(frame) {
    if (this.#signal?.aborted) return Promise.resolve();
    const { text, media } = parseInboundMessage(frame.body ?? {});
    const message = {
      messageId: clean(frame.body?.msgId) ?? clean(frame.headers?.reqId),
      chatId: clean(frame.body?.chatId),
      chatType: clean(frame.body?.chatType) ?? 'single',
      senderId: clean(frame.body?.from?.userId) ?? clean(frame.body?.from?.userid) ?? '',
      senderName: clean(frame.body?.from?.name) ?? '',
      kind: (frame.body?.chatType === 'group' || frame.body?.chatType === 'groupChat') ? 'group' : 'direct',
      text,
      media,
      reqId: clean(frame.headers?.reqId) ?? '',
    };
    if (!message.messageId || !message.senderId || this.#state.hasSeen(message.messageId)) {
      return Promise.resolve();
    }
    const key = conversationKey(message);
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.#process(message, key))
      .finally(() => {
        if (this.#queues.get(key) === current) this.#queues.delete(key);
      });
    this.#queues.set(key, current);
    return current;
  }

  async waitForIdle() {
    await Promise.allSettled([...this.#queues.values()]);
  }

  async #process(message, key) {
    if (this.#signal?.aborted) return;
    if (this.#state.hasSeen(message.messageId)) return;
    await this.#state.markSeen(message.messageId);
    this.#status.messagesReceived += 1;
    this.#status.lastMessageAt = new Date().toISOString();

    const target = {
      reqId: message.reqId,
      chatId: message.chatId,
      chatType: message.chatType,
      senderId: message.senderId,
    };

    try {
      const command = message.text.toLowerCase();
      if (message.kind === 'direct' && command === '/new') {
        await this.#state.clearSession(key);
        await this.#bot.sendReply(target, t('已开启新会话。请发送你的问题。'));
        await this.#state.markSeen(message.messageId);
        return;
      }
      if (message.kind === 'direct' && command === '/help') {
        await this.#bot.sendReply(target, helpText());
        return;
      }
      if (message.kind === 'direct' && command === '/status') {
        await this.#harness.ensureRunning?.({ signal: this.#signal });
        await this.#bot.sendReply(target, t('有度机器人与 DeepSeek Harness 连接正常。'));
        return;
      }

      if (!message.text && message.media.length === 0) {
        await this.#bot.sendReply(target, t('目前支持文字、图片和文件消息。'));
        return;
      }
      if (typeof this.#bot?.downloadMedia !== 'function') {
        message.media = [];
      }

      const promptMessage = prefetchInboundFiles(
        buildPromptMessage(message, this.#bot),
        { signal: this.#signal },
      );
      const hasImages = hasInboundImages(promptMessage);
      const hasFiles = hasInboundFiles(promptMessage);
      const content = hasImages
        ? await promptContentForInboundMessage(promptMessage, { signal: this.#signal })
        : (message.text || placeholderForMedia(message.media));
      const { answer } = await askInWorkspaceSession({
        harness: this.#harness,
        state: this.#state,
        key,
        text: message.text,
        content,
        createOptions: { signal: this.#signal },
        existsOptions: { signal: this.#signal },
        askOptions: {
          timeoutMs: this.#replyTimeoutMs,
          signal: this.#signal,
          control: { owner: this, key },
          files: hasFiles ? promptMessage.files : undefined,
        },
      });
      this.#signal?.throwIfAborted();
      await this.#bot.sendReply(target, answer ?? '');
      this.#status.messagesReplied += 1;
      this.#status.lastReplyAt = new Date().toISOString();
      this.#status.lastError = null;
    } catch (error) {
      if (this.#signal?.aborted) return;
      if (error?.code === 'turn-stopped') {
        await this.#bot.sendReply(target, t('已停止。')).catch(() => undefined);
        return;
      }
      this.#status.lastError = error?.message ?? String(error);
      const userMessage = inboundFileUserMessage(error)
        ?? imagePromptUserMessage(error);
      const failure = setLastMessageFailure(this.#status, error, {
        userMessage,
        reason: imagePromptDiagnostic(error)?.reason,
      });
      this.#logger.error?.(`[dsh-im:youdu] failed to process an inbound message [${failure.referenceId}]:`, error);
      await this.#bot.sendReply(target, messageFailureText(failure)).catch(() => undefined);
    }
  }
}

function placeholderForMedia(media) {
  if (!media.length) return '';
  const first = media[0];
  const label = first.kind === 'image' ? '图片' : '文件';
  const name = first.name ? ` ${first.name}` : '';
  return `[${label}${name}]`;
}

/** 把有度入站媒体转成 dsh-im 认可的 images/files（带 load 下载函数）。 */
function buildPromptMessage(message, bot) {
  const images = [];
  const files = [];
  for (const media of message.media ?? []) {
    const source = {
      name: media.name ?? (media.kind === 'image' ? 'image' : 'file'),
      ...(media.contentType ? { mediaType: media.contentType } : {}),
      ...(media.size !== undefined ? { size: media.size } : {}),
      load: ({ signal, maxBytes } = {}) => bot.downloadMedia(media, { signal, maxBytes }),
    };
    if (media.kind === 'image') images.push(source);
    else files.push(source);
  }
  return {
    content: message.text,
    ...(images.length ? { images } : {}),
    ...(files.length ? { files } : {}),
  };
}

function helpText() {
  return [
    t('有度机器人已连接 DeepSeek Harness。'),
    '',
    t('直接发送文字、图片或文件即可继续当前会话。'),
    t('/new  开启一个全新会话'),
    t('/status  检查连接状态'),
    t('/help  显示本帮助'),
  ].join('\n');
}
