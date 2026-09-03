/*
 * Licensed under the MIT License.
 */
/**
 * 有度(Youdu) 机器人协议常量。
 *
 * 此处是双端（@youdu/openclaw-youdu 与 dsh-im 的 youdu 适配器）共享的协议级常量集合，
 * 属于跨框架、运行时无关的「不变契约」。宿主层行为常量（如 DM 策略、提醒、占位符等）
 * 不属于此处，保留在各适配器。
 */
/** WebSocket 长连接地址（相对路径） */
export const WS_URL = "/cgi/bot/wss";
/** 媒体下载地址（相对路径） */
export const DOWNLOAD_MEDIA_URL = "/cgi/bot/file/download";
/** 媒体上传地址（相对路径） */
export const UPLOAD_MEDIA_URL = "/cgi/bot/file/upload";
/** WebSocket / HTTP 协议 Scheme */
export const WS_SCHEME = "wss://";
export const HTTP_SCHEME = "https://";
/** 默认端口 */
export const DEFAULT_PORT = 7443;
/** 心跳间隔（毫秒） */
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;
/** 快速重连阶段次数；超过后转入低频持续恢复 */
export const WS_MAX_RECONNECT_ATTEMPTS = 10;
/** 慢速持续恢复阶段的固定延迟（5 分钟） */
export const SLOW_RECONNECT_DELAY_MS = 5 * 60 * 1000;
/** 慢速持续恢复阶段的抖动比例（±20%） */
export const SLOW_RECONNECT_JITTER_RATIO = 0.2;
/** 连接超时（毫秒） */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
/** 认证超时（毫秒） */
export const DEFAULT_AUTH_TIMEOUT_MS = 30_000;
/** 回复 ACK 超时（毫秒） */
export const DEFAULT_REPLY_ACK_TIMEOUT_MS = 5_000;
/** 每个 reqId 的回复队列最大长度 */
export const DEFAULT_MAX_REPLY_QUEUE_SIZE = 100;
/** 连续未收到心跳 pong 的最大次数，超过即终止触发重连 */
export const MAX_MISSED_PONG = 2;
/** 快速重连的基准延迟（毫秒） */
export const DEFAULT_RECONNECT_BASE_DELAY_MS = 1000;
/** 快速重连的最大延迟（毫秒） */
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
