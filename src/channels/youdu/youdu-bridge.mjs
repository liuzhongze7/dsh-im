import { askInWorkspaceSession } from '../shared/workspace-session.mjs';
import {
  setLastMessageFailure,
  clearLastMessageFailure,
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
  hasReplyReference,
  promptContentForInboundMessage,
} from '../shared/semantic/reply-reference.mjs';
import {
  deliverOutboundArtifacts,
} from '../shared/semantic/artifact-delivery.mjs';
import { runWorkspaceCommand } from '../shared/workspace-command.mjs';
import { runCompactCommand } from '../shared/compact-command.mjs';
import {
  isHistoryCommand,
  runHistoryCommand,
} from '../shared/history-command.mjs';
import {
  isControlCommand,
  runControlCommand,
} from '../shared/control-command.mjs';
import {
  isModelCommand,
  runModelCommand,
} from '../shared/model-command.mjs';
import {
  isPresetCommand,
  runPresetCommand,
} from '../shared/preset-command.mjs';
import {
  BatchInputManager,
  batchInputBusyMessage,
  batchInputGroupUnsupportedMessage,
  isBatchInputCommand,
} from '../shared/batch-input.mjs';
import { HarnessApprovalQueue } from '../shared/harness-approval.mjs';
import {
  harnessAnswerForQuestion,
  harnessQuestionText,
  validHarnessQuestion,
} from '../shared/harness-question.mjs';
import {
  captureContextEnhancement,
  enhanceContextContent,
} from '../shared/context-enhancement.mjs';
import {
  COMMAND_PERMISSION_DENIED_MESSAGE,
  evaluateInboundAccess,
} from '../shared/inbound-access.mjs';
import { isSharedLocalCommand } from '../shared/command-permission.mjs';
import { t } from '../shared/i18n.mjs';
import { prepareMessageBody } from './youdu-protocol/index.js';

function interactionResolvedText() {
  return t('这个问题已在其他客户端处理，无需再次回答。');
}

/**
 * 有度(Youdu) bridge：收到 msg_callback 帧 → 解析 text → 交给共享层
 * askInWorkspaceSession（自动创建/绑定/复用 Harness 会话）→ 通过 respond_msg 回传。
 *
 * 能力（与 QQ 渠道对齐）：
 *  - 核心命令（model/preset/workspace/compact/history/control/batch）
 *  - 交互（审批 harness-approval、提问 harness-question）与失败提示
 *  - 上下文增强（context-enhancement，私聊/群聊分开）
 *  - 访问控制与命令权限（inbound-access/access-policy/command-permission）
 *  - 主动投递/产物回传与群聊 @ 响应
 *
 * 传入的 bot 需要满足：
 *  - sendReply(target, text, options): Promise<void>
 *  - sendMessage(chatId, text, options): Promise<void>   （主动投递/连接测试）
 *  - deliverArtifact(target, file, kind): Promise<any>    （可选，产物回传）
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

/** 会话路由 key：私聊用 senderId，群聊用 chatId。 */
function conversationKey(message) {
  return message.kind === 'group' ? `group:${message.chatId}` : `direct:${message.senderId}`;
}

/** 回传目标：与 bridge 内 sendReply 的实现保持一致。 */
function messageTarget(message) {
  return {
    reqId: message.reqId,
    chatId: message.chatId,
    chatType: message.chatType,
    senderId: message.senderId,
  };
}

function hasMediaImages(media) {
  return Array.isArray(media) && media.some((item) => item?.kind === 'image');
}

function hasMediaFiles(media) {
  return Array.isArray(media) && media.some((item) => item?.kind !== 'image');
}

/** 从有度框架提取 @ 提及的用户账号列表（group @ 判定字段）。 */
function extractAtUserIds(frame) {
  const atUser = frame?.body?.raw?.decoded?.atUser;
  if (!Array.isArray(atUser)) return [];
  return atUser
    .map((value) => (typeof value === 'number' ? String(value) : clean(value)))
    .filter(Boolean);
}

export class YouduBridge {
  #bot;
  #harness;
  #state;
  #status;
  #logger;
  #replyTimeoutMs;
  #ownerUserId;
  #botId;
  #gid = '';
  #contextEnhancement;
  #accessPolicy;
  #groupResponseMode;
  #signal;
  #queues = new Map();
  #commandTasks = new Set();
  #batchInputs = new BatchInputManager();
  #approvals;
  #pendingInteractions = new Map();
  #interactionKeys = new Map();
  #acceptedMessageIds = new Map();
  #approvalTasks = new Set();

