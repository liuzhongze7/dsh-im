/*
 * Licensed under the MIT License.
 */
import { parseDecodedBody, prepareMessageBody } from "./prepare.js";
/**
 * 把 WS 入站帧（msg_callback / event_callback）解析为语义消息。
 *
 * 语义化走共享 prepareMessageBody：普通文本、媒体、引用消息(msgType=10)、
 * 合并消息(msgType=12)、文件消息(msgType=3)、text[] 混排、base64/GBK 解码均在此统一处理。
 * 各适配器消费本函数产出，再对接各自的 agent 框架语义/交互层。
 *
 * @param frame      入站 WsFrame（body + headers.reqId）
 * @param options    上下文：订阅时已知的 botId
 */
export function parseInboundFrame(frame, options) {
    const body = (frame.body ?? {});
    const botId = options.botId ?? "";
    const conversationType = body.chatType === "group" ? "group" : "direct";
    const senderId = String(body.from?.userId ?? body.from?.userid ?? "");
    const senderName = cleanString(body.from?.name ?? body.from?.account);
    const prepared = prepareMessageBody(body, senderName);
    // 引用消息（msgType=10）→ 结构化 quote
    const rawDecoded = body.raw?.decoded;
    let quote;
    if (rawDecoded?.msgType === 10) {
        const parsed = parseDecodedBody(rawDecoded);
        if (parsed.reference) {
            quote = {
                senderId: parsed.reference.sender,
                senderName: parsed.reference.senderName,
                text: parsed.reference.text,
                media: parsed.reference.media,
                time: parsed.reference.time,
            };
        }
    }
    let atUser;
    if (Array.isArray(rawDecoded?.atUser)) {
        atUser = rawDecoded.atUser;
    }
    return {
        botId,
        conversationType,
        chatId: cleanString(body.chatId) ?? "",
        senderId,
        senderName,
        text: prepared.text,
        media: prepared.media,
        quote,
        atUser,
    };
}
function cleanString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
