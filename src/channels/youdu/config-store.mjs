import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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
  const sourceBotId = cleanString(value.sourceBotId);
  const wsHost = cleanString(value.wsHost);
  const ownerUserId = cleanString(value.ownerUserId);
  if (!botId || !secretRef || !sourceBotId || !wsHost) return null;
  const derived = deriveYouduBotIdentity(sourceBotId);
  if (derived.botId !== botId || derived.secretRef !== secretRef) return null;
  return Object.freeze({
    botId,
    secretRef,
    sourceBotId,
    wsHost,
    ownerUserId: ownerUserId ?? '*',
    createdAt: cleanString(value.createdAt) ?? new Date().toISOString(),
    connectedAt: cleanString(value.connectedAt),
  });
}

/**
 * 逐条保留能解析的机器人，坏条目只跳过不拖垮整份配置。
 * 有度是多机器人渠道，一条手改坏的记录不应该让其余机器人全部掉线。
 */
function keepValidBots(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.bots)) {
    return { bots: [], rejected: Array.isArray(value?.bots) ? value.bots.length : 0 };
  }
  const bots = [];
  const ids = new Set();
  const refs = new Set();
  let rejected = 0;
  for (const entry of value.bots) {
    const bot = normalizeBot(entry);
    if (!bot || ids.has(bot.botId) || refs.has(bot.secretRef)) {
      rejected += 1;
      continue;
    }
    ids.add(bot.botId);
    refs.add(bot.secretRef);
    bots.push(bot);
  }
  return { bots, rejected };
}

export class YouduConfigStore {
  #path;
  #logger;
  #value = EMPTY_DOCUMENT;
  #writeQueue = Promise.resolve();

  constructor(path, { logger = console } = {}) {
    this.#path = path;
    this.#logger = logger;
  }

  async load() {
    let raw;
    try {
      raw = JSON.parse(await readFile(this.#path, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#value = EMPTY_DOCUMENT;
        return this;
      }
      await this.#quarantine(error);
      this.#value = EMPTY_DOCUMENT;
      return this;
    }
    const { bots, rejected } = keepValidBots(raw);
    if (rejected > 0) {
      await this.#quarantine(new Error(`${rejected} invalid bot ${rejected === 1 ? 'entry' : 'entries'}`));
    }
    this.#value = Object.freeze({ version: 1, bots: Object.freeze(bots) });
    return this;
  }

  /**
   * 把读不懂的配置整份留档后继续启动：备份失败也不阻断，只记日志。
   * 备份文件名固定为 `<config>.invalid`，避免反复启动时堆出一堆副本。
   */
  async #quarantine(reason) {
    const backup = `${this.#path}.invalid`;
    const detail = reason?.message ?? String(reason);
    try {
      await copyFile(this.#path, backup);
      this.#logger.warn?.(`[dsh-im:youdu] ignoring part of the bot config (${detail}); the original is kept at ${backup}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#logger.error?.(`[dsh-im:youdu] could not back up the bot config after ${detail}: ${error?.message}`);
      }
    }
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
