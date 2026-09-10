import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { YouduDeliveryStore } from '../../../src/channels/youdu/delivery-store.mjs';
import { YouduStateStore } from '../../../src/channels/youdu/state-store.mjs';
import { createDeliveryAdapter } from '../../../plugin-src/host/delivery-adapter.mjs';
import { DeliveryService } from '../../../plugin-src/host/delivery-service.mjs';

const BOT_ID = 'yd_1a7d8037a6758b93fe17c1cc';
const GROUP_ID = '{0798E01E-CD68-42BB-813C-EB51593BB0F5}';

async function withYouduDelivery(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-youdu-adapter-'));
  try {
    const store = await new YouduDeliveryStore(join(dir, 'delivery.json'), {
      knownBotIds: () => [BOT_ID],
    }).load();
    const state = await new YouduStateStore(join(dir, 'state.json')).load();
    const sends = [];
    const controller = {
      async sendProactiveText(botId, target, text, options) {
        sends.push({ botId, target, text, options });
        return { sent: true };
      },
    };
    const adapter = createDeliveryAdapter({
      channel: 'youdu',
      workspaces: store,
      coreController: controller,
      stateFor: async (botId) => (botId === BOT_ID ? state : null),
    });
    await run({ store, state, adapter, controller, sends, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('youdu delivery adapter forwards proactive text to the runtime contract', async () => {
  await withYouduDelivery(async ({ adapter, sends }) => {
    await adapter.createTarget(BOT_ID, {
      targetId: 'group-daily',
      name: '日常群',
      kind: 'group',
      route: { chatId: GROUP_ID },
    });
    await adapter.sendText(BOT_ID, {
      targetId: 'group-daily', kind: 'group', route: { chatId: GROUP_ID },
    }, '早上好');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].botId, BOT_ID);
    assert.deepEqual(sends[0].target, {
      targetId: 'group-daily', kind: 'group', route: { chatId: GROUP_ID },
    });
    assert.equal(sends[0].text, '早上好');

    await assert.rejects(
      () => adapter.sendText(BOT_ID, { targetId: 'x', kind: 'topic', route: { chatId: '1' } }, 'hi'),
      { code: 'invalid-target' },
    );
    assert.equal(sends.length, 1, 'rejected routes never reach the runtime');
  });
});

test('youdu delivery suggestions derive user and group routes from learned sessions', async () => {
  await withYouduDelivery(async ({ adapter, state }) => {
    await state.setSession(`direct:6463894`, 'session-user');
    await state.setSession(`group:${GROUP_ID}`, 'session-group');
    await state.recordPerson('6463894', { account: 'lewis.liu', name: '刘钟泽' });

    assert.deepEqual(await adapter.listSuggestions(BOT_ID), [
      { kind: 'user', route: { chatId: '6463894' } },
      { kind: 'group', route: { chatId: GROUP_ID } },
    ]);
  });
});

test('youdu session sync binds only a matching private conversation', async () => {
  await withYouduDelivery(async ({ adapter, state }) => {
    await adapter.createTarget(BOT_ID, {
      targetId: 'alice', kind: 'user', route: { chatId: '6463894' },
    });
    // 还没聊过：不允许开启会话同步。
    await assert.rejects(() => adapter.setSessionSync(BOT_ID, 'alice', true), {
      code: 'session-sync-unavailable',
    });

    await state.setSession('direct:6463894', 'session-user');
    const enabled = await adapter.setSessionSync(BOT_ID, 'alice', true);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.state, 'active');
    assert.deepEqual(await adapter.listSessionSyncTargets('session-user'), [{
      botId: BOT_ID, targetId: 'alice',
    }]);
    await adapter.sendSessionSyncText(BOT_ID, 'alice', 'session-user', '定时结果');
    assert.equal((await adapter.listTargets(BOT_ID))[0].sessionSync.enabled, true);

    const disabled = await adapter.setSessionSync(BOT_ID, 'alice', false);
    assert.equal(disabled.enabled, false);
    await assert.rejects(
      () => adapter.sendSessionSyncText(BOT_ID, 'alice', 'session-user', '定时结果'),
      { code: 'session-sync-unavailable' },
    );
  });
});

test('the delivery service routes youdu targets through the registered adapter', async () => {
  await withYouduDelivery(async ({ adapter, sends }) => {
    const service = new DeliveryService();
    const unregister = service.registerAdapter(adapter);
    const created = await service.createTarget(BOT_ID, {
      targetId: 'alice',
      kind: 'user',
      route: { chatId: '6463894' },
    });
    assert.equal(created.targetId, 'alice');
    assert.deepEqual((await service.listTargets(BOT_ID)).targets.map((target) => target.targetId), ['alice']);
    assert.deepEqual(await service.listBots(), [{ botId: BOT_ID, channel: 'youdu' }]);

    assert.deepEqual(await service.send(BOT_ID, 'alice', '主动消息'), { sent: true });
    assert.equal(sends.at(-1).text, '主动消息');
    assert.deepEqual(sends.at(-1).target.route, { chatId: '6463894' });

    assert.equal(unregister(), true);
    assert.deepEqual(await service.listBots(), []);
  });
});
