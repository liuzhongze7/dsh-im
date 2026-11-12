import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import {
  groupContextClearedText,
  groupContextDirectText,
  groupContextResetText,
  groupContextStatusText,
  groupContextUsageText,
  isGroupContextCommand,
  parseGroupContextCommand,
} from '../src/channels/shared/context-command.mjs';
import { setImHostLanguage } from '../src/channels/shared/i18n.mjs';

after(() => {
  setImHostLanguage('zh');
});

test('only /context and /context clear are recognised, and nothing else is a command', () => {
  for (const text of ['/context', '/context clear', '  /context  ', '/CONTEXT', '/context clear ']) {
    assert.equal(isGroupContextCommand(text), true, `expected ${JSON.stringify(text)} to match`);
  }
  for (const text of ['', '/contexts', '/contextual', 'context', '/compact', '/new', 42, null]) {
    assert.equal(isGroupContextCommand(text), false, `expected ${JSON.stringify(text)} not to match`);
  }
  // 同一命令族里带了不认识的参数：仍算命令（本地消费、不落到模型），但按用法回复。
  assert.equal(isGroupContextCommand('/context clear all'), true);
  assert.deepEqual(parseGroupContextCommand('/context'), { action: 'status' });
  assert.deepEqual(parseGroupContextCommand('/context   clear'), { action: 'clear' });
  assert.deepEqual(parseGroupContextCommand('/context clear all'), { action: 'usage' });
  assert.deepEqual(parseGroupContextCommand('/context whatever'), { action: 'usage' });
  assert.deepEqual(parseGroupContextCommand('/compact'), null);
});

test('the status text reports the switch, the held messages and the staged attachments', () => {
  const active = groupContextStatusText({
    active: true, limit: 50, pending: 7, files: 3, retentionHours: 168,
  });
  assert.match(active, /本群上下文缓存：开启 · 最近 50 条/u);
  assert.match(active, /待带入的消息：7 条/u);
  assert.match(active, /本轮可带入的群附件：3 个/u);
  assert.match(active, /附件按保留期清理（当前 168 小时）。/u);
  assert.match(active, /发送 \/context clear 清空本群待带入的消息。/u);
  assert.equal(active.includes('正在下载'), false, 'nothing downloading means no extra line');

  // 刚发完附件就查询：已列出的与仍在下载的分开说明，避免看起来"没收到"。
  const downloading = groupContextStatusText({
    active: true, limit: 50, pending: 2, files: 0, downloading: 1, retentionHours: 168,
  });
  assert.match(downloading, /本轮可带入的群附件：0 个/u);
  assert.match(downloading, /正在下载的群附件：1 个（完成后本轮即可带入）/u);

  const off = groupContextStatusText({ active: false, limit: 0, pending: 0, files: 0, retentionHours: -1 });
  assert.match(off, /本群上下文缓存：未开启/u);
  assert.match(off, /待带入的消息：0 条/u);
  assert.match(off, /附件永久保留，可随时按路径取用。/u);
  assert.equal(off.includes('/context clear'), false, 'nothing to clear means no prompt to clear');

  assert.match(groupContextStatusText(), /本群上下文缓存：未开启/u);
});

test('the clear, reset, usage and direct texts stay explicit about what was left alone', () => {
  assert.match(groupContextClearedText({ cleared: 4 }), /已清空本群待带入的上下文（4 条消息）。/u);
  assert.match(groupContextClearedText({ cleared: 4 }), /已下载的群附件仍保留，按保留期自动清理。/u);
  assert.match(groupContextClearedText(), /（0 条消息）/u);

  assert.match(
    groupContextResetText({ cleared: 3 }),
    /已开启新会话，并清空本群待带入的上下文（3 条消息）。/u,
  );
  assert.match(groupContextResetText({ cleared: 0 }), /已开启新会话。请 @ 机器人发送你的问题。/u);

  assert.match(groupContextUsageText(), /用法：\/context 或 \/context clear/u);
  assert.match(groupContextUsageText(), /\/context clear {2}清空本群待带入的消息/u);
  assert.match(groupContextDirectText(), /群聊上下文缓存只在群聊里生效。/u);
});

test('every group context command text has an English projection', () => {
  setImHostLanguage('en');
  const texts = [
    groupContextUsageText(),
    groupContextDirectText(),
    groupContextStatusText({ active: true, limit: 50, pending: 2, files: 1, retentionHours: 24 }),
    groupContextStatusText({
      active: true, limit: 50, pending: 2, files: 0, downloading: 1, retentionHours: 24,
    }),
    groupContextStatusText({ active: false, limit: 0, pending: 0, files: 0, retentionHours: -1 }),
    groupContextClearedText({ cleared: 2 }),
    groupContextResetText({ cleared: 2 }),
    groupContextResetText({ cleared: 0 }),
  ];
  for (const text of texts) {
    assert.equal(/[\p{Script=Han}]/u.test(text), false, `untranslated Chinese in:\n${text}`);
  }
});
