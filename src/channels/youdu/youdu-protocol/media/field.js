/*
 * Licensed under the MIT License.
 */
/**
 * 读取上传返回中的媒体字段，兼容两种格式：
 * 1. 当前协议文档里的根级字段；
 * 2. 旧实现里包在 data 下的字段。
 */
export function readMediaField(payload, key) {
    const direct = payload?.[key];
    if (direct !== undefined && direct !== null)
        return direct;
    return payload?.data?.[key];
}
