import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { YouduConfigStore } from '../../../src/channels/youdu/config-store.mjs';
import { YouduGroupSettingsStore } from '../../../src/channels/youdu/group-settings-store.mjs';
import { YouduController } from '../../../src/channels/youdu/youdu-controller.mjs';
import { DEFAULT_GROUP_HISTORY_CONFIG, DISABLED_GROUP_HISTORY_CONFIG } from '../../../src/channels/shared/group-history.mjs';
import { createYouduRpcHandler, YOUDU_ENDPOINTS } from '../../../plugin-src/host/channels/youdu/rpc.mjs';
import { YOUDU_ENDPOINTS as CLIENT_ENDPOINTS, normalizeSnapshot } from '../../../plugin-src/client/channels/youdu/api.js';

const BOT_ID = 'yd_1a7d8037a6758b93fe17c1cc';

async function withDirectory(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-youdu-group-history-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeCredentials() {
  const values = new Map();
  return {
    async resolve(ref) { return values.has(ref) ? { value: values.get(ref) } : null; },
    async set(ref, value) { values.set(ref, value); },
    async unset(ref) { values.delete(ref); },
  };
}

test('settings store persists the group history switch and limit per bot', async () => {
  await withDirectory(async (dir) => {
    const path = join(dir, 'group-settings.json');
    const store = await new YouduGroupSettingsStore(path).load();
    assert.deepEqual(store.groupHistoryFor(BOT_ID), DEFAULT_GROUP_HISTORY_CONFIG);
    assert.deepEqual(store.groupHistoryFor('unknown'), DEFAULT_GROUP_HISTORY_CONFIG);

    const saved = await store.setGroupHistory(BOT_ID, { enabled: true, limit: 20 });
    assert.deepEqual(saved, { enabled: true, limit: 20 });
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(persisted.bots[BOT_ID].groupHistory, { enabled: true, limit: 20 });

    const reloaded = await new YouduGroupSettingsStore(path).load();
    assert.deepEqual(reloaded.groupHistoryFor(BOT_ID), { enabled: true, limit: 20 });
    assert.deepEqual(
      reloaded.groupHistoryFor(BOT_ID),
      { enabled: true, limit: 20 },
    );

    // 0 表示关闭，同样要落盘而不是被当成未配置。
    await reloaded.setGroupHistory(BOT_ID, { enabled: true, limit: 0 });
    assert.deepEqual(
      JSON.parse(await readFile(path, 'utf8')).bots[BOT_ID].groupHistory,
      { enabled: true, limit: 0 },
    );
    assert.deepEqual(
      (await new YouduGroupSettingsStore(path).load()).groupHistoryFor(BOT_ID),
      { enabled: true, limit: 0 },
    );
  });
});

test('settings store drops damaged group history values instead of trusting them', async () => {
  await withDirectory(async (dir) => {
    const path = join(dir, 'group-settings.json');
    const damaged = [
      null, [], 'enabled', true, 3,
      { enabled: 'yes', limit: 20 },
      { enabled: true, limit: 9999 },
      { enabled: true, limit: -5 },
    ];
    for (const value of damaged) {
      await writeFile(path, JSON.stringify({
        version: 1,
        bots: { [BOT_ID]: { workspace: dir, groupHistory: value } },
      }));
      const store = await new YouduGroupSettingsStore(path).load();
      const normalized = store.groupHistoryFor(BOT_ID);
      assert.equal(typeof normalized.enabled, 'boolean', `enabled for ${JSON.stringify(value)}`);
      assert.equal(Number.isSafeInteger(normalized.limit), true, `limit for ${JSON.stringify(value)}`);
      assert.equal(normalized.limit >= 0 && normalized.limit <= 200, true);
    }
    // 读取损坏的配置不改写文件（升级后的首次读取不落盘）。
    const original = JSON.stringify({
      version: 1,
      bots: { [BOT_ID]: { workspace: dir, groupHistory: { enabled: true, limit: 9999 } } },
    });
    await writeFile(path, original);
    await new YouduGroupSettingsStore(path).load();
    assert.equal(await readFile(path, 'utf8'), original);
    assert.equal(DISABLED_GROUP_HISTORY_CONFIG.limit, 0);
  });
});

test('controller saves group history settings and reports them in the status', async () => {
  await withDirectory(async (dir) => {
    const configStore = await new YouduConfigStore(join(dir, 'config.json')).load();
    const groupStore = await new YouduGroupSettingsStore(join(dir, 'group-settings.json')).load();
    const controller = new YouduController({
      credentials: fakeCredentials(),
      configStore,
      groupStore,
      createRuntime: async () => ({
        start: async () => {},
        stop: async () => {},
        status: { ready: false, youduConnectionState: 'offline', harnessReachable: false },
      }),
      logger: { info() {}, warn() {}, error() {} },
    });

    await controller.attachBot({ botId: 'oc_demo', secret: 'fixture-secret', wsHost: 'push.example.com' });
    const botId = controller.status().bots[0].botId;
    assert.deepEqual(controller.status().bots[0].groupHistory, DEFAULT_GROUP_HISTORY_CONFIG);

    const saved = await controller.updateGroupHistory(botId, { enabled: false, limit: 10 }, () => controller.status());
    assert.deepEqual(saved.bots[0].groupHistory, { enabled: false, limit: 10 });
    assert.deepEqual(controller.status().bots[0].groupHistory, { enabled: false, limit: 10 });
    assert.deepEqual(
      (await new YouduGroupSettingsStore(join(dir, 'group-settings.json')).load()).groupHistoryFor(botId),
      { enabled: false, limit: 10 },
    );
    await assert.rejects(controller.updateGroupHistory('yd_000000000000000000000000', { enabled: true, limit: 10 }));
    await controller.close();
  });
});

function fakeController({ groupHistory = DEFAULT_GROUP_HISTORY_CONFIG } = {}) {
  const calls = [];
  let current = groupHistory;
  const status = () => ({
    schemaVersion: 1,
    revision: 1,
    bots: [{ botId: BOT_ID, groupHistory: current }],
    totals: { configured: 1, connected: 1 },
  });
  return {
    calls,
    status,
    updateGroupHistory: async (botId, value, projectStatus) => {
      calls.push({ botId, value });
      current = value;
      return typeof projectStatus === 'function' ? projectStatus(status()) : value;
    },
  };
}

test('youdu RPC exposes bot.group-history.set and validates the payload', async () => {
  const controller = fakeController();
  const handler = createYouduRpcHandler(controller);

  const ok = await handler(YOUDU_ENDPOINTS.setGroupHistory, { botId: BOT_ID, config: { enabled: true, limit: 5 } });
  assert.equal(ok.ok, true);
  assert.deepEqual(controller.calls[0].value, { enabled: true, limit: 5 });
  assert.deepEqual(ok.value.bots[0].groupHistory, { enabled: true, limit: 5 });

  const off = await handler(YOUDU_ENDPOINTS.setGroupHistory, { botId: BOT_ID, config: { enabled: false, limit: 50 } });
  assert.equal(off.ok, true);
  assert.deepEqual(controller.calls[1].value, { enabled: false, limit: 50 });

  for (const payload of [
    { botId: BOT_ID, config: { enabled: true } },
    { botId: BOT_ID, config: { enabled: true, limit: 201 } },
    { botId: BOT_ID, config: { enabled: 'yes', limit: 10 } },
    { botId: BOT_ID, config: { enabled: true, limit: 10, extra: true } },
    { botId: '../bot', config: { enabled: true, limit: 10 } },
  ]) {
    const failed = await handler(YOUDU_ENDPOINTS.setGroupHistory, payload);
    assert.equal(failed.ok, false, `expected ${JSON.stringify(payload)} to be rejected`);
  }
  assert.equal(controller.calls.length, 2, 'invalid payloads must not reach the controller');

  // 未知 robot 由 controller 拒绝，payload 校验本身只检查形状（与共享 RPC 一致）。
  const unknownBot = fakeController();
  const unknownHandler = createYouduRpcHandler({
    ...unknownBot,
    updateGroupHistory: async () => { throw new Error('Unknown Youdu bot'); },
  });
  const denied = await unknownHandler(YOUDU_ENDPOINTS.setGroupHistory, {
    botId: 'nope',
    config: { enabled: true, limit: 10 },
  });
  assert.equal(denied.ok, false);
});

test('the client targets the same endpoint and normalizes the status field', () => {
  assert.equal(CLIENT_ENDPOINTS.setGroupHistory, YOUDU_ENDPOINTS.setGroupHistory);
  const snapshot = normalizeSnapshot({
    bots: [{
      botId: BOT_ID,
      connected: true,
      state: 'connected',
      groupHistory: { enabled: true, limit: 12 },
    }, {
      botId: 'yd_7bba290441e5dec614f354b3',
      connected: false,
      state: 'offline',
    }],
  });
  assert.deepEqual(snapshot.bots[0].groupHistory, { enabled: true, limit: 12 });
  assert.deepEqual(snapshot.bots[1].groupHistory, DEFAULT_GROUP_HISTORY_CONFIG);
});
