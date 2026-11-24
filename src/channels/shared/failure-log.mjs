import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 失败现场落盘：把一次消息处理失败的完整诊断按天追加成 JSONL。
 *
 * 为什么需要它：桌面端只在宿主崩溃时把 stdout 的环形缓冲写盘，插件平时
 * `logger.error` 的 `[dsh-im:youdu] failed ... [ref] codeB64= ...` 一行事后查不到；
 * 而参考号是每次失败随机生成的（见 message-failure.mjs），用户把参考号报回来
 * 之后没有任何可核对的落点。写盘后「参考号」才是真的可检索键。
 *
 * 落盘自身失败只记 warn，绝不覆盖原始异常。
 */

/** 长字段截断长度：够定位，又不让单行记录失控。 */
const FIELD_LIMIT = 8_000;

function trimmed(value) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : String(value);
  return text.length > FIELD_LIMIT ? `${text.slice(0, FIELD_LIMIT)}…` : text;
}

/** details 里可能有循环引用或不可序列化的值：取不到就当空对象，不影响落盘。 */
function jsonSafe(value) {
  if (value === undefined || value === null) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

/** 组装一条记录：结论字段（code/参考号/给用户的文案）+ 原始异常 + 上下文。 */
export function failureEntry({
  channel,
  failure,
  error,
  context = {},
  at = new Date(),
}) {
  const when = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
  return {
    at: when.toISOString(),
    channel: trimmed(channel) || null,
    referenceId: failure?.referenceId ?? null,
    code: failure?.code ?? null,
    reason: failure?.reason ?? null,
    userMessage: failure?.message ?? null,
    error: {
      name: trimmed(error?.name),
      message: trimmed(error?.message),
      code: trimmed(error?.code),
      method: trimmed(error?.method),
      status: finiteNumber(error?.status ?? error?.statusCode),
      details: jsonSafe(error?.details),
      stagingFailure: trimmed(error?.stagingFailure) || null,
      stack: trimmed(error?.stack),
    },
    context: jsonSafe(context),
  };
}

/**
 * 追加一条失败记录，返回写入的文件路径（未配置目录或写盘失败时返回 null）。
 *
 * @param {string} dir 失败日志目录，通常是 `<integrations>/<channel>/failures`
 * @param {{channel?: string, failure?: object, error?: unknown, context?: object, at?: Date}} record
 * @param {{logger?: object}} [options]
 */
export async function recordFailure(dir, record = {}, { logger } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return null;
  const entry = failureEntry(record);
  const file = join(dir, `${entry.at.slice(0, 10)}.jsonl`);
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return file;
  } catch (cause) {
    logger?.warn?.(
      `[dsh-im] unable to record a message failure in ${dir}:`,
      cause?.message ?? cause,
    );
    return null;
  }
}
