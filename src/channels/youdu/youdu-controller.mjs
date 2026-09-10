import { deriveYouduBotIdentity, maskYouduBotId } from './config-store.mjs';
import { t } from '../shared/i18n.mjs';
import { publicMessageFailure } from '../shared/message-failure.mjs';

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeError(code, message) {
  return Object.freeze({ code, message });
}

export class YouduController {
  #credentials;
  #configStore;
  #createRuntime;
  #settingsStore;
  #deleteState;
  #clearSessions;
  #knownGroupsFor;
  #logger;
  #runtimes = new Map();
  #errors = new Map();
  #transitions = new Map();
  #revision = 0;
  #closed = false;

  constructor({
    credentials,
    configStore,
    createRuntime,
    settingsStore,
    deleteState = async () => {},
    clearSessions = async () => {},
    knownGroupsFor = null,
    logger = console,
  }) {
    if (!credentials || typeof credentials.resolve !== 'function'
      || typeof credentials.set !== 'function' || typeof credentials.unset !== 'function') {
      throw new TypeError('YouduController requires the DSH credential provider');
    }
    if (!configStore || typeof configStore.list !== 'function'
      || typeof configStore.save !== 'function' || typeof configStore.remove !== 'function') {
      throw new TypeError('YouduController requires a config store');
    }
    if (typeof createRuntime !== 'function') throw new TypeError('createRuntime is required');
    this.#credentials = credentials;
    this.#configStore = configStore;
    this.#createRuntime = createRuntime;
    this.#settingsStore = settingsStore ?? null;
    this.#deleteState = deleteState;
    this.#clearSessions = clearSessions;
    this.#knownGroupsFor = typeof knownGroupsFor === 'function' ? knownGroupsFor : null;
    this.#logger = logger;
  }

  async initialize() {
    if (this.#closed) return this.status();
    for (const config of this.#configStore.list()) {
      await this.#withBotTransition(config.botId, async () => {
        if (this.#closed || this.#runtimes.get(config.botId)?.status?.ready) return;
        const secret = await this.#resolveSecret(config.secretRef);
        if (!secret) {
          this.#errors.set(config.botId, safeError('missing-secret', t('有度机器人凭据缺失，请移除后重新接入。')));
          return;
        }
        try {
          await this.#startRuntime(config, secret);
          this.#errors.delete(config.botId);
        } catch (error) {
          this.#errors.set(config.botId, safeError('connection-failed', t('有度连接未就绪，插件会自动重试。')));
          this.#logger.warn?.(`[dsh-im:youdu] bot ${config.botId} failed to initialize:`, error);
        } finally {
          this.#touch();
        }
      });
    }
    return this.status();
  }

