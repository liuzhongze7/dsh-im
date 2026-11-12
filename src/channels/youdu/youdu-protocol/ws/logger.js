/*
 * Licensed under the MIT License.
 */
/**
 * 默认日志实现。
 *
 * 详细度交调用方（可注入自定义 Logger），这里只给出一个开箱即用的实现，
 * 前缀默认 `YouDuSDK`，与原 @youdu/openclaw-youdu 的 sdk/ws-utils.ts 保持一致。
 */
export class DefaultLogger {
    prefix;
    constructor(prefix = "YouDuSDK") {
        this.prefix = prefix;
    }
    formatTime() {
        return new Date().toISOString();
    }
    format(level, message) {
        return `[${this.formatTime()}] [${this.prefix}] [${level}] ${message}`;
    }
    debug(message, ...args) {
        console.debug(this.format("DEBUG", message), ...args);
    }
    info(message, ...args) {
        console.info(this.format("INFO", message), ...args);
    }
    warn(message, ...args) {
        console.warn(this.format("WARN", message), ...args);
    }
    error(message, ...args) {
        console.error(this.format("ERROR", message), ...args);
    }
}