  constructor({
    bot,
    harness,
    state,
    status = createYouduBridgeStatus(),
    logger = console,
    replyTimeoutMs = 600_000,
    ownerUserId = '*',
    botId = '',
    contextEnhancement,
    accessPolicy,
    groupResponseMode = 'mention',
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
    this.#ownerUserId = ownerUserId ?? '*';
    this.#botId = botId ?? '';
    this.#contextEnhancement = contextEnhancement;
    this.#accessPolicy = accessPolicy;
    const resolvedGroupMode = groupResponseMode
      ?? (typeof accessPolicy === 'object' && accessPolicy !== null ? accessPolicy.groupResponseMode : undefined);
    this.#groupResponseMode = resolvedGroupMode === 'all' ? 'all' : 'mention';
    this.#signal = signal;
    this.#approvals = new HarnessApprovalQueue({ label: 'youdu', logger });
  }

  get status() {
    return structuredClone(this.#status);
  }

  /** 处理一条入站消息帧；返回 Promise（入队串行，防止并发写会话）。 */
  accept(frame) {
    if (this.#signal?.aborted) return Promise.resolve();
    const body = frame.body ?? {};
    const { text, media } = prepareMessageBody(body);
    const msgType = body?.msgType ?? undefined;
    const message = {
      messageId: clean(frame.body?.msgId) ?? clean(frame.headers?.reqId),
      chatId: clean(frame.body?.chatId),
      chatType: clean(frame.body?.chatType) ?? 'single',
      senderId: clean(frame.body?.from?.userId) ?? clean(frame.body?.from?.userid) ?? '',
      senderName: clean(frame.body?.from?.name) ?? '',
      kind: (frame.body?.chatType === 'group' || frame.body?.chatType === 'groupChat') ? 'group' : 'direct',
      text,
      media,
      msgType: msgType ?? undefined,
      atUserIds: extractAtUserIds(frame),
      reqId: clean(frame.headers?.reqId) ?? '',
    };
    if (!message.messageId || !message.senderId || this.#state.hasSeen(message.messageId)
      || this.#acceptedMessageIds.has(message.messageId)) {
      return Promise.resolve();
    }
    const key = conversationKey(message);
    const addressed = message.kind !== 'group' || this.#isAddressedGroupMessage(message);

    if (addressed) {
      const access = this.#evaluateAccess(message);
      if (!access.allowed) {
        this.#acceptedMessageIds.set(message.messageId, null);
        return this.#finishAccessDecision(message, access);
      }
    }
    this.#acceptedMessageIds.set(message.messageId, captureContextEnhancement(
      this.#contextEnhancement,
      message.kind === 'group' ? 'group' : 'direct',
    ));

    const commandText = message.text;
    const batchCommand = isBatchInputCommand(commandText);
    const batchStatus = this.#batchInputs.status(key);
    if (batchCommand && message.kind === 'group') {
      return this.#finishBatchCommand(message, key, batchInputGroupUnsupportedMessage());
    }
    if (message.kind === 'direct' && (batchCommand || batchStatus.phase === 'collecting')) {
      const exactBatchStart = /^\/batch$/iu.test(commandText.trim());
      const result = exactBatchStart
        && batchStatus.phase === 'idle'
        && this.#queues.has(key)
        ? { handled: true, kind: 'busy', message: batchInputBusyMessage() }
        : this.#batchInputs.handle(key, commandText, {
            plainText: Boolean(commandText)
              && !hasMediaImages(message.media)
              && !hasMediaFiles(message.media),
          });
      if (result.handled) {
        if (result.kind === 'submit') {
          return this.#enqueueBatchSubmission(message, key, result);
        }
        return this.#finishBatchCommand(message, key, result.message);
      }
    }

