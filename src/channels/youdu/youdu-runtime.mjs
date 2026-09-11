import {
  buildMediaMessageBody,
  downloadMedia as youduDownloadMedia,
  normalizeWsHost,
  uploadMedia as youduUploadMedia,
  YouduSocket,
} from './youdu-protocol/index.js';
import { t } from '../shared/i18n.mjs';
import {
  createYouduBridgeStatus,
  YouduBridge,
} from './youdu-bridge.mjs';
import { buildYouduTlsOptions, createYouduTransport } from './youdu-tls.mjs';

function timeoutError() {
  const error = new Error('Youdu WebSocket did not become ready in time');
  error.code = 'connect-timeout';
  return error;
}

/** 回复队列没有对应队列项时抛出的错误：属于无法判断是否需要降级的失败。 */
function isMissingReplyQueue(error) {
  return /queue item not found for reqId/i.test(String(error?.message ?? ''));
}

/**
 * 回复可靠性兜底（send_msg 降级）。
 *
 * 入站回调回传（respond_msg）依赖服务端还留着这条消息的「回调上下文」：
 * ng_bot 只按 LRU 淘汰（runtime_cache.go，上限 200、无 TTL），连接重置时整表清空。
 * 长回合（一条回复要跑几分钟）或拥挤群里上下文一旦失效，回复就永久丢失且没有任何提示。
 * 因此 respond_msg 明确失败（ack 错误或 5s ack 超时）时，改写按会话主动投递的 send_msg。
 * 只在 ack 超时/协议拒绝这类「确定没送出去」的失败上降级，避免重复消息。
 */
function replyFallbackRoute(target, ownBotIds = []) {
  const chatId = cleanId(target?.chatId);
  if (!chatId) return null;
  if (String(target?.chatType ?? '').toLowerCase() === 'group') {
    // 群聊必须显式声明 chatType，否则服务端按单聊把群 ID 当用户 ID（wss_outbound.go:207-219）。
    return { chatType: 'group', chatId };
  }
  const senderId = cleanId(target?.senderId);
  // 单聊的接收方就是发消息的人；机器人自身的账号（有度 botId / 内部 botId）绝不能作为接收方，
  // 否则会给自己发消息成环。
  const ownIds = [ownBotIds].flat().map(cleanId).filter(Boolean);
  if (!senderId || senderId === '*' || ownIds.includes(senderId)) return null;
  return { chatType: 'single', chatId: senderId };
}

function cleanId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function describeSendFailure(error) {
  if (!error) return 'unknown error';
  const code = cleanId(error.code) ?? (Number.isFinite(error.errCode) ? String(error.errCode) : null);
  const message = cleanId(error.errMsg) ?? cleanId(error.message);
  if (code && message) return `${code}: ${message}`;
  return code ?? message ?? String(error);
}

export function createYouduRuntimeStatus() {
  return {
    startedAt: null,
    ready: false,
    youduConnectionState: 'idle',
    harnessReachable: false,
    lastCheckedAt: null,
    lastConnectedAt: null,
    lastError: null,
    // 出站可靠性字段（replyFallbacks / lastReplyFallback*）来自 bridge 状态。
    ...createYouduBridgeStatus(),
  };
}

export class YouduRuntime {
  #config;
  #secret;
  #harness;
  #state;
  #logger;
  #replyTimeoutMs;
  #connectTimeoutMs;
  #botId;
  #contextEnhancement;
  #groupHistory;
  #groupContextFiles;
  #groupHistoryStagingWaitMs;
  #groupContextRecentLimit;
  #accessPolicy;
  #groupAccess;
  #onGroupSeen;
  #onPersonSeen;
  #createSocket;
  #status = createYouduRuntimeStatus();
  #socket = null;
  #bridge = null;
  #abortController = null;
  #starting = null;
  #mediaTransport = null;

