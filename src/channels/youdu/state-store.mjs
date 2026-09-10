import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY_STATE = Object.freeze({
  version: 1, sessions: {}, seenMessageIds: [], groups: {}, people: {}, titles: {},
});
const MAX_GROUPS = 200;
const MAX_PEOPLE = 200;
const MAX_TITLES = 200;
/** Persist at most one lastSeenAt update per conversation per hour. */
const GROUP_TOUCH_INTERVAL_MS = 3_600_000;

function text(value, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function normalizeGroups(value) {
  const groups = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return groups;
  for (const [chatId, entry] of Object.entries(value)) {
    if (typeof chatId !== 'string' || !chatId.trim()) continue;
    const lastSeenAt = typeof entry?.lastSeenAt === 'string' ? entry.lastSeenAt : null;
    const messages = Number.isSafeInteger(entry?.messages) && entry.messages > 0
      ? entry.messages
      : 0;
    groups[chatId] = { lastSeenAt, messages, name: text(entry?.name, 128) };
  }
  return groups;
}

/**
 * 会话标题（群名）。有度的消息回调不带群名，只有 session_create / session_update
 * 这类会话事件带 title，因此先按 sessionId 存下来，等消息或列表用到时再取。
 */
function normalizeTitles(value) {
  const titles = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return titles;
  for (const [sessionId, title] of Object.entries(value)) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) continue;
    const clean = text(title, 128);
    if (clean) titles[sessionId] = clean;
  }
  return titles;
}

/**
 * 私聊联系人（key = chatId，有度单聊里就是对方用户 ID）。
 * 用来给投递目标建议补上可读名字，并在设置页展示。
 */
function normalizePeople(value) {
  const people = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return people;
  for (const [chatId, entry] of Object.entries(value)) {
    if (typeof chatId !== 'string' || !chatId.trim()) continue;
    const account = text(entry?.account, 128);
    const name = text(entry?.name, 128);
    const lastSeenAt = typeof entry?.lastSeenAt === 'string' ? entry.lastSeenAt : null;
    people[chatId] = { account, name, lastSeenAt };
  }
  return people;
}

function normalizeState(value) {
  if (!value || typeof value !== 'object') return structuredClone(EMPTY_STATE);
  const sessions = {};
  if (value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)) {
    for (const [key, sessionId] of Object.entries(value.sessions)) {
      if (typeof key === 'string' && typeof sessionId === 'string' && sessionId) {
        sessions[key] = sessionId;
      }
    }
  }
  return {
    version: 1,
    sessions,
    seenMessageIds: Array.isArray(value.seenMessageIds)
      ? value.seenMessageIds.filter((id) => typeof id === 'string').slice(-1_000)
      : [],
    groups: normalizeGroups(value.groups),
    people: normalizePeople(value.people),
    titles: normalizeTitles(value.titles),
  };
}

export class YouduStateStore {
  #path;
  #state = structuredClone(EMPTY_STATE);
  #writeQueue = Promise.resolve();

  constructor(path) {
    this.#path = path;
  }

  async load() {
    try {
      this.#state = normalizeState(JSON.parse(await readFile(this.#path, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#state = structuredClone(EMPTY_STATE);
      await this.#persist();
    }
    return this;
  }

  sessionFor(key) {
    return this.#state.sessions[key] ?? null;
  }

  async setSession(key, sessionId) {
    this.#state.sessions[key] = sessionId;
    await this.#persist();
  }

  async clearSession(key) {
    delete this.#state.sessions[key];
    await this.#persist();
  }

  async clearSessions() {
    this.#state.sessions = {};
    await this.#persist();
  }

  hasSeen(messageId) {
    return this.#state.seenMessageIds.includes(messageId);
  }

