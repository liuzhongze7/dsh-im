import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as React from 'react';
import TestRenderer from 'react-test-renderer';

import {
  DEFAULT_GROUP_HISTORY_CONFIG,
  GROUP_HISTORY_LIMIT_MAX,
  validateGroupHistoryConfig,
} from '../../../src/channels/shared/group-history.mjs';
import { GroupHistoryEditor, groupHistoryLabel } from '../../../plugin-src/client/group-history.js';
import { en, localizeText, setImTranslator } from '../../../plugin-src/client/i18n.js';
import { YouduSettingsTab } from '../../../plugin-src/client/channels/youdu/index.js';
import { YOUDU_ENDPOINTS } from '../../../plugin-src/client/channels/youdu/api.js';

const { act, create } = TestRenderer;
const BOT_ID = 'yd_1a7d8037a6758b93fe17c1cc';
const VALIDATION_MESSAGE = '缓存条数必须是 0 到 200 之间的整数，0 表示关闭。';

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node?.children?.map(textOf).join('') ?? '';
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function entry(root) {
  return root.findByProps({ className: 'dim-contextEntry' });
}

function badge(root) {
  return textOf(root.findByProps({ className: 'dim-contextStatus' }));
}

function limitInput(root) {
  return root.findByProps({ className: 'dim-contextLimit' });
}

function switchInput(root) {
  return root.findByProps({ role: 'switch' });
}

function button(root, name) {
  const found = root.findAllByType('button').find((node) => textOf(node) === name);
  assert.ok(found, `missing button: ${name}`);
  return found;
}

async function mount(t, props, options) {
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(GroupHistoryEditor, props), options);
    await flush();
  });
  t.after(async () => { await act(async () => { renderer.unmount(); await flush(); }); });
  return renderer;
}

async function open(root) {
  await act(async () => { entry(root).props.onClick(); await flush(); });
}

async function click(root, name) {
  await act(async () => { button(root, name).props.onClick(); await flush(); });
}

async function setLimit(root, value) {
  await act(async () => { limitInput(root).props.onChange({ target: { value } }); });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
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
    error: null,
    ...overrides,
  };
}

test('the cache label has an English projection in both its static and composed forms', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  assert.equal(localizeText('群聊上下文'), 'Group chat context');
  assert.equal(localizeText('未开启'), 'Not enabled');
  // 运行时拼出来的状态标签同样要走动态翻译，否则英文界面会残留中文。
  for (const label of [groupHistoryLabel(DEFAULT_GROUP_HISTORY_CONFIG), groupHistoryLabel({ limit: 12 })]) {
    assert.equal(/[\p{Script=Han}]/u.test(localizeText(label)), false, `${label} must be translated`);
  }
  assert.equal(localizeText(groupHistoryLabel({ limit: 12 })), 'On · last 12 messages');
});

test('the trigger status label follows the normalized cache settings', async (t) => {
  assert.equal(groupHistoryLabel(undefined), '开启 · 最近 50 条');
  assert.equal(groupHistoryLabel(DEFAULT_GROUP_HISTORY_CONFIG), '开启 · 最近 50 条');
  assert.equal(groupHistoryLabel({}), '开启 · 最近 50 条');
  assert.equal(groupHistoryLabel({ limit: 20 }), '开启 · 最近 20 条');
  assert.equal(groupHistoryLabel({ limit: 500 }), `开启 · 最近 ${GROUP_HISTORY_LIMIT_MAX} 条`);
  for (const config of [
    { enabled: false, limit: 50 },
    { enabled: true, limit: 0 },
    { enabled: false, limit: 0 },
  ]) {
    assert.equal(groupHistoryLabel(config), '未开启');
  }

  const renderer = await mount(t, { onSave: () => {} });
  const trigger = entry(renderer.root);
  assert.equal(trigger.props.type, 'button');
  assert.equal(trigger.props.disabled, false);
  assert.equal(trigger.props['aria-haspopup'], 'dialog');
  assert.equal(trigger.props['aria-expanded'], false);
  assert.equal(trigger.props['aria-controls'], undefined);
  assert.equal(badge(renderer.root), '开启 · 最近 50 条');
  assert.equal(renderer.root.findByProps({ className: 'dim-contextStatus' }).props['data-active'], true);
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);

  const inactive = await mount(t, { config: { enabled: true, limit: 0 }, onSave: () => {} });
  assert.equal(badge(inactive.root), '未开启');
  assert.equal(
    inactive.root.findByProps({ className: 'dim-contextStatus' }).props['data-active'],
    false,
  );
});

