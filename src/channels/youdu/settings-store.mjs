import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  DEFAULT_CONTEXT_ENHANCEMENT_CONFIG,
  normalizeContextEnhancementConfig,
} from '../shared/context-enhancement.mjs';
import {
  normalizeAccessPolicy,
} from '../shared/access-policy.mjs';
import { validateAgentPresetId } from '../shared/agent-preset.mjs';

const EMPTY_DOCUMENT = Object.freeze({ version: 1, bots: Object.freeze({}) });

/**
 * 有度(Youdu) 轻量设置存储（文件持久化）：为每个已接入的 bot 保存
 * workspace / agentPreset / contextEnhancement / accessPolicy。
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
      contextEnhancement: DEFAULT_CONTEXT_ENHANCEMENT_CONFIG,
      accessPolicy: null,
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
            contextEnhancement: normalizeContextEnhancementConfig(value?.contextEnhancement),
            accessPolicy: normalizeAccessPolicy(value?.accessPolicy),
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

  contextEnhancementFor(botId) {
    return normalizeContextEnhancementConfig(this.ensure(botId).contextEnhancement);
  }

  accessPolicyFor(botId) {
    return this.ensure(botId).accessPolicy;
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

  async setContextEnhancement(botId, config) {
    const normalized = normalizeContextEnhancementConfig(config);
    this.ensure(botId).contextEnhancement = normalized;
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

  /** 给 controller.status() 的每个 bot 注入当前设置，供设置页展示。 */
  decorateStatus(status) {
    if (!status || typeof status !== 'object' || !Array.isArray(status.bots)) return status;
    return {
      ...status,
      bots: status.bots.map((bot) => (bot?.botId ? {
        ...bot,
        workspace: this.workspaceFor(bot.botId),
        agentPreset: this.agentPresetFor(bot.botId),
        contextEnhancement: this.contextEnhancementFor(bot.botId),
        accessPolicy: this.accessPolicyFor(bot.botId),
      } : bot)),
    };
  }

  #document() {
    const bots = {};
    for (const [botId, value] of this.#settings) {
      bots[botId] = {
        workspace: value.workspace,
        ...(value.agentPreset ? { agentPreset: value.agentPreset } : {}),
        ...(value.contextEnhancement ? { contextEnhancement: value.contextEnhancement } : {}),
        ...(value.accessPolicy ? { accessPolicy: value.accessPolicy } : {}),
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
