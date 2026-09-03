/**
 * 有度(Youdu)机器人渠道——宿主常量。
 *
 * 协议层常量在共享包 @youdu/youdu-protocol 中定义，此处 re-export 供宿主代码引用，
 * 避免重复实现。TEXT_CHUNK_LIMIT / WS_HEARTBEAT_INTERVAL_MS / WS_MAX_RECONNECT_ATTEMPTS /
 * DEFAULT_MEDIA_MAX_SIZE 在 dsh-youdu 中无消费点，属死常量，已砍掉。
 */

export {
  DOWNLOAD_MEDIA_URL,
  UPLOAD_MEDIA_URL,
  WS_URL,
  WS_SCHEME,
  HTTP_SCHEME,
  DEFAULT_PORT,
  normalizeWsHost,
} from "@youdu/youdu-protocol";

/** 渠道 ID */
export const CHANNEL_ID = 'youdu';
