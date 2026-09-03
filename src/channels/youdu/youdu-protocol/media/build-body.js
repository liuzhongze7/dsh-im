/*
 * Licensed under the MIT License.
 */
/** 构造纯文本消息体（用于 send_msg / respond_msg 的 sendText）。 */
export function buildTextMessageBody(text) {
    return { msgType: "text", text: { content: text } };
}
/**
 * 构造媒体消息体（用于 send_msg / respond_msg 的 sendMedia）。
 */
export function buildMediaMessageBody(media) {
    const payload = {
        mediaId: media.mediaId,
        name: media.name,
        size: media.size,
        width: media.width,
        height: media.height,
        duration: media.duration,
        contentType: media.contentType,
    };
    switch (media.kind) {
        case "image":
            return { msgType: "image", image: payload };
        case "audio":
            return { msgType: "audio", audio: payload };
        case "video":
            return { msgType: "video", video: payload };
        default:
            return { msgType: "file", file: payload };
    }
}
