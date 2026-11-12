/*
 * Licensed under the MIT License.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { DEFAULT_AUTH_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_MAX_REPLY_QUEUE_SIZE, DEFAULT_RECONNECT_BASE_DELAY_MS, DEFAULT_RECONNECT_MAX_DELAY_MS, DEFAULT_REPLY_ACK_TIMEOUT_MS, MAX_MISSED_PONG, WS_HEARTBEAT_INTERVAL_MS, WS_MAX_RECONNECT_ATTEMPTS, } from "../const.js";
import { DefaultLogger } from "./logger.js";
import { calculateReconnectDelay } from "./reconnect.js";
import { buildWsUrl } from "./url.js";
import { generateReqId, WsCmd, WsErrCode } from "./cmd.js";
import { SOCKET_OPEN, } from "./types.js";
/**
 * 有度(Youdu) WebSocket 机器人客户端。
 *
 * 统一合并了原 @youdu/openclaw-youdu 的 `WSClient` + `WsConnectionManager`（单类），
 * 是 dsh-im `protocol.mjs` 与插件 `sdk/ws-*.ts` 的运行时无关共享实现。
 *
 * 契约要点：
 * - 长连接地址 `wss://<host>:7443/cgi/bot/wss`
 * - 首次认证帧 `subscribe`（body: { botId, secret }），重连认证帧 `reconnect`（body: { token }）
 * - 心跳为 WebSocket 控制帧 ping/pong
 * - 入站消息帧 `msg_callback` / `event_callback` 通过 `message` 事件上抛
 * - 出站回复帧 `respond_msg` / 主动 `send_msg`，携带 token，等待 ack
 *
 * 运行时无关：对 `ws`、`Date.now`、`Math.random`、`setTimeout` 均通过 `YouduSocketHooks`
 * 暴露为可注入默认值；默认实现使用 Node 环境（`ws.WebSocket`），测试可用注入替代。
 */
