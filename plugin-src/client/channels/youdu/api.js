export const YOUDU_RPC_CHANNEL = '/youdu';

export const YOUDU_ENDPOINTS = Object.freeze({
  status: 'connection.status',
  attachBot: 'bot.attach',
  reconnectBot: 'bot.reconnect',
  deleteBot: 'bot.delete',
  connectionTest: 'bot.connection-test',
  setWorkspace: 'bot.workspace.set',
  setAgentPreset: 'bot.preset.set',
  setContextEnhancement: 'bot.context-enhancement.set',
  setAccessPolicy: 'bot.access-policy.set',
});

const BOT_STATES = new Set(['connected', 'connecting', 'offline', 'error']);
const TEST_MESSAGE_CODES = new Set(['test-target-unavailable', 'test-message-failed']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, fallback, max = 240) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

function id(value) {
  const result = text(value, '', 128);
  return /^[a-z\d_-]+$/i.test(result) ? result : undefined;
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function unwrapRpcResult(result) {
  if (!isRecord(result) || typeof result.ok !== 'boolean') throw new Error('有度服务返回了无法识别的响应');
  if (!result.ok) {
    const error = new Error(text(result.error?.message, '有度操作失败'));
    error.code = text(result.error?.code, 'YOUDU_RPC_ERROR', 80);
    throw error;
  }
  return result.value;
}

function normalizeBot(value) {
  if (!isRecord(value) || !id(value.botId)) return undefined;
  const connected = value.connected === true;
  const state = BOT_STATES.has(value.state) ? value.state : 'offline';
  return {
    botId: id(value.botId),
    connected,
    state: connected ? 'connected' : state,
    bot: {
      name: text(value.bot?.name, '有度机器人', 100),
      wsHostMasked: text(value.bot?.wsHostMasked, '服务器已安全保存', 140),
    },
    health: {
      summary: text(value.health?.summary, connected ? '有度 WebSocket 长连接运行正常' : '有度连接尚未就绪'),
      lastCheckedAt: timestamp(value.health?.lastCheckedAt),
    },
    lastMessageError: value.lastMessageError ? {
      code: text(value.lastMessageError?.code, 'YOUDU_MSG_ERROR', 80),
      message: text(value.lastMessageError?.message, '消息处理失败'),
    } : null,
    error: isRecord(value.error) ? {
      code: text(value.error.code, 'YOUDU_ACCOUNT_ERROR', 80),
      message: text(value.error.message, '有度连接尚未就绪'),
    } : null,
    workspace: typeof value.workspace === 'string' ? value.workspace : undefined,
    agentPreset: value.agentPreset ?? undefined,
    contextEnhancement: isRecord(value.contextEnhancement) ? value.contextEnhancement : undefined,
    accessPolicy: isRecord(value.accessPolicy) ? value.accessPolicy : undefined,
  };
}

function normalizeTestMessage(value) {
  if (!isRecord(value) || typeof value.sent !== 'boolean') return undefined;
  if (value.sent) return { sent: true };
  const code = text(value.code, 'test-message-failed', 80);
  return { sent: false, code: TEST_MESSAGE_CODES.has(code) ? code : 'test-message-failed' };
}

export function normalizeSnapshot(value) {
  const source = isRecord(value?.snapshot) ? value.snapshot : value;
  if (!isRecord(source) || !Array.isArray(source.bots)) throw new Error('有度服务没有返回有效的机器人列表');
  const bots = source.bots.map(normalizeBot).filter(Boolean);
  const testMessage = normalizeTestMessage(source.testMessage);
  return {
    revision: Number.isSafeInteger(source.revision) ? source.revision : 0,
    bots,
    totals: { configured: bots.length, connected: bots.filter((bot) => bot.connected).length },
    ...(testMessage ? { testMessage } : {}),
  };
}

export function connectionTestFeedback(result) {
  if (result?.sent === true) return '测试消息已发送，请到对应机器人会话中确认。';
  if (result?.code === 'test-target-unavailable') {
    return '连接检查完成。机器人尚未收到可用于测试的私聊消息。';
  }
  return result ? '连接检查完成，但测试消息发送失败。' : null;
}

export function presentError(error) {
  return {
    code: text(error?.code, 'YOUDU_ERROR', 80),
    message: text(error?.message, '有度操作失败，请稍后重试'),
  };
}
