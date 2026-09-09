import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY_STATE = Object.freeze({ version: 1, sessions: {}, seenMessageIds: [], groups: {} });
const MAX_GROUPS = 200;
/** Persist at most one lastSeenAt update per group per hour. */
const GROUP_TOUCH_INTERVAL_MS = 3_600_000;

function normalizeGroups(value) {
  const groups = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return groups;
  for (const [chatId, entry] of Object.entries(value)) {
    if (typeof chatId !== 'string' || !chatId.trim()) continue;
    const lastSeenAt = typeof entry?.lastSeenAt === 'string' ? entry.lastSeenAt : null;
    const messages = Number.isSafeInteger(entry?.messages) && entry.messages > 0
      ? entry.messages
      : 0;
    groups[chatId] = { lastSeenAt, messages };
  }
  return groups;
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
   */
  async recordGroup(chatId, { now = () => new Date() } = {}) {
    const id = typeof chatId === 'string' ? chatId.trim() : '';
    if (!id) return null;
    const existing = this.#state.groups[id];
    const seenAt = now();
    const messages = (existing?.messages ?? 0) + 1;
    const previous = existing?.lastSeenAt ? Date.parse(existing.lastSeenAt) : Number.NaN;
    const fresh = !Number.isFinite(previous) || seenAt.getTime() - previous >= GROUP_TOUCH_INTERVAL_MS;
    this.#state.groups[id] = {
      lastSeenAt: fresh ? seenAt.toISOString() : existing.lastSeenAt,
      messages,
    };
    if (fresh) {
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

  /** Observed groups, most recently active first. */
  groupsSnapshot() {
    return Object.entries(this.#state.groups)
      .map(([chatId, entry]) => ({
        chatId,
        lastSeenAt: entry.lastSeenAt,
        messages: entry.messages ?? 0,
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