export class YouduSocket extends EventEmitter {
    // Config
    logger;
    wsUrl;
    tlsOptions;
    heartbeatIntervalMs;
    reconnectBaseDelayMs;
    maxReconnectAttempts;
    connectTimeoutMs;
    authTimeoutMs;
    replyAckTimeoutMs;
    maxReplyQueueSize;
    maxMissedPong = MAX_MISSED_PONG;
    reconnectMaxDelay = DEFAULT_RECONNECT_MAX_DELAY_MS;
    // Injected hooks
    now;
    random;
    scheduleTimeout;
    cancelTimeout;
    createWebSocket;
    // Connection
    ws = null;
    heartbeatTimer = null;
    reconnectTimer = null;
    connectWatchdogTimer = null;
    authWatchdogTimer = null;
    reconnectPhase = "fast";
    isManualClose = false;
    state = "stopped";
    authenticated = false;
    nextRetryAt = null;
    lastConnectedAt = null;
    lastAuthenticatedAt = null;
    lastDisconnectedAt = null;
    lastError = null;
    /** 保留本次连接尝试中更具体的 socket/auth 错误，避免 close(1006) 覆盖根因。 */
    lastErrorIsSpecific = false;
    // Credentials
    botId = "";
    botSecret = "";
    token = "";
    /** 认证成功后服务器下发的 gid（机器人在群聊 @ 事件里出现的身份，用于 mention 匹配）。 */
    gid = "";
    /** 是否曾经成功认证过（断线后仍为 true，配合 token 用于 reconnect 与回复队列）。 */
    hasAuthenticated = false;
    isReauthenticating = false;
    /** 连续未收到心跳响应的次数 */
    missedPongCount = 0;
    reconnectAttempts = 0;
    /** 回复队列 */
    replyQueues = new Map();
    pendingAcks = new Map();
    constructor(options = {}) {
        super();
        this.logger = options.logger ?? new DefaultLogger();
        // URL 解析：完整 URL 或 host[:port]
        const rawUrl = String(options.wsUrl ?? options.wsHost ?? "").trim();
        if (!rawUrl) {
            throw new TypeError("Youdu WebSocket URL is required");
        }
        this.wsUrl = buildWsUrl(rawUrl);
        this.botId = String(options.botId ?? "");
        this.botSecret = String(options.secret ?? "");
        this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? WS_HEARTBEAT_INTERVAL_MS;
        this.reconnectBaseDelayMs =
            options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
        this.maxReconnectAttempts =
            options.maxReconnectAttempts ?? WS_MAX_RECONNECT_ATTEMPTS;
        this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        this.authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
        this.replyAckTimeoutMs =
            options.replyAckTimeoutMs ?? DEFAULT_REPLY_ACK_TIMEOUT_MS;
        this.maxReplyQueueSize =
            options.maxReplyQueueSize ?? DEFAULT_MAX_REPLY_QUEUE_SIZE;
        this.tlsOptions = options.tlsOptions;
        const hooks = options.hooks ?? {};
        this.now = hooks.now ?? Date.now;
        this.random = hooks.random ?? Math.random;
        this.scheduleTimeout = hooks.setTimeout ?? setTimeout;
        this.cancelTimeout = hooks.clearTimeout ?? clearTimeout;
        this.createWebSocket =
            hooks.createWebSocket ??
                ((url, opts) => new WebSocket(url, opts));
    }
    setCredentials(botId, botSecret) {
        const changed = this.botId !== botId || this.botSecret !== botSecret;
        this.botId = botId;
        this.botSecret = botSecret;
        if (changed) {
            // 配置更新后允许重新认证，即使上一次 1101 曾主动停止了管理器。
            this.isManualClose = false;
            this.clearReconnectTimer();
            this.clearAuth();
            this.state = "stopped";
            this.lastError = null;
            this.lastErrorIsSpecific = false;
        }
    }
    getToken() {
        return this.token;
    }
    getGid() {
        return this.gid;
    }
    getConnectionSnapshot() {
        return {
            state: this.state,
            authenticated: this.authenticated,
            reconnectAttempts: this.reconnectAttempts,
            reconnectPhase: this.reconnectPhase,
            nextRetryAt: this.nextRetryAt,
            lastConnectedAt: this.lastConnectedAt,
            lastAuthenticatedAt: this.lastAuthenticatedAt,
            lastDisconnectedAt: this.lastDisconnectedAt,
            lastError: this.lastError,
        };
    }
    connect() {
        this.clearReconnectTimer();
        this.clearWatchdogs();
        this.isManualClose = false;
        this.lastErrorIsSpecific = false;
        this.authenticated = false;
        this.state = "connecting";
        if (this.ws) {
            this.logger.info("[WS] Closing existing connection before reconnect...");
            this.ws.removeAllListeners();
            this.ws.terminate();
            this.ws = null;
        }
        this.logger.info(`[WS] >>> Attempting to connect to WebSocket`);
        this.logger.info(`[WS] Bot ID: ${this.botId}, Has Secret: ${!!this.botSecret}`);
        try {
            const options = {};
            if (this.wsUrl.startsWith("wss://")) {
                this.logger.info("[WS] Using WSS protocol, loading TLS config");
                Object.assign(options, this.tlsOptions ?? {});
            }
            else {
                this.logger.info("[WS] Using WS protocol, no TLS config required");
            }
            this.ws = this.createWebSocket(this.wsUrl, options);
            this.logger.info(`[WS] WebSocket instance created, readyState=${this.ws.readyState}`);
            this.setupEventHandlers();
            this.startConnectWatchdog(this.ws);
        }
        catch (error) {
            this.state = "offline";
            this.lastError = error?.message ?? String(error);
            this.lastErrorIsSpecific = true;
            this.logger.error(`[WS] !!! Failed to create WebSocket connection: ${error?.message}`);
            this.logger.error(`[WS] Error stack: ${error?.stack}`);
            this.emit("error", error);
            this.scheduleReconnect();
        }
    }
    disconnect() {
        this.isManualClose = true;
        this.clearReconnectTimer();
        this.clearWatchdogs();
        this.stopHeartbeat();
        this.clearPendingMessages("Connection manually closed");
        this.authenticated = false;
        this.state = "stopped";
        this.lastDisconnectedAt = this.now();
        // 主动断开时清除 token，下次连接使用 subscribe + bot_id + secret；
        // 被动断线不会调用此方法，会保留 token 并使用 reconnect。
        this.clearAuth();
        if (this.ws) {
            this.ws.close(1000, "Manual disconnect");
            this.ws = null;
        }
        this.logger.info("WebSocket connection manually closed");
    }
    /** 清除认证状态，强制下次连接使用 bot_id + secret 重新认证 */
    clearAuth() {
        this.clearWatchdogs();
        this.token = "";
        this.hasAuthenticated = false;
        this.authenticated = false;
        this.isReauthenticating = false;
        this.logger.info("[WS] Auth state cleared, will use bot_id + secret for next authentication");
    }
    /**
     * 回复入站消息帧（respond_msg）。
     *
     * @param reqId 入站帧的 headers.reqId
     * @param body  出站消息体
     * @param cmd   默认 respond_msg
     */
    sendReply(reqId, body, cmd = WsCmd.RESPONSE) {
        if (!this.hasAuthenticated || this.isReauthenticating || !this.token) {
            return Promise.reject(new Error("WebSocket authentication is not ready; message was not sent"));
        }
        return new Promise((resolve, reject) => {
            const frame = { cmd, headers: { reqId }, body };
            const item = { frame, resolve, reject };
            if (!this.replyQueues.has(reqId)) {
                this.replyQueues.set(reqId, []);
            }
            const queue = this.replyQueues.get(reqId);
            if (queue.length >= this.maxReplyQueueSize) {
                this.logger.warn(`Reply queue for reqId ${reqId} exceeds max size`);
                reject(new Error(`Reply queue for reqId ${reqId} exceeds max size`));
                return;
            }
            queue.push(item);
            if (queue.length === 1) {
                this.processReplyQueue(reqId);
            }
        });
    }
    /** 便捷回复：从入站帧取 reqId */
    reply(frame, body, cmd) {
        const reqId = frame.headers?.reqId || "";
        return this.sendReply(reqId, body, cmd);
    }
    /** 主动发送消息（send_msg） */
    sendMessage(chatId, body) {
        const reqId = generateReqId(WsCmd.SEND_MSG);
        return this.sendReply(reqId, { chatId, ...body }, WsCmd.SEND_MSG);
    }
    // --------------------------------------------------------------------------
    // Internal
    // --------------------------------------------------------------------------
    setupEventHandlers() {
        if (!this.ws)
            return;
        const socket = this.ws;
        socket.on("open", () => {
            if (this.ws !== socket || this.isManualClose)
                return;
            this.clearConnectWatchdog();
            this.missedPongCount = 0;
            this.lastConnectedAt = this.now();
            const authMethod = this.hasAuthenticated && this.token
                ? "reconnect (with token)"
                : "subscribe (with bot_id + secret)";
            this.logger.info(`[WS] WebSocket opened, will use ${authMethod} for authentication`);
            this.sendAuth();
            this.emit("connected");
        });
        socket.on("message", (data) => {
            const raw = data?.toString?.() ?? String(data);
            let frame;
            try {
                frame = JSON.parse(raw);
                this.logger.info(`[WS] <<< Received message (${raw.length} chars): ${raw}`);
            }
            catch {
                frame = {
                    cmd: WsCmd.CALLBACK,
                    headers: { reqId: generateReqId("raw_text") },
                    body: {
                        msgId: `msg_${Date.now()}`,
                        chatId: "default_chat",
                        chatType: "single",
                        from: { userid: "default_user" },
                        msgType: "text",
                        text: { content: raw },
                    },
                };
            }
            this.handleFrame(frame);
        });
        socket.on("close", (code, reason) => {
            const reasonStr = reason?.toString?.() || `code: ${code}`;
            this.logger.warn(`[WS] WebSocket DISCONNECTED: ${reasonStr}`);
            this.logger.warn(`[WS] isManualClose=${this.isManualClose}`);
            if (this.ws !== socket)
                return;
            this.stopHeartbeat();
            this.clearWatchdogs();
            this.clearPendingMessages(`WebSocket connection closed (${reasonStr})`);
            if (this.ws === socket) {
                this.ws = null;
            }
            this.authenticated = false;
            if (this.state !== "stopped") {
                this.state = "offline";
            }
            this.lastDisconnectedAt = this.now();
            if (!this.isManualClose && !this.lastErrorIsSpecific) {
                this.lastError = reasonStr;
            }
            this.emit("disconnected", reasonStr);
            if (!this.isManualClose) {
                this.scheduleReconnect();
            }
        });
        socket.on("error", (error) => {
            if (this.ws !== socket)
                return;
            this.clearWatchdogs();
            this.authenticated = false;
            if (!this.isManualClose || !this.lastErrorIsSpecific) {
                this.state = this.isManualClose ? "stopped" : "offline";
                this.lastError = error?.message ?? String(error);
                this.lastErrorIsSpecific = true;
            }
            this.logger.error(`[WS] !!! WebSocket ERROR: ${error?.message}`);
            this.emit("error", error);
            if (!this.isManualClose) {
                this.scheduleReconnect();
            }
        });
        socket.on("ping", () => {
            socket.pong();
        });
        socket.on("pong", () => {
            this.missedPongCount = 0;
        });
    }
    sendAuth(forceSubscribe = false) {
        try {
            let frame;
            if (!forceSubscribe && this.hasAuthenticated && this.token) {
                frame = {
                    cmd: WsCmd.RECONNECT,
                    headers: { reqId: generateReqId(WsCmd.RECONNECT) },
                    body: { token: this.token },
                };
                this.logger.info("[WS] Sending reconnect frame with token");
            }
            else {
                frame = {
                    cmd: WsCmd.SUBSCRIBE,
                    headers: { reqId: generateReqId(WsCmd.SUBSCRIBE) },
                    body: { botId: this.botId, secret: this.botSecret },
                };
                this.logger.info("[WS] Sending subscribe frame with bot_id + secret");
            }
            this.send(frame);
            if (this.ws)
                this.startAuthWatchdog(this.ws);
            this.logger.info("[WS] Auth frame sent successfully");
        }
        catch (error) {
            this.logger.error(`[WS] !!! Failed to send auth frame: ${error?.message}`);
        }
    }
    handleFrame(frame) {
        const cmd = frame.cmd || "";
        const reqId = frame.headers?.reqId || "";
        if (frame.cmd === WsCmd.CALLBACK || frame.cmd === WsCmd.EVENT_CALLBACK) {
            this.logger.info(`[server -> plugin] cmd=${cmd}, reqId=${reqId}`);
            this.emit("message", frame);
            return;
        }
        if (this.pendingAcks.has(reqId)) {
            this.handleReplyAck(reqId, frame);
            return;
        }
        if (reqId.startsWith(WsCmd.SUBSCRIBE) || reqId.startsWith(WsCmd.RECONNECT)) {
            this.clearAuthWatchdog();
            const isReconnect = reqId.startsWith(WsCmd.RECONNECT);
            const authType = isReconnect ? "Reconnect" : "Subscribe";
            if (frame.errCode !== WsErrCode.SUCCESS) {
                const authError = `${authType} failed: errcode=${frame.errCode}, errmsg=${frame.errMsg}`;
                this.authenticated = false;
                this.state = "offline";
                this.lastError = authError;
                this.lastErrorIsSpecific = true;
                this.logger.error(authError);
                if (frame.errCode === WsErrCode.AUTH_FAILED) {
                    this.isManualClose = true;
                    this.clearReconnectTimer();
                    this.stopHeartbeat();
                    this.ws?.close(1000, "Authentication failed");
                    this.emit("error", new Error(`Authentication failed: ${frame.errMsg} (code: ${frame.errCode})`));
                    return;
                }
                // Token rejection means the current session is no longer trusted.
                if (isReconnect) {
                    this.reconnectWithFreshAuth("[WS] Token invalid, will reconnect to re-authenticate");
                }
                else {
                    this.logger.warn(`[WS] Subscribe failed with temporary error, reconnect will retry: errcode=${frame.errCode}`);
                    this.ws?.terminate();
                }
                return;
            }
            const newToken = frame.body?.token ?? "";
            if (newToken && newToken !== this.token) {
                this.token = newToken;
                this.hasAuthenticated = true;
                this.logger.info("token already stored");
            }
            if (typeof frame.body?.gid === "string" && frame.body.gid.trim()) {
                this.gid = frame.body.gid.trim();
                this.logger.info(`gid stored: ${this.gid}`);
            }
            this.logger.info("Authentication successful");
            this.clearReconnectTimer();
            this.authenticated = true;
            this.state = "authenticated";
            this.isReauthenticating = false;
            this.reconnectAttempts = 0;
            this.reconnectPhase = "fast";
            this.nextRetryAt = null;
            this.lastAuthenticatedAt = this.now();
            this.lastError = null;
            this.lastErrorIsSpecific = false;
            this.startHeartbeat();
            this.emit("authenticated");
            return;
        }
        if (reqId.startsWith(WsCmd.HEARTBEAT)) {
            if (frame.errCode !== WsErrCode.SUCCESS) {
                this.logger.error(`Heartbeat ack error: errcode=${frame.errCode}, errmsg=${frame.errMsg}`);
                if (frame.errCode === WsErrCode.TOKEN_INVALID) {
                    this.reconnectWithFreshAuth("[WS] Heartbeat token rejected, will reconnect to re-authenticate");
                }
                return;
            }
            this.missedPongCount = 0;
            return;
        }
        // A business ACK can arrive after its local timeout removed pendingAcks.
        // Token invalidation still applies to the connection even though its promise is gone.
        if (frame.errCode === WsErrCode.TOKEN_INVALID) {
            this.reconnectWithFreshAuth("[WS] Token invalid in late reply, will reconnect to re-authenticate");
        }
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            this.sendHeartbeat();
        }, this.heartbeatIntervalMs);
        this.logger.debug(`Heartbeat timer started, interval: ${this.heartbeatIntervalMs}ms`);
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
            this.logger.debug("Heartbeat timer stopped");
        }
    }
    reconnectWithFreshAuth(reason) {
        if (this.isReauthenticating)
            return;
        this.isReauthenticating = true;
        this.logger.warn(reason);
        this.clearWatchdogs();
        this.stopHeartbeat();
        this.token = "";
        this.hasAuthenticated = false;
        this.authenticated = false;
        this.state = "offline";
        this.lastError = reason;
        this.lastErrorIsSpecific = true;
        this.missedPongCount = 0;
        this.clearPendingMessages("Authentication expired; message was not retried");
        this.ws?.terminate();
    }
    sendHeartbeat() {
        if (this.missedPongCount >= this.maxMissedPong) {
            this.logger.warn(`No heartbeat pong received for ${this.missedPongCount} consecutive pings`);
            this.stopHeartbeat();
            this.ws?.terminate();
            return;
        }
        this.missedPongCount++;
        try {
            if (this.ws && this.ws.readyState === SOCKET_OPEN) {
                this.ws.ping();
            }
        }
        catch (error) {
            this.logger.error("Failed to send heartbeat:", error?.message);
        }
    }
    scheduleReconnect() {
        if (this.isManualClose)
            return;
        if (this.reconnectTimer !== null) {
            this.state = "reconnecting";
            return;
        }
        const nextAttempt = this.reconnectAttempts + 1;
        const { delay, phase } = calculateReconnectDelay(nextAttempt, this.maxReconnectAttempts, this.reconnectBaseDelayMs, this.reconnectMaxDelay, this.random);
        this.reconnectAttempts = nextAttempt;
        this.reconnectPhase = phase;
        this.authenticated = false;
        this.state = "reconnecting";
        this.nextRetryAt = this.now() + delay;
        this.logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}, phase ${phase})...`);
        this.emit("reconnecting", this.reconnectAttempts);
        this.reconnectTimer = this.scheduleTimeout(() => {
            this.reconnectTimer = null;
            this.nextRetryAt = null;
            if (this.isManualClose) {
                this.state = "stopped";
                return;
            }
            this.connect();
        }, delay);
    }
    clearReconnectTimer() {
        if (this.reconnectTimer !== null) {
            this.cancelTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.nextRetryAt = null;
    }
    startConnectWatchdog(socket) {
        this.clearConnectWatchdog();
        let timer;
        timer = this.scheduleTimeout(() => {
            if (this.connectWatchdogTimer !== timer)
                return;
            this.connectWatchdogTimer = null;
            if (this.isManualClose || this.ws !== socket)
                return;
            const error = new Error(`WebSocket connection timed out after ${this.connectTimeoutMs}ms`);
            this.state = "offline";
            this.lastError = error.message;
            this.lastErrorIsSpecific = true;
            this.logger.error(`[WS] !!! ${error.message}`);
            this.emit("error", error);
            socket.terminate();
            this.scheduleReconnect();
        }, this.connectTimeoutMs);
        this.connectWatchdogTimer = timer;
    }
    startAuthWatchdog(socket) {
        this.clearAuthWatchdog();
        let timer;
        timer = this.scheduleTimeout(() => {
            if (this.authWatchdogTimer !== timer)
                return;
            this.authWatchdogTimer = null;
            if (this.isManualClose || this.ws !== socket)
                return;
            const error = new Error(`Authentication ACK timed out after ${this.authTimeoutMs}ms`);
            this.authenticated = false;
            this.state = "offline";
            this.lastError = error.message;
            this.lastErrorIsSpecific = true;
            this.logger.error(`[WS] !!! ${error.message}`);
            this.emit("error", error);
            socket.terminate();
            this.scheduleReconnect();
        }, this.authTimeoutMs);
        this.authWatchdogTimer = timer;
    }
    clearConnectWatchdog() {
        if (this.connectWatchdogTimer !== null) {
            this.cancelTimeout(this.connectWatchdogTimer);
            this.connectWatchdogTimer = null;
        }
    }
    clearAuthWatchdog() {
        if (this.authWatchdogTimer !== null) {
            this.cancelTimeout(this.authWatchdogTimer);
            this.authWatchdogTimer = null;
        }
    }
    clearWatchdogs() {
        this.clearConnectWatchdog();
        this.clearAuthWatchdog();
    }
    send(frame) {
        if (this.ws && this.ws.readyState === SOCKET_OPEN) {
            const data = JSON.stringify(frame);
            this.ws.send(data);
        }
        else {
            throw new Error("WebSocket not connected, unable to send data");
        }
    }
    processReplyQueue(reqId) {
        const queue = this.replyQueues.get(reqId);
        if (!queue || queue.length === 0) {
            this.replyQueues.delete(reqId);
            return;
        }
        const item = queue[0];
        if (!this.hasAuthenticated || this.isReauthenticating || !this.token) {
            queue.shift();
            item.reject(new Error("WebSocket authentication is not ready; message was not sent"));
            this.processReplyQueue(reqId);
            return;
        }
        item.frame.headers.token = this.token;
        try {
            this.send(item.frame);
        }
        catch (error) {
            this.logger.error(`Failed to send reply for reqId ${reqId}:`, error?.message);
            queue.shift();
            item.reject(error);
            this.processReplyQueue(reqId);
            return;
        }
        const timer = this.scheduleTimeout(() => {
            this.pendingAcks.delete(reqId);
            queue.shift();
            const error = new Error(`Reply ack timeout (${this.replyAckTimeoutMs}ms) for reqId: ${reqId}`);
            error.code = "youdu-reply-ack-timeout";
            item.reject(error);
            this.processReplyQueue(reqId);
        }, this.replyAckTimeoutMs);
        this.pendingAcks.set(reqId, {
            resolve: item.resolve,
            reject: item.reject,
            timer,
        });
    }
    handleReplyAck(reqId, frame) {
        const pending = this.pendingAcks.get(reqId);
        if (!pending)
            return;
        this.cancelTimeout(pending.timer);
        this.pendingAcks.delete(reqId);
        const queue = this.replyQueues.get(reqId);
        if (frame.errCode !== WsErrCode.SUCCESS) {
            this.logger.error(`Reply ack error: reqId=${reqId}, errcode=${frame.errCode}`);
            queue?.shift();
            // 上层按 error.code / error.errcode 判定可重试性，别把协议帧当错误对象抛出去。
            const error = new Error(`Reply ack failed (errcode=${frame.errCode}) for reqId: ${reqId}`);
            error.code = "youdu-reply-ack-failed";
            error.errcode = frame.errCode;
            error.frame = frame;
            pending.reject(error);
            if (frame.errCode === WsErrCode.TOKEN_INVALID) {
                this.reconnectWithFreshAuth("[WS] Token invalid in reply, will reconnect to re-authenticate");
                return;
            }
        }
        else {
            queue?.shift();
            pending.resolve(frame);
        }
        this.processReplyQueue(reqId);
    }
    clearPendingMessages(reason) {
        for (const [, pending] of this.pendingAcks) {
            this.cancelTimeout(pending.timer);
        }
        this.pendingAcks.clear();
        for (const [reqId, queue] of this.replyQueues) {
            for (const item of queue) {
                item.reject(new Error(`${reason}, reply for reqId: ${reqId} cancelled`));
            }
        }
        this.replyQueues.clear();
    }
}
