/*
 * Licensed under the MIT License.
 */
import { randomBytes } from "node:crypto";
/** WebSocket 命令常量 */
export var WsCmd;
(function (WsCmd) {
    /** 认证订阅（首次认证） */
    WsCmd["SUBSCRIBE"] = "subscribe";
    /** 断线重连认证 */
    WsCmd["RECONNECT"] = "reconnect";
    /** 心跳 */
    WsCmd["HEARTBEAT"] = "ping";
    /** 消息回调 */
    WsCmd["CALLBACK"] = "msg_callback";
    /** 事件回调 */
    WsCmd["EVENT_CALLBACK"] = "event_callback";
    /** 回复消息 */
    WsCmd["RESPONSE"] = "respond_msg";
    /** 主动发送消息 */
    WsCmd["SEND_MSG"] = "send_msg";
})(WsCmd || (WsCmd = {}));
/** WebSocket 错误码常量 */
export const WsErrCode = {
    SUCCESS: 0,
    PROTOCOL_INVALID: 1001,
    AUTH_FAILED: 1101,
    TOKEN_INVALID: 1102,
    INVALID_REQUEST: 1201,
    CONTEXT_MISSING: 1202,
    UNSUPPORTED: 1203,
    INTERNAL: 1500,
};
/** 生成随机字符串 */
export function generateRandomString(length = 8) {
    return randomBytes(Math.ceil(length / 2)).toString("hex").substring(0, length);
}
/** 生成唯一请求 ID */
export function generateReqId(prefix) {
    const timestamp = Date.now();
    const random = generateRandomString();
    return `${prefix}_${timestamp}_${random}`;
}
