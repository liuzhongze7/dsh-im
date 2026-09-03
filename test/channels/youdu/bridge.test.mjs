import assert from 'node:assert/strict';
import test from 'node:test';
import { YouduBridge } from '../../../src/channels/youdu/youdu-bridge.mjs';
import { createAccessPolicy, createAccessPolicyScope } from '../../../src/channels/shared/access-policy.mjs';

function stateFixture(initialSessions = []) {
  const sessions = new Map(initialSessions);
  const seen = new Set();
  const state = {
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => seen.add(id),
    sessionFor: (key) => sessions.get(key) ?? null,
    setSession: async (key, sessionId) => sessions.set(key, sessionId),
    clearSession: async (key) => sessions.delete(key),
  };
  return { state, sessions, seen };
}

function frame(messageId, text, overrides = {}) {
  const body = {
    msgId: messageId,
    chatId: 'chat-1',
    chatType: 'single',
    from: { userId: 'owner-1', name: 'Owner' },
    msgType: 'text',
    text: { content: text },
    ...overrides,
  };
  return { headers: { reqId: `req-${messageId}` }, body };
}

function makeBot(sent = []) {
  return {
    sendReply: async (target, text) => sent.push({ target, text }),
    sendMessage: async () => {},
    downloadMedia: async () => Buffer.from('x'),
  };
}

function baseHarness(overrides = {}) {
  return {
    ensureRunning: async () => true,
    sessionExists: async () => true,
    createSession: async () => 'session-id',
    listModels: async () => ({ groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }], failures: [] }),
    ask: async () => 'mock answer',
    ...overrides,
  };
}

function ownerOnlyPolicy(owner) {
  const scope = createAccessPolicyScope({
    mode: 'open',
    open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [{ id: owner, canExecuteCommands: true }] },
    allowlist: { users: [{ id: owner, canExecuteCommands: true }] },
  });
  return {
    getSettings: () => createAccessPolicy({ direct: scope, group: scope }),
    isPrivileged: (senders) => (Array.isArray(senders) ? senders : [senders]).some((s) => String(s) === owner),
  };
}

// G1: acceptedMessageIds is released on every path (batch command, non-addressed
// group, ordinary message), so the bot keeps processing subsequent messages and
// in-flight redelivery is still deduped.
test('acceptedMessageIds are released so many mixed messages keep processing', async () => {
  const { state, seen } = stateFixture();
  const sent = [];
  const asks = [];
  const harness = baseHarness({ ask: async () => { asks.push(1); return 'ok'; } });
  const bridge = new YouduBridge({ bot: makeBot(sent), harness, state, ownerUserId: '*', botId: 'bot-1' });

  // A non-addressed group message early-returns in #process.
  await bridge.accept(frame('g-unaddressed', '群消息', {
    chatType: 'group', chatId: 'g-1', from: { userId: 'm-9', name: 'M' },
    raw: { decoded: { msgType: 0, atUser: [999] } },
  }));
  // A batch command (private) that submits through the session.
  await bridge.accept(frame('b-start', '/batch'));
  await bridge.accept(frame('b-1', '第一条'));
  await bridge.accept(frame('b-send', '/send'));
  // Ordinary messages keep working afterward.
  await bridge.accept(frame('o-1', '普通消息1'));
  await bridge.accept(frame('o-2', '普通消息2'));
  assert.equal(asks.length >= 3, true);
  assert.equal(seen.has('o-2'), true);
});

test('in-flight redelivery is deduped via acceptedMessageIds (G1/F2)', async () => {
  const { state } = stateFixture();
  const sent = [];
  const asks = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const harness = baseHarness({ ask: async () => { asks.push(1); await gate; return 'done'; } });
  const bridge = new YouduBridge({ bot: makeBot(sent), harness, state, ownerUserId: '*' });
  const p1 = bridge.accept(frame('dup-1', '第一条'));
  const p2 = bridge.accept(frame('dup-1', '第一条')); // redelivery while in-flight
  release();
  await Promise.all([p1, p2]);
  assert.equal(asks.length, 1);
});

// G3: group @ addressing with mention (strict) and all modes.
test('mention mode processes group only when atUser hits the bot', async () => {
  const { state } = stateFixture();
  const sent = [];
  const asks = [];
  const harness = baseHarness({ ask: async () => { asks.push(1); return 'group reply'; } });
  const bridge = new YouduBridge({ bot: makeBot(sent), harness, state, ownerUserId: '*', botId: 'bot-1', groupResponseMode: 'mention' });
  await bridge.accept(frame('m1', '群消息', {
    chatType: 'group', chatId: 'g-1', from: { userId: 'm-9', name: 'M' },
    raw: { decoded: { msgType: 0, atUser: [999] } },
  }));
  assert.equal(asks.length, 0, 'unmentioned group message must not be processed in mention mode');
  await bridge.accept(frame('m2', '群消息', {
    chatType: 'group', chatId: 'g-1', from: { userId: 'm-9', name: 'M' },
    raw: { decoded: { msgType: 0, atUser: ['bot-1'] } },
  }));
  assert.equal(asks.length, 1);
  assert.match(sent.at(-1).text, /group reply/);
});

