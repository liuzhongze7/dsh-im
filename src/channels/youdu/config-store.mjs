import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { t } from '../shared/i18n.mjs';

const EMPTY_DOCUMENT = Object.freeze({ version: 1, bots: Object.freeze([]) });

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeBotId(value) {
  const id = cleanString(value);
  return id && /^yd_[a-f0-9]{24}$/.test(id) ? id : null;
}

function safeSecretRef(value) {
  const ref = cleanString(value);
  return ref && /^DSH_YOUDU_SECRET_[A-F0-9]{24}$/.test(ref) ? ref : null;
}

/** 由有度 botId 派生稳定的内部 botId 与凭据引用。 */
export function deriveYouduBotIdentity(botId) {
  const raw = cleanString(botId);
  if (!raw) throw new TypeError('botId is required');
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 24);
  return {
    botId: `yd_${digest}`,
    secretRef: `DSH_YOUDU_SECRET_${digest.toUpperCase()}`,
  };
}

export function maskYouduBotId(botId) {
  const value = cleanString(botId) ?? '';
  if (value.length <= 10) return value ? `${value.slice(0, 3)}•••` : t('有度机器人');
  return `${value.slice(0, 6)}••••${value.slice(-4)}`;
}

function normalizeBot(value) {
  if (!value || typeof value !== 'object') return null;
  const botId = safeBotId(value.botId);
  const secretRef = safeSecretRef(value.secretRef);
  const wsHost = cleanString(value.wsHost);
  const ownerUserId = cleanString(value.ownerUserId);
  if (!botId || !secretRef || !wsHost) return null;
  return Object.freeze({
    botId,
    secretRef,
    wsHost,
    ownerUserId: ownerUserId ?? '*',
    createdAt: cleanString(value.createdAt) ?? new Date().toISOString(),
    connectedAt: cleanString(value.connectedAt),
  });
}

function normalizeDocument(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.bots)) return null;
  const bots = value.bots.map(normalizeBot);
  if (bots.some((bot) => bot === null)) return null;
  const ids = new Set();
  const refs = new Set();
  for (const bot of bots) {
    if (ids.has(bot.botId) || refs.has(bot.secretRef)) return null;
    ids.add(bot.botId);
    refs.add(bot.secretRef);
  }
  return Object.freeze({ version: 1, bots: Object.freeze(bots) });
}

export class YouduConfigStore {
  #path;
  #value = EMPTY_DOCUMENT;
  #writeQueue = Promise.resolve();

  constructor(path) {
    this.#path = path;
  }

  async load() {
    try {
      const normalized = normalizeDocument(JSON.parse(await readFile(this.#path, 'utf8')));
      if (!normalized) throw new Error('dsh-im Youdu config contains invalid bot data');
      this.#value = normalized;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#value = EMPTY_DOCUMENT;
    }
    return this;
  }

  list() {
    return structuredClone(this.#value.bots);
  }

  get(botId) {
    const bot = this.#value.bots.find((candidate) => candidate.botId === botId);
    return bot ? structuredClone(bot) : null;
  }

  async save(value) {
    const normalized = normalizeBot(value);
    if (!normalized) throw new Error('Refusing to persist incomplete Youdu bot data');
    return this.#mutate((bots) => {
      const refCollision = bots.find(
        (bot) => bot.secretRef === normalized.secretRef && bot.botId !== normalized.botId,
      );
      if (refCollision) throw new Error('Duplicate Youdu bot identity');
      const index = bots.findIndex((bot) => bot.botId === normalized.botId);
      if (index === -1) bots.push(normalized);
      else bots[index] = normalized;
      return structuredClone(normalized);
    });
  }

  async remove(botId) {
    if (!safeBotId(botId)) throw new TypeError('Invalid Youdu bot id');
    return this.#mutate((bots) => {
      const index = bots.findIndex((bot) => bot.botId === botId);
      if (index === -1) return null;
      const [removed] = bots.splice(index, 1);
      return structuredClone(removed);
    });
  }

  async clear() {
    const operation = this.#writeQueue.then(async () => {
      try {
        await unlink(this.#path);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      this.#value = EMPTY_DOCUMENT;
    });
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    await operation;
  }

  async #mutate(mutator) {
    let result;
    const operation = this.#writeQueue.then(async () => {
      const bots = [...this.#value.bots];
      result = mutator(bots);
      const document = Object.freeze({ version: 1, bots: Object.freeze(bots) });
      await this.#write(document);
      this.#value = document;
    });
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }

  async #write(document) {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, this.#path);
  }
}