    if (addressed) {
      const commandRunner = isHistoryCommand(commandText) ? runHistoryCommand
        : hasMediaFiles(message.media) ? null : isControlCommand(commandText) ? runControlCommand
        : (isModelCommand(commandText) ? runModelCommand
            : (isPresetCommand(commandText) ? runPresetCommand : null));
      if (commandRunner) {
        let task;
        task = this.#processFastCommand(message, key, commandText, commandRunner)
          .catch((error) => {
            if (error?.code === 'turn-stopped' || this.#signal?.aborted) return;
            this.#status.lastError = error?.message ?? String(error);
            const failure = setLastMessageFailure(this.#status, error);
            this.#logger.error?.(
              `[dsh-im:youdu] failed to process a command [${failure.referenceId}]:`,
              error,
            );
            return this.#bot.sendReply(messageTarget(message), messageFailureText(failure))
              .catch(() => undefined);
          })
          .finally(() => {
            this.#acceptedMessageIds.delete(message.messageId);
            this.#commandTasks.delete(task);
          });
        this.#commandTasks.add(task);
        return task;
      }
    }

    const pending = this.#pendingInteractions.get(key);
    const approval = this.#approvals.claimReply({
      key,
      actor: message.senderId,
      messageId: message.messageId,
      text: hasMediaImages(message.media) || hasMediaFiles(message.media) ? '' : message.text,
      addressed,
      hasPendingQuestion: Boolean(pending),
      questionCompletion: pending?.submitting || pending?.claimedReplyMessageId
        ? pending.queue
        : null,
      isQuestionPending: () => this.#pendingInteractions.has(key),
      send: (reply) => this.#bot.sendReply(messageTarget(message), reply),
    });
    if (approval) {
      let task;
      task = approval.process(async () => {
        if (this.#state.hasSeen(message.messageId)) return false;
        await this.#state.markSeen(message.messageId);
        this.#status.messagesReceived += 1;
        this.#status.lastMessageAt = new Date().toISOString();
        return true;
      }).finally(() => {
        this.#acceptedMessageIds.delete(message.messageId);
        this.#approvalTasks.delete(task);
      });
      this.#approvalTasks.add(task);
      return task;
    }

    if (pending && message.senderId !== pending.actor) {
      return this.#enqueueMessage(message, key);
    }
    if (pending?.submitting || pending?.claimedReplyMessageId) {
      return this.#enqueueMessage(message, key);
    }
    if (pending) {
      if (this.#canClaimInteractionReply(message, pending)) {
        pending.claimedReplyMessageId = message.messageId;
      }
      const previous = pending.queue ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(() => this.#processInteractionReply(message, key, pending))
        .catch((error) => this.#handleInteractionFailure(message, error))
        .finally(() => {
          this.#acceptedMessageIds.delete(message.messageId);
          if (pending.claimedReplyMessageId === message.messageId) pending.claimedReplyMessageId = null;
          if (pending.queue === current) pending.queue = null;
        });
      pending.queue = current;
      return current;
    }
    return this.#enqueueMessage(message, key);
  }

  #enqueueMessage(message, key, { alreadyRecorded = false } = {}) {
    const promptMessage = (message.kind !== 'group' || this.#isAddressedGroupMessage(message))
      ? prefetchInboundFiles(
          buildPromptMessage(message, this.#bot),
          { signal: this.#signal },
        )
      : undefined;
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.#process(message, key, { alreadyRecorded, promptMessage }))
      .finally(() => {
        this.#acceptedMessageIds.delete(message.messageId);
        if (this.#queues.get(key) === current) this.#queues.delete(key);
      });
    this.#queues.set(key, current);
    return current;
  }

  async waitForIdle() {
    await Promise.allSettled([
      ...this.#queues.values(),
      ...this.#commandTasks,
      ...[...this.#pendingInteractions.values()].flatMap((pending) => (
        pending.queue ? [pending.queue] : []
      )),
      ...this.#approvalTasks,
    ]);
  }

  /** 群聊 @ 判定（G3）：mention 模式仅 atUser 命中机器人身份时寻址；all 模式全部响应。 */
  setGid(value) {
    this.#gid = clean(value) ?? '';
  }

  #isAddressedGroupMessage(message) {
    if (message.kind !== 'group') return true;
    if (this.#groupResponseMode === 'all') return true;
    const identities = [this.#botId, this.#ownerUserId, this.#gid]
      .map((value) => clean(value))
      .filter(Boolean);
    return message.atUserIds.some((id) => identities.includes(id)
      || (identities.length > 0 && `user:${identities[0]}` === id));
  }

  /** 访问控制：优先 accessPolicy；无 provider 时回退 ownerUserId 白名单（命令仅 owner，群聊普通消息放开）。 */
  #evaluateAccess(message) {
    const text = message.text ?? '';
    const hasImages = hasMediaImages(message.media);
    const hasFiles = hasMediaFiles(message.media);
    if (this.#accessPolicy) {
      return evaluateInboundAccess(this.#accessPolicy, {
        conversationType: message.kind === 'group' ? 'group' : 'direct',
        senderIds: message.senderId,
        text,
        hasImages,
        hasFiles,
        isCommand: isSharedLocalCommand(text, { hasImages, hasFiles }),
      });
    }
    // 无 provider 的保守回退：命令仅允许 owner（或 owner 为 '*' 时放开），
    // 群聊普通消息显式放开避免误拒；群聊命令受 owner 约束（防止任意群成员触发命令）。
    const isCommand = isSharedLocalCommand(text, { hasImages, hasFiles });
    if (isCommand) {
      return this.#isSenderAllowed(message.senderId)
        ? Object.freeze({ allowed: true, reason: 'legacy-owner' })
        : Object.freeze({ allowed: false, reason: 'command-not-allowed' });
    }
    if (message.kind === 'group') return Object.freeze({ allowed: true, reason: 'legacy-group' });
    return this.#isSenderAllowed(message.senderId)
      ? Object.freeze({ allowed: true, reason: 'legacy-owner' })
      : Object.freeze({ allowed: false, reason: 'sender-not-allowed' });
  }

  #finishAccessDecision(message, access) {
    let task;
    task = Promise.resolve().then(async () => {
      if (this.#state.hasSeen(message.messageId)) return;
      await this.#state.markSeen(message.messageId);
      if (access.reason === 'command-not-allowed') {
        this.#status.messagesReceived += 1;
        this.#status.lastMessageAt = new Date().toISOString();
        // 闭合默认引导：当命令因 owner 未配置而拒（ownerUserId='*'/空）时，给出可操作提示，
        // 避免操作者误以为机器人只支持聊天。
        const ownerUnconfigured = this.#ownerUserId === '*' || !this.#ownerUserId;
        const deniedMessage = ownerUnconfigured
          ? t('当前机器人未配置所有者，无法使用该命令。请在设置页配置 ownerUserId 后重试。')
          : t(COMMAND_PERMISSION_DENIED_MESSAGE);
        await this.#bot.sendReply(messageTarget(message), deniedMessage);
        this.#status.messagesReplied += 1;
        this.#status.lastReplyAt = new Date().toISOString();
      } else {
        this.#status.messagesRejected += 1;
      }
      this.#status.lastError = null;
    }).catch((error) => {
      if (this.#signal?.aborted) return;
      this.#status.lastError = error?.message ?? String(error);
      this.#logger.error?.('[dsh-im:youdu] failed to apply inbound access policy:', error);
    }).finally(() => {
      this.#acceptedMessageIds.delete(message.messageId);
    });
    this.#commandTasks.add(task);
    return task;
  }

  /** 私聊访问控制：ownerUserId 为 '*'（默认）时放开；否则只允许配置的 owner。 */
  #isSenderAllowed(senderId) {
    if (this.#ownerUserId === '*' || !this.#ownerUserId) return true;
    return senderId === this.#ownerUserId;
  }

  /** 当前私聊会话是否存在待处理的交互/审批。 */
  #pendingInteraction(key) {
    return this.#pendingInteractions.has(key) || this.#approvals.hasPending(key);
  }

  async #processFastCommand(message, key, text, runner) {
    this.#signal?.throwIfAborted();
    if (this.#state.hasSeen(message.messageId)) return;
    await this.#state.markSeen(message.messageId);
    this.#status.messagesReceived += 1;
    this.#status.lastMessageAt = new Date().toISOString();

    const result = await runner(text, this.#harness, this.#state, key, {
      signal: this.#signal,
      isDirect: message.kind === 'direct',
      hasImages: hasMediaImages(message.media),
      hasFiles: hasMediaFiles(message.media),
      pendingInteraction: this.#pendingInteraction(key),
      control: { owner: this, key },
    });
    if (result?.stopped) {
      await this.#cancelPendingInteraction(key);
      await this.#approvals.closeRoute(key);
    }
    for (const reply of result?.messages ?? [result?.message]) {
      if (reply) await this.#bot.sendReply(messageTarget(message), reply);
    }
    this.#status.lastError = null;
  }

  #finishBatchCommand(message, key, messageText) {
    let task;
    task = Promise.resolve().then(async () => {
      if (this.#state.hasSeen(message.messageId)) return;
      await this.#state.markSeen(message.messageId);
      this.#status.messagesReceived += 1;
      this.#status.lastMessageAt = new Date().toISOString();
      if (messageText) await this.#bot.sendReply(messageTarget(message), messageText);
      this.#status.lastError = null;
    }).catch(async (error) => {
      if (this.#signal?.aborted) return;
      this.#status.lastError = error?.message ?? String(error);
      const failure = setLastMessageFailure(this.#status, error);
      this.#logger.error?.(
        `[dsh-im:youdu] failed to process a batch input command [${failure.referenceId}]:`,
        error,
      );
      await this.#bot.sendReply(messageTarget(message), messageFailureText(failure))
        .catch(() => undefined);
    }).finally(() => {
      this.#acceptedMessageIds.delete(message.messageId);
      this.#commandTasks.delete(task);
    });
    this.#commandTasks.add(task);
    return task;
  }

  #enqueueBatchSubmission(message, key, result) {
    const submissionMessage = {
      ...message,
      text: result.prompt,
      media: [],
    };
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.#process(submissionMessage, key, { batchSubmission: result }))
      .finally(() => {
        this.#acceptedMessageIds.delete(message.messageId);
        if (this.#queues.get(key) === current) this.#queues.delete(key);
      });
    this.#queues.set(key, current);
    return current;
  }

  async #process(message, key, {
    alreadyRecorded = false,
    promptMessage: preparedMessage,
    batchSubmission = null,
  } = {}) {
    if (this.#signal?.aborted) return;
    const messageId = message.messageId;
    if (!messageId || !message.senderId) return;
    if (message.kind === 'group' && !this.#isAddressedGroupMessage(message)) return;
    if (!alreadyRecorded) {
      if (this.#state.hasSeen(messageId)) return;
      this.#status.messagesReceived += 1;
      this.#status.lastMessageAt = new Date().toISOString();
    }
    let messageRecorded = alreadyRecorded;
    const markMessageSeen = async () => {
      if (messageRecorded) return;
      await this.#state.markSeen(messageId);
      messageRecorded = true;
    };

    const target = messageTarget(message);
    const promptMessage = preparedMessage ?? buildPromptMessage(message, this.#bot);
    const mediaImages = hasMediaImages(message.media);
    const mediaFiles = hasMediaFiles(message.media);
    const text = promptMessage.content;
    const hasImages = hasInboundImages(promptMessage);
    const hasFiles = hasInboundFiles(promptMessage);
    const hasReply = hasReplyReference(promptMessage);
    let batchSettled = batchSubmission === null;

    try {
      if (message.kind === 'direct' && !mediaImages && !mediaFiles) {
        const command = (text ?? '').trim().toLowerCase();
        if (command === '/new') {
          await this.#state.clearSession(key);
          await this.#bot.sendReply(target, t('已开启新会话。请发送你的问题。'));
          await markMessageSeen();
          return;
        }
        if (command === '/help') {
          await this.#bot.sendReply(target, helpText());
          await markMessageSeen();
          return;
        }
        if (command === '/status') {
          await this.#harness.ensureRunning?.({ signal: this.#signal });
          await this.#bot.sendReply(target, t('有度机器人与 DeepSeek Harness 连接正常。'));
          await markMessageSeen();
          return;
        }
      }

      const workspaceCommand = mediaImages || mediaFiles
        ? null
        : await runWorkspaceCommand(text, this.#harness, key);
      if (workspaceCommand) {
        for (const reply of workspaceCommand.messages ?? [workspaceCommand.message]) {
          if (reply) await this.#bot.sendReply(target, reply);
        }
        await markMessageSeen();
        return;
      }

      const compactCommand = mediaImages || mediaFiles
        ? null
        : await runCompactCommand(
            text,
            this.#harness,
            this.#state,
            key,
            { signal: this.#signal },
          );
      if (compactCommand) {
        if (compactCommand.message) await this.#bot.sendReply(target, compactCommand.message);
        await markMessageSeen();
        return;
      }

      if (!text && message.media.length === 0) {
        await this.#bot.sendReply(target, t('目前支持文字、图片和文件消息。'));
        await markMessageSeen();
        return;
      }

      let content = hasImages || hasReply
        ? await promptContentForInboundMessage(promptMessage, { signal: this.#signal })
        : (text || placeholderForMedia(message.media));
      const snapshot = this.#acceptedMessageIds.get(messageId);
      let contextEnhanced = false;
      if (snapshot) {
        const originalContent = content ?? text;
        content = enhanceContextContent(originalContent, snapshot, () => ({
          channel: 'youdu',
          senderId: message.senderId,
          senderName: message.kind === 'group' ? message.senderName : undefined,
        }));
        contextEnhanced = content !== originalContent;
      }

      await markMessageSeen();
      const { answer, artifacts = [] } = await askInWorkspaceSession({
        harness: this.#harness,
        state: this.#state,
        key,
        text,
        content,
        contextEnhanced,
        createOptions: { signal: this.#signal },
        existsOptions: { signal: this.#signal },
        askOptions: {
          timeoutMs: this.#replyTimeoutMs,
          signal: this.#signal,
          control: { owner: this, key },
          progressMode: 'all',
          onUpdate: () => undefined,
          onInteraction: (interaction) => this.#handleInteraction(interaction, {
            key,
            actor: message.senderId,
            target,
            requiresMention: message.kind === 'group',
          }),
          onInteractionResolved: (resolution) => this.#handleInteractionResolved(resolution),
          files: hasFiles ? promptMessage.files : undefined,
        },
      });
      if (batchSubmission) {
        this.#batchInputs.complete(key, batchSubmission.token);
        batchSettled = true;
      }
      this.#signal?.throwIfAborted();
      await this.#bot.sendReply(target, answer ?? '');
      await this.#deliverArtifacts(target, messageId, artifacts);
      this.#status.messagesReplied += 1;
      this.#status.lastReplyAt = new Date().toISOString();
      this.#status.lastError = null;
      clearLastMessageFailure(this.#status);
    } catch (error) {
      if (this.#signal?.aborted) return;
      if (error?.code === 'turn-stopped') {
        if (!batchSettled && batchSubmission) {
          this.#batchInputs.complete(key, batchSubmission.token);
          batchSettled = true;
        }
        await this.#bot.sendReply(target, t('已停止。')).catch(() => undefined);
        await markMessageSeen();
        return;
      }
      let batchFailureMessage = null;
      if (!batchSettled && batchSubmission) {
        batchFailureMessage = this.#batchInputs.fail(key, batchSubmission.token).message ?? null;
        batchSettled = true;
      }
      this.#status.lastError = error?.message ?? String(error);
      const userMessage = inboundFileUserMessage(error)
        ?? imagePromptUserMessage(error);
      const failure = setLastMessageFailure(this.#status, error, {
        userMessage,
        reason: imagePromptDiagnostic(error)?.reason,
      });
      this.#logger.error?.(`[dsh-im:youdu] failed to process an inbound message [${failure.referenceId}]:`, error);
      const errorMessage = messageFailureText(failure);
      await this.#bot.sendReply(
        target,
        batchFailureMessage ? `${errorMessage}\n\n${batchFailureMessage}` : errorMessage,
      ).catch(() => undefined);
      await markMessageSeen();
    } finally {
      if (messageId) this.#acceptedMessageIds.delete(messageId);
      await Promise.allSettled([
        this.#cancelPendingInteraction(key),
        this.#approvals.closeRoute(key),
      ]);
    }
  }

  async #processInteractionReply(message, key, expected) {
    this.#signal?.throwIfAborted();
    const current = this.#pendingInteractions.get(key);
    const claimed = expected.claimedReplyMessageId === message.messageId;
    if (!current || current !== expected || current.submitting) {
      if (claimed && (!current || current !== expected)) {
        return this.#discardResolvedInteractionReply(message);
      }
      return this.#enqueueMessage(message, key, { alreadyRecorded: false });
    }
    if (this.#state.hasSeen(message.messageId)) return;
    await this.#state.markSeen(message.messageId);
    this.#status.messagesReceived += 1;
    this.#status.lastMessageAt = new Date().toISOString();

    if (message.kind === 'group' && !this.#isAddressedGroupMessage(message)) return;
    const text = clean(message.text);
    if (!text || hasMediaImages(message.media) || hasMediaFiles(message.media)) {
      await this.#bot.sendReply(messageTarget(message), t('请用文字回答当前问题。'));
      return;
    }

    const pending = this.#pendingInteractions.get(key);
    if (!pending || pending !== expected || pending.submitting) {
      if (claimed && (!pending || pending !== expected)) {
        await this.#bot.sendReply(messageTarget(message), interactionResolvedText());
        return;
      }
      return this.#enqueueMessage(message, key, { alreadyRecorded: true });
    }
    pending.target = messageTarget(message);
    if (pending.needsPresentation) {
      try {
        await this.#presentInteraction(pending);
      } catch {
        this.#status.lastError = t('有度交互问题发送失败。');
        this.#logger.error?.('[dsh-im:youdu] failed to retry an interaction question');
        pending.interaction.reconnect?.();
        return;
      }
    }

    const question = pending.questions[pending.index];
    if (!question) return;
    pending.answers.push(harnessAnswerForQuestion(question, text));
    pending.index += 1;
    if (pending.index < pending.questions.length) {
      if (pending.claimedReplyMessageId === message.messageId) {
        pending.claimedReplyMessageId = null;
      }
      pending.needsPresentation = true;
      try {
        await this.#presentInteraction(pending);
      } catch {
        this.#status.lastError = t('有度交互问题发送失败。');
        this.#logger.error?.('[dsh-im:youdu] failed to send the next interaction question');
        pending.interaction.reconnect?.();
      }
      return;
    }

    pending.submitting = true;
    try {
      await pending.interaction.respond({
        ok: true,
        value: {
          sessionId: pending.sessionId,
          answer: { answers: pending.answers },
        },
      });
      this.#clearPendingInteraction(key, pending.interactionId);
      this.#status.lastError = null;
    } catch (error) {
      if (this.#signal?.aborted) return;
      if (error?.code === 'interaction-not-pending') {
        this.#clearPendingInteraction(key, pending.interactionId);
        await this.#bot.sendReply(pending.target, interactionResolvedText()).catch(() => undefined);
        return;
      }
      if (this.#pendingInteractions.get(key) !== pending) return;
      pending.submitting = false;
      pending.answers.pop();
      pending.index -= 1;
      this.#status.lastError = t('回答提交失败。');
      this.#logger.error?.('[dsh-im:youdu] failed to answer a Harness interaction');
      await this.#bot.sendReply(pending.target, t('回答提交失败，请重新发送当前问题的答案。'))
        .catch(() => undefined);
    }
  }

  async #handleInteraction(interaction, { key, actor, target, requiresMention }) {
    if (interaction?.kind === 'approval') {
      return this.#approvals.handleRequested(interaction, {
        key,
        actor,
        requiresMention,
        send: (text) => this.#bot.sendReply(target, text),
      });
    }
    if (interaction?.kind !== 'question') return;
    const questions = interaction?.payload?.questions;
    const interactionId = typeof interaction?.interactionId === 'string'
      ? interaction.interactionId
      : interaction?.rpcId;
    if (typeof interaction?.rpcId !== 'string'
      || typeof interactionId !== 'string'
      || typeof interaction.sessionId !== 'string'
      || !Array.isArray(questions)
      || questions.length === 0
      || questions.some((question) => !validHarnessQuestion(question))) {
      this.#logger.warn?.('[dsh-im:youdu] ignored an invalid Harness question interaction');
      return;
    }

    if (interaction.recovered === true) {
      await interaction.respond({
        ok: false,
        error: {
          code: 'cancelled',
          message: 'Youdu safely cancelled an interaction left by an earlier client.',
          details: {},
        },
      });
      await this.#bot.sendReply(
        target,
        t('检测到这个 Session 中遗留的待回答问题，已安全取消并继续处理你刚才的消息。'),
      ).catch(() => undefined);
      return;
    }

    const existing = this.#pendingInteractions.get(key);
    if (existing?.interactionId === interactionId) {
      existing.interaction = interaction;
      if (existing.needsPresentation) await this.#presentInteraction(existing);
      return;
    }
    if (this.#interactionKeys.has(interactionId)) return;
    if (existing) {
      await interaction.respond({
        ok: false,
        error: {
          code: 'cancelled',
          message: 'Youdu is already handling another user interaction.',
          details: {},
        },
      });
      return;
    }

    const pending = {
      kind: 'question',
      interactionId,
      sessionId: interaction.sessionId,
      interaction,
      actor,
      requiresMention,
      questions,
      answers: [],
      index: 0,
      target,
      queue: null,
      claimedReplyMessageId: null,
      presentationPromise: null,
      submitting: false,
      needsPresentation: true,
    };
    this.#pendingInteractions.set(key, pending);
    this.#interactionKeys.set(interactionId, key);
    await this.#presentInteraction(pending);
  }

  async #handleInteractionResolved(resolution) {
    if (resolution?.kind === 'approval') {
      await this.#approvals.handleResolved(resolution);
      return;
    }
    const interactionId = resolution?.interactionId;
    if (resolution?.kind !== 'question' || typeof interactionId !== 'string') return;
    const key = this.#interactionKeys.get(interactionId);
    if (!key) return;
    this.#clearPendingInteraction(key, interactionId);
  }

  #presentInteraction(pending) {
    if (!pending.needsPresentation) return Promise.resolve();
    if (pending.presentationPromise) return pending.presentationPromise;
    const question = pending.questions[pending.index];
    if (!question) return Promise.resolve();
    const presentation = this.#bot.sendReply(
      pending.target,
      harnessQuestionText(
        question,
        pending.index,
        pending.questions.length,
        { requiresMention: pending.requiresMention },
      ),
    ).then(() => {
      pending.needsPresentation = false;
    }).finally(() => {
      if (pending.presentationPromise === presentation) pending.presentationPromise = null;
    });
    pending.presentationPromise = presentation;
    return presentation;
  }

  #canClaimInteractionReply(message, pending) {
    return pending.questions[pending.index]
      && clean(message.senderId) === pending.actor
      && (message.kind !== 'group' || this.#isAddressedGroupMessage(message))
      && !hasMediaImages(message.media)
      && !hasMediaFiles(message.media)
      && Boolean(clean(message.text));
  }

  async #discardResolvedInteractionReply(message) {
    if (this.#state.hasSeen(message.messageId)) return;
    await this.#state.markSeen(message.messageId);
    this.#status.messagesReceived += 1;
    this.#status.lastMessageAt = new Date().toISOString();
    await this.#bot.sendReply(messageTarget(message), interactionResolvedText()).catch(() => undefined);
  }

  #takePendingInteraction(key, interactionId) {
    const pending = this.#pendingInteractions.get(key);
    if (!pending
      || (interactionId !== undefined && pending.interactionId !== interactionId)) return null;
    this.#pendingInteractions.delete(key);
    this.#interactionKeys.delete(pending.interactionId);
    return pending;
  }

  #clearPendingInteraction(key, interactionId) {
    return this.#takePendingInteraction(key, interactionId) !== null;
  }

  async #cancelPendingInteraction(key) {
    const pending = this.#takePendingInteraction(key);
    if (!pending || pending.kind !== 'question') return;
    try {
      await pending.interaction.respond({
        ok: false,
        error: {
          code: 'cancelled',
          message: 'The Youdu interaction ended before the user answered.',
          details: {},
        },
      }, { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      if (error?.code !== 'interaction-not-pending') {
        this.#logger.warn?.('[dsh-im:youdu] failed to cancel a pending Harness interaction');
      }
    }
  }

  async #handleInteractionFailure(message, error) {
    if (this.#signal?.aborted) return;
    this.#status.lastError = error?.message ?? String(error);
    const failure = setLastMessageFailure(this.#status, error);
    this.#logger.error?.(
      `[dsh-im:youdu] failed to process an interaction reply [${failure.referenceId}]:`,
      error,
    );
    if (!this.#state.hasSeen(message.messageId)) {
      await this.#state.markSeen(message.messageId).catch(() => undefined);
    }
    await this.#bot.sendReply(messageTarget(message), messageFailureText(failure))
      .catch(() => undefined);
  }

  /** 把 Harness 产出的结果文件通过有度媒体接口回传。 */
  async #deliverArtifacts(target, replyTo, artifacts = []) {
    if (!artifacts.length) return null;
    if (typeof this.#bot?.deliverArtifact !== 'function') return null;
    const delivery = await deliverOutboundArtifacts({
      artifacts,
      deliveryId: replyTo,
      aggregatePresentation: 'youdu-files',
      alwaysMerge: true,
      channelKey: 'youdu',
      signal: this.#signal,
      sendImage: (file) => this.#bot.deliverArtifact(target, file, 'image'),
      sendFile: (file) => this.#bot.deliverArtifact(target, file, 'file'),
      onFailure: (artifact, error) => setLastMessageFailure(this.#status, error, {
        userMessage: t('结果文件「{name}」已生成，但暂时未能通过有度发送，请稍后重试。', {
          name: artifact?.fileName ?? '结果文件',
        }),
      }),
      sendFailureNotice: (_artifact, _error, failure) => this.#bot.sendReply(
        target,
        messageFailureText(failure),
      ),
      logger: this.#logger,
    });
    return delivery;
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
    t('/compact  压缩当前会话的较早上下文'),
    t('/history [数量]  查看最近历史消息（默认 3 条，最多 5 条）'),
    t('/workspace 工作区序号或绝对路径  切换工作区'),
    t('/workspacelist  列出工作区绝对路径'),
    t('/sessionlist 或 /sessions [工作区序号或绝对路径]  列出会话 ID 和标题'),
    t('/sessionlist --limit N  仅列出当前工作区前 N 个会话'),
    t('/session Session ID 或当前工作区序号  将当前聊天绑定到指定会话'),
    t('/models  按序号列出所有可用模型'),
    t('/reasoninglist 或 /reasonings  按序号列出当前模型可用推理等级'),
    t('/reasoning [序号、等级ID或 --default]  查看或切换当前推理等级'),
    t('/model [序号或完整模型ID] [推理等级ID]  查看或切换当前会话模型'),
    t('示例：先发 /models，再发 /model 2 [推理等级ID]'),
    t('/presetlist 或 /presets  按序号列出可用 Agent Preset'),
    t('/preset [序号或完整ID]  查看或设置当前机器人 Agent Preset'),
    t('纯数字 ID：/preset id:<ID>'),
    t('/preset --default  跟随 Host 默认'),
    t('/stop  停止当前任务'),
    t('/steer 补充指令  纠偏当前任务'),
    t('/batch  开始批量输入（仅私聊，最多 10 条文字）'),
    t('/send  提交当前批次'),
    t('/cancel  取消当前批次'),
    t('/status  检查连接状态'),
    t('/version  查看插件版本'),
    t('/help  显示本帮助'),
  ].join('\n');
}