  /**
   * 接入或更新一个有度机器人。同一 sourceBotId 派生同一 botId，因此再次提交即"编辑连接信息"：
   * secret / wsHost 省略表示保持原值，createdAt 保留；ownerUserId 省略保持原值，显式传空串表示清回 '*'。
   */
  async attachBot({ botId, secret, wsHost, ownerUserId }) {
    this.#logger.info?.('[dsh-im-youdu] attachBot called:', botId);
    if (this.#closed) throw new Error('Youdu controller is closed');
    const sourceBotId = cleanString(botId);
    if (!sourceBotId) throw new TypeError('Youdu bot id is required');
    const identity = deriveYouduBotIdentity(sourceBotId);
    await this.#withBotTransition(identity.botId, async () => {
      if (this.#closed) throw new Error('Youdu controller is closed');
      const existing = this.#configStore.get(identity.botId);
      const normalizedSecret = cleanString(secret)
        ?? (existing ? await this.#resolveSecret(existing.secretRef) : null);
      const normalizedHost = cleanString(wsHost) ?? existing?.wsHost ?? null;
      if (!normalizedSecret || !normalizedHost) {
        throw new TypeError('Youdu bot secret and WebSocket host are required');
      }
      const normalizedOwner = ownerUserId === undefined
        ? (existing?.ownerUserId ?? '*')
        : (cleanString(ownerUserId) ?? '*');
      const previousSecret = await this.#credentials.resolve(identity.secretRef).catch(() => undefined);
      const now = new Date().toISOString();
      const config = {
        botId: identity.botId,
        sourceBotId,
        secretRef: identity.secretRef,
        wsHost: normalizedHost,
        ownerUserId: normalizedOwner,
        createdAt: existing?.createdAt ?? now,
        connectedAt: now,
      };
      await this.#credentials.set(identity.secretRef, normalizedSecret);
      try {
        await this.#configStore.save(config);
      } catch (error) {
        await this.#restoreCredential(identity.secretRef, previousSecret);
        throw error;
      }
      try {
        await this.#startRuntime(config, normalizedSecret);
        this.#errors.delete(identity.botId);
      } catch (error) {
        this.#errors.set(identity.botId, safeError('connection-failed', t('有度机器人已接入，消息连接暂未就绪。')));
        this.#logger.warn?.(`[dsh-im:youdu] bot ${identity.botId} credential connection failed:`, error);
      }
      this.#touch();
    });
    return this.status();
  }

  async reconnectBot(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error('Unknown Youdu bot');
    await this.#withBotTransition(botId, async () => {
      const secret = await this.#resolveSecret(config.secretRef);
      if (!secret) throw new Error('Youdu bot secret is missing');
      try {
        await this.#startRuntime(config, secret);
        this.#errors.delete(botId);
      } catch (error) {
        this.#errors.set(botId, safeError('connection-failed', t('有度连接仍未就绪，请稍后重试。')));
        throw error;
      } finally {
        this.#touch();
      }
    });
    return this.status();
  }

  async sendConnectionTest(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error('Unknown Youdu bot');
    return this.#withBotTransition(botId, async () => {
      const runtime = this.#runtimes.get(botId);
      if (!runtime?.status?.ready || typeof runtime.sendConnectionTest !== 'function') {
        const error = new Error(t('有度机器人尚未连接'));
        error.code = 'test-target-unavailable';
        throw error;
      }
      await runtime.sendConnectionTest(connectionTestText(maskYouduBotId(config.wsHost)));
      return { sent: true };
    });
  }

  async sendProactiveText(botId, target, text, options = {}) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error('Unknown Youdu bot');
    return this.#withBotTransition(botId, async () => {
      const runtime = this.#runtimes.get(botId);
      if (!runtime?.status?.ready || typeof runtime.sendProactiveText !== 'function') {
        const error = new Error(t('有度机器人尚未连接'));
        error.code = 'bot-not-connected';
        throw error;
      }
      return runtime.sendProactiveText(target, text, options);
    });
  }

  async deleteBot(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error('Unknown Youdu bot');
    await this.#withBotTransition(botId, async () => {
      const previous = await this.#credentials.resolve(config.secretRef).catch(() => undefined);
      await this.#stopRuntime(botId);
      try {
        await this.#credentials.unset(config.secretRef);
        await this.#configStore.remove(botId);
      } catch (error) {
        if (previous?.value) {
          await this.#credentials.set(config.secretRef, previous.value).catch(() => undefined);
          await this.#startRuntime(config, previous.value).catch(() => undefined);
        }
        throw new Error('Unable to remove the Youdu bot safely.', { cause: error });
      }
      await this.#deleteState({ botId, config }).catch((error) => {
        this.#logger.warn?.(`[dsh-im:youdu] bot ${botId} state cleanup failed:`, error);
      });
      this.#errors.delete(botId);
      this.#touch();
    });
    return this.status();
  }

  status() {
    const bots = this.#configStore.list().map((config) => {
      const runtimeStatus = this.#runtimes.get(config.botId)?.status ?? null;
      const connected = runtimeStatus?.ready === true
        && runtimeStatus.youduConnectionState === 'connected'
        && runtimeStatus.harnessReachable === true;
      const state = connected ? 'connected'
        : runtimeStatus?.youduConnectionState === 'connecting' ? 'connecting'
          : this.#errors.has(config.botId) || runtimeStatus?.youduConnectionState === 'failed'
            ? 'error' : 'offline';
      return {
        botId: config.botId,
        sourceBotId: config.sourceBotId,
        ownerUserId: config.ownerUserId,
        state,
        connected,
        configured: true,
        bot: { name: t('有度机器人'), wsHostMasked: maskYouduBotId(config.wsHost) },
        health: {
          status: connected ? 'healthy' : state === 'error' ? 'error' : 'offline',
          summary: connected ? t('有度 WebSocket 长连接运行正常')
            : state === 'error' ? t('有度连接未就绪，插件会自动重试') : t('有度连接当前离线'),
          lastCheckedAt: runtimeStatus?.lastCheckedAt ?? null,
          lastConnectedAt: runtimeStatus?.lastConnectedAt ?? null,
        },
        stats: {
          messagesReceived: runtimeStatus?.messagesReceived ?? 0,
          messagesReplied: runtimeStatus?.messagesReplied ?? 0,
        },
        lastMessageError: publicMessageFailure(runtimeStatus?.lastMessageError),
        error: structuredClone(this.#errors.get(config.botId) ?? null),
        knownGroups: this.knownGroups(config.botId),
      };
    });
    const connectedCount = bots.filter((bot) => bot.connected).length;
    const base = {
      schemaVersion: 1,
      revision: this.#revision,
      state: bots.length === 0 ? 'disconnected'
        : connectedCount === bots.length ? 'connected'
          : connectedCount > 0 ? 'degraded' : 'offline',
      bots,
      totals: { configured: bots.length, connected: connectedCount },
    };
    return this.#settingsStore ? this.#settingsStore.decorateStatus(base) : base;
  }

  /** 更新机器人按群访问设置（null 表示全部沿用群聊访问设置）。 */
  async updateGroupAccess(botId, groupAccess, projectStatus) {
    this.#assertBot(botId);
    if (!this.#settingsStore) throw new TypeError('Youdu settings store is required');
    const result = await this.#settingsStore.setGroupAccess(botId, groupAccess);
    this.#revision += 1;
    return typeof projectStatus === 'function'
      ? projectStatus(this.status())
      : result;
  }

  /** 观察到的群（供设置页选择），按最近活跃排序。 */
  knownGroups(botId) {
    if (!this.#knownGroupsFor) return [];
    try {
      const groups = this.#knownGroupsFor(botId);
      return Array.isArray(groups) ? groups : [];
    } catch {
      return [];
    }
  }

  /** 更新机器人工作区（轻量 config-backed）：写入后清空该 bot 已绑定会话，使下条消息在新工作区新建会话。 */
  async updateWorkspace(botId, workspace) {
    this.#assertBot(botId);
    if (!this.#settingsStore) throw new TypeError('Youdu settings store is required');
    const value = await this.#settingsStore.setWorkspace(botId, workspace);
    await this.#clearSessions(botId);
    return value;
  }

  /** 更新机器人 Agent Preset。 */
  async updateAgentPreset(botId, agentPreset) {
    this.#assertBot(botId);
    if (!this.#settingsStore) throw new TypeError('Youdu settings store is required');
    return this.#settingsStore.setAgentPreset(botId, agentPreset);
  }

  /** 更新机器人上下文增强设置。 */
  async updateContextEnhancement(botId, config, projectStatus) {
    this.#assertBot(botId);
    if (!this.#settingsStore) throw new TypeError('Youdu settings store is required');
    const result = await this.#settingsStore.setContextEnhancement(botId, config);
    return typeof projectStatus === 'function'
      ? projectStatus(this.status())
      : result;
  }

  /** 更新机器人群聊上下文缓存设置（开关 + 条数，下一条消息即生效）。 */
  async updateGroupHistory(botId, config, projectStatus) {
    this.#assertBot(botId);
    if (!this.#settingsStore) throw new TypeError('Youdu settings store is required');
    const result = await this.#settingsStore.setGroupHistory(botId, config);
    return typeof projectStatus === 'function'
      ? projectStatus(this.status())
      : result;
  }

  /** 更新机器人访问策略。 */
  async updateAccessPolicy(botId, policy, projectStatus) {
    this.#assertBot(botId);
    if (!this.#settingsStore) throw new TypeError('Youdu settings store is required');
    const result = await this.#settingsStore.setAccessPolicy(botId, policy);
    return typeof projectStatus === 'function'
      ? projectStatus(this.status())
      : result;
  }

  #assertBot(botId) {
    if (!this.#configStore.get(botId)) throw new Error('Unknown Youdu bot');
    if (this.#settingsStore) this.#settingsStore.ensure(botId);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#transitions.values()]);
    await Promise.allSettled([...this.#runtimes.keys()].map((botId) => this.#stopRuntime(botId)));
  }

  async #startRuntime(config, secret) {
    if (this.#closed) throw new Error('Youdu controller is closed');
    await this.#stopRuntime(config.botId);
    if (this.#closed) throw new Error('Youdu controller is closed');
    const runtime = await this.#createRuntime({ botId: config.botId, config, secret });
    if (!runtime || typeof runtime.start !== 'function' || typeof runtime.stop !== 'function') {
      throw new TypeError('createRuntime returned an invalid Youdu runtime');
    }
    this.#runtimes.set(config.botId, runtime);
    try {
      await runtime.start();
    } catch (error) {
      await runtime.stop().catch(() => undefined);
      this.#runtimes.delete(config.botId);
      throw error;
    }
  }

  async #stopRuntime(botId) {
    const runtime = this.#runtimes.get(botId);
    this.#runtimes.delete(botId);
    await runtime?.stop().catch((error) => {
      this.#logger.warn?.(`[dsh-im:youdu] bot ${botId} failed to stop cleanly:`, error);
    });
  }

  async #resolveSecret(ref) {
    const result = await this.#credentials.resolve(ref).catch(() => undefined);
    return cleanString(result?.value);
  }

  async #restoreCredential(ref, previous) {
    if (previous?.value) await this.#credentials.set(ref, previous.value).catch(() => undefined);
    else await this.#credentials.unset(ref).catch(() => undefined);
  }

  #withBotTransition(botId, operation) {
    const previous = this.#transitions.get(botId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.finally(() => {
      if (this.#transitions.get(botId) === settled) this.#transitions.delete(botId);
    });
    this.#transitions.set(botId, settled);
    return settled;
  }

  #touch() {
    this.#revision += 1;
  }
}

function connectionTestText(label) {
  return `${label} 已连接 DeepSeek Harness`;
}
