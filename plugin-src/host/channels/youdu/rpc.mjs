import { resolveRpcAuthority } from '../../rpc-authority.mjs';

export const YOUDU_RPC_CHANNEL = '/youdu';
export const YOUDU_ENDPOINTS = Object.freeze({
  status: 'connection.status',
  attachBot: 'bot.attach',
  reconnectBot: 'bot.reconnect',
  deleteBot: 'bot.delete',
  connectionTest: 'bot.connection-test',
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
  return async (state, payload, context) => {
    const signal = context?.signal ?? payload?.signal ?? options?.signal;
    const endpoint = state?.endpoint ?? payload?.endpoint;
    try {
      let value;
      if (endpoint === YOUDU_ENDPOINTS.status) {
        value = await publicStatus(controller.status(), cachedEncode);
      } else if (endpoint === YOUDU_ENDPOINTS.attachBot) {
        if (!validSourceBotId(payload?.botId)
          || !validCredential(payload?.secret, 512)
          || !validWsHost(payload?.wsHost)) {
          throw new TypeError('Youdu bot id, secret and WebSocket host are required');
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
      } else {
        throw new Error(`Unknown Youdu RPC endpoint: ${endpoint}`);
      }
      return signal?.aborted
        ? { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.' } }
        : { ok: true, value };
    } catch (error) {
      return signal?.aborted
        ? { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.' } }
        : { ok: false, error: { code: 'youdu-operation-failed', message: error?.message ?? '有度操作失败，请稍后重试。' } };
    }
  };
}

export function installYouduRpc(ctx, controller, options, authority) {
  if (!ctx?.connection?.rpc || typeof ctx.connection.rpc.handle !== 'function') {
    throw new TypeError('DSH Host Connection RPC is required');
  }
  return ctx.connection.rpc.handle(
    YOUDU_RPC_CHANNEL,
    createYouduRpcHandler(controller, options),
    { authority: resolveRpcAuthority(authority) },
  );
}
