import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { YouduSettingsStore } from '../../../src/channels/youdu/settings-store.mjs';
import { YouduStateStore } from '../../../src/channels/youdu/state-store.mjs';
import { YouduController } from '../../../src/channels/youdu/youdu-controller.mjs';
import { YouduConfigStore } from '../../../src/channels/youdu/config-store.mjs';
import { createYouduRpcHandler, YOUDU_ENDPOINTS } from '../../../plugin-src/host/channels/youdu/rpc.mjs';
import { validateGroupAccess } from '../../../src/channels/youdu/group-access.mjs';

const BOT_ID = 'yd_1a7d8037a6758b93fe17c1cc';
const DOCUMENT = validateGroupAccess({
  version: 1,
  groups: { 'g-1': { mode: 'allowlist', users: ['1001', 'lewis.liu'] } },
});

async function withDirectory(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-youdu-group-access-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('settings store persists per-group access and decorates the status', async () => {
  await withDirectory(async (dir) => {
    const path = join(dir, 'settings.json');
    const store = await new YouduSettingsStore(path, { defaultWorkspace: dir }).load();
    assert.equal(store.groupAccessFor(BOT_ID), null, 'fresh bots inherit everywhere');

    await store.setGroupAccess(BOT_ID, DOCUMENT);
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(persisted.bots[BOT_ID].groupAccess.groups['g-1'].users, ['1001', 'lewis.liu']);

    const reloaded = await new YouduSettingsStore(path, { defaultWorkspace: dir }).load();
    assert.deepEqual(reloaded.groupAccessFor(BOT_ID).groups['g-1'].mode, 'allowlist');

    const decorated = reloaded.decorateStatus({ bots: [{ botId: BOT_ID }] });
    assert.deepEqual(decorated.bots[0].groupAccess.groups['g-1'].users, ['1001', 'lewis.liu']);

    // 清空后回到“全部沿用群聊访问设置”。
    await reloaded.setGroupAccess(BOT_ID, null);
    assert.equal(reloaded.groupAccessFor(BOT_ID), null);
    const cleared = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(Object.hasOwn(cleared.bots[BOT_ID], 'groupAccess'), false);
  });
});

test('settings store drops damaged per-group data instead of trusting it', async () => {
  await withDirectory(async (dir) => {
    const path = join(dir, 'settings.json');
    await new YouduSettingsStore(path, { defaultWorkspace: dir }).load();
    const store = await new YouduSettingsStore(path, { defaultWorkspace: dir }).load();
    assert.equal(store.groupAccessFor('unknown'), null);
    assert.throws(() => validateGroupAccess({ version: 1, groups: { a: { mode: 'allowlist', users: [] } } }));
  });
});

test('state store records observed groups with a persisted recency order', async () => {
  await withDirectory(async (dir) => {
    const path = join(dir, 'state.json');
    const store = await new YouduStateStore(path).load();
    const first = new Date('2026-09-09T10:00:00.000Z');
    const second = new Date('2026-09-09T12:00:00.000Z');
    const third = new Date('2026-09-09T14:00:00.000Z');
    await store.recordGroup('g-1', { now: () => first });
    await store.recordGroup('g-2', { now: () => second });
    await store.recordGroup('g-1', { now: () => third });

    assert.deepEqual(store.groupsSnapshot().map((group) => group.chatId), ['g-1', 'g-2']);
    assert.equal(store.groupsSnapshot().find((group) => group.chatId === 'g-1').messages, 2);

    const reloaded = await new YouduStateStore(path).load();
    assert.equal(reloaded.groupsSnapshot().length, 2);
    assert.equal(reloaded.groupsSnapshot().find((group) => group.chatId === 'g-2').lastSeenAt, second.toISOString());

    // 同一小时内的重复命中不再落盘（lastSeenAt 保持不变）。
    const before = await readFile(path, 'utf8');
    await reloaded.recordGroup('g-2', { now: () => new Date('2026-09-09T12:30:00.000Z') });
    assert.equal(await readFile(path, 'utf8'), before);
    assert.equal(reloaded.groupsSnapshot().find((group) => group.chatId === 'g-2').messages, 2);
  });
});

function fakeCredentials() {
  const values = new Map();
  return {
    async resolve(ref) { return values.has(ref) ? { value: values.get(ref) } : null; },
    async set(ref, value) { values.set(ref, value); },
    async unset(ref) { values.delete(ref); },
  };
}

test('controller saves per-group access and reports observed groups', async () => {
  await withDirectory(async (dir) => {
    const configStore = await new YouduConfigStore(join(dir, 'config.json')).load();
    const settingsStore = await new YouduSettingsStore(join(dir, 'settings.json'), {
      defaultWorkspace: dir,
    }).load();
    const state = await new YouduStateStore(join(dir, 'state.json')).load();
    await state.recordGroup('g-observed', { now: () => new Date('2026-09-09T09:00:00.000Z') });
    const controller = new YouduController({
      credentials: fakeCredentials(),
      configStore,
      settingsStore,
      createRuntime: async () => ({
        start: async () => {},
        stop: async () => {},
        status: { ready: false, youduConnectionState: 'offline', harnessReachable: false },
      }),
      knownGroupsFor: () => state.groupsSnapshot(),
      logger: { info() {}, warn() {}, error() {} },
    });

    await controller.attachBot({ botId: 'oc_demo', secret: 'secret-1', wsHost: 'push.example.com' });
    const botId = controller.status().bots[0].botId;
    assert.equal(controller.status().bots[0].groupAccess, null);
    assert.deepEqual(controller.status().bots[0].knownGroups, [{
      chatId: 'g-observed',
      lastSeenAt: '2026-09-09T09:00:00.000Z',
      messages: 1,
    }]);

    const saved = await controller.updateGroupAccess(botId, DOCUMENT, () => controller.status());
    assert.deepEqual(saved.bots[0].groupAccess.groups['g-1'].users, ['1001', 'lewis.liu']);
    assert.equal((await new YouduSettingsStore(join(dir, 'settings.json')).load()).groupAccessFor(botId).groups['g-1'].mode, 'allowlist');

    await controller.updateGroupAccess(botId, null, () => controller.status());
    assert.equal(controller.status().bots[0].groupAccess, null);
    await controller.close();
  });
});

function fakeController({ groupAccess = null } = {}) {
  const calls = [];
  let current = groupAccess;
  const status = () => ({
    schemaVersion: 1,
    revision: 1,
    bots: [{ botId: BOT_ID, groupAccess: current }],
    totals: { configured: 1, connected: 1 },
  });
  return {
    calls,
    status,
    updateGroupAccess: async (botId, value, projectStatus) => {
      calls.push({ botId, value });
      current = value;
      return typeof projectStatus === 'function' ? projectStatus(status()) : value;
    },
  };
}

test('youdu RPC exposes bot.group-access.set and validates the payload', async () => {
  const controller = fakeController();
  const handler = createYouduRpcHandler(controller);

  const ok = await handler(YOUDU_ENDPOINTS.setGroupAccess, { botId: BOT_ID, groupAccess: DOCUMENT });
  assert.equal(ok.ok, true);
  assert.deepEqual(controller.calls[0].value.groups['g-1'].users, ['1001', 'lewis.liu']);
  assert.equal(ok.value.bots[0].groupAccess.groups['g-1'].mode, 'allowlist');

  const cleared = await handler(YOUDU_ENDPOINTS.setGroupAccess, { botId: BOT_ID, groupAccess: null });
  assert.equal(cleared.ok, true);
  assert.equal(controller.calls[1].value, null);

  const badBot = await handler(YOUDU_ENDPOINTS.setGroupAccess, { botId: 'nope', groupAccess: DOCUMENT });
  assert.equal(badBot.ok, false);

  const badDocument = await handler(YOUDU_ENDPOINTS.setGroupAccess, {
    botId: BOT_ID,
    groupAccess: { version: 1, groups: { 'g-1': { mode: 'allowlist', users: [] } } },
  });
  assert.equal(badDocument.ok, false);
  assert.match(badDocument.error.message, /群访问设置无效/);
  assert.equal(controller.calls.length, 2, 'invalid payloads must not reach the controller');
});
