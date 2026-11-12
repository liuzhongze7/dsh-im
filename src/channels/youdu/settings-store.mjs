import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  DEFAULT_CONTEXT_ENHANCEMENT_CONFIG,
  normalizeContextEnhancementConfig,
} from '../shared/context-enhancement.mjs';
import {
  DEFAULT_GROUP_HISTORY_CONFIG,
  normalizeGroupHistoryConfig,
} from '../shared/group-history.mjs';
import {
  normalizeAccessPolicy,
} from '../shared/access-policy.mjs';
import { validateAgentPresetId } from '../shared/agent-preset.mjs';
import { validateBotAlias, withBotAlias } from '../shared/bot-alias.mjs';
import {
  normalizeModelSelection,
  validateModelSelection,
} from '../shared/model-setting.mjs';
import { normalizeGroupAccess } from './group-access.mjs';

const EMPTY_DOCUMENT = Object.freeze({ version: 1, bots: Object.freeze({}) });

/** 别名来自磁盘时不可信：非法值一律按"未设置"处理，避免整份设置读不出来。 */
function storedAlias(value) {
  try {
    return validateBotAlias(value);
  } catch {
    return '';
  }
}

/** 别名：非空时把显示名换成别名，并保留原名（withBotAlias 负责语义）。 */
function withAlias(bot, alias) {
  return alias && bot ? withBotAlias(bot, alias) : bot;
}

/**
 * 有度(Youdu) 轻量设置存储（文件持久化）：为每个已接入的 bot 保存
 * workspace / agentPreset / model / alias / contextEnhancement / groupHistory /
 * accessPolicy / groupAccess。
 *
 * 这是 youdu 专属持久化（非 bot-workspace-store 完整接线），设置页的 set*
 * 端点写入会在下次读取/重启后保留；bridge/runtime 从这里读取，改动即时生效。
 */
export class YouduSettingsStore {
  #path;
  #defaults;
  #settings = new Map();
  #writeQueue = Promise.resolve();

