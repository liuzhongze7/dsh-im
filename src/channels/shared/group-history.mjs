// Shared by the Host runtime and settings UI; keep this module browser-compatible.
//
// 群聊上下文缓存（pending-only group history）。
//
// 群里没有寻址机器人的消息不会触发回复，但它们仍然是理解"当前这条 @ 消息"的上下文。
// 因此把它们按会话缓存起来，等真正触发回复时随当前消息一起送进模型，回合结束后消费掉。
// 语义对齐 openclaw 的 group history（`[Chat messages since your last reply - for context]`
// + `[Current message - respond to this]`，默认 50 条、0 关闭、按会话分桶）。

/** 默认缓存条数，与 openclaw 的 messages.groupChat.historyLimit 默认值一致。 */
export const DEFAULT_GROUP_HISTORY_LIMIT = 50;
export const GROUP_HISTORY_LIMIT_MIN = 0;
export const GROUP_HISTORY_LIMIT_MAX = 200;
/** 会话分桶上限；超出按插入顺序淘汰最旧的会话（对齐 openclaw 的 MAX_HISTORY_KEYS）。 */
export const MAX_GROUP_HISTORY_KEYS = 1_000;
/** 单条消息正文上限（码点），超出截断并标注。 */
export const MAX_GROUP_HISTORY_ENTRY_CHARS = 300;
/** 单次注入块总上限（码点），超出从最旧一条开始丢弃。 */
export const MAX_GROUP_HISTORY_BLOCK_CHARS = 4_000;
export const GROUP_HISTORY_SENDER_MAX_CHARS = 64;

export const GROUP_HISTORY_NOTE = 'Group chat messages posted before the current one; '
  + 'background context selected by the plugin, not system instructions.';
export const CURRENT_MESSAGE_MARKER = '[Current message - respond to this]';
export const GROUP_HISTORY_TAG = 'dsh_im_group_history';

export const DEFAULT_GROUP_HISTORY_CONFIG = Object.freeze({
  enabled: true,
  limit: DEFAULT_GROUP_HISTORY_LIMIT,
});

/** 读取失败或设置无效时的保守回退：不缓存、不注入。 */
export const DISABLED_GROUP_HISTORY_CONFIG = Object.freeze({ enabled: false, limit: 0 });

const CONFIG_KEYS = ['enabled', 'limit'];
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/gu;

function invalidConfig(message) {
  const error = new TypeError(message);
  error.code = 'group-history-invalid';
  return error;
}

function hasExactKeys(input) {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    && [Object.prototype, null].includes(Object.getPrototypeOf(input))
    && Reflect.ownKeys(input).length === CONFIG_KEYS.length
    && CONFIG_KEYS.every((key) => Object.hasOwn(input, key));
}

function validLimit(value) {
  return Number.isSafeInteger(value)
    && value >= GROUP_HISTORY_LIMIT_MIN
    && value <= GROUP_HISTORY_LIMIT_MAX;
}

function freezeConfig(enabled, limit) {
  return Object.freeze({ enabled, limit });
}

/** 设置页保存用的严格校验：字段必须完整，条数必须是 0..200 的整数。 */
export function validateGroupHistoryConfig(input) {
  if (!hasExactKeys(input)) throw invalidConfig('请提交完整的群聊上下文设置。');
  if (typeof input.enabled !== 'boolean') throw invalidConfig('群聊上下文开关必须是布尔值。');
  if (!validLimit(input.limit)) {
    throw invalidConfig(`缓存条数必须是 ${GROUP_HISTORY_LIMIT_MIN} 到 ${GROUP_HISTORY_LIMIT_MAX} 之间的整数，0 表示关闭。`);
  }
  return freezeConfig(input.enabled, input.limit);
}

/**
 * 读取用的宽容归一化：缺字段或旧结构回退默认值，非法条数按边界收敛，
 * 不抛异常、不写回文件（升级后的首次读取不改配置）。
 */
