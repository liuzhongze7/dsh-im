import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { YouduConfigStore } from '../../../../src/channels/youdu/config-store.mjs';
import { YouduGroupSettingsStore } from '../../../../src/channels/youdu/group-settings-store.mjs';
import { YouduHarnessClient } from '../../../../src/channels/youdu/harness-client.mjs';
import {
  migrateLegacyYouduDeliveryTargets,
  migrateLegacyYouduSettings,
} from '../../../../src/channels/youdu/legacy-settings.mjs';
import { YouduController } from '../../../../src/channels/youdu/youdu-controller.mjs';
import { YouduRuntime } from '../../../../src/channels/youdu/youdu-runtime.mjs';
import { YouduStateStore } from '../../../../src/channels/youdu/state-store.mjs';
import { resolveYouduRoute } from '../../../../src/channels/youdu/target-resolve.mjs';
import { listAgentPresetCatalog } from '../../../../src/channels/shared/agent-preset.mjs';
import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
  createWorkspaceAwareController,
  observeBotWorkspaceRemovals,
} from '../../../../src/channels/shared/bot-workspace-store.mjs';
import { normalizeContextEnhancementConfig } from '../../../../src/channels/shared/context-enhancement.mjs';
import { normalizeGroupHistoryConfig } from '../../../../src/channels/shared/group-history.mjs';
import {
  createGroupContextFiles,
  normalizeGroupContextRetention,
} from '../../../../src/channels/shared/group-context-files.mjs';
import { listModelCatalog } from '../../../../src/channels/shared/model-setting.mjs';
import {
  accessPolicyProvider,
  initialAccessPolicyFor,
} from '../shared/access-policy-production.mjs';
import { createConnectionSupervisor } from './connection-supervisor.mjs';
import { createHarnessCommandExecutor } from '../../harness-command-executor.mjs';
import { harnessConnection } from '../../harness-connection.mjs';
import { createDeliveryAdapter } from '../../delivery-adapter.mjs';
import { createHarnessSessionExecutors } from '../../harness-session-coordinator.mjs';
import {
  getInboundTtlRuntime,
  registerInboundTtlWorkspaces,
} from '../../inbound-ttl-runtime.mjs';

/** 取非空字符串（用于建议目标的可读名字）。 */
function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 有度的访问策略：直接复用共享 provider（ownerUserId 的种子策略由
 * `initialAccessPolicyFor('youdu', …)` 统一生成），只补 groupResponseMode。
 */
function createYouduAccessPolicy(workspaces, botId, botConfig, groupResponseMode = 'mention') {
  const provider = accessPolicyProvider(workspaces, botId, {
    channel: 'youdu',
    config: botConfig,
  });
  return Object.freeze({
    botId,
    groupResponseMode,
    getSettings: () => provider.getSettings() ?? initialAccessPolicyFor('youdu', botConfig),
    isPrivileged: provider.isPrivileged,
  });
}

/** 按群访问规则的 provider：每次决策都从按群设置存储读取，改完即时生效。 */
function createYouduGroupAccess(groupStore, botId) {
  return {
    botId,
    getSettings: () => groupStore.groupAccessFor(botId),
  };
}

function createYouduContextEnhancement(workspaces, botId) {
  return {
    botId,
    getSettings: () => normalizeContextEnhancementConfig(
      workspaces.contextEnhancementFor(botId),
    ),
  };
}

/** 群聊上下文缓存设置（开关 + 条数）：bridge 每次记录/注入时实时读取，保存后即时生效。 */
function createYouduGroupHistory(groupStore, botId) {
  return {
    botId,
    getSettings: () => normalizeGroupHistoryConfig(groupStore.groupHistoryFor(botId)),
  };
}

/**
 * 群聊附件落盘：用媒体下载接口把未寻址群消息的图片/文件取回，写到该 bot 工作区的
 * `.dsh-im/group-context/<群>/<时间戳>-<消息>/`，供模型在被 @ 时按相对路径读取。
 * 工作区每次实时读取，跟随设置页的工作区切换；过期清理挂在写入路径上。
 */