  constructor(path, { defaultWorkspace = process.cwd(), defaultAgentPreset = null } = {}) {
    if (typeof path !== 'string' || !path) throw new TypeError('settings store path is required');
    this.#path = path;
    this.#defaults = {
      workspace: resolve(defaultWorkspace),
      agentPreset: validateAgentPresetId(defaultAgentPreset),
      model: null,
      alias: '',
      contextEnhancement: DEFAULT_CONTEXT_ENHANCEMENT_CONFIG,
      groupHistory: DEFAULT_GROUP_HISTORY_CONFIG,
      accessPolicy: null,
      groupAccess: null,
    };
  }

  async load() {
    try {
      const document = JSON.parse(await readFile(this.#path, 'utf8'));
      const bots = document?.bots;
      if (document?.version === 1 && bots && typeof bots === 'object' && !Array.isArray(bots)) {
        for (const [botId, value] of Object.entries(bots)) {
          this.#settings.set(botId, {
            workspace: typeof value?.workspace === 'string'
              ? resolve(value.workspace)
              : this.#defaults.workspace,
            agentPreset: validateAgentPresetId(value?.agentPreset),
            model: normalizeModelSelection(value?.model),
            alias: storedAlias(value?.alias),
            contextEnhancement: normalizeContextEnhancementConfig(value?.contextEnhancement),
            groupHistory: normalizeGroupHistoryConfig(value?.groupHistory),
            accessPolicy: normalizeAccessPolicy(value?.accessPolicy),
            groupAccess: normalizeGroupAccess(value?.groupAccess),
          });
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return this;
  }

  ensure(botId) {
    if (!this.#settings.has(botId)) {
      this.#settings.set(botId, { ...this.#defaults });
    }
    return this.#settings.get(botId);
  }

  workspaceFor(botId) {
    return this.ensure(botId).workspace;
  }

  agentPresetFor(botId) {
    return this.ensure(botId).agentPreset;
  }

  modelFor(botId) {
    const model = this.ensure(botId).model;
    return model ? { ...model } : null;
  }

  /** 显示别名；空字符串表示沿用原名。 */
  aliasFor(botId) {
    return this.ensure(botId).alias;
  }

  contextEnhancementFor(botId) {
    return normalizeContextEnhancementConfig(this.ensure(botId).contextEnhancement);
  }

  groupHistoryFor(botId) {
    return normalizeGroupHistoryConfig(this.ensure(botId).groupHistory);
  }

  accessPolicyFor(botId) {
    return this.ensure(botId).accessPolicy;
  }

  groupAccessFor(botId) {
    return this.ensure(botId).groupAccess;
  }

  async setWorkspace(botId, workspace) {
    this.ensure(botId).workspace = resolve(workspace);
    await this.#persist();
    return this.workspaceFor(botId);
  }

  async setAgentPreset(botId, value) {
    const agentPreset = validateAgentPresetId(value);
    this.ensure(botId).agentPreset = agentPreset;
    await this.#persist();
    return agentPreset;
  }

  /** 写入每 bot 模型；null/空表示跟随默认模型。 */
  async setModel(botId, value) {
    const model = validateModelSelection(value);
    this.ensure(botId).model = model;
    await this.#persist();
    return this.modelFor(botId);
  }

  /** 写入显示别名；空字符串表示恢复原名。 */
  async setAlias(botId, value) {
    const alias = validateBotAlias(value);
    this.ensure(botId).alias = alias;
    await this.#persist();
    return alias;
  }

  async setContextEnhancement(botId, config) {
    const normalized = normalizeContextEnhancementConfig(config);
    this.ensure(botId).contextEnhancement = normalized;
    await this.#persist();
    return normalized;
  }

  async setGroupHistory(botId, config) {
    const normalized = normalizeGroupHistoryConfig(config);
    this.ensure(botId).groupHistory = normalized;
    await this.#persist();
    return normalized;
  }

  async setAccessPolicy(botId, policy) {
    const normalized = policy !== null && policy !== undefined
      ? normalizeAccessPolicy(policy)
      : null;
    this.ensure(botId).accessPolicy = normalized;
    await this.#persist();
    return normalized;
  }

  /** 写入按群访问设置；传 null/空文档表示恢复“全部沿用群聊访问设置”。 */
  async setGroupAccess(botId, groupAccess) {
    const normalized = groupAccess !== null && groupAccess !== undefined
      ? normalizeGroupAccess(groupAccess)
      : null;
    this.ensure(botId).groupAccess = normalized;
    await this.#persist();
    return normalized;
  }

  /** 给 controller.status() 的每个 bot 注入当前设置，供设置页展示。 */
  decorateStatus(status) {
    if (!status || typeof status !== 'object' || !Array.isArray(status.bots)) return status;
    return {
      ...status,
      bots: status.bots.map((bot) => {
        if (!bot?.botId) return bot;
        const alias = this.aliasFor(bot.botId);
        return {
          ...bot,
          ...(alias ? { bot: withAlias(bot.bot, alias) } : {}),
          workspace: this.workspaceFor(bot.botId),
          agentPreset: this.agentPresetFor(bot.botId),
          model: this.modelFor(bot.botId),
          contextEnhancement: this.contextEnhancementFor(bot.botId),
          groupHistory: this.groupHistoryFor(bot.botId),
          accessPolicy: this.accessPolicyFor(bot.botId),
          groupAccess: this.groupAccessFor(bot.botId),
        };
      }),
    };
  }

  #document() {
    const bots = {};
    for (const [botId, value] of this.#settings) {
      bots[botId] = {
        workspace: value.workspace,
        ...(value.agentPreset ? { agentPreset: value.agentPreset } : {}),
        ...(value.model ? { model: value.model } : {}),
        ...(value.alias ? { alias: value.alias } : {}),
        ...(value.contextEnhancement ? { contextEnhancement: value.contextEnhancement } : {}),
        ...(value.groupHistory ? { groupHistory: value.groupHistory } : {}),
        ...(value.accessPolicy ? { accessPolicy: value.accessPolicy } : {}),
        ...(value.groupAccess ? { groupAccess: value.groupAccess } : {}),
      };
    }
    return { version: 1, bots };
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
