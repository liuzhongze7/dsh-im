// 有度主动投递目标的名字解析。
//
// 有度服务端只认 chatId：单聊 chatId 是对方用户 ID（纯数字），群聊 chatId 是会话
// ID（形如 {0798E01E-CD68-42BB-813C-EB51593BB0F5}）。但人更愿意记「刘钟泽」或
// 「研发群」，所以投递目标允许填名字，发送前解析成权威 chatId。
//
// 规则移植自 OpenClaw 插件（message-sender.ts / group-resolve.ts）：
// - 先精确匹配，再大小写不敏感回退；
// - 单聊先按账号名（account，唯一性更高）再按昵称（name）；
// - 命中多个候选一律报歧义并列出候选，绝不猜一个发出去；
// - 群名只是可寻址别名，权威标识仍是群 ID。
import { t } from '../shared/i18n.mjs';

/** 有度群会话 ID 形态。 */
const GROUP_ID_PATTERN = /^\{[0-9A-Za-z-]{6,}\}$/;
/** 有度单聊 chatId 是对方用户 ID（纯数字）。 */
const USER_ID_PATTERN = /^\d+$/;

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function lowered(value) {
  return value.toLowerCase();
}

// 解析失败统一用共享的 invalid-target 码（投递层与 RPC 层都认这个码），
// 具体原因（没找到 / 重名 / 空值）放在 message 里：
// 用户填错名字时需要看到"没找到"或"匹配到多个"的原文，而不是折叠后的 delivery-failed。
function targetError(reason, message) {
  const error = new Error(message);
  error.code = 'invalid-target';
  error.reason = reason;
  // 标记"这条消息可以直接给用户看"，投递 RPC 据此透传 message。
  error.userMessage = true;
  return error;
}

/** 名字命中多个候选：把候选连同 ID 一起列出来，让调用方改用 ID。 */
function ambiguousError(kind, name, candidates) {
  const details = candidates.join('、');
  return targetError(
    'ambiguous',
    kind === 'group'
      ? t('有度群名「{name}」对应多个群：{candidates}。请改用群 ID。', { name, candidates: details })
      : t('有度用户名「{name}」对应多个联系人：{candidates}。请改用用户 ID 或账号名。', {
        name,
        candidates: details,
      }),
  );
}

function unknownError(kind, name) {
  return targetError(
    'unknown',
    kind === 'group'
      ? t('找不到有度的群「{name}」。请先让群里有消息，或直接填写群 ID。', { name })
      : t('找不到有度的联系人「{name}」。请先让对方私聊机器人，或直接填写数字用户 ID。', { name }),
  );
}

/** 精确命中优先，其次大小写不敏感；两者都只返回该层级的全部候选。 */
function matchBy(entries, needle, pick) {
  const exact = entries.filter((entry) => pick(entry) === needle);
  if (exact.length > 0) return exact;
  const loweredNeedle = lowered(needle);
  return entries.filter((entry) => lowered(pick(entry) ?? '') === loweredNeedle);
}

function resolveGroup(name, { groups }) {
  const candidates = groups
    .filter((group) => cleanString(group?.chatId) && cleanString(group?.name))
    .map((group) => ({ chatId: cleanString(group.chatId), name: cleanString(group.name) }));
  const hits = matchBy(candidates, name, (group) => group.name);
  if (hits.length === 1) return { chatId: hits[0].chatId };
  if (hits.length > 1) {
    throw ambiguousError('group', name, hits.map((group) => `${group.name} (${group.chatId})`));
  }
  throw unknownError('group', name);
}

function resolveUser(name, { people }) {
  const candidates = people
    .filter((person) => cleanString(person?.chatId))
    .map((person) => ({
      chatId: cleanString(person.chatId),
      account: cleanString(person.account),
      name: cleanString(person.name),
    }));
  // 账号名唯一性高于昵称：先按账号名找，找到就不再退到昵称（避免同一个人两种写法重名）。
  const byAccount = candidates.filter((person) => person.account);
  const accountHits = matchBy(byAccount, name, (person) => person.account);
  if (accountHits.length === 1) return { chatId: accountHits[0].chatId };
  if (accountHits.length > 1) {
    throw ambiguousError(
      'user',
      name,
      accountHits.map((person) => `${person.account} (${person.chatId})`),
    );
  }
  const named = candidates.filter((person) => person.name);
  const nameHits = matchBy(named, name, (person) => person.name);
  if (nameHits.length === 1) return { chatId: nameHits[0].chatId };
  if (nameHits.length > 1) {
    throw ambiguousError(
      'user',
      name,
      nameHits.map((person) => `${person.name} (${person.account ?? '无账号名'}, ${person.chatId})`),
    );
  }
  throw unknownError('user', name);
}

/**
 * 把投递目标里的 chatId 字段解析成权威 chatId。
 *
 * - 单聊填纯数字 → 就是用户 ID，直接使用；
 * - 群聊填 `{GUID}` → 就是群会话 ID，直接使用；
 * - 其余按名字解析（单聊：账号名 → 昵称；群聊：群名），命中唯一才返回。
 */
export function resolveYouduRoute(kind, chatId, targets = {}) {
  const raw = cleanString(chatId);
  if (!raw) {
    throw targetError(
      'empty',
      t('请填写有度投递目标：用户 ID、昵称、群 ID 或群名。'),
    );
  }
  const groups = targets.groups ?? [];
  const people = targets.people ?? [];
  if (kind === 'group') {
    // 群 ID 形态或已观察到的群 chatId 都是权威标识（历史数据里也有纯数字群 ID）。
    if (GROUP_ID_PATTERN.test(raw)) return { chatId: raw };
    if (groups.some((group) => cleanString(group?.chatId) === raw)) return { chatId: raw };
    return resolveGroup(raw, { groups });
  }
  if (kind === 'user') {
    if (USER_ID_PATTERN.test(raw)) return { chatId: raw };
    if (people.some((person) => cleanString(person?.chatId) === raw)) return { chatId: raw };
    return resolveUser(raw, { people });
  }
  throw targetError(
    'invalid-target',
    t('有度投递目标只支持私聊或群聊。'),
  );
}
