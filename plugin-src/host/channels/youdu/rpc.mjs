import { registerManagementRpc } from '../../../management-rpc.mjs';
import { resolveRpcAuthority } from '../../rpc-authority.mjs';
import { normalizeGroupAccess } from '../../../../src/channels/youdu/group-access.mjs';
import { SET_WORKSPACE_ENDPOINT, validWorkspacePayload } from '../shared/workspace-rpc.mjs';
import { SET_AGENT_PRESET_ENDPOINT, validAgentPresetPayload } from '../shared/agent-preset-rpc.mjs';
import { SET_CONTEXT_ENHANCEMENT_ENDPOINT, validContextEnhancementPayload } from '../shared/context-enhancement-rpc.mjs';
import { SET_GROUP_HISTORY_ENDPOINT, validGroupHistoryPayload } from '../shared/group-history-rpc.mjs';
import { SET_ACCESS_POLICY_ENDPOINT, validAccessPolicyPayload } from '../shared/access-policy-rpc.mjs';
import { SET_ALIAS_ENDPOINT, validAliasPayload } from '../shared/bot-alias-rpc.mjs';
import { SET_MODEL_ENDPOINT, validModelPayload } from '../shared/model-setting-rpc.mjs';

export const YOUDU_RPC_CHANNEL = '/youdu';
export const YOUDU_ENDPOINTS = Object.freeze({
  status: 'connection.status',
  attachBot: 'bot.attach',
  reconnectBot: 'bot.reconnect',
  deleteBot: 'bot.delete',
  connectionTest: 'bot.connection-test',
  setWorkspace: SET_WORKSPACE_ENDPOINT,
  setAgentPreset: SET_AGENT_PRESET_ENDPOINT,
  setModel: SET_MODEL_ENDPOINT,
  setAlias: SET_ALIAS_ENDPOINT,
  setContextEnhancement: SET_CONTEXT_ENHANCEMENT_ENDPOINT,
  setGroupHistory: SET_GROUP_HISTORY_ENDPOINT,
  setAccessPolicy: SET_ACCESS_POLICY_ENDPOINT,
  setGroupAccess: 'bot.group-access.set',
});
export const YOUDU_RPC_ENDPOINTS = Object.freeze(Object.values(YOUDU_ENDPOINTS));

const FORBIDDEN_KEYS = new Set(['secretRef', 'secret', 'wsHost']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sanitize(key, value) {
  if (FORBIDDEN_KEYS.has(key)) return undefined;
  return value;
}

/** 递归脱敏状态：不返回 secretRef 与明文 host。 */
function publicStatus(value) {
  if (Array.isArray(value)) return value.map(publicStatus);
  if (isRecord(value)) {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      const cleanKey = sanitize(key, val);
      if (cleanKey === undefined) continue;
      out[key] = publicStatus(val);
    }
    return out;
  }
  return value;
}

function validBotId(value) {
  return typeof value === 'string' && /^yd_[a-f0-9]{24}$/.test(value);
}

