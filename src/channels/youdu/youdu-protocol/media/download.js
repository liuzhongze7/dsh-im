/*
 * Licensed under the MIT License.
 */
import { DOWNLOAD_MEDIA_URL } from "../const.js";
import { buildHttpUrl } from "../ws/url.js";
import { defaultHttpTransport, getHeader, } from "../transport.js";
/**
 * 下载有度媒体字节。
 *
 * 对应契约：`GET https://<host>:<port>/cgi/bot/file/download?kind=<kind>&mediaId=<id>`，
 * 头 `x-token`。返回 `{ contentType, buffer }`，当 buffer 超过 maxBytes 时抛错。
 */
export async function downloadMedia(params) {
    const { host, token, kind, mediaId, maxBytes, transport = defaultHttpTransport, timeoutMs, signal, } = params;
    const headers = {};
    if (token)
        headers["x-token"] = token;
    const url = buildHttpUrl(host, DOWNLOAD_MEDIA_URL, `kind=${encodeURIComponent(kind)}&mediaId=${encodeURIComponent(mediaId)}`);
    const response = await transport({
        url,
        method: "GET",
        headers,
        timeoutMs,
        signal,
    });
    if (response.statusCode >= 400) {
        throw new Error(`Youdu download failed with HTTP ${response.statusCode} ${response.body.toString("utf8")}`);
    }
    const contentType = getHeader(response.headers, "content-type");
    const buffer = response.body;
    if (Number.isFinite(maxBytes) && buffer.length > maxBytes) {
        throw new Error("Youdu media exceeds the allowed size");
    }
    return { contentType, buffer };
}
