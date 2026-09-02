/**
 * 有度(Youdu)机器人渠道——协议常量。
 *
 * 移植自 @youdu/openclaw-youdu 的 src/const.ts（MIT）。这里只保留接入
 * DeepSeek Harness 最小闭环所需的路径、端口、速率与消息常量。
 */

/** 渠道 ID */
export const CHANNEL_ID = 'youdu';

/** WebSocket 长连接地址（相对路径） */
export const WS_URL = '/cgi/bot/wss';

/** 媒体下载/上传地址（相对路径） */
export const DOWNLOAD_MEDIA_URL = '/cgi/bot/file/download';
export const UPLOAD_MEDIA_URL = '/cgi/bot/file/upload';

/** WebSocket / HTTP 协议 Scheme */
export const WS_SCHEME = 'wss://';
export const HTTP_SCHEME = 'https://';

/** 默认端口 */
export const DEFAULT_PORT = 7443;

/** 文本分块大小上限 */
export const TEXT_CHUNK_LIMIT = 4000;

/** 心跳间隔（毫秒） */
export const WS_HEARTBEAT_INTERVAL_MS = 30000;

/** 快速重连阶段次数；超过后转入低频持续恢复 */
export const WS_MAX_RECONNECT_ATTEMPTS = 10;

/** 默认媒体最大体积（12MiB） */
export const DEFAULT_MEDIA_MAX_SIZE = 12 * 1024 * 1024;

/**
 * 从「服务器地址」(可选含 scheme/端口) 生成 WebSocket 连接 host + 端口。
 * 返回无 scheme 的 host（形如 `push.example.com` 或 `push.example.com:7443`）。
 */
export function normalizeWsHost(rawUrl) {
  const value = String(rawUrl ?? '').trim();
  if (!value) return null;
  let cleaned = value
    .replace(/^wss?:\/\//i, '')
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .trim();
  if (!cleaned) return null;
  // 缺省端口时补默认端口（有度机器人 WS 通常走 7443）
  if (!/:\d+$/.test(cleaned)) {
    cleaned = `${cleaned}:${DEFAULT_PORT}`;
  }
  return cleaned;
}
