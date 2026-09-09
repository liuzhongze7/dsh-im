import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import TestRenderer from 'react-test-renderer';

import { YouduSettingsTab } from '../../../plugin-src/client/channels/youdu/index.js';
import { normalizeSnapshot } from '../../../plugin-src/client/channels/youdu/api.js';

const { act, create } = TestRenderer;
const BOT_ID = 'yd_1a7d8037a6758b93fe17c1cc';

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node?.children?.map(textOf).join('') ?? '';
}

function buttonNamed(root, name) {
  return root.findAllByType('button').find((button) => textOf(button) === name);
}

function botFixture(overrides = {}) {
  return {
    botId: BOT_ID,
    sourceBotId: 'oc86aed821c86345e4',
    ownerUserId: '*',
    connected: true,
    state: 'connected',
    configured: true,
    bot: { name: '有度机器人', wsHostMasked: 'internal.cindacode.com' },
    health: { summary: '有度 WebSocket 长连接运行正常', lastCheckedAt: Date.now() },
    workspace: 'D:\\Youdu',
    groupAccess: null,
    knownGroups: [{ chatId: '{0798E01E-CD68-42BB-813C-EB51593BB0F5}', lastSeenAt: Date.now(), messages: 12 }],
    error: null,
    ...overrides,
  };
}

