// Shared by the Host and the settings UI; keep this module browser-compatible.
//
// Per-group access rules for the Youdu channel, modelled after openclaw's
// `groups[<chatId>].allowFrom` plus its `groupPolicy` switch:
//   inherit   – fall back to the shared direct/group access policy (default)
//   open      – everyone in this group may chat (mention rules still apply)
//   allowlist – only the listed user ids / account names may chat
//   disabled  – ignore the group entirely
export const GROUP_ACCESS_VERSION = 1;
export const GROUP_ACCESS_MODES = Object.freeze(['inherit', 'open', 'allowlist', 'disabled']);
export const GROUP_ACCESS_WILDCARD = '*';
export const GROUP_ACCESS_CHAT_ID_MAX_LENGTH = 256;
export const GROUP_ACCESS_USER_MAX_LENGTH = 256;
export const GROUP_ACCESS_MAX_GROUPS = 200;
export const GROUP_ACCESS_MAX_USERS = 200;

const RULE_KEYS = ['mode', 'users'];
const DOCUMENT_KEYS = ['version', 'groups'];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function invalidGroupAccess(message) {
  const error = new TypeError(message);
  error.code = 'group-access-invalid';
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** Normalize one opaque Youdu chat id (group id) without interpreting it. */
export function normalizeGroupAccessChatId(value) {
  if (typeof value !== 'string') throw invalidGroupAccess('群标识必须是字符串。');
  const id = value.trim();
  if (!id || id.length > GROUP_ACCESS_CHAT_ID_MAX_LENGTH || CONTROL_CHARACTERS.test(id)) {
    throw invalidGroupAccess(`群标识不能为空、包含控制字符或超过 ${GROUP_ACCESS_CHAT_ID_MAX_LENGTH} 个字符。`);
  }
  return id;
}

/** Normalize one Youdu sender identity (numeric user id or account name). */
export function normalizeGroupAccessUser(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidGroupAccess('用户标识无效。');
    value = String(value);
  } else if (typeof value === 'bigint') {
    value = String(value);
  }
  if (typeof value !== 'string') throw invalidGroupAccess('用户标识必须是字符串。');
  const id = value.trim();
  if (!id || id.length > GROUP_ACCESS_USER_MAX_LENGTH || CONTROL_CHARACTERS.test(id)) {
    throw invalidGroupAccess(`用户标识不能为空、包含控制字符或超过 ${GROUP_ACCESS_USER_MAX_LENGTH} 个字符。`);
  }
  return id;
}

function validateRule(input) {
  if (!isPlainObject(input)) throw invalidGroupAccess('群访问规则必须是对象。');
  for (const key of Reflect.ownKeys(input)) {
    if (!RULE_KEYS.includes(key)) throw invalidGroupAccess(`群访问规则包含未知字段：${String(key)}。`);
  }
  if (!GROUP_ACCESS_MODES.includes(input.mode)) {
    throw invalidGroupAccess('群访问模式只能是 inherit、open、allowlist 或 disabled。');
  }
  if (input.mode === 'inherit') return Object.freeze({ mode: 'inherit' });
  const users = input.users === undefined ? [] : input.users;
  if (!Array.isArray(users)) throw invalidGroupAccess('群访问用户名单必须是数组。');
  if (users.length > GROUP_ACCESS_MAX_USERS) {
    throw invalidGroupAccess(`群访问用户名单不能超过 ${GROUP_ACCESS_MAX_USERS} 项。`);
  }
  const normalized = users.map(normalizeGroupAccessUser);
  if (new Set(normalized).size !== normalized.length) {
    throw invalidGroupAccess('群访问用户名单不能包含重复的用户标识。');
  }
  if (input.mode === 'allowlist' && normalized.length === 0) {
    throw invalidGroupAccess('“仅名单内用户”模式至少要配置一个用户。');
  }
  return Object.freeze({ mode: input.mode, users: Object.freeze(normalized) });
}