function createYouduGroupContextFiles(workspaces, botId, {
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
        workspace: workspaces.workspaceFor(botId),
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
      return store.list(workspaces.workspaceFor(botId), chatId, { limit });
    },
    sweep: () => store.sweep(workspaces.workspaceFor(botId)),
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
  const WorkspaceStore = internals.WorkspaceStore ?? BotWorkspaceStore;
  const GroupStore = internals.GroupStore ?? YouduGroupSettingsStore;
  const createSupervisor = internals.createConnectionSupervisor ?? createConnectionSupervisor;
  const logger = log;
  const paths = pluginPaths(config);
  log.info('[dsh-im-youdu] config path=', paths.config);
  const configStore = await new ConfigStore(paths.config, { logger: log }).load();
  const defaultWorkspace = resolve(config.workspace ?? process.cwd());
  // 每 bot 设置与其它渠道一样落在共享 workspace 存储里（workspaces.json）；
  // 有度独有的按群设置（groupAccess / groupHistory）放在 group-settings.json。
  const workspaces = internals.workspaces ?? await new WorkspaceStore(
    resolve(paths.bots, 'workspaces.json'),
    { defaultWorkspace },
  ).load();
  const groupStore = internals.groupStore ?? await new GroupStore(
    resolve(paths.bots, 'group-settings.json'),
  ).load();
  // 旧版自建 store 的文件：先迁进新存储再把原文件改名，避免设置丢失。
  await migrateLegacyYouduSettings({
    legacyPath: resolve(paths.bots, 'settings.json'),
    workspaces,
    groups: groupStore,
    defaultAgentPreset: config.agentPreset,
  });
  const botIds = configStore.list().map((bot) => bot.botId);
  await workspaces.reconcile(botIds);
  await Promise.all(configStore.list().map((botConfig) => workspaces.ensure(botConfig.botId, {
    defaultAgentPreset: config.agentPreset,
    initialAccessPolicy: initialAccessPolicyFor('youdu', botConfig),
  })));
  await migrateLegacyYouduDeliveryTargets({
    legacyPath: resolve(paths.bots, 'delivery.json'),
    workspaces,
    knownBotIds: botIds,
  });
  // configStore 删除 bot 时同步清掉 workspace 记录（与其它渠道一致）。
  const observedConfigStore = typeof configStore.remove === 'function'
    ? observeBotWorkspaceRemovals(configStore, { workspaces })
    : configStore;
  // 入站附件（图片/文件）经同进程 fileIngressExecutor 落到会话工作区；
  // 缺少它时 HarnessClient 会抛 "Harness file ingress is unavailable"。
  const inboundTtl = internals.inboundTtl ?? getInboundTtlRuntime(ctx, config);
  const inboundTtlService = inboundTtl?.service ?? inboundTtl;
  registerInboundTtlWorkspaces(ctx, inboundTtlService, {
    workspaces,
    configStore: observedConfigStore,
    defaultWorkspace,
  });
  const { fileIngressExecutor } = createHarnessSessionExecutors(ctx, {
    fileIngressExecutor: internals.fileIngressExecutor,
    inboundTtlService,
  });
  // 与其它渠道一致：/compact 等 Host 命令经共享 executor 执行，而不是直连 RPC。
  const commandExecutor = createHarnessCommandExecutor(ctx, internals.commandExecutor);
  const harness = new Harness({
    ...connection,
    workspace: defaultWorkspace,
    autostart: false,
    dshBin: config.dshBin ?? 'dsh',
    ...(fileIngressExecutor ? { fileIngressExecutor } : {}),
    ...(commandExecutor ? { commandExecutor } : {}),
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
  const agentPresetCatalog = () => listAgentPresetCatalog(ctx);
  const modelCatalog = () => listModelCatalog(harness);
  const coreController = new Controller({
    credentials: ctx.credentials,
    configStore: observedConfigStore,
    groupStore,
    logger,
    knownGroupsFor: (botId) => {
      const state = stateStores.get(botId);
      return state && typeof state.groupsSnapshot === 'function' ? state.groupsSnapshot() : [];
    },
    // 接入/编辑连接后保证该 bot 在 workspace 存储里有记录（seed 访问策略）。
    ensureBot: (botConfig) => workspaces.ensure(botConfig.botId, {
      defaultAgentPreset: config.agentPreset,
      initialAccessPolicy: initialAccessPolicyFor('youdu', botConfig),
    }),
    createRuntime: async ({ botId, config: botConfig, secret }) => {
      const state = await stateFor(botId);
      const workspaceScope = createBotWorkspaceScope(harness, {
        botId,
        workspaces,
        state,
        agentPresetCatalog,
      });
      return new Runtime({
        config: botConfig,
        secret,
        harness: workspaceScope.harness,
        state: workspaceScope.state,
        replyTimeoutMs: config.replyTimeoutMs ?? 600_000,
        connectTimeoutMs: config.connectTimeoutMs ?? 20_000,
        botId: botConfig.sourceBotId ?? botConfig.botId ?? botId,
        contextEnhancement: createYouduContextEnhancement(workspaces, botId),
        groupHistory: createYouduGroupHistory(groupStore, botId),
        groupContextFiles: createYouduGroupContextFiles(workspaces, botId, {
          retentionHours: config.groupContextRetentionHours,
          sweepIntervalMs: config.groupContextSweepIntervalMs,
          logger,
        }),
        groupHistoryStagingWaitMs: config.groupHistoryStagingWaitMs,
        groupContextRecentLimit: config.groupContextRecentLimit,
        accessPolicy: createYouduAccessPolicy(
          workspaces,
          botId,
          botConfig,
          config.groupResponseMode ?? 'mention',
        ),
        groupAccess: createYouduGroupAccess(groupStore, botId),
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
    deleteState: async ({ botId }) => {
      const state = stateStores.get(botId);
      stateStores.delete(botId);
      // 有度独有的按群设置随 bot 一起清理；workspace / 投递目标由共享存储负责。
      await groupStore.remove(botId).catch(() => undefined);
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
  // 共享包装层：updateWorkspace / updateAgentPreset / updateModel / updateAlias /
  // updateContextEnhancement / updateAccessPolicy / deleteBot 与其它渠道同一实现，
  // 并给每次状态回传补上 modelCatalog / agentPresetCatalog。
  const controller = createWorkspaceAwareController(coreController, {
    workspaces,
    stateFor,
    agentPresetCatalog,
    modelCatalog,
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
    workspaces,
    coreController,
    stateFor,
    // 有度服务端只认 chatId，但人更愿意填昵称/群名：在这里解析成权威 ID，
    // 保存与发送都走同一套规则（重名报歧义，不猜）。
    resolveTarget: async (botId, target) => {
      const state = await stateFor(botId).catch(() => null);
      return resolveYouduRoute(target.kind, target.route?.chatId, {
        people: typeof state?.peopleSnapshot === 'function' ? state.peopleSnapshot() : [],
        groups: typeof state?.groupsSnapshot === 'function' ? state.groupsSnapshot() : [],
      });
    },
  });
  const deliveryAdapter = Object.freeze({
    ...baseDeliveryAdapter,
    // 建议目标补上可读名字：单聊用观察到的账号名/昵称，群聊用群名/会话标题。
    // 目标本身仍以 chatId 为准（服务端不保证名字唯一），这里只解决"选目标时看着是
    // 一串 ID"的问题；按名字直接投递由上层挑选目标完成，不在渠道里另造解析器。
    async listSuggestions(botId) {
      const suggestions = await baseDeliveryAdapter.listSuggestions(botId);
      let people = [];
      let groups = [];
      try {
        const state = await stateFor(botId);
        people = typeof state?.peopleSnapshot === 'function' ? state.peopleSnapshot() : [];
        groups = typeof state?.groupsSnapshot === 'function' ? state.groupsSnapshot() : [];
      } catch {
        // 名字只是展示信息，读不到就退化为纯 ID。
      }
      const labels = new Map();
      for (const group of groups) {
        const label = cleanString(group?.name);
        if (label) labels.set(`group:${group.chatId}`, label);
      }
      for (const person of people) {
        const label = cleanString(person?.name) ?? cleanString(person?.account);
        if (label) labels.set(`user:${person.chatId}`, label);
      }
      return suggestions.map((suggestion) => {
        const chatId = suggestion?.route?.chatId;
        const label = labels.get(`${suggestion?.kind}:${chatId}`);
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