  constructor({
    config,
    secret,
    harness,
    state,
    logger = console,
    replyTimeoutMs = 600_000,
    connectTimeoutMs = 20_000,
    botId = '',
    contextEnhancement,
    groupHistory,
    groupContextFiles,
    groupHistoryStagingWaitMs = 10_000,
    groupContextRecentLimit,
    accessPolicy,
    groupAccess,
    onGroupSeen,
    onPersonSeen,
    createSocket = (options) => new YouduSocket(options),
  }) {
    if (!config || !secret || !harness || !state) {
      throw new TypeError('YouduRuntime requires config, secret, Harness, and state');
    }
    this.#config = config;
    this.#secret = secret;
    this.#harness = harness;
    this.#state = state;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#botId = botId ?? '';
    this.#contextEnhancement = contextEnhancement;
    this.#groupHistory = groupHistory ?? null;
    this.#groupContextFiles = groupContextFiles ?? null;
    this.#groupHistoryStagingWaitMs = groupHistoryStagingWaitMs;
    this.#groupContextRecentLimit = groupContextRecentLimit;
    this.#accessPolicy = accessPolicy;
    this.#groupAccess = groupAccess ?? null;
    this.#onGroupSeen = typeof onGroupSeen === 'function' ? onGroupSeen : null;
    this.#onPersonSeen = typeof onPersonSeen === 'function' ? onPersonSeen : null;
    this.#createSocket = createSocket;
  }

