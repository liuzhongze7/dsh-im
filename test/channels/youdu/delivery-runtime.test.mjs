import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { YouduRuntime } from '../../../src/channels/youdu/youdu-runtime.mjs';

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