test('all mode processes every group message even when atUser is empty', async () => {
  const { state } = stateFixture();
  const sent = [];
  const asks = [];
  const harness = baseHarness({ ask: async () => { asks.push(1); return 'group reply'; } });
  const bridge = new YouduBridge({ bot: makeBot(sent), harness, state, ownerUserId: '*', botId: 'bot-1', groupResponseMode: 'all' });
  await bridge.accept(frame('a1', '群消息', {
    chatType: 'group', chatId: 'g-1', from: { userId: 'm-9', name: 'M' },
    raw: { decoded: { msgType: 0, atUser: [] } },
  }));
  assert.equal(asks.length, 1);
});

// G2: closed default (owner unconfigured → commands denied with guidance hint);
// a configured owner may execute commands.
test('closed default denies commands without an owner and gives a guidance hint, while a configured owner can execute', async () => {
  const { state } = stateFixture();
  const sent = [];
  const asks = [];
  const harness = baseHarness({ ask: async () => { asks.push(1); return 'x'; } });
  const closedScope = createAccessPolicyScope({
    mode: 'open',
    open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
    allowlist: { users: [] },
  });
  const closedPolicy = {
    getSettings: () => createAccessPolicy({ direct: closedScope, group: closedScope }),
    isPrivileged: () => false,
  };

  // owner unconfigured ('*') + closed default → command denied + guidance hint.
  const bridge = new YouduBridge({ bot: makeBot(sent), harness, state, ownerUserId: '*', accessPolicy: closedPolicy });
  await bridge.accept(frame('g2-denied', '/models', { from: { userId: 'anyone' } }));
  assert.equal(asks.length, 0);
  assert.match(sent.at(-1).text, /未配置所有者/);
  assert.match(sent.at(-1).text, /配置 ownerUserId/);

  // owner='owner-1' + owner-only policy → non-owner denied (generic), owner allowed.
  const ownerSent = [];
  const ownerBot = makeBot(ownerSent);
  const ownerBridge = new YouduBridge({ bot: ownerBot, harness, state, ownerUserId: 'owner-1', accessPolicy: ownerOnlyPolicy('owner-1') });
  await ownerBridge.accept(frame('owner-cmd-denied', '/models', { from: { userId: 'someone-else' } }));
  assert.equal(ownerSent.some(({ text }) => text.includes('没有执行命令的权限')), true);
  await ownerBridge.accept(frame('owner-cmd-allowed', '/models', { from: { userId: 'owner-1' } }));
  assert.match(ownerSent.at(-1).text, /p\/m/);
});

// contextEnhancement channel field output (F4 regression).
test('context enhancement emits the youdu channel field when enabled', async () => {
  const { state } = stateFixture();
  const sent = [];
  let prompt;
  const harness = baseHarness({ ask: async (_s, content) => { prompt = content; return 'ok'; } });
  const contextEnhancement = {
    botId: 'bot-1',
    getSettings: () => ({
      direct: { enabled: true, fields: ['channel', 'senderId'], guidance: '' },
      group: { enabled: false, fields: ['senderId'], guidance: '' },
    }),
  };
  const bridge = new YouduBridge({ bot: makeBot(sent), harness, state, ownerUserId: '*', contextEnhancement });
  await bridge.accept(frame('ctx', '分析'));
  assert.ok(prompt.includes('<dsh_im_source>'));
  assert.match(prompt, /"channel":"youdu"/);
});

// batch /send submits a combined prompt via the session (G1 batch scenario).
test('batch collect then /send submits a combined prompt to the session', async () => {
  const { state } = stateFixture();
  const sent = [];
  const asks = [];
  const harness = baseHarness({ ask: async (_s, content) => { asks.push(content); return 'batch ok'; } });
  const bridge = new YouduBridge({ bot: makeBot(sent), harness, state, ownerUserId: '*' });
  await bridge.accept(frame('b-2', '/batch'));
  assert.match(sent.at(-1).text, /已进入批量输入模式/);
  await bridge.accept(frame('b-2-1', '第一条'));
  await bridge.accept(frame('b-2-2', '第二条'));
  const submission = await bridge.accept(frame('b-2-send', '/send'));
  assert.equal(asks.length, 1);
  assert.match(asks[0], /批量输入模式/);
  assert.match(asks[0], /第一条/);
  assert.match(asks[0], /第二条/);
  assert.deepEqual(await submission, undefined);
});