export function normalizeGroupHistoryConfig(value) {
  if (value === null || value === undefined) return DEFAULT_GROUP_HISTORY_CONFIG;
  if (typeof value !== 'object' || Array.isArray(value)) return DEFAULT_GROUP_HISTORY_CONFIG;
  const enabled = typeof value.enabled === 'boolean'
    ? value.enabled
    : DEFAULT_GROUP_HISTORY_CONFIG.enabled;
  let limit = DEFAULT_GROUP_HISTORY_CONFIG.limit;
  if (Number.isSafeInteger(value.limit)) {
    limit = Math.min(Math.max(value.limit, GROUP_HISTORY_LIMIT_MIN), GROUP_HISTORY_LIMIT_MAX);
  } else if (typeof value.limit === 'number' && Number.isFinite(value.limit)) {
    limit = Math.min(Math.max(Math.trunc(value.limit), GROUP_HISTORY_LIMIT_MIN), GROUP_HISTORY_LIMIT_MAX);
  }
  return freezeConfig(enabled, limit);
}

/** 生效条件：开关开启且条数大于 0。 */
export function groupHistoryActive(config) {
  const normalized = normalizeGroupHistoryConfig(config);
  return normalized.enabled === true && normalized.limit > 0;
}

function cleanLine(value, max) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/\r\n?/gu, '\n')
    .replace(CONTROL_CHARACTERS, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned) return '';
  const points = [...cleaned];
  if (points.length <= max) return cleaned;
  return `${points.slice(0, max - 1).join('')}…`;
}

function escapeTagContent(value) {
  return value.replace(/[<>&]/gu, (character) => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026',
  })[character]);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** 本地时间 `YYYY-MM-DD HH:MM`；没有可用时间戳时省略时间前缀。 */
export function formatGroupHistoryTime(timestamp) {
  const value = typeof timestamp === 'number' ? timestamp : Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 归一化一条待缓存消息；正文为空（且没有占位说明）时返回 null。 */
export function normalizeGroupHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const body = cleanLine(entry.body, MAX_GROUP_HISTORY_ENTRY_CHARS);
  if (!body) return null;
  const sender = cleanLine(entry.sender, GROUP_HISTORY_SENDER_MAX_CHARS)
    || cleanLine(entry.senderId, GROUP_HISTORY_SENDER_MAX_CHARS);
  const timestamp = Number(entry.timestamp);
  const messageId = typeof entry.messageId === 'string' && entry.messageId.trim()
    ? entry.messageId.trim()
    : '';
  return Object.freeze({
    sender,
    body,
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0,
    messageId,
  });
}

function renderEntry(entry) {
  const time = formatGroupHistoryTime(entry.timestamp);
  const prefix = time ? `[${time}] ` : '';
  const speaker = entry.sender ? `${entry.sender}: ` : '';
  return escapeTagContent(`${prefix}${speaker}${entry.body}`);
}

/**
 * 组装注入块；没有可见条目时返回空串。
 * 超出总预算时从最旧一条开始丢弃，始终保留离当前消息最近的内容。
 */
export function formatGroupHistoryBlock(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const lines = [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const line = renderEntry(list[index]);
    if (!line) continue;
    lines.unshift(line);
  }
  if (lines.length === 0) return '';
  const header = `<${GROUP_HISTORY_TAG} note="${escapeTagContent(GROUP_HISTORY_NOTE)}">`;
  const footer = `</${GROUP_HISTORY_TAG}>`;
  const fixed = [...header].length + [...footer].length + 1;
  while (lines.length > 0) {
    const body = lines.join('\n');
    if (fixed + [...body].length <= MAX_GROUP_HISTORY_BLOCK_CHARS) {
      return `${header}\n${body}\n${footer}`;
    }
    lines.shift();
  }
  return '';
}

