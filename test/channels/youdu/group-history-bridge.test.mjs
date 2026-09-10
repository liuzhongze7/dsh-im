import assert from 'node:assert/strict';
import test from 'node:test';

import { YouduBridge } from '../../../src/channels/youdu/youdu-bridge.mjs';

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

function groupFrame(messageId, text, {
  chatId = 'g-1', userId = 'member-1', name = '成员一', account, atUser = [], createTime = 1_700_000_000_000,
} = {}) {
  return frame(messageId, text, {
    chatId,
    chatType: 'group',
    from: { userId, name, ...(account ? { account } : {}) },
    createTime,
    raw: { decoded: { msgType: 0, atUser } },
  });
}

function makeBot(sent = []) {
  return {
    sendReply: async (target, text) => sent.push({ target, text }),
    sendMessage: async () => {},
    downloadMedia: async () => Buffer.from('x'),
  };
}

function baseHarness({ contents = [], gate } = {}) {
  return {
    ensureRunning: async () => true,
    sessionExists: async () => true,
    createSession: async () => 'session-id',
    ask: async (sessionId, content) => {
      contents.push(content);
      if (gate) await gate;
      return 'mock answer';
    },
  };
}

function bridgeWith(harness, options = {}) {
  const { state } = stateFixture();
  return new YouduBridge({
    bot: makeBot([]),
    harness,
    state,
    ownerUserId: '*',
    botId: 'bot-1',
    groupResponseMode: 'mention',
    ...options,
  });
}

test('group messages that did not address the bot become context for the next mention', async () => {
  const contents = [];
  const bridge = bridgeWith(baseHarness({ contents }));
  await bridge.accept(groupFrame('h-1', '下午三点评审', { userId: 'm-1', name: '张三', createTime: 1_700_000_000_000 }));
  await bridge.accept(groupFrame('h-2', '我参加', { userId: 'm-2', name: '李四', createTime: 1_700_000_060_000 }));
  await bridge.accept(groupFrame('h-3', '会议室 A', { userId: 'm-3', name: '王五', createTime: 1_700_000_120_000 }));
  assert.equal(contents.length, 0, 'messages without a mention must not reach the model');

  await bridge.accept(groupFrame('ask-1', '帮我整理一下', { atUser: ['bot-1'], createTime: 1_700_000_180_000 }));
  assert.equal(contents.length, 1);
  const content = contents[0];
  assert.match(content, /^<dsh_im_group_history note="[^"]+">/);
  assert.match(content, /\n<\/dsh_im_group_history>\n\n\[Current message - respond to this\]\n帮我整理一下$/);
  assert.match(content, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 张三: 下午三点评审/);
  assert.match(content, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 李四: 我参加/);
  assert.match(content, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 王五: 会议室 A/);
  // 旧到新：第一条在最前，最后一条最靠近当前消息。
  assert.equal(content.indexOf('张三') < content.indexOf('李四'), true);
  assert.equal(content.indexOf('李四') < content.indexOf('王五'), true);

  // 回合结束后上下文被消费：下一条 @ 消息不再重复带上同一批群消息。
  await bridge.accept(groupFrame('ask-2', '再来一次', { atUser: ['bot-1'], createTime: 1_700_000_240_000 }));
  assert.equal(contents.length, 2);
  assert.equal(contents[1], '再来一次');
});

test('the mention that triggered the turn is not stored as context itself', async () => {
  const contents = [];
  const bridge = bridgeWith(baseHarness({ contents }));
  await bridge.accept(groupFrame('ask-1', '第一条 @', { atUser: ['bot-1'] }));
  await bridge.accept(groupFrame('ask-2', '第二条 @', { atUser: ['bot-1'] }));
  assert.deepEqual(contents, ['第一条 @', '第二条 @']);
});

