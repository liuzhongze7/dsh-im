import assert from 'node:assert/strict';
import test from 'node:test';

import { YouduSocket } from '../../../src/channels/youdu/youdu-protocol/ws/socket.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeSocket() {
  const timers = [];
  const socket = new YouduSocket({
    wsUrl: '127.0.0.1:9999',
    botId: 'yd_000000000000000000000000',
    secret: 'secret',
    logger: silentLogger,
    hooks: {
      setTimeout: (fn, ms) => {
        const handle = { fn, ms, cancelled: false };
        timers.push(handle);
        return handle;
      },
      clearTimeout: (handle) => {
        if (handle) handle.cancelled = true;
      },
    },
  });
  socket.hasAuthenticated = true;
  socket.token = 'token';
  socket.send = () => {};
  return { socket, timers };
}

/** 排队一条回复并返回它的结算 Promise，避免依赖真实 WebSocket。 */
function enqueue(socket, reqId) {
  let settle;
  const settled = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  socket.replyQueues.set(reqId, [{ frame: { headers: {} }, ...settle }]);
  return settled;
}

test('a reply ack timeout is scheduled through the injected timer and rejects with a code', async () => {
  const { socket, timers } = makeSocket();
  const settled = enqueue(socket, 'req-1');
  socket.processReplyQueue('req-1');

  assert.equal(timers.length, 1, 'ack 计时器必须走注入的调度器，便于测试与统一取消');
  timers[0].fn();
  const error = await settled.catch((value) => value);
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'youdu-reply-ack-timeout');
  assert.match(error.message, /Reply ack timeout/);
  assert.equal(socket.pendingAcks.size, 0);
});

test('a rejected reply ack rejects with an Error carrying the protocol errcode', async () => {
  const { socket } = makeSocket();
  const settled = enqueue(socket, 'req-2');
  socket.processReplyQueue('req-2');
  socket.handleReplyAck('req-2', { errCode: 1001 });

  const error = await settled.catch((value) => value);
  assert.ok(error instanceof Error, '不能把协议帧当错误对象抛给上层');
  assert.equal(error.code, 'youdu-reply-ack-failed');
  assert.equal(error.errcode, 1001);
});

test('clearing pending replies cancels their ack timers', async () => {
  const { socket, timers } = makeSocket();
  const settled = enqueue(socket, 'req-3');
  socket.processReplyQueue('req-3');
  socket.clearPendingMessages('test');

  assert.equal(timers[0].cancelled, true, '断开时要取消 ack 计时器，避免泄漏');
  const error = await settled.catch((value) => value);
  assert.match(error.message, /cancelled/);
});
