/*
 * Licensed under the MIT License.
 */
/** 从响应头中读取指定头（大小写不敏感） */
export function getHeader(headers, name) {
    const value = headers[name.toLowerCase()];
    if (Array.isArray(value))
        return value[0];
    return value;
}
function normalizeHeaders(headers) {
    const result = {};
    headers.forEach((value, key) => {
        result[key.toLowerCase()] = value;
    });
    return result;
}
/**
 * 基于全局 fetch 的默认 HTTP 传输实现。
 *
 * @param request 请求描述
 */
export async function nodeFetchTransport(request) {
    const headers = {};
    for (const [key, value] of Object.entries(request.headers ?? {})) {
        if (value !== undefined)
            headers[key] = String(value);
    }
    const controller = new AbortController();
    const externalSignal = request.signal;
    let timeoutTimer;
    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
        if (externalSignal.aborted) {
            controller.abort(externalSignal.reason);
        }
        else {
            externalSignal.addEventListener("abort", onExternalAbort, { once: true });
        }
    }
    if (request.timeoutMs && request.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
            controller.abort(new Error(`Youdu request timed out after ${request.timeoutMs}ms`));
        }, request.timeoutMs);
    }
    try {
        const response = await fetch(request.url, {
            method: request.method,
            headers,
            body: request.body,
            signal: controller.signal,
        });
        const arrayBuffer = await response.arrayBuffer();
        return {
            statusCode: response.status,
            headers: normalizeHeaders(response.headers),
            body: Buffer.from(arrayBuffer),
        };
    }
    finally {
        if (externalSignal) {
            externalSignal.removeEventListener("abort", onExternalAbort);
        }
        if (timeoutTimer)
            clearTimeout(timeoutTimer);
    }
}
/** 默认传输 */
export const defaultHttpTransport = nodeFetchTransport;