test('the dialog exposes the switch, the bounded limit input and the cache help text', async (t) => {
  const saved = [];
  const renderer = await mount(t, {
    config: { enabled: true, limit: 20 },
    onSave: (value) => saved.push(value),
  });
  await open(renderer.root);

  const dialog = renderer.root.findByProps({ role: 'dialog' });
  assert.equal(dialog.props['aria-modal'], 'true');
  assert.equal(dialog.props['aria-busy'], false);
  assert.equal(dialog.props.tabIndex, -1);
  assert.equal(textOf(renderer.root.findByProps({ id: dialog.props['aria-labelledby'] })), '群聊上下文');
  assert.equal(renderer.root.findByProps({ className: 'dim-contextEntry' }).props['aria-expanded'], true);
  assert.ok(renderer.root.findByProps({ className: 'dim-contextEntry' }).props['aria-controls']);

  const switchRow = renderer.root.findByProps({ className: 'dim-contextSwitchRow' });
  assert.equal(textOf(switchRow), '启用');
  const toggle = switchInput(renderer.root);
  assert.equal(toggle.props.type, 'checkbox');
  assert.equal(toggle.props.checked, true);
  assert.equal(toggle.props.disabled, false);

  const limit = limitInput(renderer.root);
  assert.equal(limit.props.type, 'number');
  assert.equal(limit.props.inputMode, 'numeric');
  assert.equal(limit.props.min, 0);
  assert.equal(limit.props.max, GROUP_HISTORY_LIMIT_MAX);
  assert.equal(limit.props.step, 1);
  assert.equal(limit.props.value, '20');
  assert.equal(limit.props.disabled, false);
  assert.equal(textOf(renderer.root.findByProps({ htmlFor: limit.props.id })), '缓存条数');

  const help = renderer.root.findByProps({ 'aria-label': '查看缓存条数说明' });
  const tooltip = renderer.root.findByProps({ id: help.props['aria-describedby'] });
  assert.equal(help.props.type, 'button');
  assert.equal(tooltip.props.role, 'tooltip');
  assert.equal(limit.props['aria-describedby'], tooltip.props.id);
  assert.equal(dialog.props['aria-describedby'], tooltip.props.id);
  assert.equal(renderer.root.findByProps({ className: 'dim-contextSection dim-contextScope' }).props.disabled, false);
  const helpText = textOf(tooltip);
  assert.match(helpText, /缓存群里没有 @ 机器人的最近消息，机器人被 @ 时把这些消息作为上下文一起交给模型/);
  assert.match(helpText, /0 表示不缓存/);
  assert.match(helpText, /默认 50 条/);
  assert.match(helpText, /只作用于群聊/);
  assert.match(helpText, /缓存在内存中、重启即清空/);
  assert.match(helpText, /被群访问规则拒绝的群不缓存/);
  assert.equal(
    renderer.root.findAllByType('p').some((node) => /0 表示不缓存/.test(textOf(node))),
    false,
    '帮助文案只放在 tooltip 里，不重复渲染成正文段落',
  );
  assert.equal(renderer.root.findByProps({ 'aria-label': '关闭弹窗' }).props.disabled, false);
  assert.deepEqual(saved, []);
});

