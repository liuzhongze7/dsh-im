/**
 * 有度(Youdu) WebSocket 机器人客户端。
 *
 * 忠实移植自 @youdu/openclaw-youdu 的 src/sdk/ws-manager.ts + ws-client.ts（MIT），
 * 并把两者合并为一个面向 dsh-im 渠道的类。协议要点：
 *  - 长连接地址 `wss://<host>:7443/cgi/bot/wss`
 *  - 首次认证帧 `subscribe`（body: { botId, secret }），重连认证帧 `reconnect`（body: { token }）
 *  - 心跳为 WebSocket 控制帧 ping/pong（需 `ws` 包）
 *  - 入站消息帧 `msg_callback` / `event_callback` 通过 onMessage 回调上抛
 *  - 出站回复帧 `respond_msg` / 主动 `send_msg`，携带 token，等待 ack
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

import { WS_SCHEME, WS_URL } from './const.mjs';

/** WebSocket 命令常量 */
export const WsCmd = Object.freeze({
  SUBSCRIBE: 'subscribe',
  RECONNECT: 'reconnect',
  HEARTBEAT: 'ping',
  CALLBACK: 'msg_callback',
  EVENT_CALLBACK: 'event_callback',
  RESPONSE: 'respond_msg',
  SEND_MSG: 'send_msg',
});

/** WebSocket 错误码常量 */
export const WsErrCode = Object.freeze({
  SUCCESS: 0,
  PROTOCOL_INVALID: 1001,
  AUTH_FAILED: 1101,
  TOKEN_INVALID: 1102,
  INVALID_REQUEST: 1201,
  CONTEXT_MISSING: 1202,
  UNSUPPORTED: 1203,
  INTERNAL: 1500,
});

const SLOW_RECONNECT_DELAY_MS = 5 * 60 * 1000;
const SLOW_RECONNECT_JITTER_RATIO = 0.2;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_AUTH_TIMEOUT_MS = 30_000;
const DEFAULT_REPLY_ACK_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_REPLY_QUEUE_SIZE = 100;
const WS_HEARTBEAT_DEFAULT = 30000;

function generateRandomString(length = 8) {
  return randomBytes(Math.ceil(length / 2)).toString('hex').substring(0, length);
}

export function generateReqId(prefix) {
  return `${prefix}_${Date.now()}_${generateRandomString()}`;
}

/** 计算重连延迟与阶段（快速指数退避封顶 30s，随后 5 分钟 ±20% 抖动持续恢复） */
export function calculateReconnectDelay(
  reconnectAttempt,
  maxFastAttempts = 10,
  reconnectBaseDelay = 1000,
  reconnectMaxDelay = 30000,
  random = Math.random,
) {
  const attempt = Math.max(1, Math.floor(reconnectAttempt));
  const fastLimit = maxFastAttempts > 0 ? Math.floor(maxFastAttempts) : 10;
  if (attempt <= fastLimit) {
    return {
      delay: Math.min(reconnectBaseDelay * 2 ** (attempt - 1), reconnectMaxDelay),
      phase: 'fast',
    };
  }
  const randomValue = Math.min(1, Math.max(0, random()));
  const jitter = 1 - SLOW_RECONNECT_JITTER_RATIO
    + randomValue * SLOW_RECONNECT_JITTER_RATIO * 2;
  return {
    delay: Math.round(SLOW_RECONNECT_DELAY_MS * jitter),
    phase: 'slow',
  };
}

export class DefaultLogger {
  constructor(prefix = 'YouDuSDK') {
    this.prefix = prefix;
  }