test('messages that arrive while the turn runs stay for the next turn', async () => {
  const contents = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = bridgeWith(baseHarness({ contents, gate }));
  await bridge.accept(groupFrame('h-1', '开工前的讨论', { userId: 'm-1', name: '张三' }));
  const turn = bridge.accept(groupFrame('ask-1', '开始吧', { atUser: ['bot-1'] }));
  // 等到回合确实开始（快照已取走）以后再让群里继续说话。
  while (contents.length === 0) await new Promise((resolve) => { setImmediate(resolve); });
  // accept 里同步记录这条消息，但它要排队等当前回合结束才被处理。
  const queued = bridge.accept(groupFrame('h-2', '补充一句', { userId: 'm-2', name: '李四' }));
  release();
  await turn;
  await queued;
  assert.match(contents[0], /开工前的讨论/);

  await bridge.accept(groupFrame('ask-2', '继续', { atUser: ['bot-1'] }));
  assert.match(contents[1], /补充一句/);
  assert.equal(contents[1].includes('开工前的讨论'), false, 'consumed context must not be injected twice');
});

test('only the newest messages within the configured limit are injected', async () => {
  const contents = [];
  const bridge = bridgeWith(baseHarness({ contents }), { groupHistory: { enabled: true, limit: 2 } });
  for (let index = 1; index <= 4; index += 1) {
    await bridge.accept(groupFrame(`h-${index}`, `消息${index}`, { userId: `m-${index}`, name: `成员${index}` }));
  }
  await bridge.accept(groupFrame('ask-1', '总结', { atUser: ['bot-1'] }));
  const content = contents[0];
  assert.equal(content.includes('消息4'), true);
  assert.equal(content.includes('消息3'), true);
  assert.equal(content.includes('消息2'), false);
  assert.equal(content.includes('消息1'), false);
});

test('a disabled cache neither stores group messages nor injects one', async () => {
  for (const groupHistory of [{ enabled: false, limit: 50 }, { enabled: true, limit: 0 }]) {
    const contents = [];
    const bridge = bridgeWith(baseHarness({ contents }), { groupHistory });
    await bridge.accept(groupFrame('h-1', '不应缓存', { userId: 'm-1', name: '张三' }));
    await bridge.accept(groupFrame('ask-1', '在吗', { atUser: ['bot-1'] }));
    assert.deepEqual(contents, ['在吗'], `unexpected content for ${JSON.stringify(groupHistory)}`);
  }
});

test('a sender the group allowlist rejects is not cached, while an allowed mention still works', async () => {
  const contents = [];
  const sent = [];
  const bridge = bridgeWith(baseHarness({ contents }), {
    bot: makeBot(sent),
    groupAccess: {
      getSettings: () => ({ version: 1, groups: { 'g-1': { mode: 'allowlist', users: ['owner-1'] } } }),
    },
  });
  await bridge.accept(groupFrame('h-1', '名单外的消息', { userId: 'm-9', name: '路人' }));
  await bridge.accept(groupFrame('ask-1', '在吗', { userId: 'owner-1', name: 'Owner', atUser: ['bot-1'] }));
  assert.deepEqual(contents, ['在吗'], 'a rejected sender must not leak into the injected context');
});

test('a disabled group neither reaches the model nor caches its messages', async () => {
  const contents = [];
  const sent = [];
  const state = stateFixture();
  const bridge = new YouduBridge({
    bot: makeBot(sent),
    harness: baseHarness({ contents }),
    state: state.state,
    ownerUserId: '*',
    botId: 'bot-1',
    groupAccess: {
      getSettings: () => ({ version: 1, groups: { 'g-1': { mode: 'disabled' } } }),
    },
  });
  await bridge.accept(groupFrame('h-1', '这个群被关掉了', { userId: 'm-1', name: '张三' }));
  await bridge.accept(groupFrame('ask-1', '在吗', { atUser: ['bot-1'] }));
  assert.deepEqual(contents, []);
  assert.deepEqual(sent, []);
  assert.equal(bridge.status.messagesRejected, 1);
});

test('a per-group allowlist only caches members it allows', async () => {
  const contents = [];
  const bridge = bridgeWith(baseHarness({ contents }), {
    groupAccess: {
      getSettings: () => ({ version: 1, groups: { 'g-1': { mode: 'allowlist', users: ['zhangsan'] } } }),
    },
  });
  await bridge.accept(groupFrame('h-1', '名单内成员', { userId: '10086', account: 'zhangsan', name: '张三' }));
  await bridge.accept(groupFrame('h-2', '名单外成员', { userId: '10087', account: 'luren', name: '路人' }));
  await bridge.accept(groupFrame('ask-1', '在吗', {
    userId: '10086', account: 'zhangsan', name: '张三', atUser: ['bot-1'],
  }));
  assert.match(contents[0], /名单内成员/);
  assert.equal(contents[0].includes('名单外成员'), false);
});