/** Validate one canonical per-bot group-access document. */
export function validateGroupAccess(input) {
  if (!isPlainObject(input)) throw invalidGroupAccess('群访问设置必须是对象。');
  for (const key of Reflect.ownKeys(input)) {
    if (!DOCUMENT_KEYS.includes(key)) throw invalidGroupAccess(`群访问设置包含未知字段：${String(key)}。`);
  }
  if (input.version !== GROUP_ACCESS_VERSION) throw invalidGroupAccess('群访问设置版本无效。');
  if (!isPlainObject(input.groups)) throw invalidGroupAccess('群访问设置缺少群规则表。');
  const entries = Object.entries(input.groups);
  if (entries.length > GROUP_ACCESS_MAX_GROUPS) {
    throw invalidGroupAccess(`群访问设置不能超过 ${GROUP_ACCESS_MAX_GROUPS} 个群。`);
  }
  const groups = {};
  for (const [chatId, rule] of entries) {
    const key = normalizeGroupAccessChatId(chatId);
    if (Object.hasOwn(groups, key)) throw invalidGroupAccess('群访问设置包含重复的群标识。');
    groups[key] = validateRule(rule);
  }
  return Object.freeze({ version: GROUP_ACCESS_VERSION, groups: Object.freeze(groups) });
}

/** Normalize persisted/runtime data; damaged settings fail closed. */
export function normalizeGroupAccess(input) {
  try {
    return validateGroupAccess(input);
  } catch {
    return null;
  }
}

/** Canonical empty document used by the settings UI and fresh bots. */
export function emptyGroupAccess() {
  return Object.freeze({ version: GROUP_ACCESS_VERSION, groups: Object.freeze({}) });
}

/**
 * Resolve the rule for one chat id: case-insensitive exact match first, then
 * the `*` fallback. Returns null when the group inherits the shared policy.
 */
export function resolveGroupAccessRule(groupAccess, chatId) {
  const document = normalizeGroupAccess(groupAccess);
  if (!document || typeof chatId !== 'string') return null;
  const id = chatId.trim();
  if (!id) return null;
  const lowered = id.toLowerCase();
  const exact = Object.keys(document.groups).find((key) => key.toLowerCase() === lowered);
  const key = exact ?? (Object.hasOwn(document.groups, GROUP_ACCESS_WILDCARD)
    ? GROUP_ACCESS_WILDCARD
    : null);
  if (!key) return null;
  const rule = document.groups[key];
  return Object.freeze({
    chatId: key,
    mode: rule.mode,
    users: rule.users ?? Object.freeze([]),
  });
}

function stripUserPrefix(entry) {
  return entry.replace(/^(youdu|user):/i, '').trim();
}

/** Match one sender against an allowlist of user ids / account names / `*`. */
export function matchesGroupAccessUser(users, senderIds, { equals = (left, right) => left === right } = {}) {
  if (!Array.isArray(users) || users.length === 0) return false;
  const candidates = (Array.isArray(senderIds) ? senderIds : [senderIds])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim());
  if (candidates.length === 0) return false;
  return users.some((raw) => {
    const entry = stripUserPrefix(String(raw));
    if (!entry) return false;
    if (entry === GROUP_ACCESS_WILDCARD) return true;
    return candidates.some((candidate) => {
      try {
        return equals(candidate, entry) === true
          || equals(candidate.toLowerCase(), entry.toLowerCase()) === true;
      } catch {
        return false;
      }
    });
  });
}

/**
 * Decide one group message against the per-group rules.
 * `matched: false` means the group inherits the shared access policy.
 */
export function evaluateGroupAccess(groupAccess, { chatId, senderIds, equals } = {}) {
  const rule = resolveGroupAccessRule(groupAccess, chatId);
  if (!rule || rule.mode === 'inherit') {
    return Object.freeze({ matched: false, allowed: true, reason: 'inherit', rule: null });
  }
  if (rule.mode === 'disabled') {
    return Object.freeze({ matched: true, allowed: false, reason: 'group-disabled', rule });
  }
  if (rule.mode === 'open') {
    return Object.freeze({ matched: true, allowed: true, reason: 'group-open', rule });
  }
  const allowed = matchesGroupAccessUser(rule.users, senderIds, equals ? { equals } : {});
  return Object.freeze({
    matched: true,
    allowed,
    reason: allowed ? 'group-sender-allowed' : 'group-sender-not-allowed',
    rule,
  });
}