  #fmt(level, message) {
    return `[${new Date().toISOString()}] [${this.prefix}] [${level}] ${message}`;
  }

  debug(message, ...args) {
    console.debug(this.#fmt('DEBUG', message), ...args);
  }

  info(message, ...args) {
    console.info(this.#fmt('INFO', message), ...args);
  }

  warn(message, ...args) {
    console.warn(this.#fmt('WARN', message), ...args);
  }

  error(message, ...args) {
    console.error(this.#fmt('ERROR', message), ...args);
  }
}

export class YouduSocket extends EventEmitter {
  #options;
  #logger;
  #ws = null;
  #heartbeatTimer = null;
  #reconnectTimer = null;
  #connectWatchdogTimer = null;
  #authWatchdogTimer = null;
  #state = 'stopped';
  #authenticated = false;
  #hasAuthenticated = false;
  #isReauthenticating = false;
  #isManualClose = false;
  #reconnectAttempts = 0;
  #reconnectPhase = 'fast';
  #nextRetryAt = null;
  #lastConnectedAt = null;
  #lastAuthenticatedAt = null;
  #lastDisconnectedAt = null;
  #lastError = null;
  #lastErrorIsSpecific = false;
  #missedPongCount = 0;
  #maxMissedPong = 2;
  #token = '';
  #botId = '';
  #botSecret = '';
  #wsUrl = '';
  #replyQueues = new Map();
  #pendingAcks = new Map();

  constructor(options) {
    super();
    const wsUrl = String(options?.wsUrl ?? options?.wsHost ?? '').trim();
    if (!wsUrl) throw new TypeError('Youdu WebSocket URL is required');
    this.#options = {
      heartbeatIntervalMs: WS_HEARTBEAT_DEFAULT,
      reconnectBaseDelayMs: 1000,
      maxReconnectAttempts: 10,
      heartbeatInterval: 30000,
      reconnectInterval: 1000,
      maxReconnectAttemptsConfig: 10,
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      authTimeoutMs: DEFAULT_AUTH_TIMEOUT_MS,
      replyAckTimeoutMs: DEFAULT_REPLY_ACK_TIMEOUT_MS,
      maxReplyQueueSize: DEFAULT_MAX_REPLY_QUEUE_SIZE,
      tlsOptions: undefined,
      logger: new DefaultLogger(),
      ...options,
    };
    this.#logger = this.#options.logger;
    this.#botId = String(options?.botId ?? '');
    this.#botSecret = String(options?.secret ?? '');
    this.#wsUrl = wsUrl.startsWith('ws') ? wsUrl : `${WS_SCHEME}${wsUrl}${WS_URL}`;
  }

  setCredentials(botId, botSecret) {
    const changed = this.#botId !== botId || this.#botSecret !== botSecret;
    this.#botId = botId;
    this.#botSecret = botSecret;
    if (changed) {
      this.#isManualClose = false;
      this.#clearReconnectTimer();
      this.#clearAuth();
      this.#state = 'stopped';
      this.#lastError = null;
      this.#lastErrorIsSpecific = false;
    }
  }

  getToken() {
    return this.#token;
  }

  getConnectionSnapshot() {
    return {
      state: this.#state,
      authenticated: this.#authenticated,
      reconnectAttempts: this.#reconnectAttempts,
      reconnectPhase: this.#reconnectPhase,
      nextRetryAt: this.#nextRetryAt,
      lastConnectedAt: this.#lastConnectedAt,
      lastAuthenticatedAt: this.#lastAuthenticatedAt,
      lastDisconnectedAt: this.#lastDisconnectedAt,
      lastError: this.#lastError,
    };
  }

  connect() {
    this.#clearReconnectTimer();
    this.#clearWatchdogs();
    this.#isManualClose = false;
    this.#lastErrorIsSpecific = false;
    this.#authenticated = false;
    this.#state = 'connecting';

    if (this.#ws) {
      this.#logger.info('[WD] Closing existing connection before reconnect...');
      this.#ws.removeAllListeners();
      this.#ws.terminate();
      this.#ws = null;
    }

    try {
      const options = {};
      if (this.#wsUrl.startsWith('wss://')) {
        Object.assign(options, this.#options.tlsOptions ?? {});
      }
      this.#ws = new WebSocket(this.#wsUrl, options);
      this.#setupEventHandlers();
      this.#startConnectWatchdog(this.#ws);
    } catch (error) {
      this.#state = 'offline';
      this.#lastError = error?.message ?? String(error);
      this.#lastErrorIsSpecific = true;
      this.#logger.error(`[WD] Failed to create WebSocket connection: ${error?.message}`);
      this.#emitError(error);
      this.#scheduleReconnect();
    }
  }

  #setupEventHandlers() {
    if (!this.#ws) return;
    const socket = this.#ws;

    socket.on('open', () => {
      if (this.#ws !== socket || this.#isManualClose) return;
      this.#clearConnectWatchdog();
      this.#missedPongCount = 0;
      this.#lastConnectedAt = Date.now();
      this.#sendAuth();
      this.emit('connected');
    });

    socket.on('message', (data) => {
      const raw = data.toString();
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        frame = {
          cmd: WsCmd.CALLBACK,
          headers: { reqId: generateReqId('raw_text') },
          body: {
            msgId: `msg_${Date.now()}`,
            chatId: 'default_chat',
            chatType: 'single',
            from: { userid: 'default_user' },
            msgType: 'text',
            text: { content: raw },
          },
        };
      }
      this.#handleFrame(frame);
    });

    socket.on('close', (code, reason) => {
      const reasonStr = reason?.toString?.() || `code: ${code}`;
      this.#logger.warn(`[WD] WebSocket DISCONNECTED: ${reasonStr}`);
      if (this.#ws !== socket) return;
      this.#stopHeartbeat();
      this.#clearWatchdogs();
      this.#clearPendingMessages(`WebSocket connection closed (${reasonStr})`);
      this.#ws = null;
      this.#authenticated = false;
      if (this.#state !== 'stopped') this.#state = 'offline';
      this.#lastDisconnectedAt = Date.now();
      if (!this.#isManualClose && !this.#lastErrorIsSpecific) this.#lastError = reasonStr;
      this.emit('disconnected', reasonStr);
      if (!this.#isManualClose) this.#scheduleReconnect();
    });

    socket.on('error', (error) => {
      if (this.#ws !== socket) return;
      this.#clearWatchdogs();
      this.#authenticated = false;
      if (!this.#isManualClose || !this.#lastErrorIsSpecific) {
        this.#state = this.#isManualClose ? 'stopped' : 'offline';
        this.#lastError = error?.message ?? String(error);
        this.#lastErrorIsSpecific = true;
      }
      this.#logger.error(`[WD] WebSocket ERROR: ${error?.message}`);
      this.#emitError(error);
      if (!this.#isManualClose) this.#scheduleReconnect();
    });

    socket.on('ping', () => {
      socket.pong();
    });

    socket.on('pong', () => {
      this.#missedPongCount = 0;
    });
  }

  #sendAuth(forceSubscribe = false) {
    try {
      let frame;
      if (!forceSubscribe && this.#hasAuthenticated && this.#token) {
        frame = {
          cmd: WsCmd.RECONNECT,
          headers: { reqId: generateReqId(WsCmd.RECONNECT) },
          body: { token: this.#token },
        };
      } else {
        frame = {
          cmd: WsCmd.SUBSCRIBE,
          headers: { reqId: generateReqId(WsCmd.SUBSCRIBE) },
          body: { botId: this.#botId, secret: this.#botSecret },
        };
      }
      this.#send(frame);
      if (this.#ws) this.#startAuthWatchdog(this.#ws);
    } catch (error) {
      this.#logger.error(`[WD] Failed to send auth frame: ${error?.message}`);
    }
  }

  #handleFrame(frame) {
    const cmd = frame.cmd || '';
    const reqId = frame.headers?.reqId || '';
    const actualReqId = frame.headers?.reqId || '';

    if (frame.cmd === WsCmd.CALLBACK || frame.cmd === WsCmd.EVENT_CALLBACK) {
      this.emit('message', frame);
      return;
    }

    if (this.#pendingAcks.has(actualReqId)) {
      this.#handleReplyAck(actualReqId, frame);
      return;
    }

    if (actualReqId.startsWith(WsCmd.SUBSCRIBE) || actualReqId.startsWith(WsCmd.RECONNECT)) {
      this.#clearAuthWatchdog();
      const isReconnect = actualReqId.startsWith(WsCmd.RECONNECT);
      const authType = isReconnect ? 'Reconnect' : 'Subscribe';

      if (frame.errCode !== WsErrCode.SUCCESS) {
        const authError = `${authType} failed: errcode=${frame.errCode}, errmsg=${frame.errMsg}`;
        this.#authenticated = false;
        this.#state = 'offline';
        this.#lastError = authError;
        this.#lastErrorIsSpecific = true;
        this.#logger.error(authError);
        if (frame.errCode === WsErrCode.AUTH_FAILED) {
          this.#isManualClose = true;
          this.#clearReconnectTimer();
          this.#stopHeartbeat();
          this.#ws?.close(1000, 'Authentication failed');
          this.#emitError(new Error(`Authentication failed: ${frame.errMsg} (code: ${frame.errCode})`));
          return;
        }
        if (isReconnect) {
          this.#reconnectWithFreshAuth('[WD] Token invalid, will reconnect to re-authenticate');
        } else {
          this.#logger.warn(`[WD] Subscribe failed with temporary error, reconnect will retry: errcode=${frame.errCode}`);
          this.#ws?.terminate();
        }
        return;
      }

      const newToken = frame.body?.token ?? '';
      if (newToken && newToken !== this.#token) {
        this.#token = newToken;
        this.#hasAuthenticated = true;
      }

      this.#clearReconnectTimer();
      this.#authenticated = true;
      this.#state = 'authenticated';
      this.#isReauthenticating = false;
      this.#reconnectAttempts = 0;
      this.#reconnectPhase = 'fast';
      this.#nextRetryAt = null;
      this.#lastAuthenticatedAt = Date.now();
      this.#lastError = null;
      this.#lastErrorIsSpecific = false;
      this.#startHeartbeat();
      this.emit('authenticated');
      return;
    }

    if (actualReqId.startsWith(WsCmd.HEARTBEAT)) {
      if (frame.errCode !== WsErrCode.SUCCESS) {
        this.#logger.error(`Heartbeat ack error: errcode=${frame.errCode}, errmsg=${frame.errMsg}`);
        if (frame.errCode === WsErrCode.TOKEN_INVALID) {
          this.#reconnectWithFreshAuth('[WD] Heartbeat token rejected, will reconnect to re-authenticate');
        }
        return;
      }
      this.#missedPongCount = 0;
      return;
    }

    if (frame.errCode === WsErrCode.TOKEN_INVALID) {
      this.#reconnectWithFreshAuth('[WD] Token invalid in late reply, will reconnect to re-authenticate');
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => this.#sendHeartbeat(), this.#options.heartbeatInterval);
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #reconnectWithFreshAuth(reason) {
    if (this.#isReauthenticating) return;
    this.#isReauthenticating = true;
    this.#logger.warn(reason);
    this.#clearWatchdogs();
    this.#stopHeartbeat();
    this.#token = '';
    this.#hasAuthenticated = false;
    this.#authenticated = false;
    this.#state = 'offline';
    this.#lastError = reason;
    this.#lastErrorIsSpecific = true;
    this.#missedPongCount = 0;
    this.#clearPendingMessages('Authentication expired; message was not retried');
    this.#ws?.terminate();
  }

  #sendHeartbeat() {
    if (this.#missedPongCount >= this.#maxMissedPong) {
      this.#logger.warn(`No heartbeat pong received for ${this.#missedPongCount} consecutive pings`);
      this.#stopHeartbeat();
      this.#ws?.terminate();
      return;
    }
    this.#missedPongCount += 1;
    try {
      if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
        this.#ws.ping();
      }
    } catch (error) {
      this.#logger.error('Failed to send heartbeat:', error?.message);
    }
  }

  #scheduleReconnect() {
    if (this.#isManualClose) return;
    if (this.#reconnectTimer !== null) {
      this.#state = 'reconnecting';
      return;
    }
    const nextAttempt = this.#reconnectAttempts + 1;
    const { delay, phase } = calculateReconnectDelay(
      nextAttempt,
      this.#options.maxReconnectAttempts,
      this.#options.reconnectBaseDelayMs,
      30000,
    );
    this.#reconnectAttempts = nextAttempt;
    this.#reconnectPhase = phase;
    this.#authenticated = false;
    this.#state = 'reconnecting';
    this.#nextRetryAt = Date.now() + delay;
    this.emit('reconnecting', this.#reconnectAttempts);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#nextRetryAt = null;
      if (this.#isManualClose) {
        this.#state = 'stopped';
        return;
      }
      this.connect();
    }, delay);
  }

  #clearReconnectTimer() {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#nextRetryAt = null;
  }

  #startConnectWatchdog(socket) {
    this.#clearConnectWatchdog();
    const timer = setTimeout(() => {
      if (this.#connectWatchdogTimer !== timer) return;
      this.#connectWatchdogTimer = null;
      if (this.#isManualClose || this.#ws !== socket) return;
      const error = new Error(`WebSocket connection timed out after ${this.#options.connectTimeoutMs}ms`);
      this.#state = 'offline';
      this.#lastError = error.message;
      this.#lastErrorIsSpecific = true;
      this.#logger.error(`[WD] ${error.message}`);
      this.#emitError(error);
      socket.terminate();
      this.#scheduleReconnect();
    }, this.#options.connectTimeoutMs);
    this.#connectWatchdogTimer = timer;
  }

  #startAuthWatchdog(socket) {
    this.#clearAuthWatchdog();
    const timer = setTimeout(() => {
      if (this.#authWatchdogTimer !== timer) return;
      this.#authWatchdogTimer = null;
      if (this.#isManualClose || this.#ws !== socket) return;
      const error = new Error(`Authentication ACK timed out after ${this.#options.authTimeoutMs}ms`);
      this.#authenticated = false;
      this.#state = 'offline';
      this.#lastError = error.message;
      this.#lastErrorIsSpecific = true;
      this.#logger.error(`[WD] ${error.message}`);
      this.#emitError(error);
      socket.terminate();
      this.#scheduleReconnect();
    }, this.#options.authTimeoutMs);
    this.#authWatchdogTimer = timer;
  }

  #clearConnectWatchdog() {
    if (this.#connectWatchdogTimer !== null) {
      clearTimeout(this.#connectWatchdogTimer);
      this.#connectWatchdogTimer = null;
    }
  }

  #clearAuthWatchdog() {
    if (this.#authWatchdogTimer !== null) {
      clearTimeout(this.#authWatchdogTimer);
      this.#authWatchdogTimer = null;
    }
  }

  #clearWatchdogs() {
    this.#clearConnectWatchdog();
    this.#clearAuthWatchdog();
  }

  #send(frame) {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(frame));
    } else {
      throw new Error('WebSocket not connected, unable to send data');
    }
  }

  sendReply(reqId, body, cmd = WsCmd.RESPONSE) {
    if (!this.#authenticated || this.#isReauthenticating || !this.#token) {
      return Promise.reject(new Error('WebSocket authentication is not ready; message was not sent'));
    }
    return new Promise((resolve, reject) => {
      const frame = { cmd, headers: { reqId }, body };
      if (!this.#replyQueues.has(reqId)) this.#replyQueues.set(reqId, []);
      const queue = this.#replyQueues.get(reqId);
      if (queue.length >= this.#options.maxReplyQueueSize) {
        reject(new Error(`Reply queue for reqId ${reqId} exceeds max size`));
        return;
      }
      queue.push({ frame, resolve, reject });
      if (queue.length === 1) this.#processReplyQueue(reqId);
    });
  }

  sendMessage(chatId, body) {
    const reqId = generateReqId(WsCmd.SEND_MSG);
    return this.sendReply(reqId, { chatId, ...body }, WsCmd.SEND_MSG);
  }

  #processReplyQueue(reqId) {
    const queue = this.#replyQueues.get(reqId);
    if (!queue || queue.length === 0) {
      this.#replyQueues.delete(reqId);
      return;
    }
    const item = queue[0];
    if (!this.#authenticated || this.#isReauthenticating || !this.#token) {
      queue.shift();
      item.reject(new Error('WebSocket authentication is not ready; message was not sent'));
      this.#processReplyQueue(reqId);
      return;
    }
    item.frame.headers.token = this.#token;
    try {
      this.#send(item.frame);
    } catch (error) {
      queue.shift();
      item.reject(error);
      this.#processReplyQueue(reqId);
      return;
    }
    const timer = setTimeout(() => {
      this.#pendingAcks.delete(reqId);
      queue.shift();
      item.reject(new Error(`Reply ack timeout (${this.#options.replyAckTimeoutMs}ms) for reqId: ${reqId}`));
      this.#processReplyQueue(reqId);
    }, this.#options.replyAckTimeoutMs);
    this.#pendingAcks.set(reqId, { resolve: item.resolve, reject: item.reject, timer });
  }

  #handleReplyAck(reqId, frame) {
    const pending = this.#pendingAcks.get(reqId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pendingAcks.delete(reqId);
    const queue = this.#replyQueues.get(reqId);
    if (frame.errCode !== WsErrCode.SUCCESS) {
      queue?.shift();
      pending.reject(frame);
      if (frame.errCode === WsErrCode.TOKEN_INVALID) {
        this.#reconnectWithFreshAuth('[WD] Token invalid in reply, will reconnect to re-authenticate');
        return;
      }
    } else {
      queue?.shift();
      pending.resolve(frame);
    }
    this.#processReplyQueue(reqId);
  }

  #clearPendingMessages(reason) {
    for (const [, pending] of this.#pendingAcks) clearTimeout(pending.timer);
    this.#pendingAcks.clear();
    for (const [reqId, queue] of this.#replyQueues) {
      for (const item of queue) item.reject(new Error(`${reason}, reply for reqId: ${reqId} cancelled`));
    }
    this.#replyQueues.clear();
  }

  disconnect() {
    this.#isManualClose = true;
    this.#clearReconnectTimer();
    this.#clearWatchdogs();
    this.#stopHeartbeat();
    this.#clearPendingMessages('Connection manually closed');
    this.#authenticated = false;
    this.#state = 'stopped';
    this.#lastDisconnectedAt = Date.now();
    this.#clearAuth();
    if (this.#ws) {
      this.#ws.close(1000, 'Manual disconnect');
      this.#ws = null;
    }
  }

  #clearAuth() {
    this.#clearWatchdogs();
    this.#token = '';
    this.#hasAuthenticated = false;
    this.#authenticated = false;
    this.#isReauthenticating = false;
  }

  #emitError(error) {
    this.emit('error', error);
  }
}
