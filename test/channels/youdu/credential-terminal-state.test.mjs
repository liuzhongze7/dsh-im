import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { YouduConfigStore } from '../../../src/channels/youdu/config-store.mjs';
import { YouduController } from '../../../src/channels/youdu/youdu-controller.mjs';
import { isYouduCredentialRejection } from '../../../src/channels/youdu/youdu-runtime.mjs';
import { createConnectionSupervisor } from '../../../plugin-src/host/channels/youdu/connection-supervisor.mjs';

function credentials() {
  const values = new Map();
  return {
    async resolve(ref) { return values.has(ref) ? { value: values.get(ref) } : null; },
    async set(ref, value) { values.set(ref, value); },
    async unset(ref) { values.delete(ref); },
  };
}

async function withController(createRuntime, run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-youdu-credentials-'));
  try {
    const configStore = await new YouduConfigStore(join(dir, 'config.json')).load();
    const controller = new YouduController({
      credentials: credentials(),
      configStore,
      createRuntime,
      logger: { info() {}, warn() {}, error() {} },
    });
    await run({ controller, configStore });
    await controller.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a rejected bot secret stops automatic retries and reports a terminal error', async () => {
  const created = [];
  let attempts = 0;
  await withController(async () => {
    attempts += 1;
    return {
      async start() {
        const error = new Error('Authentication failed: invalid secret (code: 1101)');
        error.code = 'youdu-credentials-rejected';
        throw error;
      },
      async stop() {},
      status: { ready: false, youduConnectionState: 'failed', harnessReachable: true },
    };
  }, async ({ controller }) => {
    await controller.attachBot({ botId: 'oc_demo', secret: 'bad', wsHost: 'push.example.com' });

    const first = controller.status();
    assert.equal(first.bots[0].state, 'error');
    assert.equal(first.bots[0].blocked, true);
    assert.equal(first.bots[0].error.code, 'youdu-credentials-rejected');
    assert.equal(first.bots[0].error.message, '有度机器人凭据被拒绝，请更新机器人密钥后重新连接。');
    assert.equal(first.totals.blocked, 1);
    assert.equal(first.totals.connected, 0);

    // 后续 initialize（supervisor 每次轮询都会调）不得再用同一份坏密钥新建 runtime。
    const before = attempts;
    await controller.initialize();
    await controller.initialize();
    assert.equal(attempts, before);
    assert.equal(created.length, 0);
  });
});

test('an explicit reconnect retries a rejected secret once the user fixes it', async () => {
  let attempt = 0;
  await withController(async ({ config, secret }) => {
    attempt += 1;
    return {
      async start() {
        if (secret === 'bad') {
          const error = new Error('Authentication failed: invalid secret (code: 1101)');
          error.code = 'youdu-credentials-rejected';
          throw error;
        }
      },
      async stop() {},
      status: { ready: secret !== 'bad', youduConnectionState: 'connected', harnessReachable: true },
    };
  }, async ({ controller }) => {
    await controller.attachBot({ botId: 'oc_demo', secret: 'bad', wsHost: 'push.example.com' });
    assert.equal(controller.status().bots[0].blocked, true);

    // 用户更新密钥后重连：终态清除，runtime 重新建立。
    await controller.attachBot({ botId: 'oc_demo', secret: 'good', wsHost: 'push.example.com' });
    const status = controller.status();
    assert.equal(status.bots[0].error, null);
    assert.equal(status.bots[0].blocked, false);
    assert.equal(attempt >= 2, true);
  });
});

test('the connection supervisor treats blocked bots as settled', async () => {
  let calls = 0;
  const controller = {
    async initialize() {
      calls += 1;
      return { totals: { configured: 1, connected: 0, blocked: 1 } };
    },
    status() { return { totals: { configured: 1, connected: 0, blocked: 1 } }; },
  };
  const supervisor = createConnectionSupervisor({
    controller,
    harness: { ensureRunning: async () => true },
    logger: { warn() {} },
    // 若把 blocked 当成"未连接"，10ms 的重试间隔会在窗口内打出十几次；
    // 终态下只应走健康轮询（100ms）。
    retryDelaysMs: [10],
    healthyIntervalMs: 100,
  });
  supervisor.start();
  await new Promise((resolve) => setTimeout(resolve, 230));
  await supervisor.close();
  assert.ok(calls >= 2, `expected at least the initial reconcile and one healthy poll, got ${calls}`);
  assert.ok(calls <= 4, `blocked bots must not be retried on the fast schedule, got ${calls} calls`);
});

test('authentication failures are recognized as credential rejections', () => {
  assert.equal(isYouduCredentialRejection(new Error('Authentication failed: bad secret (code: 1101)')), true);
  assert.equal(isYouduCredentialRejection(new Error('errcode=1101, errmsg=secret invalid')), true);
  assert.equal(isYouduCredentialRejection(new Error('WebSocket connection timed out after 20000ms')), false);
  assert.equal(isYouduCredentialRejection(undefined), false);
});
