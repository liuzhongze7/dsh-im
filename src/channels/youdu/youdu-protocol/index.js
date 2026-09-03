/*
 * Licensed under the MIT License.
 */
// ============================================================================
// 协议常量
// ============================================================================
export { DEFAULT_AUTH_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_MAX_REPLY_QUEUE_SIZE, DEFAULT_PORT, DEFAULT_RECONNECT_BASE_DELAY_MS, DEFAULT_RECONNECT_MAX_DELAY_MS, DEFAULT_REPLY_ACK_TIMEOUT_MS, DOWNLOAD_MEDIA_URL, HTTP_SCHEME, MAX_MISSED_PONG, SLOW_RECONNECT_DELAY_MS, SLOW_RECONNECT_JITTER_RATIO, UPLOAD_MEDIA_URL, WS_HEARTBEAT_INTERVAL_MS, WS_MAX_RECONNECT_ATTEMPTS, WS_SCHEME, WS_URL, } from "./const.js";
// ============================================================================
// WS：命令/错误码/工具
// ============================================================================
export { generateRandomString, generateReqId, WsCmd, WsErrCode, } from "./ws/cmd.js";
export { DefaultLogger } from "./ws/logger.js";
export { calculateReconnectDelay } from "./ws/reconnect.js";
export { buildHttpUrl, buildWsUrl, normalizeWsHost } from "./ws/url.js";
export { SOCKET_OPEN, } from "./ws/types.js";
export { YouduSocket } from "./ws/socket.js";
// ============================================================================
// 传输层（可注入，媒体 upload/download 使用）
// ============================================================================
export { defaultHttpTransport, getHeader, nodeFetchTransport, } from "./transport.js";
// ============================================================================
// 消息语义化：媒体提取 + 深解析 + 语义消息
// ============================================================================
export { extractInboundMedia, inferInboundMessageText, kindFromContentType, kindLabel, MEDIA_KIND, } from "./message/media.js";
export { formatFileSize, formatTimestamp, inferContentTypeFromName, } from "./message/text-utils.js";
export { formatMergedText, formatMessageWithReference, parseDecodedBody, parseMergedMessage, parseTextElements, prepareMessageBody, safeBase64Decode, } from "./message/prepare.js";
export { parseInboundFrame } from "./message/semantic.js";
// ============================================================================
// 媒体：组包 / 上传 / 下载
// ============================================================================
export { buildMediaMessageBody, buildTextMessageBody } from "./media/build-body.js";
export { buildMultipartFileBody, escapeMultipartHeader, sanitizeFileName, } from "./media/multipart.js";
export { readMediaField } from "./media/field.js";
export { uploadMedia } from "./media/upload.js";
export { downloadMedia } from "./media/download.js";
