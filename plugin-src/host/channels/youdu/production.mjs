import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { YouduConfigStore } from '../../../../src/channels/youdu/config-store.mjs';
import { YouduHarnessClient } from '../../../../src/channels/youdu/harness-client.mjs';
import { YouduController } from '../../../../src/channels/youdu/youdu-controller.mjs';
import { YouduRuntime } from '../../../../src/channels/youdu/youdu-runtime.mjs';
import { YouduStateStore } from '../../../../src/channels/youdu/state-store.mjs';
import { YouduSettingsStore } from '../../../../src/channels/youdu/settings-store.mjs';
import {
  createAccessPolicy,
  createAccessPolicyScope,
} from '../../../../src/channels/shared/access-policy.mjs';
import {
  normalizeContextEnhancementConfig,
} from '../../../../src/channels/shared/context-enhancement.mjs';
import { createConnectionSupervisor } from './connection-supervisor.mjs';
import { harnessConnection } from '../../harness-connection.mjs';

/** 从设置存储读取访问策略；未配置时：owner='*'（未配置）→ 命令开放，配置了具体 owner → 仅该 owner 可执行命令。 */
function createYouduAccessPolicy(settingsStore, botId, botConfig, groupResponseMode = 'all') {
  const ownerUserId = typeof botConfig.ownerUserId === 'string' ? botConfig.ownerUserId.trim() : '';
  const ownerReal = Boolean(ownerUserId && ownerUserId !== '*');
  const ownerUsers = ownerReal ? [{ id: ownerUserId, canExecuteCommands: true }] : [];
  // 闭合默认（接受的既有安全姿态）：owner 未配置时命令默认拒绝；配置了具体 owner 时命令仅该 owner 可执行。
  const defaultCanExecuteCommands = false;
  const closedScope = createAccessPolicyScope({
    mode: 'open',
    open: {
      defaultCanExecuteCommands,
      commandPermissionOverrides: ownerUsers,
    },
    allowlist: { users: ownerUsers },
  });
  return Object.freeze({
    botId,
    groupResponseMode,
    getSettings: () => settingsStore.accessPolicyFor(botId)
      ?? createAccessPolicy({ direct: closedScope, group: closedScope }),
    isPrivileged(senderIds, conversationType) {
      if (!['direct', 'group'].includes(conversationType)) return false;
      if (!ownerReal) return false;
      const candidates = Array.isArray(senderIds) ? senderIds : [senderIds];
      return candidates.some((senderId) => String(senderId) === ownerUserId);
    },
  });
}

function createYouduContextEnhancement(settingsStore, botId) {
  return {
    botId,
    getSettings: () => normalizeContextEnhancementConfig(
      settingsStore.contextEnhancementFor(botId),
    ),
  };
}

function pluginPaths(config) {
  const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  const root = resolve(config.dataDir ?? join(dshHome, 'integrations', 'dsh-youdu'));
  return {
    config: resolve(config.configPath ?? join(root, 'config.json')),
    bots: resolve(config.botsDir ?? join(root, 'bots')),
  };
}

export async function createProductionController(ctx, config = {}, internals = {}) {
  let log;
  try { log = typeof ctx.logger === 'function' ? ctx.logger('dsh-im:youdu') : (ctx.logger ?? console); }
  catch { log = console; }
  log.info('[dsh-im-youdu] createProductionController entered; DSH_HOME=', process.env.DSH_HOME, 'dataDir=', config.dataDir);
  if (!ctx?.credentials) throw new TypeError('dsh-im Youdu requires ctx.credentials');
  const connection = harnessConnection(ctx, config);

  const ConfigStore = internals.ConfigStore ?? YouduConfigStore;
  const StateStore = internals.StateStore ?? YouduStateStore;
  const Harness = internals.HarnessClient ?? YouduHarnessClient;
  const Controller = internals.Controller ?? YouduController;
  const Runtime = internals.Runtime ?? YouduRuntime;
  const createSupervisor = internals.createConnectionSupervisor ?? createConnectionSupervisor;
  const logger = log;
  const paths = pluginPaths(config);
  log.info('[dsh-im-youdu] config path=', paths.config);
  const configStore = await new ConfigStore(paths.config).load();
  const defaultWorkspace = resolve(config.workspace ?? process.cwd());
  const settingsStore = await new YouduSettingsStore(
    resolve(paths.bots, 'settings.json'),
    { defaultWorkspace, defaultAgentPreset: config.agentPreset },
  ).load();
  const harness = new Harness({
    ...connection,
    workspace: defaultWorkspace,
    autostart: false,
    dshBin: config.dshBin ?? 'dsh',
  });
  log.info('[dsh-im-youdu] harness created');
  const stateStores = new Map();
  const statePath = (botId) => resolve(paths.bots, botId, 'state.json');
  const stateFor = async (botId) => {
    let state = stateStores.get(botId);
    if (!state) {
      state = await new StateStore(statePath(botId)).load();
      stateStores.set(botId, state);
    }
    return state;
  };
  const controller = new Controller({
    credentials: ctx.credentials,
    configStore,
    settingsStore,
    logger,
    createRuntime: async ({ botId, config: botConfig, secret }) => {
      const state = await stateFor(botId);
      settingsStore.ensure(botId);
      return new Runtime({
        config: botConfig,
        secret,
        harness,
        state,
        replyTimeoutMs: config.replyTimeoutMs ?? 600_000,
        connectTimeoutMs: config.connectTimeoutMs ?? 20_000,
        botId: botConfig.sourceBotId ?? botConfig.botId ?? botId,
        contextEnhancement: createYouduContextEnhancement(settingsStore, botId),
        accessPolicy: createYouduAccessPolicy(settingsStore, botId, botConfig, config.groupResponseMode ?? 'all'),
        logger: {
          error: (...args) => logger.error?.(`[${botId}]`, ...args),
          warn: (...args) => logger.warn?.(`[${botId}]`, ...args),
          info: (...args) => logger.info?.(`[${botId}]`, ...args),
          debug: (...args) => logger.debug?.(`[${botId}]`, ...args),
        },
      });
    },
    deleteState: async ({ botId }) => {
      const state = stateStores.get(botId);
      stateStores.delete(botId);
      if (state && typeof state.remove === 'function') {
        await state.remove();
      } else {
        try {
          await unlink(statePath(botId));
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    },
  });
  const supervisor = createSupervisor({
    controller,
    harness,
    logger,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs,
  }).start();
  return {
    controller,
    ready: supervisor.ready,
    async close() {
      await supervisor.close();
      await controller.close();
      harness.stopManagedProcess();
    },
  };
}