test('saving keeps the entered limit and submits the normalized config exactly once', async (t) => {
  const calls = [];
  function Fixture() {
    const [config, setConfig] = React.useState(undefined);
    return React.createElement(GroupHistoryEditor, {
      config,
      onSave(value) { calls.push(value); setConfig(value); },
    });
  }
  let renderer;
  await act(async () => { renderer = create(React.createElement(Fixture)); await flush(); });
  t.after(async () => { await act(async () => { renderer.unmount(); await flush(); }); });

  await open(renderer.root);
  await setLimit(renderer.root, '120');
  assert.equal(limitInput(renderer.root).props.value, '120');
  assert.deepEqual(calls, [], '编辑草稿不触发保存');
  await click(renderer.root, '保存');
  assert.deepEqual(calls, [{ enabled: true, limit: 120 }]);
  assert.equal(Object.isFrozen(calls[0]), true);
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0, '保存成功后关闭弹窗');
  assert.equal(badge(renderer.root), '开启 · 最近 120 条');

  await open(renderer.root);
  assert.equal(limitInput(renderer.root).props.value, '120');
  await setLimit(renderer.root, '0');
  await click(renderer.root, '取消');
  assert.equal(calls.length, 1, '取消必须丢弃草稿');
  assert.equal(badge(renderer.root), '开启 · 最近 120 条');

  await open(renderer.root);
  assert.equal(limitInput(renderer.root).props.value, '120');
  assert.equal(switchInput(renderer.root).props.checked, true);
  await setLimit(renderer.root, '0');
  await click(renderer.root, '保存');
  assert.deepEqual(calls, [{ enabled: true, limit: 120 }, { enabled: true, limit: 0 }]);
  assert.equal(badge(renderer.root), '未开启', '条数为 0 时视为未开启');

  await open(renderer.root);
  await act(async () => { switchInput(renderer.root).props.onChange({ target: { checked: false } }); });
  await click(renderer.root, '保存');
  assert.deepEqual(calls.at(-1), { enabled: false, limit: 0 });
  assert.equal(badge(renderer.root), '未开启');
});

test('a non-integer or out-of-range limit is rejected locally without calling the host', async (t) => {
  assert.throws(
    () => validateGroupHistoryConfig({ enabled: true, limit: 3.5 }),
    { message: VALIDATION_MESSAGE },
  );
  const calls = [];
  const renderer = await mount(t, {
    config: DEFAULT_GROUP_HISTORY_CONFIG,
    onSave: (value) => calls.push(value),
  });
  await open(renderer.root);
  for (const value of ['3.5', String(GROUP_HISTORY_LIMIT_MAX + 1), '-1', '', 'abc']) {
    await setLimit(renderer.root, value);
    await click(renderer.root, '保存');
    assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 1, `弹窗必须保持打开：${value}`);
    assert.equal(textOf(renderer.root.findByProps({ role: 'alert' })), VALIDATION_MESSAGE, value);
    assert.equal(limitInput(renderer.root).props.value, value, `草稿必须保留：${value}`);
  }
  assert.deepEqual(calls, [], '本地校验失败不得调用 onSave');

  await setLimit(renderer.root, String(GROUP_HISTORY_LIMIT_MAX));
  await click(renderer.root, '保存');
  assert.deepEqual(calls, [{ enabled: true, limit: GROUP_HISTORY_LIMIT_MAX }]);
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
});

test('disabled locks the trigger and every control, and saving stays inert', async (t) => {
  const calls = [];
  const onSave = (value) => calls.push(value);
  const renderer = await mount(t, { onSave });
  await open(renderer.root);
  assert.equal(limitInput(renderer.root).props.disabled, false);

  await act(async () => {
    renderer.update(React.createElement(GroupHistoryEditor, { disabled: true, onSave }));
    await flush();
  });
  assert.equal(entry(renderer.root).props.disabled, true);
  assert.equal(renderer.root.findByProps({ className: 'dim-contextSection dim-contextScope' }).props.disabled, true);
  assert.ok(renderer.root.findAllByType('input').every((node) => node.props.disabled === true));
  for (const name of ['保存', '取消']) assert.equal(button(renderer.root, name).props.disabled, true, name);
  assert.equal(renderer.root.findByProps({ 'aria-label': '关闭弹窗' }).props.disabled, true);

  await setLimit(renderer.root, '10');
  assert.equal(limitInput(renderer.root).props.value, '50', '禁用时受控输入不得改写草稿');
  await act(async () => { switchInput(renderer.root).props.onChange({ target: { checked: false } }); });
  assert.equal(switchInput(renderer.root).props.checked, true);
  await click(renderer.root, '保存');
  assert.deepEqual(calls, []);
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 1);

  const locked = await mount(t, { disabled: true, onSave });
  assert.equal(entry(locked.root).props.disabled, true);
  assert.equal(locked.root.findAllByProps({ role: 'dialog' }).length, 0);
  assert.deepEqual(calls, []);
});

