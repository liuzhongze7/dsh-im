import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_MESSAGE_MARKER,
  DEFAULT_GROUP_HISTORY_CONFIG,
  DEFAULT_GROUP_HISTORY_LIMIT,
  DISABLED_GROUP_HISTORY_CONFIG,
  GROUP_HISTORY_LIMIT_MAX,
  MAX_GROUP_HISTORY_BLOCK_CHARS,
  MAX_GROUP_HISTORY_ENTRY_CHARS,
  appendGroupHistoryContext,
  createGroupHistory,
  formatGroupHistoryBlock,
  formatGroupHistoryFilesBlock,
  groupHistoryActive,
  normalizeGroupHistoryConfig,
  normalizeGroupHistoryEntry,
  validateGroupHistoryConfig,
} from '../src/channels/shared/group-history.mjs';

test('a missing configuration reads as the enabled 50-message default', () => {
  assert.deepEqual(normalizeGroupHistoryConfig(undefined), DEFAULT_GROUP_HISTORY_CONFIG);
  assert.deepEqual(normalizeGroupHistoryConfig(null), DEFAULT_GROUP_HISTORY_CONFIG);
  assert.equal(DEFAULT_GROUP_HISTORY_CONFIG.enabled, true);
  assert.equal(DEFAULT_GROUP_HISTORY_CONFIG.limit, DEFAULT_GROUP_HISTORY_LIMIT);
  assert.equal(DEFAULT_GROUP_HISTORY_LIMIT, 50);
});

test('a stored configuration is normalized without throwing or clamping away intent', () => {
  assert.deepEqual(normalizeGroupHistoryConfig({ enabled: false, limit: 0 }), { enabled: false, limit: 0 });
  assert.deepEqual(normalizeGroupHistoryConfig({ enabled: true, limit: 20 }), { enabled: true, limit: 20 });
  // 越界与非法类型按默认值/边界收敛，而不是让读取方拿到坏配置。
  assert.deepEqual(normalizeGroupHistoryConfig({ enabled: 'yes', limit: 5 }), { enabled: true, limit: 5 });
  assert.deepEqual(normalizeGroupHistoryConfig({ enabled: true, limit: 9999 }), {
    enabled: true,
    limit: GROUP_HISTORY_LIMIT_MAX,
  });
  assert.deepEqual(normalizeGroupHistoryConfig({ enabled: true, limit: -3 }), { enabled: true, limit: 0 });
  assert.deepEqual(normalizeGroupHistoryConfig({ enabled: true, limit: 7.6 }), { enabled: true, limit: 7 });
  assert.deepEqual(normalizeGroupHistoryConfig({ enabled: true, limit: 'many' }), DEFAULT_GROUP_HISTORY_CONFIG);
  assert.deepEqual(normalizeGroupHistoryConfig([]), DEFAULT_GROUP_HISTORY_CONFIG);
});

