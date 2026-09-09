import assert from 'node:assert/strict';
import test from 'node:test';

import { YouduBridge } from '../../../src/channels/youdu/youdu-bridge.mjs';
import { validateGroupAccess } from '../../../src/channels/youdu/group-access.mjs';
import { createAccessPolicy, createAccessPolicyScope } from '../../../src/channels/shared/access-policy.mjs';

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
    seen,
  };
}

function groupFrame(messageId, { chatId = 'g-1', senderId = '1001', account = 'lewis.liu', text = '群消息' } = {}) {
  return {
    headers: { reqId: `req-${messageId}` },
    body: {
      msgId: messageId,
      chatId,
      chatType: 'group',
      from: { userId: senderId, account, name: 'Sender' },
      msgType: 'text',
      text: { content: text },
      raw: { decoded: { msgType: 0, atUser: ['bot-1'] } },
    },
  };
}

function makeBot(sent = []) {
  return {
    sendReply: async (target, text) => sent.push({ target, text }),
    sendMessage: async () => {},
    downloadMedia: async () => Buffer.from('x'),
  };
}

function baseHarness(asks) {
  return {
    ensureRunning: async () => true,
    sessionExists: async () => true,
    createSession: async () => 'session-id',
    listModels: async () => ({ groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }], failures: [] }),
    ask: async () => { asks.push(1); return 'ok'; },
  };
}

function denyAllGroupsPolicy() {
  const scope = createAccessPolicyScope({
    mode: 'allowlist',
    open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
    allowlist: { users: [] },
  });
  return {
    getSettings: () => createAccessPolicy({ direct: scope, group: scope }),
    isPrivileged: () => false,
  };
}

function bridgeFor({ groupAccess, asks, sent = [], ...rest }) {
  const { state } = stateFixture();
  return new YouduBridge({
    bot: makeBot(sent),
    harness: baseHarness(asks),
    state,
    ownerUserId: '*',
    botId: 'bot-1',
    groupResponseMode: 'mention',
    groupAccess: groupAccess ? { getSettings: () => groupAccess } : undefined,
    ...rest,
  });
}

test('per-group allowlist admits listed senders and silently drops the rest', async () => {
  const asks = [];
  const groupAccess = validateGroupAccess({
    version: 1,
    groups: { 'g-1': { mode: 'allowlist', users: ['1001'] } },
  });
  // 共享策略拒绝所有群消息；按群名单应覆盖它。
  const bridge = bridgeFor({ groupAccess, asks, accessPolicy: denyAllGroupsPolicy() });

  await bridge.accept(groupFrame('ga-1', { senderId: '1001' }));
  assert.equal(asks.length, 1, 'listed sender must be processed even when the shared group policy denies');

  await bridge.accept(groupFrame('ga-2', { senderId: '2002', account: 'someone.else' }));
  assert.equal(asks.length, 1, 'unlisted sender must not reach the Harness');
  assert.equal(bridge.status.messagesRejected, 1);
  assert.equal(bridge.status.messagesReceived, 1, 'only the admitted message is counted');
});

test('per-group allowlist matches the sender account name as well', async () => {
  const asks = [];
  const groupAccess = validateGroupAccess({
    version: 1,
    groups: { 'g-1': { mode: 'allowlist', users: ['lewis.liu'] } },
  });
  const bridge = bridgeFor({ groupAccess, asks, accessPolicy: denyAllGroupsPolicy() });
  await bridge.accept(groupFrame('gb-1', { senderId: '6463894', account: 'lewis.liu' }));
  assert.equal(asks.length, 1);
});

test('per-group disabled ignores the group entirely, including the owner', async () => {
  const asks = [];
  const groupAccess = validateGroupAccess({ version: 1, groups: { 'g-1': { mode: 'disabled' } } });
  const bridge = bridgeFor({ groupAccess, asks, ownerUserId: '1001' });
  await bridge.accept(groupFrame('gc-1', { senderId: '1001' }));
  assert.equal(asks.length, 0);
  assert.equal(bridge.status.messagesRejected, 1);
});

test('per-group open admits everyone while unconfigured groups keep the shared policy', async () => {
  const asks = [];
  const groupAccess = validateGroupAccess({ version: 1, groups: { 'g-open': { mode: 'open' } } });
  const bridge = bridgeFor({ groupAccess, asks, accessPolicy: denyAllGroupsPolicy() });

  await bridge.accept(groupFrame('gd-1', { chatId: 'g-open', senderId: '9999', account: 'nobody' }));
  assert.equal(asks.length, 1, 'open group admits any sender');

  await bridge.accept(groupFrame('gd-2', { chatId: 'g-other', senderId: '9999', account: 'nobody' }));
  assert.equal(asks.length, 1, 'other groups still follow the shared group policy');
  assert.equal(bridge.status.messagesRejected, 1);
});

test('wildcard rule applies to every group without a specific entry', async () => {
  const asks = [];
  const groupAccess = validateGroupAccess({
    version: 1,
    groups: { '*': { mode: 'allowlist', users: ['1001'] }, 'g-2': { mode: 'open' } },
  });
  const bridge = bridgeFor({ groupAccess, asks, accessPolicy: denyAllGroupsPolicy() });

  await bridge.accept(groupFrame('ge-1', { chatId: 'g-3', senderId: '1001' }));
  assert.equal(asks.length, 1);
  await bridge.accept(groupFrame('ge-2', { chatId: 'g-3', senderId: '2002', account: 'nobody' }));
  assert.equal(asks.length, 1, 'wildcard allowlist still filters unlisted senders');
  await bridge.accept(groupFrame('ge-3', { chatId: 'g-2', senderId: '2002', account: 'nobody' }));
  assert.equal(asks.length, 2, 'an exact entry overrides the wildcard');
});

test('commands from an allowlisted group still need the shared command permission', async () => {
  const asks = [];
  const sent = [];
  const groupAccess = validateGroupAccess({
    version: 1,
    groups: { 'g-1': { mode: 'allowlist', users: ['1001'] } },
  });
  const closedScope = createAccessPolicyScope({
    mode: 'open',
    open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
    allowlist: { users: [] },
  });
  const bridge = bridgeFor({
    groupAccess,
    asks,
    sent,
    ownerUserId: '9999',
    accessPolicy: {
      getSettings: () => createAccessPolicy({ direct: closedScope, group: closedScope }),
      isPrivileged: () => false,
    },
  });

  await bridge.accept(groupFrame('gf-1', { text: '/models' }));
  assert.equal(asks.length, 0);
  assert.equal(sent.some(({ text }) => text.includes('没有执行命令的权限')), true);

  // 普通消息不受命令权限影响，仍按名单放行。
  await bridge.accept(groupFrame('gf-2', { text: '普通消息' }));
  assert.equal(asks.length, 1);
});

test('observed groups are reported through onGroupSeen', async () => {
  const asks = [];
  const observed = [];
  const bridge = bridgeFor({ asks, onGroupSeen: (chatId) => observed.push(chatId) });
  await bridge.accept(groupFrame('gg-1', { chatId: 'g-observed' }));
  await bridge.accept(groupFrame('gg-2', { chatId: 'g-observed' }));
  assert.deepEqual(observed, ['g-observed', 'g-observed']);
});
