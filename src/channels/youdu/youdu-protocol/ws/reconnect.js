/*
 * Licensed under the MIT License.
 */
import { DEFAULT_RECONNECT_BASE_DELAY_MS, DEFAULT_RECONNECT_MAX_DELAY_MS, SLOW_RECONNECT_DELAY_MS, SLOW_RECONNECT_JITTER_RATIO, WS_MAX_RECONNECT_ATTEMPTS, } from "../const.js";
/**
 * 计算重连延迟与阶段。
 *
 * - 快速阶段：指数退避 `base * 2^(attempt-1)`，封顶 `maxDelay`，共 `maxFastAttempts` 次。
 * - 慢速阶段：超过快速次数后，固定 5 分钟 ±20% 抖动的持续恢复。
 *
 * @param reconnectAttempt   第几次尝试（从 1 开始）
 * @param maxFastAttempts    快速阶段次数
 * @param reconnectBaseDelay 快速阶段基准延迟（毫秒）
 * @param reconnectMaxDelay  快速阶段最大延迟（毫秒）
 * @param random             随机源（默认 Math.random，可注入以便测试）
 */
export function calculateReconnectDelay(reconnectAttempt, maxFastAttempts = WS_MAX_RECONNECT_ATTEMPTS, reconnectBaseDelay = DEFAULT_RECONNECT_BASE_DELAY_MS, reconnectMaxDelay = DEFAULT_RECONNECT_MAX_DELAY_MS, random = Math.random) {
    const attempt = Math.max(1, Math.floor(reconnectAttempt));
    const fastAttemptLimit = maxFastAttempts > 0 ? Math.floor(maxFastAttempts) : WS_MAX_RECONNECT_ATTEMPTS;
    // Fast recovery: the configured window (10 attempts in production) caps at 30 seconds.
    if (attempt <= fastAttemptLimit) {
        return {
            delay: Math.min(reconnectBaseDelay * Math.pow(2, attempt - 1), reconnectMaxDelay),
            phase: "fast",
        };
    }
    // Slow persistent recovery: retry forever every five minutes with +/-20% jitter.
    const randomValue = Math.min(1, Math.max(0, random()));
    const jitterMultiplier = 1 - SLOW_RECONNECT_JITTER_RATIO + randomValue * SLOW_RECONNECT_JITTER_RATIO * 2;
    return {
        delay: Math.round(SLOW_RECONNECT_DELAY_MS * jitterMultiplier),
        phase: "slow",
    };
}
