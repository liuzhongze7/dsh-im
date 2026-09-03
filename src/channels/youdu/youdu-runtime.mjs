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

function timeoutError() {
  const error = new Error('Youdu WebSocket did not become ready in time');
  error.code = 'connect-timeout';
  return error;
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
  #accessPolicy;
  #createSocket;
  #status = createYouduRuntimeStatus();
  #socket = null;
  #bridge = null;
  #abortController = null;
  #starting = null;

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
    accessPolicy,
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
    this.#accessPolicy = accessPolicy;
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
      logger,
    });
    this.#socket = socket;

    const bridge = new YouduBridge({
      bot: {
        sendReply: (target, text, options = {}) => {
          const body = { msgType: 'text', text: { content: text } };
          return socket.sendReply(target.reqId, body);
        },
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
          });
          const body = buildMediaMessageBody(media);
          return socket.sendReply(target.reqId, body);
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
      accessPolicy: this.#accessPolicy,
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
    await this.#socket.sendMessage(chatId, text);
    return { sent: true };
  }

  async sendProactiveText(target, text, { signal } = {}) {
    const chatId = typeof target?.chatId === 'string' ? target.chatId.trim() : '';
    if (!chatId) {
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
    return this.#socket.sendMessage(chatId, text);
  }

  async stop() {
    const socket = this.#socket;
    const bridge = this.#bridge;
    this.#abortController?.abort();
    this.#abortController = null;
    this.#socket = null;
    this.#bridge = null;
    await bridge?.waitForIdle().catch(() => undefined);
    socket?.disconnect();
    this.#status.ready = false;
    this.#status.youduConnectionState = 'idle';
    return this.status;
  }
}
