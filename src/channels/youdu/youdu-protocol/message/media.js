/*
 * Licensed under the MIT License.
 */
/** 媒体种类常量 */
export const MEDIA_KIND = {
    IMAGE: "image",
    FILE: "file",
    AUDIO: "audio",
    VIDEO: "video",
};
/** 根据 content-type 推断媒体种类（SVG 作为文件，避免被按图片类型处理后无法正常展示或接收） */
export function kindFromContentType(contentType) {
    const normalized = String(contentType ?? "").toLowerCase();
    if (normalized === "image/svg+xml")
        return MEDIA_KIND.FILE;
    if (normalized.startsWith("image/"))
        return MEDIA_KIND.IMAGE;
    if (normalized.startsWith("audio/"))
        return MEDIA_KIND.AUDIO;
    if (normalized.startsWith("video/"))
        return MEDIA_KIND.VIDEO;
    return MEDIA_KIND.FILE;
}
/** 媒体种类的中文标签 */
export function kindLabel(kind) {
    switch (kind) {
        case MEDIA_KIND.IMAGE:
            return "[图片]";
        case MEDIA_KIND.AUDIO:
            return "[语音]";
        case MEDIA_KIND.VIDEO:
            return "[视频]";
        default:
            return "[文件]";
    }
}
function clean(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
/** 从 body 顶层提取媒体附件（image/file/audio/video + media[]）。 */
export function extractInboundMedia(body) {
    const items = [];
    // 某些回调里 media[] 只有 mediaId/name/size，没有显式 kind，
    // 这里根据顶层 msgType 或具名媒体节点做一次回退推断。
    const fallbackKindFromBody = (() => {
        const normalizedMsgType = String(body.msgType ?? "").toLowerCase();
        if (normalizedMsgType === "image" || body.image?.mediaId)
            return MEDIA_KIND.IMAGE;
        if (normalizedMsgType === "audio" || body.audio?.mediaId)
            return MEDIA_KIND.AUDIO;
        if (normalizedMsgType === "video" || body.video?.mediaId)
            return MEDIA_KIND.VIDEO;
        if (normalizedMsgType === "file" || body.file?.mediaId)
            return MEDIA_KIND.FILE;
        return undefined;
    })();
    const push = (kind, node) => {
        if (!node?.mediaId)
            return;
        items.push({
            kind,
            mediaId: node.mediaId,
            name: clean(node.name),
            size: typeof node.size === "number" ? node.size : undefined,
            width: typeof node.width === "number" ? node.width : undefined,
            height: typeof node.height === "number" ? node.height : undefined,
            duration: typeof node.duration === "number" ? node.duration : undefined,
            contentType: clean(node.contentType),
        });
    };
    for (const media of body.media ?? []) {
        const kind = String(media.kind ?? "").toLowerCase();
        if (!media.mediaId)
            continue;
        if (kind === MEDIA_KIND.IMAGE || kind === MEDIA_KIND.AUDIO || kind === MEDIA_KIND.VIDEO) {
            push(kind, media);
            continue;
        }
        if (!kind && fallbackKindFromBody) {
            push(fallbackKindFromBody, media);
            continue;
        }
        push(MEDIA_KIND.FILE, media);
    }
    if (items.length > 0)
        return items;
    push(MEDIA_KIND.IMAGE, body.image);
    push(MEDIA_KIND.FILE, body.file);
    push(MEDIA_KIND.AUDIO, body.audio);
    push(MEDIA_KIND.VIDEO, body.video);
    return items;
}
/** 从 body 推断 AI 可读的文本（无正文时返回媒体占位）。 */
export function inferInboundMessageText(body) {
    const text = clean(body.text?.content);
    if (text)
        return text;
    const media = extractInboundMedia(body);
    if (media.length === 0)
        return "";
    const first = media[0];
    return first.name ? `${kindLabel(first.kind)} ${first.name}` : kindLabel(first.kind);
}
