import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BotWorkspaceStore } from '../../../src/channels/shared/bot-workspace-store.mjs';
import { YouduGroupSettingsStore } from '../../../src/channels/youdu/group-settings-store.mjs';
import {
  migrateLegacyYouduDeliveryTargets,
  migrateLegacyYouduSettings,
} from '../../../src/channels/youdu/legacy-settings.mjs';

const BOT_ID = 'yd_1a7d8037a6758b93fe17c1cc';

async function withMigration(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-youdu-legacy-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('legacy per-bot settings move into the shared workspace store', async () => {
  await withMigration(async (dir) => {
    const legacyPath = join(dir, 'settings.json');
    await writeFile(legacyPath, JSON.stringify({
      version: 1,
      bots: {
        [BOT_ID]: {
          workspace: join(dir, 'workspace'),
          agentPreset: 'careful',
          model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
          alias: '客服小度',
          contextEnhancement: { enabled: true, channelContext: true, citeGroupContext: false, showThinking: false, groupContextWindow: 20 },
          accessPolicy: null,
          groupAccess: { version: 1, groups: { 'g-1': { mode: 'allowlist', users: ['1001'] } } },
          groupHistory: { enabled: true, limit: 12 },
        },
      },
    }, null, 2));

    const workspaces = await new BotWorkspaceStore(join(dir, 'workspaces.json'), {
      defaultWorkspace: join(dir, 'default'),
    }).load();
    const groups = await new YouduGroupSettingsStore(join(dir, 'group-settings.json')).load();

    const migrated = await migrateLegacyYouduSettings({
      legacyPath,
      workspaces,
      groups,
      defaultAgentPreset: 'standard',
    });
    assert.equal(migrated, true);
    assert.equal(existsSync(legacyPath), false);
    assert.equal(existsSync(`${legacyPath}.migrated`), true);

    assert.equal(workspaces.workspaceFor(BOT_ID), join(dir, 'workspace'));
    assert.equal(workspaces.agentPresetFor(BOT_ID), 'careful');
    assert.deepEqual(workspaces.modelFor(BOT_ID), {
      provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high',
    });
    assert.equal(workspaces.aliasFor(BOT_ID), '客服小度');
    assert.equal(groups.groupAccessFor(BOT_ID).groups['g-1'].users[0], '1001');
    assert.deepEqual(groups.groupHistoryFor(BOT_ID), { enabled: true, limit: 12 });

    // 迁移后重启：旧文件已改名，不会再次迁移。
    const again = await migrateLegacyYouduSettings({
      legacyPath,
      workspaces,
      groups,
      defaultAgentPreset: 'standard',
    });
    assert.equal(again, false);
  });
});

test('a damaged legacy document is left in place and reported', async () => {
  await withMigration(async (dir) => {
    const legacyPath = join(dir, 'settings.json');
    await writeFile(legacyPath, '{not json');
    const workspaces = await new BotWorkspaceStore(join(dir, 'workspaces.json'), {
      defaultWorkspace: dir,
    }).load();
    const groups = await new YouduGroupSettingsStore(join(dir, 'group-settings.json')).load();
    await assert.rejects(() => migrateLegacyYouduSettings({
      legacyPath, workspaces, groups, defaultAgentPreset: 'standard',
    }), SyntaxError);
    assert.equal(existsSync(legacyPath), true);
  });
});

test('legacy delivery targets move into the shared workspace store', async () => {
  await withMigration(async (dir) => {
    const legacyPath = join(dir, 'delivery.json');
    await writeFile(legacyPath, JSON.stringify({
      version: 1,
      bots: {
        [BOT_ID]: {
          alice: { name: '爱丽丝', kind: 'user', route: { chatId: '6463894' } },
          'group-daily': { name: '日常群', kind: 'group', route: { chatId: '{0798}' }, sessionSync: { enabled: true } },
        },
      },
    }, null, 2));

    const workspaces = await new BotWorkspaceStore(join(dir, 'workspaces.json'), {
      defaultWorkspace: dir,
    }).load();
    await workspaces.ensure(BOT_ID);

    const migrated = await migrateLegacyYouduDeliveryTargets({
      legacyPath,
      workspaces,
      knownBotIds: [BOT_ID],
    });
    assert.equal(migrated, true);
    assert.deepEqual(
      workspaces.listDeliveryTargets(BOT_ID).map((target) => target.targetId),
      ['alice', 'group-daily'],
    );
    assert.equal(workspaces.deliveryTargetFor(BOT_ID, 'alice').route.chatId, '6463894');
    assert.deepEqual(
      workspaces.listSessionSyncTargets('session-user').length,
      0,
      'session sync flags only matter once a session is bound',
    );
    assert.equal(existsSync(legacyPath), false);
    assert.equal(existsSync(`${legacyPath}.migrated`), true);
    const stored = await readFile(join(dir, 'workspaces.json'), 'utf8');
    assert.match(stored, /group-daily/);
  });
});