function withWindow(run) {
  const previousWindow = globalThis.window;
  globalThis.window = {
    setInterval() { return 1; }, clearInterval() {},
    setTimeout() { return 1; }, clearTimeout() {},
    requestAnimationFrame(callback) { callback(); return 1; }, cancelAnimationFrame() {},
  };
  return run().finally(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
}

test('client normalization keeps per-group rules and observed groups', () => {
  const snapshot = normalizeSnapshot({
    schemaVersion: 1,
    revision: 3,
    bots: [botFixture({
      groupAccess: {
        version: 1,
        groups: {
          '{0798E01E-CD68-42BB-813C-EB51593BB0F5}': { mode: 'allowlist', users: ['1001', 'lewis.liu'] },
          '*': { mode: 'disabled' },
        },
      },
      knownGroups: [
        { chatId: '{0798E01E-CD68-42BB-813C-EB51593BB0F5}', lastSeenAt: '2026-09-09T09:00:00.000Z', messages: 3, extra: 'dropped' },
        { chatId: '', lastSeenAt: null, messages: 0 },
      ],
    })],
  });
  assert.deepEqual(snapshot.bots[0].groupAccess.groups['*'], { mode: 'disabled', users: [] });
  assert.deepEqual(snapshot.bots[0].knownGroups, [{
    chatId: '{0798E01E-CD68-42BB-813C-EB51593BB0F5}',
    lastSeenAt: Date.parse('2026-09-09T09:00:00.000Z'),
    messages: 3,
  }]);
  assert.equal(normalizeSnapshot({ revision: 1, bots: [botFixture({ groupAccess: { version: 9 } })] }).bots[0].groupAccess, null);
});

test('the settings page saves per-group rules through bot.group-access.set', async () => {
  await withWindow(async () => {
    const calls = [];
    const rpcCall = async (endpoint, payload) => {
      if (endpoint === 'connection.status') {
        return { ok: true, value: { revision: 1, bots: [botFixture()] } };
      }
      if (endpoint === 'bot.group-access.set') {
        calls.push(payload);
        return {
          ok: true,
          value: {
            revision: 2,
            bots: [botFixture({ groupAccess: payload.groupAccess })],
          },
        };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    };

    let renderer;
    await act(async () => {
      renderer = create(React.createElement(YouduSettingsTab, { rpcCall }));
      await flushMicrotasks();
    });

    const card = renderer.root.findByProps({ 'data-bot-id': BOT_ID });
    const groupSection = card.findAll((node) => node.type === 'div'
      && node.props?.className === 'ydt-accessInline')
      .find((node) => textOf(node).includes('按群访问'));
    assert.ok(groupSection, 'per-group section must be rendered');
    assert.match(textOf(groupSection), /未按群配置/);

    await act(async () => {
      buttonNamed(groupSection, '编辑').props.onClick();
      await flushMicrotasks();
    });

    const expanded = renderer.root.findByProps({ 'data-bot-id': BOT_ID })
      .findAll((node) => node.type === 'div')
      .find((node) => node.props?.className === 'ydt-accessInline'
        && textOf(node).includes('按群访问'));
    const row = expanded.findAll((node) => node.type === 'li'
      && node.props?.className === 'ydt-groupAccessRow')[0];
    assert.match(textOf(row), /\{0798E01E-CD68-42BB-813C-EB51593BB0F5\}/);
    assert.match(textOf(row), /12 条消息/);

    const select = row.findByType('select');
    await act(async () => {
      select.props.onChange({ target: { value: 'allowlist' } });
      await flushMicrotasks();
    });

    const updatedRow = renderer.root.findByProps({ 'data-bot-id': BOT_ID })
      .findAll((node) => node.type === 'li' && node.props?.className === 'ydt-groupAccessRow')[0];
    const users = updatedRow.findByProps({ className: 'ydt-groupAccessUsers' });
    await act(async () => {
      users.props.onChange({ target: { value: '1001, lewis.liu' } });
      await flushMicrotasks();
    });

    const form = renderer.root.findByProps({ 'data-bot-id': BOT_ID })
      .findAll((node) => node.type === 'form')
      .find((node) => node.props?.className === 'ydt-groupAccess');
    await act(async () => {
      buttonNamed(form, '保存按群设置').props.onClick({ preventDefault() {} });
      await flushMicrotasks();
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].botId, BOT_ID);
    assert.deepEqual(calls[0].groupAccess, {
      version: 1,
      groups: {
        '{0798E01E-CD68-42BB-813C-EB51593BB0F5}': { mode: 'allowlist', users: ['1001', 'lewis.liu'] },
      },
    });
    assert.match(textOf(renderer.root.findByProps({ 'data-bot-id': BOT_ID })), /按群访问设置已保存/);
    await act(async () => { renderer.unmount(); });
  });
});

test('an invalid per-group draft surfaces the validation message instead of calling the host', async () => {
  await withWindow(async () => {
    const calls = [];
    const rpcCall = async (endpoint, payload) => {
      if (endpoint === 'connection.status') {
        return { ok: true, value: { revision: 1, bots: [botFixture()] } };
      }
      calls.push(payload);
      throw new Error('must not be called');
    };

    let renderer;
    await act(async () => {
      renderer = create(React.createElement(YouduSettingsTab, { rpcCall }));
      await flushMicrotasks();
    });
    const card = renderer.root.findByProps({ 'data-bot-id': BOT_ID });
    const groupSection = card.findAll((node) => node.type === 'div'
      && node.props?.className === 'ydt-accessInline')
      .find((node) => textOf(node).includes('按群访问'));
    await act(async () => {
      buttonNamed(groupSection, '编辑').props.onClick();
      await flushMicrotasks();
    });
    const row = renderer.root.findByProps({ 'data-bot-id': BOT_ID })
      .findAll((node) => node.type === 'li' && node.props?.className === 'ydt-groupAccessRow')[0];
    await act(async () => {
      row.findByType('select').props.onChange({ target: { value: 'allowlist' } });
      await flushMicrotasks();
    });

    const form = renderer.root.findByProps({ 'data-bot-id': BOT_ID })
      .findAll((node) => node.type === 'form')
      .find((node) => node.props?.className === 'ydt-groupAccess');
    await act(async () => {
      buttonNamed(form, '保存按群设置').props.onClick({ preventDefault() {} });
      await flushMicrotasks();
    });

    assert.equal(calls.length, 0);
    assert.match(textOf(renderer.root.findByProps({ 'data-bot-id': BOT_ID })), /至少要配置一个用户/);
    await act(async () => { renderer.unmount(); });
  });
});
