import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  DEFAULT_GROUP_HISTORY_CONFIG,
  normalizeGroupHistoryConfig,
} from '../shared/group-history.mjs';
import { normalizeGroupAccess } from './group-access.mjs';

const EMPTY_DOCUMENT = Object.freeze({ version: 1, bots: Object.freeze({}) });

/**
 * 有度(Youdu) 按群设置存储：只保存有度独有的 groupAccess / groupHistory。
 *
 * 其余每 bot 设置（workspace / agentPreset / model / alias / contextEnhancement /
 * accessPolicy）统一由共享 BotWorkspaceStore 保存，避免每个渠道各写一套。
 */
export class YouduGroupSettingsStore {
  #path;
  #bots = new Map();
  #writeQueue = Promise.resolve();

  constructor(path) {
    if (typeof path !== 'string' || !path) throw new TypeError('group settings store path is required');
    this.#path = path;
  }

  async load() {
    try {
      const document = JSON.parse(await readFile(this.#path, 'utf8'));
      const bots = document?.bots;
      if (document?.version === 1 && bots && typeof bots === 'object' && !Array.isArray(bots)) {
        for (const [botId, value] of Object.entries(bots)) {
          this.#bots.set(botId, {
            groupAccess: normalizeGroupAccess(value?.groupAccess),
            groupHistory: normalizeGroupHistoryConfig(value?.groupHistory),
          });
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return this;
  }

  has(botId) {
    return this.#bots.has(botId);
  }

  groupAccessFor(botId) {
    return this.#bots.get(botId)?.groupAccess ?? null;
  }

  groupHistoryFor(botId) {
    return normalizeGroupHistoryConfig(this.#bots.get(botId)?.groupHistory);
  }

  /** 写入按群访问设置；传 null/空文档表示恢复“全部沿用群聊访问设置”。 */
  async setGroupAccess(botId, groupAccess) {
    const normalized = groupAccess !== null && groupAccess !== undefined
      ? normalizeGroupAccess(groupAccess)
      : null;
    this.#ensure(botId).groupAccess = normalized;
    await this.#persist();
    return normalized;
  }

  async setGroupHistory(botId, config) {
    const normalized = normalizeGroupHistoryConfig(config ?? DEFAULT_GROUP_HISTORY_CONFIG);
    this.#ensure(botId).groupHistory = normalized;
    await this.#persist();
    return normalized;
  }

  /** bot 删除时清理其按群设置；没有记录时静默返回。 */
  async remove(botId) {
    if (!this.#bots.delete(botId)) return false;
    await this.#persist();
    return true;
  }

  #ensure(botId) {
    let value = this.#bots.get(botId);
    if (!value) {
      value = { groupAccess: null, groupHistory: DEFAULT_GROUP_HISTORY_CONFIG };
      this.#bots.set(botId, value);
    }
    return value;
  }

  #document() {
    const bots = {};
    for (const [botId, value] of this.#bots) {
      bots[botId] = {
        ...(value.groupAccess ? { groupAccess: value.groupAccess } : {}),
        ...(value.groupHistory ? { groupHistory: value.groupHistory } : {}),
      };
    }
    return { ...EMPTY_DOCUMENT, bots };
  }

  async #persist() {
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