test('the settings save path validates strictly', () => {
  assert.deepEqual(validateGroupHistoryConfig({ enabled: true, limit: 50 }), { enabled: true, limit: 50 });
  assert.deepEqual(validateGroupHistoryConfig({ enabled: false, limit: 0 }), { enabled: false, limit: 0 });
  const rejected = [
    {},
    { enabled: true },
    { enabled: true, limit: 50, extra: 1 },
    { enabled: 'true', limit: 50 },
    { enabled: true, limit: -1 },
    { enabled: true, limit: GROUP_HISTORY_LIMIT_MAX + 1 },
    { enabled: true, limit: 2.5 },
  ];
  for (const value of rejected) {
    assert.throws(
      () => validateGroupHistoryConfig(value),
      (error) => error?.code === 'group-history-invalid',
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
});

test('a configuration only takes effect when it is enabled with a positive limit', () => {
  assert.equal(groupHistoryActive(DEFAULT_GROUP_HISTORY_CONFIG), true);
  assert.equal(groupHistoryActive({ enabled: true, limit: 1 }), true);
  assert.equal(groupHistoryActive({ enabled: false, limit: 50 }), false);
  assert.equal(groupHistoryActive({ enabled: true, limit: 0 }), false);
  assert.equal(groupHistoryActive(DISABLED_GROUP_HISTORY_CONFIG), false);
});

test('the buffer keeps the newest entries within the configured limit', () => {
  const history = createGroupHistory();
  for (let index = 1; index <= 5; index += 1) {
    history.record('group:g-1', { sender: 'S', body: `m${index}`, messageId: `id-${index}` }, { limit: 3 });
  }
  assert.equal(history.size('group:g-1'), 3);
  assert.deepEqual(
    history.snapshot('group:g-1', { limit: 3 }).map((entry) => entry.body),
    ['m3', 'm4', 'm5'],
  );
});

test('a zero or negative limit records nothing, and empty bodies are ignored', () => {
  const history = createGroupHistory();
  history.record('group:g-1', { body: 'ignored' }, { limit: 0 });
  history.record('group:g-1', { body: '' }, { limit: 50 });
  history.record('group:g-1', { body: '   ' }, { limit: 50 });
  history.record('group:g-1', {}, { limit: 50 });
  history.record('', { body: 'no key' }, { limit: 50 });
  assert.equal(history.size('group:g-1'), 0);
});

test('entries are single-line, control-character free and length capped', () => {
  const normalized = normalizeGroupHistoryEntry({
    sender: ' 张三 \n',
    body: '第一行\u0000\n第二行   第三行',
    timestamp: 1_700_000_000_000,
    messageId: ' id-1 ',
  });
  assert.equal(normalized.sender, '张三');
  assert.equal(normalized.body, '第一行 第二行 第三行');
  assert.equal(normalized.messageId, 'id-1');
  const long = normalizeGroupHistoryEntry({ body: '字'.repeat(MAX_GROUP_HISTORY_ENTRY_CHARS + 50) });
  assert.equal([...long.body].length, MAX_GROUP_HISTORY_ENTRY_CHARS);
  assert.equal(long.body.endsWith('…'), true);
});

test('the snapshot is a copy and consuming it keeps messages that arrived mid-turn', () => {
  const history = createGroupHistory();
  history.record('group:g-1', { sender: 'A', body: 'one', messageId: 'id-1' });
  history.record('group:g-1', { sender: 'B', body: 'two', messageId: 'id-2' });
  const snapshot = history.snapshot('group:g-1');
  snapshot.pop();
  assert.equal(history.size('group:g-1'), 2, 'mutating the snapshot must not shrink the buffer');
  // 回合进行中又到了两条没有寻址机器人的消息。
  history.record('group:g-1', { sender: 'C', body: 'three', messageId: 'id-3' });
  history.record('group:g-1', { sender: 'D', body: 'four', messageId: 'id-4' });
  const consumed = history.snapshot('group:g-1');
  assert.equal(consumed.length, 4);
  history.consume('group:g-1', [consumed[0], consumed[1]]);
  assert.deepEqual(
    history.snapshot('group:g-1').map((entry) => entry.body),
    ['three', 'four'],
  );
  history.consume('group:g-1', history.snapshot('group:g-1'));
  assert.equal(history.size('group:g-1'), 0);
});

test('a redelivered message is not buffered twice', () => {
  const history = createGroupHistory();
  history.record('group:g-1', { sender: 'A', body: 'one', messageId: 'id-1' });
  history.record('group:g-1', { sender: 'A', body: 'one', messageId: 'id-1' });
  history.record('group:g-1', { sender: 'A', body: 'one', messageId: 'id-2' });
  assert.equal(history.size('group:g-1'), 2);
  assert.deepEqual(history.snapshot('group:g-1').map((entry) => entry.messageId), ['id-1', 'id-2']);
});

test('repeated message ids are consumed together even when the snapshot is rebuilt', () => {
  const history = createGroupHistory();
  history.record('group:g-1', { sender: 'A', body: 'one', messageId: 'id-1' });
  const snapshot = history.snapshot('group:g-1');
  // 重建快照（模拟交付重试）后仍按 messageId 消费同一条记录。
  history.consume('group:g-1', history.snapshot('group:g-1'));
  assert.equal(history.size('group:g-1'), 0);
  history.record('group:g-1', { sender: 'A', body: 'one', messageId: 'id-1' });
  history.consume('group:g-1', snapshot.map((entry) => ({ ...entry })));
  assert.equal(history.size('group:g-1'), 0, 'the same messageId must not be injected twice');
});

test('the buffer evicts the least recently used conversation beyond the key cap', () => {
  const history = createGroupHistory({ maxKeys: 2 });
  history.record('group:a', { body: 'a' });
  history.record('group:b', { body: 'b' });
  history.record('group:c', { body: 'c' });
  assert.equal(history.size('group:a'), 0);
  assert.equal(history.size('group:b'), 1);
  assert.equal(history.size('group:c'), 1);
  // 命中过的会话刷新为最近使用，下一次淘汰最旧的那个。
  history.record('group:b', { body: 'b2' });
  history.record('group:d', { body: 'd' });
  assert.equal(history.size('group:c'), 0);
  assert.equal(history.size('group:b'), 2);
});

test('the injected block carries the marker, note, time and escaping', () => {
  const entries = [
    normalizeGroupHistoryEntry({ sender: '张三', body: '下午三点评审', timestamp: 1_700_000_000_000 }),
    normalizeGroupHistoryEntry({ sender: '李四', body: '<b>收到</b> & ok', timestamp: 1_700_000_060_000 }),
  ];
  const block = formatGroupHistoryBlock(entries);
  assert.match(block, /^<dsh_im_group_history note="[^"]+">\n/);
  assert.match(block, /\n<\/dsh_im_group_history>$/);
  assert.match(block, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 张三: 下午三点评审/);
  assert.equal(block.includes('<b>'), false, 'tag characters must be escaped');
  assert.equal(block.includes('\\u003cb\\u003e收到\\u003c/b\\u003e \\u0026 ok'), true);
  assert.equal(formatGroupHistoryBlock([]), '');
  assert.equal(formatGroupHistoryBlock(null), '');
});

test('the injected block drops the oldest entries to stay within the character budget', () => {
  const entries = Array.from({ length: 40 }, (_, index) => normalizeGroupHistoryEntry({
    sender: 'S',
    body: `m${index}-${'a'.repeat(MAX_GROUP_HISTORY_ENTRY_CHARS - 8)}`,
  }));
  const block = formatGroupHistoryBlock(entries);
  assert.equal([...block].length <= MAX_GROUP_HISTORY_BLOCK_CHARS, true);
  assert.equal(block.includes('m39-'), true, 'the newest entry must survive');
  assert.equal(block.includes('m0-'), false, 'the oldest entries are dropped first');
});

test('the context block is prepended before the current message', () => {
  const block = '<dsh_im_group_history note="n">\n[2026-09-10 14:12] 张三: 下午三点评审\n</dsh_im_group_history>';
  const content = appendGroupHistoryContext('帮我总结一下', block);
  assert.equal(content.endsWith('\n帮我总结一下'), true);
  assert.equal(content.includes(CURRENT_MESSAGE_MARKER), true);
  assert.equal(content.indexOf(block) < content.indexOf(CURRENT_MESSAGE_MARKER), true);
  assert.equal(content.indexOf(CURRENT_MESSAGE_MARKER) < content.indexOf('帮我总结一下'), true);
  // 图片消息走数组内容，块作为第一个文本块前置。
  const arrayContent = appendGroupHistoryContext([{ type: 'text', text: '正文' }], block);
  assert.equal(Array.isArray(arrayContent), true);
  assert.equal(arrayContent[0].text.startsWith(block), true);
  assert.deepEqual(arrayContent[1], { type: 'text', text: '正文' });
  // 空块与未知内容形态原样返回。
  assert.equal(appendGroupHistoryContext('只有正文', ''), '只有正文');
  assert.equal(appendGroupHistoryContext('只有正文', '   '), '只有正文');
  assert.deepEqual(appendGroupHistoryContext({ custom: true }, block), { custom: true });
});

test('staged attachments are attached to their entry and listed in their own block', () => {
  const history = createGroupHistory();
  history.record('group:g-1', { sender: '张三', body: '[图片] photo.png', messageId: 'id-1', timestamp: 1_700_000_000_000 });
  history.record('group:g-1', { sender: '李四', body: '看下附件', messageId: 'id-2', timestamp: 1_700_000_060_000 });
  assert.deepEqual(history.snapshot('group:g-1')[0].files, []);
  assert.equal(formatGroupHistoryFilesBlock(history.snapshot('group:g-1')), '');

  const attached = history.attachFiles('group:g-1', 'id-1', [
    { name: 'photo.png', path: '.dsh-im/group-context/g-1/20260910-141200-id-1/01-photo.png' },
  ]);
  assert.equal(attached.files.length, 1);
  assert.equal(history.attachFiles('group:g-1', 'missing', [{ path: 'x' }]), null);
  assert.equal(history.attachFiles('group:g-1', 'id-2', []), null);
  assert.equal(history.attachFiles('group:missing', 'id-1', [{ path: 'x' }]), null);

  const entries = history.snapshot('group:g-1');
  assert.equal(entries[0].files[0].name, 'photo.png');
  const filesBlock = formatGroupHistoryFilesBlock(entries);
  assert.match(filesBlock, /^<dsh_im_group_files>\n/u);
  assert.match(filesBlock, /\n<\/dsh_im_group_files>$/u);
  const payload = JSON.parse(filesBlock.split('\n')[1]);
  assert.equal(payload.files.length, 1);
  assert.equal(payload.files[0].sender, '张三');
  assert.equal(payload.files[0].path, '.dsh-im/group-context/g-1/20260910-141200-id-1/01-photo.png');
  assert.match(payload.files[0].time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u);
  assert.match(payload.description, /relative to the current Harness workspace/u);

  // 历史块与附件清单块一起前置，且顺序固定：历史 → 附件 → 当前消息。
  const content = appendGroupHistoryContext(
    '帮我看看',
    formatGroupHistoryBlock(entries),
    filesBlock,
  );
  assert.equal(content.indexOf('<dsh_im_group_history') < content.indexOf('<dsh_im_group_files>'), true);
  assert.equal(content.indexOf('<dsh_im_group_files>') < content.indexOf(CURRENT_MESSAGE_MARKER), true);
  assert.equal(content.endsWith('\n帮我看看'), true);

  // 条目被消费后附件清单随之消失，但磁盘文件不受影响（由保留期清理）。
  history.consume('group:g-1', entries);
  assert.equal(formatGroupHistoryFilesBlock(history.snapshot('group:g-1')), '');
});

test('the attachment block drops the oldest files first when it exceeds its budget', () => {
  const history = createGroupHistory();
  for (let index = 0; index < 60; index += 1) {
    history.record('group:g-1', {
      sender: 'S',
      body: `m${index}`,
      messageId: `id-${index}`,
      timestamp: 1_700_000_000_000 + index * 1000,
    });
    history.attachFiles('group:g-1', `id-${index}`, [{
      name: `${'n'.repeat(120)}-${index}.bin`,
      path: `.dsh-im/group-context/g-1/${'p'.repeat(80)}-${index}/01-file.bin`,
    }]);
  }
  const block = formatGroupHistoryFilesBlock(history.snapshot('group:g-1', { limit: 200 }));
  assert.equal([...block].length <= 4_000, true);
  const payload = JSON.parse(block.split('\n')[1]);
  assert.equal(payload.files.at(-1).name.endsWith('-59.bin'), true, 'the newest attachment survives');
  assert.equal(payload.files.some((file) => file.name.endsWith('-0.bin')), false, 'the oldest are dropped');
});
