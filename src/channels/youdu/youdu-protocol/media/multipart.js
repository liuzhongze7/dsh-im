/*
 * Licensed under the MIT License.
 */
/** 转义 multipart 头中的特殊字符 */
export function escapeMultipartHeader(value) {
    return String(value ?? "").replace(/[\r\n"]/g, "_");
}
/** 清理文件名（去掉非法字符、压缩空白），空则回退 `media.bin` */
export function sanitizeFileName(name) {
    return (String(name ?? "media.bin")
        .replace(/[\\/:*?"<>|]+/g, "_")
        .replace(/\s+/g, " ")
        .trim() || "media.bin");
}
/** 构造 multipart/form-data 文件体 */
export function buildMultipartFileBody(params) {
    const boundary = `----youdu-${Date.now().toString(16)}-${Math.random()
        .toString(16)
        .slice(2)}`;
    const header = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="${escapeMultipartHeader(params.fieldName)}"; filename="${escapeMultipartHeader(params.fileName)}"`,
        `Content-Type: ${params.contentType || "application/octet-stream"}`,
        "",
        "",
    ].join("\r\n");
    const footer = `\r\n--${boundary}--\r\n`;
    return {
        body: Buffer.concat([Buffer.from(header), params.content, Buffer.from(footer)]),
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}