  async markSeen(messageId) {
    if (this.hasSeen(messageId)) return;
    this.#state.seenMessageIds.push(messageId);
    if (this.#state.seenMessageIds.length > 1_000) {
      this.#state.seenMessageIds.splice(0, this.#state.seenMessageIds.length - 1_000);
    }
    await this.#persist();
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  /**
   * Remember a group the bot has seen so the settings page can offer it.
   * Message counters update in memory on every hit; `lastSeenAt` is persisted
   * at most once per hour per group to keep the state file write rate low.
   * 群名来自会话事件（见 recordSessionTitle）或消息帧里带的 chatName，取不到就留空。
   */
  async recordGroup(chatId, { name, now = () => new Date() } = {}) {
    const id = typeof chatId === 'string' ? chatId.trim() : '';
    if (!id) return null;
    const existing = this.#state.groups[id];
    const seenAt = now();
    const messages = (existing?.messages ?? 0) + 1;
    const nextName = text(name, 128) ?? existing?.name ?? this.#state.titles[id] ?? null;
    const previous = existing?.lastSeenAt ? Date.parse(existing.lastSeenAt) : Number.NaN;
    const fresh = !Number.isFinite(previous) || seenAt.getTime() - previous >= GROUP_TOUCH_INTERVAL_MS;
    const renamed = nextName !== null && existing?.name !== nextName;
    this.#state.groups[id] = {
      lastSeenAt: fresh ? seenAt.toISOString() : existing.lastSeenAt,
      messages,
      name: nextName,
    };
    if (fresh || renamed) {
      const entries = Object.entries(this.#state.groups);
      if (entries.length > MAX_GROUPS) {
        entries.sort((left, right) => (Date.parse(right[1].lastSeenAt ?? 0) || 0)
          - (Date.parse(left[1].lastSeenAt ?? 0) || 0));
        this.#state.groups = Object.fromEntries(entries.slice(0, MAX_GROUPS));
      }
      await this.#persist();
    }
    return structuredClone(this.#state.groups[id]);
  }

  /**
   * 记住一个会话的标题（有度会话事件里的 title，群聊就是群名）。
   * 会话 id 与群聊消息的 chatId 同源，因此已观察到的群记录会一并补上名字。
   */
  async recordSessionTitle(sessionId, title) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    const clean = text(title, 128);
    if (!id || !clean || this.#state.titles[id] === clean) return false;
    this.#state.titles[id] = clean;
    const entries = Object.entries(this.#state.titles);
    if (entries.length > MAX_TITLES) {
      this.#state.titles = Object.fromEntries(entries.slice(-MAX_TITLES));
    }
    const group = this.#state.groups[id];
    if (group) group.name = clean;
    await this.#persist();
    return true;
  }

  /** Observed groups, most recently active first. */
  groupsSnapshot() {
    return Object.entries(this.#state.groups)
      .map(([chatId, entry]) => ({
        chatId,
        name: entry.name ?? this.#state.titles[chatId] ?? null,
        lastSeenAt: entry.lastSeenAt,
        messages: entry.messages ?? 0,
      }))
      .sort((left, right) => (Date.parse(right.lastSeenAt ?? 0) || 0)
        - (Date.parse(left.lastSeenAt ?? 0) || 0));
  }

  /**
   * 记住一个私聊联系人。有度单聊的 chatId 就是对方用户 ID，因此这条记录同时
   * 提供了「主动投递目标」和它的可读名字（账号名 / 昵称）。
   */
  async recordPerson(chatId, { account, name, now = () => new Date() } = {}) {
    const id = typeof chatId === 'string' ? chatId.trim() : '';
    if (!id) return null;
    const existing = this.#state.people[id];
    const seenAt = now();
    const nextAccount = text(account, 128) ?? existing?.account ?? null;
    const nextName = text(name, 128) ?? existing?.name ?? null;
    const previous = existing?.lastSeenAt ? Date.parse(existing.lastSeenAt) : Number.NaN;
    const fresh = !Number.isFinite(previous) || seenAt.getTime() - previous >= GROUP_TOUCH_INTERVAL_MS;
    const changed = !existing || existing.account !== nextAccount || existing.name !== nextName;
    this.#state.people[id] = {
      account: nextAccount,
      name: nextName,
      lastSeenAt: fresh || changed ? seenAt.toISOString() : existing.lastSeenAt,
    };
    if (fresh || changed) {
      const entries = Object.entries(this.#state.people);
      if (entries.length > MAX_PEOPLE) {
        entries.sort((left, right) => (Date.parse(right[1].lastSeenAt ?? 0) || 0)
          - (Date.parse(left[1].lastSeenAt ?? 0) || 0));
        this.#state.people = Object.fromEntries(entries.slice(0, MAX_PEOPLE));
      }
      await this.#persist();
    }
    return structuredClone(this.#state.people[id]);
  }

  /** Observed private contacts, most recently active first. */
  peopleSnapshot() {
    return Object.entries(this.#state.people)
      .map(([chatId, entry]) => ({
        chatId,
        account: entry.account ?? null,
        name: entry.name ?? null,
        lastSeenAt: entry.lastSeenAt,
      }))
      .sort((left, right) => (Date.parse(right.lastSeenAt ?? 0) || 0)
        - (Date.parse(left.lastSeenAt ?? 0) || 0));
  }

  async remove() {
    try {
      await unlink(this.#path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.#state = structuredClone(EMPTY_STATE);
  }

  async #persist() {
    const snapshot = `${JSON.stringify(this.#state, null, 2)}\n`;
    const operation = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.tmp`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.#path);
    });
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    await operation;
  }
}
