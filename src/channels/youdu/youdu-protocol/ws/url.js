/*
 * Licensed under the MIT License.
 */
import { DEFAULT_PORT, HTTP_SCHEME, WS_SCHEME, WS_URL } from "../const.js";
/**
 * 从「服务器地址」(可选含 scheme/端口) 生成无 scheme 的 host[:port]。
 *
 * 例如：
 * - `wss://push.example.com` → `push.example.com:7443`
 * - `https://push.example.com:7443` → `push.example.com:7443`
 * - `push.example.com` → `push.example.com:7443`
 * - `push.example.com:9000` → `push.example.com:9000`
 *
 * @param rawUrl 原始地址（可含 scheme/端口/路径）
 * @returns host[:port]，无法解析时返回 null
 */
export function normalizeWsHost(rawUrl) {
    const value = String(rawUrl ?? "").trim();
    if (!value)
        return null;
    let cleaned = value
        .replace(/^wss?:\/\//i, "")
        .replace(/^https?:\/\//i, "")
        .split("/")[0]
        .trim();
    if (!cleaned)
        return null;
    if (!/:\d+$/.test(cleaned)) {
        cleaned = `${cleaned}:${DEFAULT_PORT}`;
    }
    return cleaned;
}
/**
 * 构建 WebSocket 连接地址。
 *
 * 若传入的是完整 URL（以 ws/wss 开头）则原样返回；否则当作 host[:port]，
 * 拼接 scheme 与 `/cgi/bot/wss` 路径。
 */
export function buildWsUrl(host) {
    const trimmed = String(host ?? "").trim();
    if (!trimmed)
        return trimmed;
    // 已是含 /cgi/bot/wss 的完整 WebSocket URL：原样返回
    if (/^wss?:\/\/[^/]+\/cgi\/bot\/wss$/i.test(trimmed))
        return trimmed;
    // 去掉 scheme 后作为 host[:port] 拼接默认路径（含带 scheme 但缺路径的输入）
    const bare = trimmed.replace(/^wss?:\/\//i, "").split("/")[0];
    if (!bare)
        return trimmed;
    return `${WS_SCHEME}${bare}${WS_URL}`;
}
/**
 * 构建（供媒体上传下载使用的）HTTP 地址。
 *
 * @param host    host[:port]（无 scheme）
 * @param path    HTTP 相对路径，如 `/cgi/bot/file/upload`
 * @param query   可选查询串（不含前导 `?`），如 `kind=image&mediaId=123`
 */
export function buildHttpUrl(host, path, query) {
    const queryPart = query ? `?${query}` : "";
    return `${HTTP_SCHEME}${host}${path}${queryPart}`;
}
