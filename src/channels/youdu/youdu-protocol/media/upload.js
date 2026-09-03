/*
 * Licensed under the MIT License.
 */
import { UPLOAD_MEDIA_URL } from "../const.js";
import { buildHttpUrl } from "../ws/url.js";
import { kindFromContentType } from "../message/media.js";
import { defaultHttpTransport } from "../transport.js";
import { buildMultipartFileBody, sanitizeFileName } from "./multipart.js";
import { readMediaField } from "./field.js";
/**
 * 上传单个结果文件字节到有度，返回媒体附件（含 mediaId/kind/name 等）。
 *
 * 对应契约：`POST https://<host>:<port>/cgi/bot/file/upload?kind=<kind>`，
 * multipart 字段名 `file`，头 `x-token`。返回兼容根级或 `data` 包裹两种格式。
 */
export async function uploadMedia(params) {
    const { host, token, fileName, contentType, content, kind, transport = defaultHttpTransport, timeoutMs, signal, } = params;
    const effectiveKind = kind ?? kindFromContentType(contentType);
    const safeName = sanitizeFileName(fileName);
    const form = buildMultipartFileBody({
        fieldName: "file",
        fileName: safeName,
        contentType,
        content,
    });
    const headers = { "Content-Type": form.contentType };
    if (token)
        headers["x-token"] = token;
    const url = buildHttpUrl(host, UPLOAD_MEDIA_URL, `kind=${encodeURIComponent(effectiveKind)}`);
    const response = await transport({
        url,
        method: "POST",
        headers,
        body: form.body,
        timeoutMs,
        signal,
    });
    if (response.statusCode >= 400) {
        throw new Error(`Youdu upload failed with HTTP ${response.statusCode} ${response.body.toString("utf8")}`);
    }
    const text = response.body.toString("utf8");
    const payload = JSON.parse(text);
    const mediaId = String(readMediaField(payload, "mediaId") ?? "");
    if (!mediaId) {
        throw new Error("Youdu upload returned no mediaId");
    }
    return {
        kind: effectiveKind,
        mediaId,
        name: String(readMediaField(payload, "name") ?? safeName),
        size: Number(readMediaField(payload, "size") ?? content.length),
        width: Number(readMediaField(payload, "width") ?? 0) || undefined,
        height: Number(readMediaField(payload, "height") ?? 0) || undefined,
        duration: Number(readMediaField(payload, "duration") ?? 0) || undefined,
        contentType: String(readMediaField(payload, "contentType") ?? contentType ?? ""),
    };
}