  get status() {
    return structuredClone(this.#status);
  }

  async start() {
    if (this.#status.ready && this.#socket) return this.status;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start() {
    await this.stop();
    this.#status.startedAt = new Date().toISOString();
    this.#status.youduConnectionState = 'connecting';
    this.#status.lastError = null;
    await this.#harness.ensureRunning?.();
    this.#status.harnessReachable = true;

    const wsHost = normalizeWsHost(this.#config.wsHost);
    if (!wsHost) throw new TypeError('Youdu WebSocket host is missing');
    // 对齐 openclaw：加载自带 CA，并在 IP 直连时跳过 hostname 匹配（仍校验证书链）。
    const tlsOptions = buildYouduTlsOptions(wsHost);
    const mediaTransport = createYouduTransport(tlsOptions);
    this.#mediaTransport = mediaTransport;
    const controller = new AbortController();
    this.#abortController = controller;

    const logger = {
      debug: (...args) => this.#logger.debug?.(...args),
      info: (...args) => this.#logger.info?.(...args),
      warn: (...args) => this.#logger.warn?.(...args),
      error: (...args) => this.#logger.error?.(...args),
    };
    const socket = this.#createSocket({
      wsUrl: wsHost,
      botId: this.#config.sourceBotId,
      secret: this.#secret,
      tlsOptions,
      logger,
    });
    this.#socket = socket;

    // 统一出站：先按入站回调回传（respond_msg），失败再按会话主动投递（send_msg）。
    const deliverOutbound = async (target, body) => {
      const reqId = cleanId(target?.reqId) ?? '';
      // 没有 reqId 时（例如从 Web 端继续这个会话）没有可用的回调通道，直接主动投递。
      if (!reqId) {
        const route = replyFallbackRoute(target, this.#ownBotIds());
        if (!route) throw new Error('Youdu reply target is missing a usable conversation route');
        return socket.sendMessage(route.chatId, { chatType: route.chatType, ...body });
      }
      let replyFailure = null;
      try {
        return await socket.sendReply(reqId, body);
      } catch (error) {
        // 队列项缺失说明该 reqId 已经处理完，属于编程错误：不降级，避免重复发送。
        if (isMissingReplyQueue(error)) throw error;
        replyFailure = error;
      }
      const route = replyFallbackRoute(target, this.#ownBotIds());
      if (!route) {
        this.#recordReplyFallbackFailure(replyFailure, reqId);
        throw replyFailure;
      }
      try {
        const result = await socket.sendMessage(route.chatId, { chatType: route.chatType, ...body });
        this.#recordReplyFallback(replyFailure, reqId, route);
        return result;
      } catch (fallbackError) {
        this.#recordReplyFallbackFailure(replyFailure, reqId, fallbackError);
        const error = new Error(
          `Youdu reply was not delivered: respond_msg failed (${describeSendFailure(replyFailure)}), `
          + `send_msg failed (${describeSendFailure(fallbackError)})`,
          { cause: fallbackError },
        );
        error.code = 'youdu-reply-undeliverable';
        error.replyError = replyFailure;
        error.fallbackError = fallbackError;
        throw error;
      }
    };

    const bridge = new YouduBridge({
      bot: {
        sendReply: (target, text, options = {}) => deliverOutbound(
          target,
          { msgType: 'text', text: { content: text } },
        ),
        sendMessage: (chatId, text) => {
          const body = { msgType: 'text', text: { content: text } };
          return socket.sendMessage(chatId, body);
        },
        downloadMedia: async (attachment, { signal, maxBytes } = {}) => {
          const host = normalizeWsHost(this.#config.wsHost);
          const { buffer } = await youduDownloadMedia({
            host,
            token: socket.getToken(),
            kind: attachment.kind,
            mediaId: attachment.mediaId ?? '',
            maxBytes,
            signal,
            transport: mediaTransport,
          });
          return buffer;
        },
        deliverArtifact: async (target, file, kind) => {
          const host = normalizeWsHost(this.#config.wsHost);
          const media = await youduUploadMedia({
            host,
            token: socket.getToken(),
            fileName: file?.fileName,
            contentType: file?.mediaType,
            content: file?.bytes,
            kind,
            transport: mediaTransport,
          });
          const body = buildMediaMessageBody(media);
          return deliverOutbound(target, body);
        },
      },
      harness: this.#harness,
      state: this.#state,
      status: this.#status,
      logger: this.#logger,
      replyTimeoutMs: this.#replyTimeoutMs,
      ownerUserId: this.#config.ownerUserId,
      botId: this.#botId || this.#config.sourceBotId || this.#config.botId,
      kbAccount: {
        botId: this.#config.sourceBotId || this.#config.botId || this.#botId || '',
        secret: this.#secret,
        url: this.#config.wsHost,
      },
      contextEnhancement: this.#contextEnhancement,
      groupHistory: this.#groupHistory,
      groupContextFiles: this.#groupContextFiles,
      groupHistoryStagingWaitMs: this.#groupHistoryStagingWaitMs,
      groupContextRecentLimit: this.#groupContextRecentLimit,
      accessPolicy: this.#accessPolicy,
      groupAccess: this.#groupAccess,
      onGroupSeen: this.#onGroupSeen,
      onPersonSeen: this.#onPersonSeen,
      signal: controller.signal,
    });
    this.#bridge = bridge;

    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    socket.on('authenticated', () => {
      this.#logger.info?.('[dsh-im-youdu] socket authenticated (botId=', this.#config.botId, ')');
      bridge.setGid?.(socket.getGid?.() ?? '');
      const now = Date.now();
      this.#status.ready = true;
      this.#status.youduConnectionState = 'connected';
      this.#status.lastCheckedAt = now;
      this.#status.lastConnectedAt = now;
      this.#status.lastError = null;
      readyResolve();
    });
    socket.on('message', (frame) => {
      this.#logger.info?.('[dsh-im-youdu] inbound frame', frame.cmd);
      const task = bridge.accept(frame);
      if (!task) return;
      void task.catch((error) => {
        if (controller.signal.aborted) return;
        this.#logger.error?.(`[dsh-im:youdu] bot ${this.#config.botId} message handling failed:`, error);
      });
    });
    socket.on('error', (error) => {
      this.#logger.warn?.('[dsh-im-youdu] socket ERROR:', error?.message);
      if (!this.#status.ready) readyReject(error);
      else {
        this.#status.lastError = error?.message ?? String(error);
        this.#logger.warn?.(`[dsh-im:youdu] bot ${this.#config.botId} connection error:`, error);
      }
    });
    socket.on('disconnected', (reason) => {
      this.#logger.warn?.('[dsh-im-youdu] socket disconnected:', reason);
      this.#status.youduConnectionState = 'offline';
      this.#status.lastError = reason || null;
    });

    this.#logger.info?.('[dsh-im-youdu] connecting to wss://' + wsHost + '/cgi/bot/wss');
    socket.connect();

    let timer;
    try {
      await Promise.race([
        ready,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(timeoutError()), this.#connectTimeoutMs);
        }),
      ]);
      this.#status.ready = true;
      this.#status.youduConnectionState = 'connected';
      this.#status.lastCheckedAt = Date.now();
      this.#status.lastConnectedAt = Date.now();
      return this.status;
    } catch (error) {
      this.#status.ready = false;
      this.#status.youduConnectionState = 'failed';
      this.#status.lastError = error?.message ?? String(error);
      await this.stop();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async sendConnectionTest(text) {
    if (!this.#status.ready || !this.#socket) {
      const error = new Error(t('有度机器人尚未连接'));
      error.code = 'test-target-unavailable';
      throw error;
    }
    const chatId = this.#config.ownerUserId;
    if (!chatId || chatId === '*') {
      const error = new Error(t('有度机器人尚未收到任何私聊，无法发送测试消息。'));
      error.code = 'test-target-unavailable';
      throw error;
    }
    // 主动发送必须显式带 chatType：服务端只按 `chatType === 'group'` 走会话发送，
    // 否则一律按单聊处理（把群 ID 当用户 ID），见 ng_bot/internal/api/openclaw/wss_outbound.go:207-219。
    await this.#socket.sendMessage(chatId, {
      chatType: 'single',
      msgType: 'text',
      text: { content: text },
    });
    return { sent: true };
  }

  async sendProactiveText(target, text, { signal } = {}) {
    // 与其它渠道一致：目标形如 { kind: 'user'|'group', route: { chatId } }。
    // 有度单聊的 chatId 就是对方用户 ID（服务端 resolveChatID 对 single 取 Sender.ID），
    // 群聊的 chatId 是会话 ID，两者都用 send_msg 按 chatId 投递。
    const chatId = typeof target?.route?.chatId === 'string' ? target.route.chatId.trim() : '';
    if ((target?.kind !== 'user' && target?.kind !== 'group') || !chatId) {
      const error = new TypeError('Invalid Youdu proactive delivery target');
      error.code = 'invalid-target';
      throw error;
    }
    if (!this.#status.ready || !this.#socket) {
      const error = new Error('Youdu bot is not connected');
      error.code = 'bot-not-connected';
      throw error;
    }
    signal?.throwIfAborted();
    try {
      await this.#socket.sendMessage(chatId, {
        // 群聊必须声明 chatType，否则服务端按单聊投递，消息发不到群里。
        chatType: target.kind === 'group' ? 'group' : 'single',
        msgType: 'text',
        text: { content: text },
      });
    } catch (cause) {
      const error = new Error('Youdu rejected the proactive delivery', { cause });
      error.code = 'delivery-failed';
      throw error;
    }
    return { sent: true };
  }

  async stop() {
    const socket = this.#socket;
    const bridge = this.#bridge;
    const mediaTransport = this.#mediaTransport;
    this.#mediaTransport = null;
    this.#abortController?.abort();
    this.#abortController = null;
    this.#socket = null;
    this.#bridge = null;
    await bridge?.waitForIdle().catch(() => undefined);
    socket?.disconnect();
    await mediaTransport?.close?.().catch(() => undefined);
    this.#status.ready = false;
    this.#status.youduConnectionState = 'idle';
    return this.status;
  }

  /** 本机器人的所有身份标识（有度 botId 与内部派生 botId），用于避免把回复发给自己。 */
  #ownBotIds() {
    return [
      this.#config.sourceBotId,
      this.#config.botId,
      this.#botId,
    ];
  }

  /** 记录一次「入站回调回传失败、已改用主动投递」的降级（设置页可见）。 */
  #recordReplyFallback(replyFailure, reqId, route) {
    const at = new Date().toISOString();
    this.#status.replyFallbacks += 1;
    if (!this.#status.firstReplyFallbackAt) this.#status.firstReplyFallbackAt = at;
    this.#status.lastReplyFallbackAt = at;
    this.#status.lastReplyFallbackReason = describeSendFailure(replyFailure);
    const scope = route.chatType === 'group' ? 'group' : 'direct';
    this.#logger.warn?.(
      `[dsh-im:youdu] respond_msg failed for ${scope} reply (${describeSendFailure(replyFailure)}); `
      + `delivered with send_msg instead (reqId=${reqId}, chatId=${route.chatId})`,
    );
  }

  /** 记录一次彻底发不出去的回复（respond_msg 与 send_msg 都失败）。 */
  #recordReplyFallbackFailure(replyFailure, reqId, fallbackFailure = null) {
    const at = new Date().toISOString();
    const reason = describeSendFailure(replyFailure);
    this.#status.lastReplyFallbackAt = at;
    this.#status.lastReplyFallbackReason = reason;
    this.#status.lastReplyFallbackError = fallbackFailure
      ? `${reason} -> send_msg: ${describeSendFailure(fallbackFailure)}`
      : `${reason} -> no fallback route (reqId=${reqId})`;
    this.#logger.error?.(
      `[dsh-im:youdu] reply could not be delivered (reqId=${reqId}): ${this.#status.lastReplyFallbackError}`,
    );
  }
}
