import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveYouduRoute } from '../../../src/channels/youdu/target-resolve.mjs';

const people = [
  { chatId: '6463894', account: 'lewis.liu', name: '刘钟泽' },
  { chatId: '7000001', account: 'zhang.san', name: '张三' },
  { chatId: '7000002', account: 'sun.li', name: '张三' },
  { chatId: '7000003', account: 'wang.wu', name: '王五' },
  { chatId: '7000004', account: 'zhao.liu', name: 'Zhao Liu' },
];
const groups = [
  { chatId: '{0798E01E-CD68-42BB-813C-EB51593BB0F5}', name: '研发群' },
  { chatId: '{11111111-2222-3333-4444-555555555555}', name: '产品群' },
  { chatId: '{99999999-8888-7777-6666-555555555555}', name: '研发群' },
];

function failure(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('numeric direct-chat ids and group ids pass through untouched', () => {
  assert.deepEqual(resolveYouduRoute('user', '6463894', { people, groups }), { chatId: '6463894' });
  assert.deepEqual(
    resolveYouduRoute('group', '{0798E01E-CD68-42BB-813C-EB51593BB0F5}', { people, groups }),
    { chatId: '{0798E01E-CD68-42BB-813C-EB51593BB0F5}' },
  );
});

test('an already-learned chat id is authoritative even without the canonical shape', () => {
  // 有度的群会话 ID 通常是 {GUID}，但历史数据里也有纯数字的群 chatId。
  assert.deepEqual(resolveYouduRoute('group', '2048', {
    people,
    groups: [{ chatId: '2048', name: '研发群' }],
  }), { chatId: '2048' });
});

test('a nickname resolves to the learned direct chat id', () => {
  assert.deepEqual(resolveYouduRoute('user', '刘钟泽', { people, groups }), { chatId: '6463894' });
  assert.deepEqual(resolveYouduRoute('user', '王五', { people, groups }), { chatId: '7000003' });
});

test('an account name is preferred over a nickname', () => {
  // 张三 这个昵称重复，但 lewis.liu / zhang.san 这类账号名是唯一的。
  assert.deepEqual(resolveYouduRoute('user', 'zhang.san', { people, groups }), { chatId: '7000001' });
  assert.deepEqual(resolveYouduRoute('user', 'lewis.liu', { people, groups }), { chatId: '6463894' });
});

test('name matching falls back to a case-insensitive comparison', () => {
  assert.deepEqual(resolveYouduRoute('user', 'zhao liu', { people, groups }), { chatId: '7000004' });
  assert.deepEqual(resolveYouduRoute('group', '产品群', { people, groups }), {
    chatId: '{11111111-2222-3333-4444-555555555555}',
  });
});

test('duplicate nicknames are rejected instead of guessed', () => {
  assert.throws(
    () => resolveYouduRoute('user', '张三', { people, groups }),
    (error) => {
      assert.equal(error.code, 'youdu-target-ambiguous');
      assert.match(error.message, /zhang\.san, 7000001/);
      assert.match(error.message, /sun\.li, 7000002/);
      return true;
    },
  );
});

test('duplicate group names are rejected with their ids', () => {
  assert.throws(
    () => resolveYouduRoute('group', '研发群', { people, groups }),
    (error) => {
      assert.equal(error.code, 'youdu-target-ambiguous');
      assert.match(error.message, /\{0798E01E-CD68-42BB-813C-EB51593BB0F5\}/);
      assert.match(error.message, /\{99999999-8888-7777-6666-555555555555\}/);
      return true;
    },
  );
});

test('unknown names and empty targets are reported clearly', () => {
  failure(() => resolveYouduRoute('user', '不存在的人', { people, groups }), 'youdu-target-unknown');
  failure(() => resolveYouduRoute('group', '不存在的群', { people, groups }), 'youdu-target-unknown');
  failure(() => resolveYouduRoute('user', '   ', { people, groups }), 'youdu-target-empty');
});

test('a group name is not usable as a direct chat target and vice versa', () => {
  failure(() => resolveYouduRoute('user', '研发群', { people, groups }), 'youdu-target-unknown');
  failure(
    () => resolveYouduRoute('group', '刘钟泽', { people, groups }),
    'youdu-target-unknown',
  );
});

test('an unknown target kind is rejected', () => {
  failure(() => resolveYouduRoute('channel', '研发群', { people, groups }), 'invalid-target');
});

