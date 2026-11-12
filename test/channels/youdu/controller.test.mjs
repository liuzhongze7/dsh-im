import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { YouduConfigStore } from '../../../src/channels/youdu/config-store.mjs';
import { YouduController } from '../../../src/channels/youdu/youdu-controller.mjs';

function fakeCredentials() {
  const values = new Map();
  return {
    async resolve(ref) {
      return values.has(ref) ? { value: values.get(ref) } : null;
    },
    async set(ref, value) { values.set(ref, value); },
    async unset(ref) { values.delete(ref); },
  };
}

function fakeRuntimeFactory(created) {
  return async ({ botId, config, secret }) => {
    created.push({ botId, config, secret });
    return {
      start: async () => {},
      stop: async () => {},
      status: { ready: true, youduConnectionState: 'connected', harnessReachable: true },
    };
  };
}

async function withController(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-youdu-controller-'));
  try {
    const configStore = await new YouduConfigStore(join(dir, 'config.json')).load();
    const created = [];
    const controller = new YouduController({
      credentials: fakeCredentials(),
      configStore,
      createRuntime: fakeRuntimeFactory(created),
      logger: { info() {}, warn() {}, error() {} },
    });
    await run({ controller, configStore, created });
    await controller.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('attachBot exposes the source bot id and owner for editing', async () => {
  await withController(async ({ controller }) => {
    await controller.attachBot({
      botId: 'oc_demo',
      secret: 'secret-1',
      wsHost: 'push.example.com',
      ownerUserId: 'alice',
    });
    const bot = controller.status().bots[0];
    assert.equal(bot.sourceBotId, 'oc_demo');
    assert.equal(bot.ownerUserId, 'alice');
    assert.match(bot.botId, /^yd_[a-f0-9]{24}$/);
  });
});

test('attachBot updates an existing bot and keeps omitted fields', async () => {
  await withController(async ({ controller, configStore, created }) => {
    await controller.attachBot({
      botId: 'oc_demo',
      secret: 'secret-1',
      wsHost: 'push.example.com',
      ownerUserId: 'alice',
    });
    const before = configStore.get(controller.status().bots[0].botId);

    // 只改 secret：地址 / owner / createdAt 保持不变
    await controller.attachBot({ botId: 'oc_demo', secret: 'secret-2' });
    const after = configStore.get(before.botId);
    assert.equal(after.wsHost, 'push.example.com');
    assert.equal(after.ownerUserId, 'alice');
    assert.equal(after.createdAt, before.createdAt);
    assert.equal(created.at(-1).secret, 'secret-2');
    assert.equal(created.at(-1).config.wsHost, 'push.example.com');

    // 显式传空串表示把 owner 清回 '*'
    await controller.attachBot({ botId: 'oc_demo', secret: 'secret-2', ownerUserId: '' });
    assert.equal(configStore.get(before.botId).ownerUserId, '*');
  });
});

test('attachBot rejects an update that has no stored secret and no new one', async () => {
  await withController(async ({ controller }) => {
    await assert.rejects(
      () => controller.attachBot({ botId: 'oc_unknown' }),
      /secret and WebSocket host are required/,
    );
  });
});