test('a rejected save keeps the draft and the open dialog, then reports the failure inline', async (t) => {
  const request = deferred();
  const calls = [];
  const renderer = await mount(t, {
    config: DEFAULT_GROUP_HISTORY_CONFIG,
    onSave(value) { calls.push(value); return calls.length === 1 ? request.promise : undefined; },
  });
  await open(renderer.root);
  await setLimit(renderer.root, '30');
  const save = button(renderer.root, '保存');
  await act(async () => { save.props.onClick(); save.props.onClick(); await flush(); });
  assert.equal(calls.length, 1, '保存中不得重复提交');
  assert.equal(renderer.root.findByProps({ role: 'dialog' }).props['aria-busy'], true);
  assert.ok(renderer.root.findAllByType('input').every((node) => node.props.disabled === true));
  assert.equal(textOf(button(renderer.root, '正在保存…')), '正在保存…');
  await act(async () => {
    limitInput(renderer.root).props.onChange({ target: { value: '999' } });
    renderer.root.findByProps({ role: 'dialog' }).props.onKeyDown({
      key: 'Escape', preventDefault() {}, stopPropagation() {},
    });
    button(renderer.root, '取消').props.onClick();
    await flush();
  });
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 1, '保存中不得关闭弹窗');
  assert.equal(limitInput(renderer.root).props.value, '30');

  request.reject(new Error('保存被拒绝'));
  await act(async () => { await flush(); });
  assert.equal(textOf(renderer.root.findByProps({ role: 'alert' })), '保存被拒绝');
  assert.equal(limitInput(renderer.root).props.value, '30');
  assert.equal(badge(renderer.root), '开启 · 最近 50 条', '失败后状态标签仍取自已保存配置');

  await click(renderer.root, '保存');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { enabled: true, limit: 30 });
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
  assert.equal(badge(renderer.root), '开启 · 最近 50 条', '状态标签只取父级传入的已保存配置');
});

test('the dialog traps Tab, closes with Escape or the backdrop, and restores trigger focus', async (t) => {
  const previous = globalThis.document;
  const listeners = new Map();
  const document = {
    activeElement: null,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
  };
  globalThis.document = document;
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const focusable = () => ({ focus() { document.activeElement = this; } });
  const trigger = focusable();
  const first = focusable();
  const last = focusable();
  const dialog = {
    ...focusable(),
    contains(node) { return [this, first, last].includes(node); },
    querySelectorAll() { return [first, last]; },
  };
  const renderer = await mount(t, { onSave: () => {} }, {
    createNodeMock(element) {
      if (element.props.className === 'dim-contextEntry') return trigger;
      if (element.props.role === 'dialog') return dialog;
      return {};
    },
  });
  await open(renderer.root);
  assert.equal(document.activeElement, dialog);
  const keydown = (shiftKey) => {
    let prevented = false;
    renderer.root.findByProps({ role: 'dialog' }).props.onKeyDown({
      key: 'Tab', shiftKey, preventDefault() { prevented = true; },
    });
    assert.equal(prevented, true);
  };
  keydown(false);
  assert.equal(document.activeElement, first);
  keydown(true);
  assert.equal(document.activeElement, last);
  listeners.get('focusin')({ target: {} });
  assert.equal(document.activeElement, dialog);

  await act(async () => {
    renderer.root.findByProps({ role: 'dialog' }).props.onKeyDown({
      key: 'Escape', preventDefault() {}, stopPropagation() {},
    });
    await flush();
  });
  assert.equal(document.activeElement, trigger, '关闭后焦点回到触发按钮');
  assert.equal(listeners.has('focusin'), false);
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);

  await open(renderer.root);
  await act(async () => {
    renderer.root.findByProps({ 'aria-label': '关闭弹窗' }).props.onClick();
    await flush();
  });
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);

  await open(renderer.root);
  await act(async () => {
    const target = {};
    renderer.root.findByProps({ className: 'dim-contextBackdrop' }).props.onMouseDown({ target, currentTarget: target });
    await flush();
  });
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
});