test('the direct chat path never carries group context', async () => {
  const contents = [];
  const bridge = bridgeWith(baseHarness({ contents }));
  await bridge.accept(frame('g-1', '群里没 @ 的消息', {
    chatId: 'g-1', chatType: 'group', from: { userId: 'm-1', name: '张三' },
    raw: { decoded: { msgType: 0, atUser: [] } },
  }));
  await bridge.accept(frame('d-1', '私聊消息', { from: { userId: 'owner-1', name: 'Owner' } }));
  assert.deepEqual(contents, ['私聊消息']);
});

test('a live settings provider changes behaviour without reconnecting the bot', async () => {
  const contents = [];
  let settings = { enabled: true, limit: 50 };
  const bridge = bridgeWith(baseHarness({ contents }), {
    groupHistory: { botId: 'bot-1', getSettings: () => settings },
  });
  await bridge.accept(groupFrame('h-1', '开启时的消息', { userId: 'm-1', name: '张三' }));
  await bridge.accept(groupFrame('ask-1', '第一次', { atUser: ['bot-1'] }));
  assert.match(contents[0], /开启时的消息/);

  settings = { enabled: false, limit: 50 };
  await bridge.accept(groupFrame('h-2', '关闭后的消息', { userId: 'm-1', name: '张三' }));
  await bridge.accept(groupFrame('ask-2', '第二次', { atUser: ['bot-1'] }));
  assert.equal(contents[1], '第二次');

  settings = { enabled: true, limit: 50 };
  await bridge.accept(groupFrame('ask-3', '第三次', { atUser: ['bot-1'] }));
  assert.equal(contents[2], '第三次', 'a re-enabled cache must not resurrect messages from the disabled window');
});

test('a settings provider that throws fails closed', async () => {
  const contents = [];
  const bridge = bridgeWith(baseHarness({ contents }), {
    groupHistory: { botId: 'bot-1', getSettings: () => { throw new Error('settings unavailable'); } },
  });
  await bridge.accept(groupFrame('h-1', '不应缓存', { userId: 'm-1', name: '张三' }));
  await bridge.accept(groupFrame('ask-1', '在吗', { atUser: ['bot-1'] }));
  assert.deepEqual(contents, ['在吗']);
});

test('redelivered group messages are not buffered twice', async () => {
  const contents = [];
  const bridge = bridgeWith(baseHarness({ contents }));
  await bridge.accept(groupFrame('h-1', '只应出现一次', { userId: 'm-1', name: '张三' }));
  await bridge.accept(groupFrame('h-1', '只应出现一次', { userId: 'm-1', name: '张三' }));
  await bridge.accept(groupFrame('ask-1', '在吗', { atUser: ['bot-1'] }));
  assert.equal(contents[0].match(/只应出现一次/g).length, 1);
});

test('group context and the context-enhancement source block coexist', async () => {
  const contents = [];
  const bridge = bridgeWith(baseHarness({ contents }), {
    contextEnhancement: {
      botId: 'bot-1',
      getSettings: () => ({
        group: { enabled: true, fields: ['channel', 'senderName'], guidance: '' },
        direct: { enabled: false, fields: [], guidance: '' },
      }),
    },
  });
  await bridge.accept(groupFrame('h-1', '讨论内容', { userId: 'm-1', name: '张三' }));
  await bridge.accept(groupFrame('ask-1', '总结', { atUser: ['bot-1'] }));
  const content = contents[0];
  assert.match(content, /^<dsh_im_group_history/);
  assert.match(content, /<dsh_im_source>\{"channel":"youdu","senderName":"成员一"\}<\/dsh_im_source>/);
  assert.match(content, /\[Current message - respond to this\]\n<dsh_im_source>/);
});
