import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const TARGET_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_NAME_LENGTH = 80;
const MAX_CONVERSATION_KEY_LENGTH = 1_024;

function storeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function targetIdOf(value) {
  if (typeof value !== 'string' || !TARGET_ID_PATTERN.test(value)) {
    throw storeError('invalid-target', 'Invalid target id');
  }
  return value;
}

function conversationKeyOf(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_CONVERSATION_KEY_LENGTH
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw storeError('invalid-target', 'Invalid private conversation key');
  }
  return value;
}

function jsonRecord(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw storeError('invalid-target', message);
  }
  try {
    const parsed = JSON.parse(JSON.stringify(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('not a record');
    return parsed;
  } catch {
    throw storeError('invalid-target', message);
  }
}

/**
 * Validate one stored/public delivery target. Mirrors the shared workspace
 * store so the DeliveryService adapter sees identical shapes and error codes.
 */
export function normalizeYouduDeliveryTarget(value, { targetId, allowSessionSync = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw storeError('invalid-target', 'Invalid delivery target');
  }
  const allowed = targetId === undefined
    ? new Set(['targetId', 'name', 'kind', 'route', ...(allowSessionSync ? ['sessionSync'] : [])])
    : new Set(['name', 'kind', 'route', ...(allowSessionSync ? ['sessionSync'] : [])]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw storeError('invalid-target', 'Invalid delivery target');
  }
  const id = targetIdOf(targetId ?? value.targetId);
  if (typeof value.kind !== 'string' || !KIND_PATTERN.test(value.kind)) {
    throw storeError('invalid-target', 'Invalid target kind');
  }
  let name;
  if (value.name !== undefined) {
    if (typeof value.name !== 'string' || !value.name.trim()
      || value.name.trim().length > MAX_NAME_LENGTH) {
      throw storeError('invalid-target', 'Invalid target name');
    }
    name = value.name.trim();
  }
  let sessionSync;
  if (value.sessionSync !== undefined) {
    if (!allowSessionSync || !value.sessionSync || typeof value.sessionSync !== 'object'
      || Array.isArray(value.sessionSync)) {
      throw storeError('invalid-target', 'Invalid session sync');
    }
    if (Object.keys(value.sessionSync).some((key) => key !== 'conversationKey')) {
      throw storeError('invalid-target', 'Invalid session sync');
    }
    sessionSync = { conversationKey: conversationKeyOf(value.sessionSync.conversationKey) };
  }
  return {
    targetId: id,
    ...(name === undefined ? {} : { name }),
    kind: value.kind,
    route: jsonRecord(value.route, 'Invalid target route'),
    ...(sessionSync === undefined ? {} : { sessionSync }),
  };
}

function publicTarget(target, { targetId }) {
  const normalized = normalizeYouduDeliveryTarget(target, { targetId, allowSessionSync: true });
  const { sessionSync: _sessionSync, ...rest } = normalized;
  return rest;
}

function normalizeDocument(value, knownBotIds) {
  const bots = {};
  const source = value?.bots;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { bots };
  for (const [botId, targets] of Object.entries(source)) {
    if (typeof botId !== 'string' || !botId) continue;
    if (knownBotIds && !knownBotIds.includes(botId)) continue;
    if (!targets || typeof targets !== 'object' || Array.isArray(targets)) continue;
    const entries = {};
    for (const [targetId, target] of Object.entries(targets)) {
      try {
        const normalized = normalizeYouduDeliveryTarget(target, { targetId, allowSessionSync: true });
        const { targetId: _id, ...stored } = normalized;
        entries[targetId] = stored;
      } catch {
        // 损坏的条目在加载时丢弃，避免整份投递配置失效。
      }
    }
    if (Object.keys(entries).length > 0) bots[botId] = entries;
  }
  return { bots };
}

/**
 * 有度渠道的投递目标存储（每个 bot 一份），实现 DeliveryService 适配器需要的
 * 那一组 workspace 方法。bot 是否存在由 configStore 提供，避免两份 bot 列表。
 */
export class YouduDeliveryStore {
  #path;
  #knownBotIds;
  #bots = {};
  #writeQueue = Promise.resolve();

  constructor(path, { knownBotIds = () => [] } = {}) {
    if (typeof path !== 'string' || !path) throw new TypeError('delivery store path is required');
    if (typeof knownBotIds !== 'function') throw new TypeError('knownBotIds must be a function');
    this.#path = path;
    this.#knownBotIds = knownBotIds;
  }

  async load() {
    try {
      this.#bots = normalizeDocument(JSON.parse(await readFile(this.#path, 'utf8')), this.#knownBotIds()).bots;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#bots = {};
    }
    return this;
  }

  has(botId) {
    return typeof botId === 'string' && this.#knownBotIds().includes(botId);
  }

  listBotIds() {
    return [...this.#knownBotIds()].sort();
  }

  listDeliveryTargets(botId) {
    const id = this.#assertBot(botId);
    return Object.entries(this.#bots[id] ?? {})
      .map(([targetId, target]) => publicTarget(target, { targetId }))
      .sort((left, right) => left.targetId.localeCompare(right.targetId));
  }

  deliveryTargetFor(botId, targetId) {
    const id = this.#assertBot(botId);
    const targetKey = targetIdOf(targetId);
    const target = this.#bots[id]?.[targetKey];
    return target ? publicTarget(target, { targetId: targetKey }) : null;
  }

  listSessionSyncTargets() {
    const targets = [];
    for (const [botId, entries] of Object.entries(this.#bots)) {
      if (!this.has(botId)) continue;
      for (const [targetId, target] of Object.entries(entries)) {
        const normalized = normalizeYouduDeliveryTarget(target, { targetId, allowSessionSync: true });
        if (!normalized.sessionSync) continue;
        targets.push({
          botId,
          targetId,
          conversationKey: normalized.sessionSync.conversationKey,
        });
      }
    }
    return targets.sort((left, right) => (
      left.botId.localeCompare(right.botId) || left.targetId.localeCompare(right.targetId)
    ));
  }

  async createDeliveryTarget(botId, value) {
    const id = this.#assertBot(botId);
    const target = normalizeYouduDeliveryTarget(value);
    if (Object.hasOwn(this.#bots[id] ?? {}, target.targetId)) {
      throw storeError('target-conflict', 'Target already exists');
    }
    const { targetId, ...stored } = target;
    await this.#commit({ ...this.#bots, [id]: { ...(this.#bots[id] ?? {}), [targetId]: stored } });
    return publicTarget(stored, { targetId });
  }

  async updateDeliveryTarget(botId, targetId, value) {
    const id = this.#assertBot(botId);
    const targetKey = targetIdOf(targetId);
    const replacement = normalizeYouduDeliveryTarget(value, { targetId: targetKey });
    const previous = this.#bots[id]?.[targetKey];
    if (!previous) throw storeError('unknown-target', 'Unknown target');
    const { targetId: _targetId, ...stored } = replacement;
    const sameRoute = JSON.stringify(previous.route) === JSON.stringify(stored.route)
      && previous.kind === stored.kind;
    const nextStored = previous.sessionSync && sameRoute
      ? { ...stored, sessionSync: previous.sessionSync }
      : stored;
    await this.#commit({ ...this.#bots, [id]: { ...this.#bots[id], [targetKey]: nextStored } });
    return publicTarget(nextStored, { targetId: targetKey });
  }

  async deleteDeliveryTarget(botId, targetId) {
    const id = this.#assertBot(botId);
    const targetKey = targetIdOf(targetId);
    if (!Object.hasOwn(this.#bots[id] ?? {}, targetKey)) {
      throw storeError('unknown-target', 'Unknown target');
    }
    const entries = { ...this.#bots[id] };
    delete entries[targetKey];
    const next = { ...this.#bots };
    if (Object.keys(entries).length > 0) next[id] = entries;
    else delete next[id];
    await this.#commit(next);
    return true;
  }

  async setDeliveryTargetSessionSync(botId, targetId, conversationKeyOrNull) {
    const id = this.#assertBot(botId);
    const targetKey = targetIdOf(targetId);
    const conversationKey = conversationKeyOrNull === null
      ? null
      : conversationKeyOf(conversationKeyOrNull);
    const previous = this.#bots[id]?.[targetKey];
    if (!previous) throw storeError('unknown-target', 'Unknown target');
    if ((previous.sessionSync?.conversationKey ?? null) === conversationKey) {
      return conversationKey !== null;
    }
    const nextStored = { ...previous };
    if (conversationKey === null) delete nextStored.sessionSync;
    else nextStored.sessionSync = { conversationKey };
    await this.#commit({ ...this.#bots, [id]: { ...this.#bots[id], [targetKey]: nextStored } });
    return conversationKey !== null;
  }

  /** 删除 bot 时清理它的投递目标。 */
  async remove(botId) {
    if (!Object.hasOwn(this.#bots, botId)) return false;
    const next = { ...this.#bots };
    delete next[botId];
    await this.#commit(next);
    return true;
  }

  #assertBot(botId) {
    if (typeof botId !== 'string' || !botId) throw storeError('invalid-target', 'Invalid bot id');
    if (!this.has(botId)) throw storeError('unknown-bot', 'Unknown bot');
    return botId;
  }

  #document() {
    const bots = {};
    for (const [botId, entries] of Object.entries(this.#bots)) {
      if (Object.keys(entries).length === 0) continue;
      bots[botId] = entries;
    }
    return { version: 1, bots };
  }

  async #commit(bots) {
    this.#bots = bots;
    const snapshot = `${JSON.stringify(this.#document(), null, 2)}\n`;
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
