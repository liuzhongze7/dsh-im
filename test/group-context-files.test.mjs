import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  DEFAULT_GROUP_CONTEXT_RETENTION_HOURS,
  GROUP_CONTEXT_DIRECTORY,
  KEEP_GROUP_CONTEXT_FOREVER,
  createGroupContextFiles,
  groupContextChatSegment,
  groupContextMessageSegment,
  normalizeGroupContextRetention,
  sweepGroupContextFiles,
} from '../src/channels/shared/group-context-files.mjs';
import { InboundFileError, parseInboundDirectoryName } from '../src/channels/shared/inbound-file.mjs';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-group-context-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** 目录名分段：跨平台断言用（Windows 下 relative 给的是反斜杠）。 */
function segments(value) {
  return value.split(/[\\/]+/u).filter(Boolean);
}

async function seedStagedDirectory(root, chat, message, { now = new Date() } = {}) {
  const directory = join(root, GROUP_CONTEXT_DIRECTORY, chat, groupContextMessageSegment(message, now));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, '01-a.bin'), 'x');
  return directory;
}

test('the chat and message directory segments are filesystem safe and parseable', () => {
  const chat = groupContextChatSegment('{0798E01E-CD68-42BB-813C-EB51593BB0F5}');
  assert.match(chat, /^[^\\/:*?"<>|]+$/u);
  assert.equal(chat.includes('{'), true, 'a brace is legal in a path segment and stays readable');
  assert.equal(groupContextChatSegment('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(groupContextChatSegment(''), 'chat');
  assert.equal(groupContextChatSegment('...'), 'chat');
  assert.equal(groupContextChatSegment('字'.repeat(200)).length, 60);

  const segment = groupContextMessageSegment('1777543724', new Date(2026, 8, 10, 14, 12, 30));
  assert.equal(segment, '20260910-141230-1777543724');
  assert.equal(parseInboundDirectoryName(segment)?.getHours(), 14);
  assert.equal(groupContextMessageSegment('', new Date(2026, 8, 10, 14, 12, 30)), '20260910-141230-message');
});

test('the retention value only accepts a non-negative integer or keep-forever', () => {
  assert.equal(normalizeGroupContextRetention(undefined), DEFAULT_GROUP_CONTEXT_RETENTION_HOURS);
  assert.equal(DEFAULT_GROUP_CONTEXT_RETENTION_HOURS, 24 * 7);
  assert.equal(normalizeGroupContextRetention(-1), KEEP_GROUP_CONTEXT_FOREVER);
  assert.equal(normalizeGroupContextRetention(-5), KEEP_GROUP_CONTEXT_FOREVER);
  assert.equal(normalizeGroupContextRetention(0), 0);
  assert.equal(normalizeGroupContextRetention(36), 36);
  assert.equal(normalizeGroupContextRetention(2.5), DEFAULT_GROUP_CONTEXT_RETENTION_HOURS);
  assert.equal(normalizeGroupContextRetention('24'), DEFAULT_GROUP_CONTEXT_RETENTION_HOURS);
});

test('staging writes the attachments into the group context tree with relative paths', async (t) => {
  const root = await workspace(t);
  const files = createGroupContextFiles({ sweepIntervalMs: 0 });
  const staged = await files.stage({
    workspace: root,
    chatId: '{0798E01E-CD68-42BB-813C-EB51593BB0F5}',
    messageId: '1777543724',
    files: [
      { name: 'photo.png', data: Buffer.from([0x01, 0x02]), mediaType: 'image/png' },
      { name: 'report.pdf', data: Buffer.from('pdf'), mediaType: 'application/pdf' },
    ],
  });

  assert.equal(staged.files.length, 2);
  assert.deepEqual(segments(staged.files[0].path).slice(0, 3), [
    '.dsh-im', 'group-context', '{0798E01E-CD68-42BB-813C-EB51593BB0F5}',
  ]);
  assert.match(segments(staged.files[0].path)[3], /^\d{8}-\d{6}-1777543724$/u);
  assert.equal(segments(staged.files[0].path)[4], '01-photo.png');
  assert.equal(segments(staged.files[1].path)[4], '02-report.pdf');
  // 相对路径 + 相对路径必须真的落在工作区里的那个文件上。
  assert.equal(relative(root, staged.directory).startsWith('..'), false);
  assert.deepEqual(await readFile(resolve(root, staged.files[0].path)), Buffer.from([0x01, 0x02]));
  assert.deepEqual(await readFile(resolve(root, staged.files[1].path)), Buffer.from('pdf'));
  assert.deepEqual(staged.files.map((file) => file.mediaType), ['image/png', 'application/pdf']);
  assert.equal(files.isTracked(staged.directory), false, 'staging releases its in-flight marker');
});

test('staging streams and never follows traversal-like names out of the workspace', async (t) => {
  const root = await workspace(t);
  const files = createGroupContextFiles({ sweepIntervalMs: 0 });
  const staged = await files.stage({
    workspace: root,
    chatId: 'g-1',
    messageId: '../../escape',
    files: [
      {
        name: '../../etc/passwd',
        load: async () => ({ stream: Readable.from([Buffer.from('stream-bytes')]) }),
      },
    ],
  });
  const path = segments(staged.files[0].path);
  assert.deepEqual(path.slice(0, 3), ['.dsh-im', 'group-context', 'g-1']);
  assert.equal(path.includes('..'), false, 'no segment may traverse upwards');
  assert.equal(path.includes('.'), false);
  assert.equal(path.length, 5);
  assert.match(path[3], /^\d{8}-\d{6}-.+$/u);
  assert.equal(path[4], '01-passwd');
  assert.equal(staged.files[0].name, 'passwd');
  assert.deepEqual(await readFile(resolve(root, staged.files[0].path)), Buffer.from('stream-bytes'));
});

test('a failed download removes the partially staged directory and reports the cause', async (t) => {
  const root = await workspace(t);
  const files = createGroupContextFiles({ sweepIntervalMs: 0 });
  await assert.rejects(
    () => files.stage({
      workspace: root,
      chatId: 'g-1',
      messageId: 'm-1',
      files: [
        { name: 'ok.bin', data: Buffer.from('ok') },
        { name: 'broken.bin', load: async () => { throw new Error('socket closed'); } },
      ],
    }),
    (error) => error instanceof InboundFileError
      && error.code === 'group-context-download-failed'
      && /socket closed/u.test(error.message),
  );
  const chatDirectory = join(root, GROUP_CONTEXT_DIRECTORY, 'g-1');
  assert.deepEqual(await readdir(chatDirectory).catch(() => []), []);
  assert.equal(files.isTracked(join(chatDirectory, groupContextMessageSegment('m-1'))), false);
});

test('staging requires an absolute workspace and at least one file', async (t) => {
  const root = await workspace(t);
  const files = createGroupContextFiles({ sweepIntervalMs: 0 });
  assert.equal(await files.stage({ workspace: root, chatId: 'g', messageId: 'm', files: [] }), null);
  await assert.rejects(
    () => files.stage({ workspace: 'relative/path', chatId: 'g', messageId: 'm', files: [{ name: 'a', data: Buffer.from('a') }] }),
    (error) => error?.code === 'group-context-workspace-unavailable',
  );
});

test('the sweep deletes only entries past the retention window', async (t) => {
  const root = await workspace(t);
  const now = new Date(2026, 8, 10, 12, 0, 0);
  const fresh = await seedStagedDirectory(root, 'g-1', 'm-fresh', { now: new Date(2026, 8, 10, 11, 0, 0) });
  const stale = await seedStagedDirectory(root, 'g-1', 'm-stale', { now: new Date(2026, 8, 8, 11, 0, 0) });
  const other = await seedStagedDirectory(root, 'g-2', 'm-other', { now: new Date(2026, 8, 1, 11, 0, 0) });

  const result = await sweepGroupContextFiles(root, 24, { now: () => now });
  assert.equal(result.deleted, 2);
  assert.equal(await stat(fresh).then(() => true, () => false), true);
  assert.equal(await stat(stale).then(() => true, () => false), false);
  assert.equal(await stat(other).then(() => true, () => false), false);
  // 空掉的群目录被清掉，仍有内容的群目录保留。
  assert.deepEqual(await readdir(join(root, GROUP_CONTEXT_DIRECTORY)), ['g-1']);
});

test('the sweep respects tracking, keep-forever and the zero retention', async (t) => {
  const root = await workspace(t);
  const now = new Date(2026, 8, 10, 12, 0, 0);
  const tracked = await seedStagedDirectory(root, 'g-1', 'm-tracked', { now: new Date(2026, 8, 1, 11, 0, 0) });
  const untracked = await seedStagedDirectory(root, 'g-1', 'm-untracked', { now: new Date(2026, 8, 1, 12, 0, 0) });

  assert.deepEqual(
    await sweepGroupContextFiles(root, 1, { now: () => now, isTracked: (path) => path === tracked }),
    { deleted: 1 },
  );
  assert.equal(await stat(tracked).then(() => true, () => false), true);
  assert.equal(await stat(untracked).then(() => true, () => false), false);

  assert.deepEqual(
    await sweepGroupContextFiles(root, KEEP_GROUP_CONTEXT_FOREVER, { now: () => now }),
    { deleted: 0 },
  );
  assert.equal(await stat(tracked).then(() => true, () => false), true);

  // TTL 0 表示下一次清理就删（不受时间窗保护）。
  assert.deepEqual(await sweepGroupContextFiles(root, 0, { now: () => now }), { deleted: 1 });
  assert.equal(await stat(tracked).then(() => true, () => false), false);
});

test('the sweep ignores unparsable names and a missing tree', async (t) => {
  const root = await workspace(t);
  const directory = join(root, GROUP_CONTEXT_DIRECTORY, 'g-1', 'manual-notes');
  await mkdir(directory, { recursive: true });
  assert.deepEqual(await sweepGroupContextFiles(root, 0), { deleted: 0 });
  assert.equal(await stat(directory).then(() => true, () => false), true);

  const missing = join(root, 'no-such-workspace');
  await mkdir(missing, { recursive: true });
  assert.deepEqual(await sweepGroupContextFiles(missing, 0), { deleted: 0 });

  // 工作区本身不存在时必须安全退出，而不是抛错或乱删。
  assert.deepEqual(await sweepGroupContextFiles(join(root, 'gone'), 0), { deleted: 0 });
  await assert.rejects(() => sweepGroupContextFiles('', 0), /requires a workspace/u);
});

test('the listing rebuilds the recent attachments of one group from disk', async (t) => {
  const root = await workspace(t);
  const chatId = '{0798E01E-CD68-42BB-813C-EB51593BB0F5}';
  const files = createGroupContextFiles({ retentionHours: 24, sweepIntervalMs: 0 });
  const staged = await files.stage({
    workspace: root,
    chatId,
    messageId: '1777543724',
    sender: '张三',
    timestamp: 1_700_000_000_000,
    files: [{ name: 'photo.png', data: Buffer.from('png') }],
  });

  const listing = await files.list(root, chatId);
  assert.deepEqual(segments(listing.directory).slice(0, 2), ['.dsh-im', 'group-context']);
  assert.equal(listing.messages.length, 1);
  assert.equal(listing.messages[0].sender, '张三');
  assert.equal(listing.messages[0].messageId, '1777543724');
  assert.equal(listing.messages[0].timestamp, 1_700_000_000_000);
  assert.deepEqual(listing.messages[0].files, [{
    name: 'photo.png',
    path: staged.files[0].path,
  }]);
  // 元数据落盘，重启后清单仍能还原发送者与时间。
  const meta = JSON.parse(await readFile(join(root, staged.files[0].path, '..', '.meta.json'), 'utf8'));
  assert.equal(meta.sender, '张三');
  assert.deepEqual(meta.files, [{ name: 'photo.png', storage: '01-photo.png' }]);

  await new Promise((resolve) => { setTimeout(resolve, 1100); });
  await files.stage({
    workspace: root,
    chatId,
    messageId: '1777543800',
    sender: '李四',
    timestamp: 1_700_000_100_000,
    files: [{ name: 'spec.pdf', data: Buffer.from('pdf') }],
  });
  const newer = await files.list(root, chatId);
  assert.deepEqual(newer.messages.map((message) => message.messageId), ['1777543800', '1777543724']);
  assert.equal((await files.list(root, chatId, { limit: 1 })).messages.length, 1);

  // 其他群、缺失的群/工作区、相对路径都安全返回。
  assert.deepEqual((await files.list(root, 'other-group')).messages, []);
  assert.deepEqual((await files.list(join(root, 'gone'), chatId)).messages, []);
  assert.deepEqual((await files.list('relative', chatId)).messages, []);
});

test('the listing skips in-flight downloads, stale messages and honours the limit', async (t) => {
  const root = await workspace(t);
  const chatId = 'g-1';
  // 保留期 1 小时：更早的目录不该出现在清单里。
  const files = createGroupContextFiles({ retentionHours: 1, sweepIntervalMs: 0 });
  await seedStagedDirectory(root, chatId, 'm-stale', { now: new Date(Date.now() - 26 * 3_600_000) });
  await seedStagedDirectory(root, chatId, 'm-fresh');
  await seedStagedDirectory(root, chatId, 'm-fresh-2');
  assert.equal((await files.list(root, chatId)).messages.length, 2);
  assert.equal((await files.list(root, chatId, { limit: 1 })).messages.length, 1);

  // keep-forever 与 0 保留都不做时间过滤（0 只是让清理更早动手）。
  assert.equal(
    (await createGroupContextFiles({ retentionHours: -1, sweepIntervalMs: 0 }).list(root, chatId)).messages.length,
    3,
  );
  assert.equal(
    (await createGroupContextFiles({ retentionHours: 0, sweepIntervalMs: 0 }).list(root, chatId)).messages.length,
    3,
  );

  // 下载中的目录不出现在清单里，避免给出半份文件。
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const staging = createGroupContextFiles({ sweepIntervalMs: 0 });
  const pendingStage = staging.stage({
    workspace: root,
    chatId,
    messageId: 'm-inflight',
    sender: '王五',
    timestamp: Date.now(),
    files: [{ name: 'big.bin', load: async () => { await gate; return Buffer.from('big'); } }],
  });
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  const during = await staging.list(root, chatId);
  assert.equal(during.messages.some((message) => message.messageId === 'm-inflight'), false);
  release();
  await pendingStage;
  const after = await staging.list(root, chatId);
  // 目录名的时间戳只精确到秒，同秒内落盘的两条谁在前不保证；只断言它出现了。
  assert.equal(after.messages.some((message) => message.messageId === 'm-inflight'), true);
  assert.equal(
    after.messages.find((message) => message.messageId === 'm-inflight').sender,
    '王五',
  );
});

test('the listing falls back to the storage name when metadata is missing', async (t) => {
  const root = await workspace(t);
  const chatId = 'g-1';
  const files = createGroupContextFiles({ retentionHours: -1, sweepIntervalMs: 0 });
  const directory = join(root, GROUP_CONTEXT_DIRECTORY, chatId, '20260910-141230-1777543724');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, '01-photo.png'), 'png');
  await writeFile(join(directory, '02-note.txt'), 'note');

  const listing = await files.list(root, chatId);
  assert.equal(listing.messages.length, 1);
  assert.equal(listing.messages[0].messageId, '1777543724');
  assert.equal(listing.messages[0].sender, '');
  assert.deepEqual(listing.messages[0].files.map((file) => file.name), ['photo.png', 'note.txt']);

  // 无法解析目录名（没有时间戳）的目录不参与清单。
  await mkdir(join(root, GROUP_CONTEXT_DIRECTORY, chatId, 'manual-notes'), { recursive: true });
  await writeFile(join(root, GROUP_CONTEXT_DIRECTORY, chatId, 'manual-notes', 'a.txt'), 'a');
  assert.equal((await files.list(root, chatId)).messages.length, 1);
});

test('stage triggers a throttled sweep and never lets a sweep failure break staging', async (t) => {
  const root = await workspace(t);
  const logs = [];
  const files = createGroupContextFiles({
    retentionHours: 1,
    sweepIntervalMs: 60 * 60_000,
    logger: { warn: (...args) => logs.push(args) },
  });
  const stale = await seedStagedDirectory(root, 'g-1', 'm-stale', { now: new Date(2026, 8, 1, 11, 0, 0) });

  const first = await files.sweepIfDue(root);
  assert.equal(first.deleted, 1);
  assert.equal(await stat(stale).then(() => true, () => false), false);

  const fresh = await seedStagedDirectory(root, 'g-1', 'm-fresh', { now: new Date(2026, 8, 1, 11, 0, 0) });
  // 间隔内不再重复清理……
  assert.deepEqual(await files.sweepIfDue(root), { deleted: 0 });
  assert.equal(await stat(fresh).then(() => true, () => false), true);
  // ……但显式 sweep 仍然生效。
  assert.deepEqual(await files.sweep(root), { deleted: 1 });
  assert.equal(await stat(fresh).then(() => true, () => false), false);
  assert.deepEqual(logs, []);

  // 清理失败只记日志：写入路径不受影响。
  const broken = createGroupContextFiles({
    retentionHours: 1,
    sweepIntervalMs: 0,
    logger: { warn: (...args) => logs.push(args) },
  });
  const missing = join(root, 'gone-workspace');
  assert.deepEqual(await broken.sweepIfDue(missing), { deleted: 0 });
  assert.equal(logs.length, 0, 'a missing workspace is not an error');
});
