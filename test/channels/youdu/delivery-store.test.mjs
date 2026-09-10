import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { YouduDeliveryStore } from '../../../src/channels/youdu/delivery-store.mjs';

const BOT_ID = 'yd_1a7d8037a6758b93fe17c1cc';
const OTHER_BOT = 'yd_7bba290441e5dec614f354b3';

async function withStore(run, botIds = [BOT_ID]) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-youdu-delivery-'));
  try {
    const path = join(dir, 'delivery.json');
    const store = await new YouduDeliveryStore(path, { knownBotIds: () => botIds }).load();
    await run({ store, path, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('delivery store owns exactly the configured bots', async () => {
  await withStore(async ({ store }) => {
    assert.equal(store.has(BOT_ID), true);
    assert.equal(store.has(OTHER_BOT), false);
    assert.deepEqual(store.listBotIds(), [BOT_ID]);
    assert.throws(() => store.listDeliveryTargets(OTHER_BOT), { code: 'unknown-bot' });
  });
  await withStore(async ({ store }) => {
    assert.deepEqual(store.listBotIds(), [BOT_ID, OTHER_BOT].sort());
  }, [OTHER_BOT, BOT_ID]);
});

test('delivery store persists targets and keeps CRUD semantics', async () => {
  await withStore(async ({ store, path }) => {
    assert.deepEqual(store.listDeliveryTargets(BOT_ID), []);

    const created = await store.createDeliveryTarget(BOT_ID, {
      targetId: 'group-daily',
      name: '日常群',
      kind: 'group',
      route: { chatId: '{0798E01E-CD68-42BB-813C-EB51593BB0F5}' },
    });
    assert.deepEqual(created, {
      targetId: 'group-daily',
      name: '日常群',
      kind: 'group',
      route: { chatId: '{0798E01E-CD68-42BB-813C-EB51593BB0F5}' },
    });
    await store.createDeliveryTarget(BOT_ID, {
      targetId: 'alice',
      kind: 'user',
      route: { chatId: '6463894' },
    });
    assert.deepEqual(
      store.listDeliveryTargets(BOT_ID).map((target) => target.targetId),
      ['alice', 'group-daily'],
      'targets are listed in stable targetId order',
    );

    await assert.rejects(
      () => store.createDeliveryTarget(BOT_ID, {
        targetId: 'alice', kind: 'user', route: { chatId: '6463894' },
      }),
      { code: 'target-conflict' },
    );
    await assert.rejects(
      () => store.updateDeliveryTarget(BOT_ID, 'missing', {
        kind: 'user', route: { chatId: '1' },
      }),
      { code: 'unknown-target' },
    );

    const updated = await store.updateDeliveryTarget(BOT_ID, 'alice', {
      name: '刘钟泽',
      kind: 'user',
      route: { chatId: '6463895' },
    });
    assert.equal(updated.name, '刘钟泽');
    assert.equal(updated.route.chatId, '6463895');
    assert.equal(store.deliveryTargetFor(BOT_ID, 'alice').route.chatId, '6463895');
    assert.equal(store.deliveryTargetFor(BOT_ID, 'missing'), null);

    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.bots[BOT_ID].alice.route.chatId, '6463895');

    assert.equal(await store.deleteDeliveryTarget(BOT_ID, 'alice'), true);
    assert.equal(store.deliveryTargetFor(BOT_ID, 'alice'), null);

    const reloaded = await new YouduDeliveryStore(path, { knownBotIds: () => [BOT_ID] }).load();
    assert.deepEqual(reloaded.listDeliveryTargets(BOT_ID).map((target) => target.targetId), ['group-daily']);
  });
});

test('delivery store validates kinds, routes, ids and rejects unknown bots', async () => {
  await withStore(async ({ store }) => {
    const invalid = [
      { targetId: 'bad id', kind: 'user', route: { chatId: '1' } },
      { targetId: 'ok', kind: 'User', route: { chatId: '1' } },
      { targetId: 'ok', kind: 'user', route: 'nope' },
      { targetId: 'ok', kind: 'user', route: { chatId: '1' }, extra: true },
      { targetId: 'ok', kind: 'user', route: { chatId: '1' }, name: 'x'.repeat(81) },
    ];
    for (const value of invalid) {
      await assert.rejects(() => store.createDeliveryTarget(BOT_ID, value), { code: 'invalid-target' });
    }
    await assert.rejects(
      () => store.createDeliveryTarget(OTHER_BOT, { targetId: 'ok', kind: 'user', route: { chatId: '1' } }),
      { code: 'unknown-bot' },
    );
  });
});

test('delivery store binds and clears one private Session sync per target', async () => {
  await withStore(async ({ store }) => {
    await store.createDeliveryTarget(BOT_ID, {
      targetId: 'alice', kind: 'user', route: { chatId: '6463894' },
    });
    assert.deepEqual(store.listSessionSyncTargets(), []);

    assert.equal(await store.setDeliveryTargetSessionSync(BOT_ID, 'alice', 'direct:6463894'), true);
    assert.deepEqual(store.listSessionSyncTargets(), [{
      botId: BOT_ID,
      targetId: 'alice',
      conversationKey: 'direct:6463894',
    }]);

    // 同一路由重命名保留会话同步；改路由则丢弃。
    await store.updateDeliveryTarget(BOT_ID, 'alice', {
      name: '刘钟泽', kind: 'user', route: { chatId: '6463894' },
    });
    assert.equal(store.listSessionSyncTargets().length, 1);
    await store.updateDeliveryTarget(BOT_ID, 'alice', {
      name: '刘钟泽', kind: 'user', route: { chatId: '6463895' },
    });
    assert.deepEqual(store.listSessionSyncTargets(), []);

    assert.equal(await store.setDeliveryTargetSessionSync(BOT_ID, 'alice', null), false);
    await assert.rejects(
      () => store.setDeliveryTargetSessionSync(BOT_ID, 'missing', 'direct:1'),
      { code: 'unknown-target' },
    );

    assert.equal(await store.remove(BOT_ID), true);
    assert.deepEqual(store.listDeliveryTargets(BOT_ID), []);
  });
});

test('delivery store drops damaged entries instead of failing the whole file', async () => {
  await withStore(async ({ path, dir }) => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify({
      version: 1,
      bots: {
        [BOT_ID]: {
          good: { kind: 'group', route: { chatId: 'g-1' } },
          bad: { kind: 'group', route: null },
        },
        'unknown-bot': { kept: { kind: 'user', route: { chatId: '1' } } },
      },
    }), 'utf8');
    const store = await new YouduDeliveryStore(path, { knownBotIds: () => [BOT_ID] }).load();
    assert.deepEqual(store.listDeliveryTargets(BOT_ID).map((target) => target.targetId), ['good']);
    assert.equal(store.has('unknown-bot'), false);
    assert.equal(dir.length > 0, true);
  });
});