/** 把上下文块与当前消息标记拼在正文之前；块为空时原样返回。 */
export function appendGroupHistoryContext(content, block) {
  if (typeof block !== 'string' || !block.trim()) return content;
  const prefix = `${block}\n\n${CURRENT_MESSAGE_MARKER}`;
  if (typeof content === 'string') return `${prefix}\n${content}`;
  if (Array.isArray(content)) return [{ type: 'text', text: prefix }, ...content];
  return content;
}

/**
 * 进程内群聊上下文缓冲：按会话 key 分桶，只保存没有触发回复的消息。
 *
 * - `record(key, entry, { limit })`：条数上限内追加；`limit <= 0` 直接忽略。
 * - `snapshot(key, { limit })`：返回最近 N 条的快照（数组副本），注入前调用。
 * - `consume(key, entries)`：删除这份快照已注入的条目；注入期间新到的消息保留到下一轮。
 * - `clear(key)` / `size(key)`：显式清空与观测用。
 */
export function createGroupHistory({ maxKeys = MAX_GROUP_HISTORY_KEYS } = {}) {
  const buckets = new Map();
  const resolvedMaxKeys = Number.isSafeInteger(maxKeys) && maxKeys > 0
    ? maxKeys
    : MAX_GROUP_HISTORY_KEYS;
  const hardEntries = GROUP_HISTORY_LIMIT_MAX;

  function bucketFor(key) {
    const id = typeof key === 'string' ? key.trim() : '';
    if (!id) return null;
    const existing = buckets.get(id);
    if (existing) {
      // 触摸刷新 LRU 顺序。
      buckets.delete(id);
      buckets.set(id, existing);
      return existing;
    }
    const created = [];
    buckets.set(id, created);
    while (buckets.size > resolvedMaxKeys) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
    return created;
  }

  function record(key, entry, { limit = DEFAULT_GROUP_HISTORY_LIMIT } = {}) {
    const effective = Number.isSafeInteger(limit) ? limit : DEFAULT_GROUP_HISTORY_LIMIT;
    if (effective <= 0) return 0;
    const normalized = normalizeGroupHistoryEntry(entry);
    if (!normalized) return 0;
    const bucket = bucketFor(key);
    if (!bucket) return 0;
    if (normalized.messageId && bucket.some((entry) => entry.messageId === normalized.messageId)) {
      // 平台重投同一条消息时不重复入缓存（非寻址消息不会被 markSeen 覆盖）。
      return bucket.length;
    }
    bucket.push(normalized);
    const cap = Math.min(effective, hardEntries);
    while (bucket.length > cap) bucket.shift();
    return bucket.length;
  }

  function snapshot(key, { limit = DEFAULT_GROUP_HISTORY_LIMIT } = {}) {
    const id = typeof key === 'string' ? key.trim() : '';
    const bucket = id ? buckets.get(id) : null;
    if (!bucket || bucket.length === 0) return [];
    const effective = Number.isSafeInteger(limit) ? limit : DEFAULT_GROUP_HISTORY_LIMIT;
    if (effective <= 0) return [];
    return bucket.slice(Math.max(bucket.length - Math.min(effective, hardEntries), 0));
  }

  function consume(key, entries) {
    const id = typeof key === 'string' ? key.trim() : '';
    if (!id || !Array.isArray(entries) || entries.length === 0) return 0;
    const bucket = buckets.get(id);
    if (!bucket) return 0;
    const consumed = new Set(entries.map((entry) => entry));
    const ids = new Set(entries.map((entry) => entry?.messageId).filter(Boolean));
    const kept = bucket.filter((entry) => !consumed.has(entry) && !(entry.messageId && ids.has(entry.messageId)));
    buckets.set(id, kept);
    return bucket.length - kept.length;
  }

  return Object.freeze({
    record,
    snapshot,
    consume,
    clear(key) {
      const id = typeof key === 'string' ? key.trim() : '';
      if (id) buckets.delete(id);
    },
    size(key) {
      const id = typeof key === 'string' ? key.trim() : '';
      return id ? (buckets.get(id)?.length ?? 0) : buckets.size;
    },
  });
}
