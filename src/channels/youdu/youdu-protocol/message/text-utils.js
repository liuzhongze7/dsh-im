/*
 * Licensed under the MIT License.
 */
/** 根据文件名后缀推断 content-type */
export function inferContentTypeFromName(name) {
    const ext = name.split(".").pop()?.toLowerCase();
    const map = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        bmp: "image/bmp",
        svg: "image/svg+xml",
    };
    return map[ext ?? ""];
}
/** 将 Unix 毫秒时间戳格式化为本地日期时间字符串 */
export function formatTimestamp(ms) {
    if (!ms)
        return "";
    try {
        const d = new Date(ms);
        const pad = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
    catch {
        return String(ms);
    }
}
/** 格式化文件大小为人类可读形式 */
export function formatFileSize(bytes) {
    if (bytes < 1024)
        return `${bytes}B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
