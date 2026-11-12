import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deriveYouduBotIdentity, YouduConfigStore } from '../../../src/channels/youdu/config-store.mjs';

const warnings = [];

function storeAt(path) {
  return new YouduConfigStore(path, {
    logger: {
      info() {},
      debug() {},
      error() {},
      warn(message) { warnings.push(String(message)); },
    },
  });
}

function botRecord(sourceBotId, extra = {}) {
  return { ...deriveYouduBotIdentity(sourceBotId), sourceBotId, wsHost: 'youdu.example.com', ...extra };
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'youdu-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a saved bot survives a reload', async (t) => {
  warnings.length = 0;
  const path = join(await tempDir(t), 'bots.json');
  const saved = botRecord('10001', { ownerUserId: '6463894' });
  await storeAt(path).load().then((store) => store.save(saved));

  const reloaded = await storeAt(path).load();
  assert.deepEqual(reloaded.list().map((bot) => bot.botId), [saved.botId]);
  assert.equal(reloaded.get(saved.botId).ownerUserId, '6463894');
});

test('a damaged bot entry is skipped instead of failing every bot', async (t) => {
  warnings.length = 0;
  const dir = await tempDir(t);
  const path = join(dir, 'bots.json');
  const healthy = botRecord('10001');
  const damaged = { ...botRecord('10002'), botId: 'yd_not-a-real-id' };
  await writeFile(path, `${JSON.stringify({ version: 1, bots: [damaged, healthy] })}\n`, 'utf8');

  const store = await storeAt(path).load();
  assert.deepEqual(store.list().map((bot) => bot.botId), [healthy.botId]);
  assert.match(warnings.join('\n'), /1 invalid bot entry/);
  // 原始内容留档，方便人工找回被跳过的条目
  const backup = await readFile(`${path}.invalid`, 'utf8');
  assert.match(backup, /yd_not-a-real-id/);
});

test('an unreadable config file starts empty and keeps a copy of the file', async (t) => {
  warnings.length = 0;
  const dir = await tempDir(t);
  const path = join(dir, 'bots.json');
  await writeFile(path, '{not json', 'utf8');

  const store = await storeAt(path).load();
  assert.deepEqual(store.list(), []);
  const backup = await stat(`${path}.invalid`);
  assert.ok(backup.isFile());
  assert.match(warnings.join('\n'), /ignoring part of the bot config/);
});
