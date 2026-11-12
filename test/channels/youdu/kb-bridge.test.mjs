import assert from 'node:assert/strict';
import test from 'node:test';

import { YouduBridge } from '../../../src/channels/youdu/youdu-bridge.mjs';
import {
  clearYouduKbRunContext,
  getYouduKbRunContext,
} from '../../../src/channels/youdu/kb/kb-run-context.mjs';

function stateFixture() {
  const sessions = new Map();
  const seen = new Set();
  return {
    state: {
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      sessionFor: (key) => sessions.get(key) ?? null,
      setSession: async (key, sessionId) => sessions.set(key, sessionId),
      clearSession: async (key) => sessions.delete(key),
    },
    sessions,
    seen,
  };
}

function frame(messageId, text, overrides = {}) {
  const body = {
    msgId: messageId,
    chatId: 'chat-1',
    chatType: 'single',
    from: { userId: 'user-7', name: 'User' },
    msgType: 'text',
    text: { content: text },
    ...overrides,
  };
  return { headers: { reqId: `req-${messageId}` }, body };
}

function baseHarness(overrides = {}) {
  return {
    ensureRunning: async () => true,
    sessionExists: async () => true,
    createSession: async () => 'session-kb',
    ask: async () => 'mock answer',
    ...overrides,
  };
}

function makeBot(sent = []) {
  return {
    sendReply: async (target, text) => sent.push({ target, text }),
    sendMessage: async () => {},
    downloadMedia: async () => Buffer.from('x'),
  };
}

const account = { botId: 'src-bot', secret: 's', url: 'host:7443' };

test('the bridge binds the KB run context for the session and releases it after the ask', async () => {
  const { state } = stateFixture();
  const observed = [];
  const harness = baseHarness({
    ask: async (sessionId) => {
      observed.push({ sessionId, ctx: getYouduKbRunContext(sessionId) });
      return 'answer';
    },
  });
  const bridge = new YouduBridge({
    bot: makeBot(),
    harness,
    state,
    ownerUserId: '*',
    botId: 'bot-1',
    kbAccount: account,
  });
  try {
    await bridge.accept(frame('kb-bind', '查询知识库'));
    assert.equal(observed.length, 1);
    const { sessionId, ctx } = observed[0];
    assert.equal(sessionId, 'session-kb');
    assert.ok(ctx, 'a KB run context must be bound during the ask');
    assert.equal(ctx.account.botId, 'src-bot');
    assert.equal(ctx.account.secret, 's');
    assert.deepEqual(ctx.gids, ['user-7']);
    assert.equal(getYouduKbRunContext(sessionId), undefined, 'the context must be released after the ask settles');
  } finally {
    clearYouduKbRunContext();
  }
});

test('without kbAccount the bridge does not bind a KB context (fail closed at the tool)', async () => {
  const { state } = stateFixture();
  const observed = [];
  const harness = baseHarness({
    ask: async (sessionId) => {
      observed.push({ sessionId, ctx: getYouduKbRunContext(sessionId) });
      return 'answer';
    },
  });
  const bridge = new YouduBridge({ bot: makeBot(), harness, state, ownerUserId: '*', botId: 'bot-1' });
  try {
    await bridge.accept(frame('kb-none', '普通消息'));
    assert.equal(observed.length, 1);
    assert.equal(observed[0].ctx, undefined, 'no KB context must be bound without kbAccount');
  } finally {
    clearYouduKbRunContext();
  }
});