function validCredential(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function validSourceBotId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

function validWsHost(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

export function createYouduRpcHandler(controller, options = {}) {
  if (!controller || typeof controller.status !== 'function') {
    throw new TypeError('Youdu RPC requires a controller');
  }
  const cachedEncode = options?.cachedEncode ?? ((value) => value);
  // 客户端用 set* 的返回值整体替换快照，模型目录丢了设置页就只剩「跟随默认模型」，
  // 因此所有会回传状态的端点都要带上目录，而不只是 status。
  const presentStatus = async (status) => {
    const catalogs = typeof controller.catalogs === 'function' ? await controller.catalogs() : {};
    return { ...publicStatus(status, cachedEncode), ...catalogs };
  };
  return async (endpoint, payload, signal) => {
    const activeSignal = signal ?? payload?.signal ?? options?.signal;
    try {
      let value;
      if (endpoint === YOUDU_ENDPOINTS.status) {
        value = await presentStatus(controller.status());
      } else if (endpoint === YOUDU_ENDPOINTS.attachBot) {
        if (!validSourceBotId(payload?.botId)) {
          throw new TypeError('有度机器人 botId 无效。');
        }
        // 编辑既有接入时 secret / wsHost 可省略（表示保持不变）；仅在提供时校验格式。
        if (payload?.secret !== undefined && !validCredential(payload.secret, 512)) {
          throw new TypeError('有度机器人 secret 无效。');
        }
        if (payload?.wsHost !== undefined && !validWsHost(payload.wsHost)) {
          throw new TypeError('有度服务器地址无效。');
        }
        value = await publicStatus(await controller.attachBot({
          botId: payload?.botId,
          secret: payload?.secret,
          wsHost: payload?.wsHost,
          ownerUserId: payload?.ownerUserId,
        }), cachedEncode);
      } else if (endpoint === YOUDU_ENDPOINTS.reconnectBot) {
        if (!validBotId(payload?.botId)) throw new TypeError('Invalid Youdu bot id');
        value = await publicStatus(await controller.reconnectBot(payload.botId), cachedEncode);
      } else if (endpoint === YOUDU_ENDPOINTS.connectionTest) {
        if (!validBotId(payload?.botId)) throw new TypeError('Invalid Youdu bot id');
        await controller.sendConnectionTest(payload.botId);
        value = await publicStatus({ ok: true, message: '用于测试的私聊消息已发送。' }, cachedEncode);
      } else if (endpoint === YOUDU_ENDPOINTS.deleteBot) {
        if (!validBotId(payload?.botId)) throw new TypeError('Invalid Youdu bot id');
        value = await publicStatus(await controller.deleteBot(payload.botId), cachedEncode);
      } else if (endpoint === YOUDU_ENDPOINTS.setWorkspace) {
        if (!validWorkspacePayload(payload)) throw new TypeError('请输入工作区绝对路径。');
        value = await publicStatus(
          await controller.updateWorkspace(payload.botId, payload.workspace),
          cachedEncode,
        );
      } else if (endpoint === YOUDU_ENDPOINTS.setAgentPreset) {
        if (!validAgentPresetPayload(payload)) throw new TypeError('请选择 Agent Preset。');
        value = await publicStatus(
          await controller.updateAgentPreset(payload.botId, payload.agentPreset),
          cachedEncode,
        );
      } else if (endpoint === YOUDU_ENDPOINTS.setModel) {
        if (!validModelPayload(payload)) throw new TypeError('请选择有效模型。');
        value = await publicStatus(
          await controller.updateModel(
            payload.botId,
            payload.model,
            presentStatus,
          ),
          cachedEncode,
        );
      } else if (endpoint === YOUDU_ENDPOINTS.setAlias) {
        if (!validAliasPayload(payload)) throw new TypeError('请输入有效的别名（最多 80 个字符）。');
        value = await publicStatus(
          await controller.updateAlias(
            payload.botId,
            payload.alias,
            presentStatus,
          ),
          cachedEncode,
        );
      } else if (endpoint === YOUDU_ENDPOINTS.setContextEnhancement) {
        if (!validContextEnhancementPayload(payload)) throw new TypeError('请提交有效的上下文增强设置。');
        value = await controller.updateContextEnhancement(
          payload.botId,
          payload.config,
          presentStatus,
        );
      } else if (endpoint === YOUDU_ENDPOINTS.setGroupHistory) {
        if (!validGroupHistoryPayload(payload)) throw new TypeError('请提交有效的群聊上下文设置。');
        value = await controller.updateGroupHistory(
          payload.botId,
          payload.config,
          presentStatus,
        );
      } else if (endpoint === YOUDU_ENDPOINTS.setAccessPolicy) {
        if (!validAccessPolicyPayload(payload)) throw new TypeError('请提交有效的访问设置。');
        value = await controller.updateAccessPolicy(
          payload.botId,
          payload.policy,
          presentStatus,
        );
      } else if (endpoint === YOUDU_ENDPOINTS.setGroupAccess) {
        if (!validBotId(payload?.botId)) throw new TypeError('Invalid Youdu bot id');
        // 省略 / null 等价于清空按群设置（所有群沿用群聊访问设置）。
        const raw = payload?.groupAccess ?? null;
        const groupAccess = raw === null ? null : normalizeGroupAccess(raw);
        if (raw !== null && !groupAccess) {
          throw new TypeError('群访问设置无效：请检查群标识、访问模式与用户名单。');
        }
        value = await controller.updateGroupAccess(
          payload.botId,
          groupAccess,
          presentStatus,
        );
      } else {
        throw new Error(`Unknown Youdu RPC endpoint: ${endpoint}`);
      }
      return activeSignal?.aborted
        ? { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.' } }
        : { ok: true, value };
    } catch (error) {
      return activeSignal?.aborted
        ? { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.' } }
        : { ok: false, error: { code: 'youdu-operation-failed', message: error?.message ?? '有度操作失败，请稍后重试。' } };
    }
  };
}

export function installYouduRpc(ctx, controller, options, authority) {
  // 客户端固定请求 /api/dsh-im/youdu（见 management-rpc.mjs 的 callManagementRpc），
  // 因此必须和其它通道一样注册到共享 /api 载波上的精确 Fetch 路由；
  // 旧写法 ctx.connection.rpc.handle 只会在站点根路径注册前缀路由，客户端必然 404。
  return registerManagementRpc(ctx,
    YOUDU_RPC_CHANNEL,
    createYouduRpcHandler(controller, options),
    { authority: resolveRpcAuthority(authority) },
  );
}
