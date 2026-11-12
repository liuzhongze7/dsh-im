/*
 * Licensed under the MIT License.
 *
 * 有度消息统一解析器
 *
 * 所有消息内容的解析与格式化在此文件中集中管理。
 * 入口函数 prepareMessageBody() 根据消息体类型自动分发，
 * 返回统一的 { text, media } 结果，调用方无需关心底层消息类型。
 *
 * 支持的消息类型：
 * - msgType=12（合并消息/聊天记录转发）
 * - msgType=10（引用消息/回复）
 * - msgType=1/3/其他（图片/文件/普通消息等，走 body 顶层字段提取）
 *
 * 普通文本消息（msgType=0）不在此做特殊处理，直接走 body.text.content。
 */
import { extractInboundMedia, inferInboundMessageText } from "./media.js";
import { formatFileSize, formatTimestamp, inferContentTypeFromName, } from "./text-utils.js";
// ============================================================================
// 2. 共享工具函数
// ============================================================================
// ============================================================================
// 3. 底层解析函数
// ============================================================================
/**
 * 解析 text[] 数组，提取纯文本和媒体附件。
 *
 * text[] 中的元素类型：
 * - txt: 纯文本内容，直接拼接
 * - em:  表情代码，格式化为 "[表情: /:happy]"
 * - img: 图片，生成 "[图片: xxx.png]" 占位文本，同时提取为附件
 */
export function parseTextElements(elements) {
    const textParts = [];
    const media = [];
    for (const entry of elements) {
        if (!entry || typeof entry !== "object")
            continue;
        if (typeof entry.txt === "string" && entry.txt) {
            textParts.push(entry.txt);
            continue;
        }
        if (typeof entry.em === "string" && entry.em) {
            textParts.push(`[表情: ${entry.em}]`);
            continue;
        }
        if (entry.img && typeof entry.img.id === "string" && entry.img.id) {
            const imgName = typeof entry.img.name === "string" ? entry.img.name : "图片";
            textParts.push(`[图片: ${imgName}]`);
            media.push({
                kind: "image",
                mediaId: entry.img.id,
                name: imgName,
                size: typeof entry.img.size === "number" ? entry.img.size : undefined,
                width: typeof entry.img.width === "number" ? entry.img.width : undefined,
                height: typeof entry.img.height === "number" ? entry.img.height : undefined,
                contentType: inferContentTypeFromName(imgName),
            });
            continue;
        }
    }
    return { text: textParts.join(""), media };
}
/**
 * 安全解码 base64 字符串，失败时返回 null。
 *
 * 编码兼容：先尝试 UTF-8 解码。若 JSON.parse 校验失败，再尝试 GBK 编码
 *（有度早期版本的部分消息使用 GBK 编码的中文文本）。
 */
export function safeBase64Decode(encoded) {
    if (!encoded || typeof encoded !== "string")
        return null;
    if (!/^[A-Za-z0-9+/=]*$/.test(encoded))
        return null;
    try {
        const buf = Buffer.from(encoded, "base64");
        if (buf.length === 0)
            return null;
        // 1) 尝试 UTF-8 解码
        const utf8Str = buf.toString("utf-8");
        if (utf8Str) {
            try {
                JSON.parse(utf8Str);
                return utf8Str;
            }
            catch {
                // 不是合法 JSON → 可能是 GBK 编码
            }
        }
        // 2) GBK 回退
        try {
            const gbkStr = new TextDecoder("gbk").decode(buf);
            if (gbkStr) {
                JSON.parse(gbkStr);
                return gbkStr;
            }
        }
        catch {
            // GBK 也失败
        }
        return null;
    }
    catch {
        return null;
    }
}
// ============================================================================
// 4. 合并消息解析（msgType=12）
// ============================================================================
/** 合并消息的 msgType 值 */
const MERGED_MESSAGE_MSG_TYPE = 12;
/**
 * 解析合并消息（msgType === 12）。
 */
export function parseMergedMessage(body) {
    if (body?.msgType !== MERGED_MESSAGE_MSG_TYPE)
        return null;
    const rawList = body.list;
    if (!Array.isArray(rawList) || rawList.length === 0)
        return null;
    const result = {
        textParts: [],
        mediaAttachments: [],
        subMessages: [],
        subMessageCount: rawList.length,
    };
    for (let i = 0; i < rawList.length; i++) {
        const item = rawList[i];
        const sender = typeof item.sender === "number" ? item.sender : 0;
        const senderName = (typeof item.senderName === "string" ? item.senderName : "").trim();
        const sendTime = typeof item.sendTime === "number" ? item.sendTime : 0;
        const encodedContent = typeof item.content === "string" ? item.content : "";
        const decodedStr = safeBase64Decode(encodedContent);
        if (decodedStr === null)
            continue;
        let decoded;
        try {
            decoded = JSON.parse(decodedStr);
        }
        catch {
            const textLine = decodedStr;
            result.textParts.push(textLine);
            result.subMessages.push({
                text: textLine,
                media: [],
                sender,
                senderName,
                sendTime,
            });
            continue;
        }
        const subTextParts = [];
        const subMedia = [];
        // 分支 A：有 text[] 数组（msgType=0 文本/表情/混排 或 msgType=1 图片）
        if (Array.isArray(decoded.text) && decoded.text.length > 0) {
            const parsed = parseTextElements(decoded.text);
            subTextParts.push(parsed.text);
            subMedia.push(...parsed.media);
        }
        // 分支 B：文件类型（msgType=3，无 text[]，顶层 id/name/size）
        const subMsgType = typeof decoded.msgType === "number" ? decoded.msgType : -1;
        if (subMsgType === 3 && typeof decoded.id === "string" && decoded.id) {
            const fileName = typeof decoded.name === "string" ? decoded.name : "文件";
            const fileSize = typeof decoded.size === "number" ? decoded.size : undefined;
            const sizeLabel = fileSize !== undefined ? ` (${formatFileSize(fileSize)})` : "";
            subTextParts.push(`[文件: ${fileName}]${sizeLabel}`);
            subMedia.push({
                kind: "file",
                mediaId: decoded.id,
                name: fileName,
                size: fileSize,
                contentType: inferContentTypeFromName(fileName),
            });
        }
        // 分支 C：完全未知的 msgType，兜底
        if (subTextParts.length === 0 && subMedia.length === 0) {
            subTextParts.push(JSON.stringify(decoded));
        }
        const lineText = subTextParts.join("");
        result.textParts.push(lineText);
        result.mediaAttachments.push(...subMedia);
        result.subMessages.push({
            text: lineText,
            media: subMedia,
            sender,
            senderName,
            sendTime,
        });
    }
    if (result.subMessages.length === 0)
        return null;
    result.subMessageCount = result.subMessages.length;
    return result;
}
// ============================================================================
// 5. 引用消息解析（msgType=10）
// ============================================================================
/**
 * 解析 raw.decoded 为结构化消息（仅用于引用消息 msgType=10）。
 *
 * 同时解析 reference（被引用内容）和 text（原文），
 * 注意：不对 msgType=0 做特殊处理。
 */