test('the Youdu settings tab saves the group history cache through bot.group-history.set', async () => {
  await withWindow(async () => {
    assert.equal(YOUDU_ENDPOINTS.setGroupHistory, 'bot.group-history.set');
    const calls = [];
    const rpcCall = async (endpoint, payload) => {
      if (endpoint === YOUDU_ENDPOINTS.status) {
        return { ok: true, value: { revision: 1, bots: [botFixture()] } };
      }
      if (endpoint === YOUDU_ENDPOINTS.setGroupHistory) {
        calls.push(payload);
        return { ok: true, value: { revision: 2, bots: [botFixture({ groupHistory: payload.config })] } };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    };

    let renderer;
    await act(async () => {
      renderer = create(React.createElement(YouduSettingsTab, { rpcCall }));
      await flush();
    });
    const entryOf = () => {
      const card = renderer.root.findByProps({ 'data-bot-id': BOT_ID });
      const found = card.findAll((node) => node.type === 'button'
        && node.props?.className === 'dim-contextEntry')
        .find((node) => node.props['aria-label'] === '群聊上下文');
      assert.ok(found, '有度机器人卡片必须渲染「群聊上下文」面板');
      return found;
    };
    const badgeOf = () => textOf(entryOf().findAllByProps({ className: 'dim-contextStatus' })[0]);
    assert.equal(badgeOf(), '开启 · 最近 50 条');
    assert.ok(renderer.root.findByProps({ 'data-bot-id': BOT_ID })
      .findAll((node) => node.type === 'button' && node.props?.className === 'dim-contextEntry')
      .find((node) => node.props['aria-label'] === '上下文增强'), '上下文增强面板保持存在');

    await act(async () => { entryOf().props.onClick(); await flush(); });
    assert.deepEqual(calls, [], '打开弹窗不触发保存');
    await act(async () => {
      renderer.root.findByProps({ className: 'dim-contextLimit' }).props.onChange({ target: { value: '20' } });
      await flush();
    });
    await act(async () => {
      button(renderer.root.findByProps({ role: 'dialog' }), '保存').props.onClick();
      await flush();
    });

    assert.deepEqual(calls, [{ botId: BOT_ID, config: { enabled: true, limit: 20 } }]);
    assert.equal(badgeOf(), '开启 · 最近 20 条');
    assert.match(textOf(renderer.root.findByProps({ 'data-bot-id': BOT_ID })), /已保存。/);
    assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);

    const source = await readFile(
      new URL('../../../plugin-src/client/channels/youdu/index.js', import.meta.url),
      'utf8',
    );
    assert.match(source, /import \{ GroupHistoryEditor \} from '\.\.\/\.\.\/group-history\.js';/);
    assert.match(source, /h\(GroupHistoryEditor, \{\s*config: account\.groupHistory,\s*disabled,\s*onSave: onGroupHistorySave,\s*\}\)/);
    assert.match(source, /onGroupHistorySave: \(config\) => saveBotSetting\(YOUDU_ENDPOINTS\.setGroupHistory, bot, \{ config \}, 'context'\)/);

    await act(async () => { renderer.unmount(); });
  });
});
