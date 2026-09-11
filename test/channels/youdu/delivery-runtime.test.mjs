import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { YouduRuntime } from '../../../src/channels/youdu/youdu-runtime.mjs';
import { getYouduOutboundRoute } from '../../../src/channels/youdu/send-tool.mjs';

class FakeSocket extends EventEmitter {
  sent = [];
  connected = false;
  connect() {
    this.connected = true;
    queueMicrotask(() => this.emit('authenticated'));
  }
  disconnect() { this.connected = false; }
  getToken() { return 'token-1'; }
  getGid() { return '6463898'; }
  sendReply(reqId, body) { this.sent.push({ kind: 'reply', reqId, body }); return Promise.resolve({}); }
  sendMessage(chatId, body) { this.sent.push({ kind: 'message', chatId, body }); return Promise.resolve({}); }
}

function fakeState() {
  const seen = new Set();
  return {
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => seen.add(id),
    sessionFor: () => null,
    setSession: async () => {},
    clearSession: async () => {},
    clearSessions: async () => {},
  };
}

async function startedRuntime() {
  const socket = new FakeSocket();
  const runtime = new YouduRuntime({
    config: { botId: 'yd_bot', wsHost: 'push.example.com' },
    secret: 'secret-1',
    harness: { ensureRunning: async () => true },
    state: fakeState(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    connectTimeoutMs: 1_000,
    createSocket: () => socket,
  });
  await runtime.start();
  return { runtime, socket };
}

test('youdu runtime sends proactive text through send_msg with the route chatId', async () => {
  const { runtime, socket } = await startedRuntime();
  assert.deepEqual(await runtime.sendProactiveText({
    kind: 'group',
    route: { chatId: '{0798E01E-CD68-42BB-813C-EB51593BB0F5}' },
  }, '主动投递'), { sent: true });
  assert.deepEqual(socket.sent.at(-1), {
    kind: 'message',
    chatId: '{0798E01E-CD68-42BB-813C-EB51593BB0F5}',
    // chatType 必须显式声明，否则服务端按单聊投递（wss_outbound.go:207-219）。
    body: { chatType: 'group', msgType: 'text', text: { content: '主动投递' } },
  });

  // 单聊：chatId 就是对方用户 ID。
  await runtime.sendProactiveText({ kind: 'user', route: { chatId: '6463894' } }, 'hi');
  assert.deepEqual(socket.sent.at(-1), {
    kind: 'message',
    chatId: '6463894',
    body: { chatType: 'single', msgType: 'text', text: { content: 'hi' } },
  });
  await runtime.stop();
});

test('youdu connection test sends a well-formed single-chat text frame', async () => {
  const socket = new FakeSocket();
  const runtime = new YouduRuntime({
    config: { botId: 'yd_bot', wsHost: 'push.example.com', ownerUserId: '6463894' },
    secret: 'secret-1',
    harness: { ensureRunning: async () => true },
    state: fakeState(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    connectTimeoutMs: 1_000,
    createSocket: () => socket,
  });
  await runtime.start();
  assert.deepEqual(await runtime.sendConnectionTest('连接测试'), { sent: true });
  assert.deepEqual(socket.sent.at(-1), {
    kind: 'message',
    chatId: '6463894',
    // 连接测试也必须发合规文本帧，而不是把字符串当 body。
    body: { chatType: 'single', msgType: 'text', text: { content: '连接测试' } },
  });
  await runtime.stop();
});

test('youdu runtime rejects malformed proactive targets and disconnected bots', async () => {
  const { runtime, socket } = await startedRuntime();
  for (const target of [
    { kind: 'topic', route: { chatId: '1' } },
    { kind: 'group', route: {} },
    { kind: 'group', route: { chatId: '   ' } },
    { kind: 'group' },
    { route: { chatId: '1' } },
    // 旧形状（扁平 chatId）必须被拒，避免与框架的 route.chatId 契约漂移。
    { kind: 'group', chatId: '1' },
  ]) {
    await assert.rejects(
      () => runtime.sendProactiveText(target, 'x'),
      { code: 'invalid-target' },
    );
  }
  assert.equal(socket.sent.length, 0);
  await runtime.stop();

  await assert.rejects(
    () => runtime.sendProactiveText({ kind: 'group', route: { chatId: '1' } }, 'x'),
    { code: 'bot-not-connected' },
  );
});

test('youdu runtime surfaces send_msg failures as delivery-failed', async () => {
  const { runtime, socket } = await startedRuntime();
  socket.sendMessage = () => Promise.reject(new Error('socket closed'));
  await assert.rejects(
    () => runtime.sendProactiveText({ kind: 'group', route: { chatId: '1' } }, 'x'),
    { code: 'delivery-failed' },
  );
  await runtime.stop();
});

function groupFrame(messageId, text, atUser = []) {
  return {
    headers: { reqId: `req-${messageId}` },
    body: {
      msgId: messageId,
      chatId: 'g-1',
      chatType: 'group',
      from: { userId: '10086', name: '张三' },
      msgType: 'text',
      text: { content: text },
      raw: { decoded: { msgType: 0, atUser } },
    },
  };
}

async function waitFor(predicate, attempts = 400) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error('timed out waiting for the runtime to settle');
}

test('youdu runtime carries pending group context into the next mention', async () => {
  const socket = new FakeSocket();
  const contents = [];
  const runtime = new YouduRuntime({
    config: { botId: 'yd_bot', wsHost: 'push.example.com' },
    secret: 'secret-1',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => 'session-1',
      ask: async (sessionId, content) => { contents.push(content); return 'answer'; },
    },
    state: fakeState(),
    botId: 'yd_bot',
    groupHistory: { botId: 'yd_bot', getSettings: () => ({ enabled: true, limit: 50 }) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    connectTimeoutMs: 1_000,
    createSocket: () => socket,
  });
  await runtime.start();
  socket.emit('message', groupFrame('m1', '下午三点评审'));
  socket.emit('message', groupFrame('m2', '帮我总结', ['yd_bot']));
  await waitFor(() => contents.length === 1);
  assert.match(contents[0], /下午三点评审/);
  assert.match(contents[0], /\[Current message - respond to this\]\n帮我总结$/);
  await waitFor(() => socket.sent.some(({ kind }) => kind === 'reply'));
  await runtime.stop();
});

// --- 出站可靠性：respond_msg 失败后的 send_msg 降级 -------------------------
// 服务端的回调上下文只按 LRU 淘汰、没有 TTL（ng_bot runtime_cache.go），
// 长回合或拥挤群里 respond_msg 会失败，而原来既没有降级路径也没有任何日志。

async function mentionRuntime({ ensureRunning } = {}) {
  const socket = new FakeSocket();
  const runtime = new YouduRuntime({
    config: { botId: 'yd_bot', wsHost: 'push.example.com' },
    secret: 'secret-1',
    harness: {
      ensureRunning: ensureRunning ?? (async () => true),
      sessionExists: async () => true,
      createSession: async () => 'session-1',
      ask: async () => 'answer',
    },
    state: fakeState(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    connectTimeoutMs: 1_000,
    createSocket: () => socket,
  });
  await runtime.start();
  return { runtime, socket };
}

test('youdu runtime falls back to send_msg in the group when respond_msg fails', async () => {
  const { runtime, socket } = await mentionRuntime();
  socket.sendReply = () => Promise.reject(
    new Error('Reply ack timeout (5000ms) for reqId: req-m1'),
  );

  socket.emit('message', groupFrame('m1', '帮我总结', ['yd_bot']));
  await waitFor(() => socket.sent.some(({ kind }) => kind === 'message'));

  assert.deepEqual(socket.sent.at(-1), {
    kind: 'message',
    chatId: 'g-1',
    // 群聊必须显式声明 chatType，否则服务端按单聊把群 ID 当用户 ID（wss_outbound.go:207-219）。
    body: { chatType: 'group', msgType: 'text', text: { content: 'answer' } },
  });
  const status = runtime.status;
  assert.equal(status.replyFallbacks, 1);
  assert.ok(status.firstReplyFallbackAt);
  assert.ok(status.lastReplyFallbackAt);
  assert.match(status.lastReplyFallbackReason, /ack timeout/i);
  assert.equal(status.lastReplyFallbackError, null);
  await runtime.stop();
});

test('youdu runtime falls back to send_msg in a direct chat when respond_msg fails', async () => {
  const { runtime, socket } = await mentionRuntime();
  socket.sendReply = () => Promise.reject({ errCode: 1001, errMsg: 'callback context not found' });

  socket.emit('message', {
    headers: { reqId: 'req-d1' },
    body: {
      msgId: 'd1',
      chatId: '6463894',
      chatType: 'single',
      from: { userId: '6463894', name: '刘钟泽' },
      msgType: 'text',
      text: { content: '你好' },
      raw: { decoded: { msgType: 0 } },
    },
  });
  await waitFor(() => socket.sent.some(({ kind }) => kind === 'message'));

  assert.deepEqual(socket.sent.at(-1), {
    kind: 'message',
    // 单聊的接收方是发消息的人，而不是会话 ID 之外的任何东西。
    chatId: '6463894',
    body: { chatType: 'single', msgType: 'text', text: { content: 'answer' } },
  });
  assert.equal(runtime.status.replyFallbacks, 1);
  assert.match(runtime.status.lastReplyFallbackReason, /1001: callback context not found/);
  await runtime.stop();
});

test('youdu runtime refuses to answer the bot itself when the callback route is gone', async () => {
  const socket = new FakeSocket();
  const runtime = new YouduRuntime({
    // sourceBotId 是有度侧的机器人账号：它出现在会话里时，回复降级必须被拒绝而不是自问自答。
    config: { botId: 'yd_bot', sourceBotId: 'oc86aed821c86345e4', wsHost: 'push.example.com' },
    secret: 'secret-1',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => 'session-1',
      ask: async () => 'answer',
    },
    state: fakeState(),
    botId: 'oc86aed821c86345e4',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    connectTimeoutMs: 1_000,
    createSocket: () => socket,
  });
  await runtime.start();
  socket.sendReply = () => Promise.reject(new Error('callback context not found'));

  socket.emit('message', {
    headers: { reqId: 'req-d2' },
    body: {
      msgId: 'd2',
      chatId: 'oc86aed821c86345e4',
      chatType: 'single',
      from: { userId: 'oc86aed821c86345e4', name: 'lewis.liu的智能机器人' },
      msgType: 'text',
      text: { content: 'loop' },
      raw: { decoded: { msgType: 0 } },
    },
  });
  await waitFor(() => runtime.status.lastReplyFallbackError !== null);

  assert.equal(
    socket.sent.some(({ kind }) => kind === 'message'),
    false,
    'self-addressed replies must never be sent with send_msg',
  );
  assert.equal(runtime.status.replyFallbacks, 0);
  assert.match(runtime.status.lastReplyFallbackError, /no fallback route/i);
  await runtime.stop();
});

test('youdu runtime keeps a doubly-failed reply visible instead of dropping it', async () => {
  const { runtime, socket } = await mentionRuntime();
  socket.sendReply = () => Promise.reject(new Error('callback context not found'));
  socket.sendMessage = () => Promise.reject(new Error('WebSocket not connected, unable to send data'));

  socket.emit('message', groupFrame('m2', '群里再问一次', ['yd_bot']));
  await waitFor(() => runtime.status.lastReplyFallbackError !== null);

  assert.equal(runtime.status.replyFallbacks, 0, 'fallback that also failed is not counted as recovered');
  assert.match(
    runtime.status.lastReplyFallbackError,
    /callback context not found -> send_msg: WebSocket not connected/,
  );
  await runtime.stop();
});

test('youdu runtime exposes the bound session outbound route for explicit sends', async () => {
  const socket = new FakeSocket();
  const runtime = new YouduRuntime({
    // botId 是群消息 @ 判定用的机器人标识（有度 @ 里就是机器人账号）。
    config: { botId: 'oc-bot', sourceBotId: 'oc-bot', wsHost: 'push.example.com' },
    secret: 'secret-1',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => 'session-42',
      ask: async () => 'answer',
    },
    state: {
      ...fakeState(),
      // 会话已经与这个群绑定：出站绑定要能立刻登记，供 dsh_im_send_to_youdu 使用。
      sessionFor: () => 'session-42',
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    connectTimeoutMs: 1_000,
    createSocket: () => socket,
  });
  await runtime.start();

  socket.emit('message', groupFrame('m9', '帮我发个东西', ['oc-bot']));
  await waitFor(() => getYouduOutboundRoute('session-42') !== undefined);

  const binding = getYouduOutboundRoute('session-42');
  assert.equal(binding.kind, 'group');
  await binding.sendText('显式发回群里');
  assert.deepEqual(socket.sent.at(-1), {
    kind: 'message',
    chatId: 'g-1',
    body: { chatType: 'group', msgType: 'text', text: { content: '显式发回群里' } },
  });

  // 断开后绑定必须释放：停用的机器人不能再往有度发。
  await runtime.stop();
  assert.equal(getYouduOutboundRoute('session-42'), undefined);
});
