/**
 * 有度(Youdu)机器人渠道——协议与宿主常量。
 *
 * 协议层常量与实现内联在本渠道（youdu-protocol/ 下），此处 re-export 供宿主代码引用，
 * 避免依赖外部包。WS_HEARTBEAT_INTERVAL_MS / WS_MAX_RECONNECT_ATTEMPTS / DEFAULT_MEDIA_MAX_SIZE
 * 在 dsh-youdu 中无消费点，属死常量，已砍掉；出站文本分片上限见 text-chunking.mjs。
 */

export {
  DOWNLOAD_MEDIA_URL,
  UPLOAD_MEDIA_URL,
  WS_URL,
  WS_SCHEME,
  HTTP_SCHEME,
  DEFAULT_PORT,
  normalizeWsHost,
} from "./youdu-protocol/index.js";

/** 渠道 ID */
export const CHANNEL_ID = 'youdu';