export function parseDecodedBody(decoded) {
    const original = parseTextElements(decoded.text ?? []);
    let reference;
    if (decoded.reference) {
        const refContent = parseTextElements(decoded.reference.text);
        reference = {
            text: refContent.text,
            media: refContent.media,
            sender: decoded.reference.sender,
            senderName: decoded.reference.senderName,
            time: decoded.reference.time,
        };
    }
    return {
        originalText: original.text,
        originalMedia: original.media,
        reference,
    };
}
// ============================================================================
// 6. 格式化函数
// ============================================================================
/**
 * 格式化合并消息为 AI 可读的文本。
 */
export function formatMergedText(result, title) {
    const header = `聊天记录: ${title ?? ""}`;
    const lines = result.subMessages.map((msg) => {
        const timeStr = formatTimestamp(msg.sendTime);
        const senderLabel = msg.senderName
            ? `${msg.sender}(${msg.senderName})`
            : String(msg.sender);
        return `[${timeStr}] ${senderLabel}: ${msg.text}`;
    });
    const body = [header, ...lines].join("\n");
    return [
        "用户分享了一段聊天记录。请先完整阅读聊天记录，然后对聊天记录中的对话内容做简要总结，最后主动询问用户的意图或需要你帮忙完成什么任务。",
        "",
        body,
    ].join("\n");
}
/**
 * 构建 AI 可读的引用消息上下文文本。
 */
export function formatMessageWithReference(parsed, currentUserName) {
    if (!parsed.reference) {
        return {
            text: parsed.originalText || "",
            allMedia: parsed.originalMedia,
        };
    }
    const ref = parsed.reference;
    const refSenderLabel = ref.senderName || String(ref.sender);
    const refTimeStr = formatTimestamp(ref.time);
    const userName = currentUserName || "未知用户";
    const text = [
        "用户回复了一条消息，请结合以下上下文理解用户意图：",
        "",
        `被回复的消息（发送者: ${refSenderLabel}，时间: ${refTimeStr}）：`,
        ref.text || "(空消息)",
        "",
        `用户当前消息（发送者: ${userName}）：`,
        parsed.originalText || "(空消息)",
        "",
        "请结合上述对话上下文理解用户的意图，并给出恰当的回复。",
    ].join("\n");
    return {
        text,
        allMedia: [...parsed.originalMedia, ...ref.media],
    };
}
// ============================================================================
// 7. ★ 主入口：prepareMessageBody()
// ============================================================================
/**
 * 统一消息准备入口。
 *
 * 根据消息体内容自动判断消息类型并完成解析，返回 AI 可消费的
 * 纯文本 + 媒体附件列表。调用方无需关心底层消息类型。
 */
export function prepareMessageBody(body, currentUserName) {
    // Step 1: 提取顶层媒体和基础文本（保持原有逻辑）
    let inboundMedia = extractInboundMedia(body);
    let text = inferInboundMessageText(body);
    // Step 2: 检查 raw.decoded，处理特殊消息类型
    const rawDecoded = body.raw?.decoded;
    if (rawDecoded) {
        // 合并消息（msgType=12）
        if (rawDecoded.msgType === MERGED_MESSAGE_MSG_TYPE &&
            Array.isArray(rawDecoded.list)) {
            const mergedResult = parseMergedMessage(rawDecoded);
            if (mergedResult) {
                if (mergedResult.mediaAttachments.length > 0) {
                    inboundMedia = mergedResult.mediaAttachments;
                }
                text = formatMergedText(mergedResult, rawDecoded.title);
            }
        }
        else if (rawDecoded.msgType === 10) {
            // 引用消息（msgType=10）
            const parsed = parseDecodedBody(rawDecoded);
            if (parsed.reference) {
                const userName = currentUserName || body.from?.name || body.from?.account || "";
                const formatted = formatMessageWithReference(parsed, userName);
                text = formatted.text;
                if (formatted.allMedia.length > 0) {
                    inboundMedia = formatted.allMedia;
                }
            }
            else if (parsed.originalText && !text) {
                // 有 decoded.text 但没有 reference，兜底使用解析出的文本
                text = parsed.originalText;
            }
        }
    }
    // Step 3: 返回统一结果
    return { text, media: inboundMedia };
}
