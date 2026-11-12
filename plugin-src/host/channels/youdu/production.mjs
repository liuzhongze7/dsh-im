import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { YouduConfigStore } from '../../../../src/channels/youdu/config-store.mjs';
import { YouduDeliveryStore } from '../../../../src/channels/youdu/delivery-store.mjs';
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
import {
  normalizeGroupHistoryConfig,
} from '../../../../src/channels/shared/group-history.mjs';
import {
  createGroupContextFiles,
  normalizeGroupContextRetention,
} from '../../../../src/channels/shared/group-context-files.mjs';
import {
  confirmsModelSelection,
  listModelCatalog,
} from '../../../../src/channels/shared/model-setting.mjs';
import { createConnectionSupervisor } from './connection-supervisor.mjs';
import { harnessConnection } from '../../harness-connection.mjs';
import { createDeliveryAdapter } from '../../delivery-adapter.mjs';
import { createHarnessSessionExecutors } from '../../harness-session-coordinator.mjs';
import {
  getInboundTtlRuntime,
  registerInboundTtlWorkspaces,
} from '../../inbound-ttl-runtime.mjs';

/** 从设置存储读取访问策略；未配置时：owner='*'（未配置）→ 命令开放，配置了具体 owner → 仅该 owner 可执行命令。 */
function createYouduAccessPolicy(settingsStore, botId, botConfig, groupResponseMode = 'mention') {
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

/** 按群访问规则的 provider：每次决策都从设置存储读取，改完即时生效。 */
function createYouduGroupAccess(settingsStore, botId) {
  return {
    botId,
    getSettings: () => settingsStore.groupAccessFor(botId),
  };
}

function createYouduContextEnhancement(settingsStore, botId) {
  return {
    botId,
    getSettings: () => normalizeContextEnhancementConfig(
      settingsStore.contextEnhancementFor(botId),
    ),
  };
}

/** 群聊上下文缓存设置（开关 + 条数）：bridge 每次记录/注入时实时读取，保存后即时生效。 */
function createYouduGroupHistory(settingsStore, botId) {
  return {
    botId,
    getSettings: () => normalizeGroupHistoryConfig(settingsStore.groupHistoryFor(botId)),
  };
}

/**
 * 群聊附件落盘：用媒体下载接口把未寻址群消息的图片/文件取回，写到该 bot 工作区的
 * `.dsh-im/group-context/<群>/<时间戳>-<消息>/`，供模型在被 @ 时按相对路径读取。
 * 工作区每次实时读取，跟随设置页的工作区切换；过期清理挂在写入路径上。
 */
function createYouduGroupContextFiles(settingsStore, botId, {
  retentionHours, sweepIntervalMs, logger = console,
} = {}) {
  const store = createGroupContextFiles({
    retentionHours: normalizeGroupContextRetention(retentionHours),
    sweepIntervalMs,
    logger,
  });
  return {
    botId,
    retentionHours: store.retentionHours,
    async stage({ chatId, messageId, sender, timestamp, files, signal }) {
      return store.stage({
        workspace: settingsStore.workspaceFor(botId),
        chatId,
        messageId,
        sender,
        timestamp,
        files,
        signal,
      });
    },
    /** 从磁盘重建“这个群最近的附件”：重启、清单被消费后依然能列出。 */
    async list({ chatId, limit }) {
      return store.list(settingsStore.workspaceFor(botId), chatId, { limit });
    },
    sweep: () => store.sweep(settingsStore.workspaceFor(botId)),
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

/**
 * 每个机器人工区感知的 Harness 代理（轻量版）：
 * - createSession 注入该 bot 在 settingsStore 里的 workspace、agentPreset 与 model，
 *   使消息会话跑在各自配置的工作区/模型上，而不是 Harness 启动时的默认值。
 *   `inheritBotModel: false` 时跳过模型注入（调用方要自己选模型）。
 * - currentWorkspace / switchWorkspace 读写 settingsStore，并让切换工作区时清空
 *   该 bot 的已绑定会话，使下一条消息在新工作区新建会话。
 * 其余方法（listWorkspaces / listWorkspaceSessions / 转发等）原样透传到目标 Harness。
 */
function createYouduWorkspaceScope(harness, { botId, settingsStore, state }) {
  if (!harness || !settingsStore) {
    throw new TypeError('youdu workspace scope requires harness and settingsStore');
  }
  return new Proxy(harness, {
    get(target, property) {
      if (property === 'createSession') {
        return async (options = {}) => {
          const { inheritBotModel = true, ...createOptions } = options;
          const agentPreset = settingsStore.agentPresetFor(botId);
          const model = inheritBotModel === false ? null : settingsStore.modelFor(botId);
          const sessionId = await target.createSession({
            ...createOptions,
            workspace: settingsStore.workspaceFor(botId),
            ...(agentPreset == null ? {} : { agentPreset }),
          });
          if (model) {
            if (typeof target.selectSessionModel !== 'function') {
              throw new TypeError('Harness does not support model selection');
            }
            const selected = await target.selectSessionModel(
              sessionId,
              model,
              options.signal ? { signal: options.signal } : {},
            );
            if (!confirmsModelSelection(selected?.selected, model)) {
              const error = new Error('Harness did not confirm the selected model');
              error.code = 'model-selection-mismatch';
              throw error;
            }
          }
          return sessionId;
        };
      }
      if (property === 'currentWorkspace') {
        return () => settingsStore.workspaceFor(botId);
      }
      if (property === 'switchWorkspace') {
        return async (workspace) => {
          const next = await settingsStore.setWorkspace(botId, workspace);
          if (typeof state?.clearSessions === 'function') await state.clearSessions();
          return next;
        };
      }
      // 其余方法透传到目标 Harness，但必须把 this 绑定到 target：
      // 共享 HarnessClient 使用 # 私有字段，若以 Proxy 作为 this 调用会抛
      // "Cannot read private member ... from an object whose class did not declare it"。
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
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
  // 投递目标存储：bot 是否存在以 configStore 为准，避免两份 bot 列表漂移。
  const DeliveryStore = internals.DeliveryStore ?? YouduDeliveryStore;
  const deliveryStore = await new DeliveryStore(
    resolve(paths.bots, 'delivery.json'),
    { knownBotIds: () => configStore.list().map((bot) => bot.botId) },
  ).load();
  // 入站附件（图片/文件）经同进程 fileIngressExecutor 落到会话工作区；
  // 缺少它时 HarnessClient 会抛 "Harness file ingress is unavailable"。
  const inboundTtl = internals.inboundTtl ?? getInboundTtlRuntime(ctx, config);
  const inboundTtlService = inboundTtl?.service ?? inboundTtl;
  registerInboundTtlWorkspaces(ctx, inboundTtlService, {
    workspaces: settingsStore,
    configStore,
    defaultWorkspace,
  });
  const { fileIngressExecutor } = createHarnessSessionExecutors(ctx, {
    fileIngressExecutor: internals.fileIngressExecutor,
    inboundTtlService,
  });
  const harness = new Harness({
    ...connection,
    workspace: defaultWorkspace,
    autostart: false,
    dshBin: config.dshBin ?? 'dsh',
    ...(fileIngressExecutor ? { fileIngressExecutor } : {}),
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
    knownGroupsFor: (botId) => {
      const state = stateStores.get(botId);
      return state && typeof state.groupsSnapshot === 'function' ? state.groupsSnapshot() : [];
    },
    // 每 bot 模型选择：目录来自当前 Harness（不可用时给空目录，客户端沿用上次结果）。
    modelCatalog: () => listModelCatalog(harness),
    createRuntime: async ({ botId, config: botConfig, secret }) => {
      const state = await stateFor(botId);
      settingsStore.ensure(botId);
      return new Runtime({
        config: botConfig,
        secret,
        harness: createYouduWorkspaceScope(harness, { botId, settingsStore, state }),
        state,
        replyTimeoutMs: config.replyTimeoutMs ?? 600_000,
        connectTimeoutMs: config.connectTimeoutMs ?? 20_000,
        botId: botConfig.sourceBotId ?? botConfig.botId ?? botId,
        contextEnhancement: createYouduContextEnhancement(settingsStore, botId),
        groupHistory: createYouduGroupHistory(settingsStore, botId),
        groupContextFiles: createYouduGroupContextFiles(settingsStore, botId, {
          retentionHours: config.groupContextRetentionHours,
          sweepIntervalMs: config.groupContextSweepIntervalMs,
          logger,
        }),
        groupHistoryStagingWaitMs: config.groupHistoryStagingWaitMs,
        groupContextRecentLimit: config.groupContextRecentLimit,
        accessPolicy: createYouduAccessPolicy(settingsStore, botId, botConfig, config.groupResponseMode ?? 'mention'),
        groupAccess: createYouduGroupAccess(settingsStore, botId),
        onGroupSeen: (chatId, info = {}) => {
          // 观察到的群写进该 bot 的状态文件，供设置页按群配置时选择；
          // 群名来自会话事件（session title）或消息帧里带的 chatName。
          try {
            const task = state.recordGroup?.(chatId, { name: info?.name ?? undefined });
            if (task && typeof task.catch === 'function') task.catch(() => undefined);
          } catch {
            // 群记录失败不影响消息处理。
          }
        },
        onPersonSeen: (person) => {
          // 观察到的私聊联系人（chatId / 账号名 / 昵称），供投递目标建议与设置页展示。
          try {
            const task = state.recordPerson?.(person.chatId, {
              account: person.account,
              name: person.name,
            });
            if (task && typeof task.catch === 'function') task.catch(() => undefined);
          } catch {
            // 联系人记录失败不影响消息处理。
          }
        },
        logger: {
          error: (...args) => logger.error?.(`[${botId}]`, ...args),
          warn: (...args) => logger.warn?.(`[${botId}]`, ...args),
          info: (...args) => logger.info?.(`[${botId}]`, ...args),
          debug: (...args) => logger.debug?.(`[${botId}]`, ...args),
        },
      });
    },
    clearSessions: async (botId) => {
      const state = await stateFor(botId);
      if (typeof state.clearSessions === 'function') await state.clearSessions();
    },
    deleteState: async ({ botId }) => {
      const state = stateStores.get(botId);
      stateStores.delete(botId);
      // 移除接入时连同投递目标一起清理。
      await deliveryStore.remove(botId).catch(() => undefined);
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
  // 主动投递适配器：把有度的 send_msg 接进 DeliveryService（与其它 10 个渠道同一条通路）。
  const CreateDeliveryAdapter = internals.createDeliveryAdapter ?? createDeliveryAdapter;
  const baseDeliveryAdapter = CreateDeliveryAdapter({
    channel: 'youdu',
    workspaces: deliveryStore,
    coreController: controller,
    stateFor,
  });
  const deliveryAdapter = Object.freeze({
    ...baseDeliveryAdapter,
    // 建议目标里补上联系人可读名字（观察到的 account / name）。
    async listSuggestions(botId) {
      const suggestions = await baseDeliveryAdapter.listSuggestions(botId);
      let people = [];
      try {
        const state = await stateFor(botId);
        people = typeof state?.peopleSnapshot === 'function' ? state.peopleSnapshot() : [];
      } catch {
        // 名字只是展示信息，读不到就退化为纯 ID。
      }
      const byChatId = new Map(people.map((person) => [person.chatId, person]));
      return suggestions.map((suggestion) => {
        if (suggestion?.kind !== 'user') return suggestion;
        const person = byChatId.get(suggestion.route?.chatId);
        const label = person?.name ?? person?.account;
        return label ? { ...suggestion, name: label } : suggestion;
      });
    },
  });
  return {
    controller,
    deliveryAdapter,
    ready: supervisor.ready,
    async close() {
      await supervisor.close();
      await controller.close();
      harness.stopManagedProcess();
    },
  };
}
