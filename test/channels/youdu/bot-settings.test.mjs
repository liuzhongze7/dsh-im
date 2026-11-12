import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as React from 'react';
import TestRenderer from 'react-test-renderer';

import { YouduConfigStore } from '../../../src/channels/youdu/config-store.mjs';
import { YouduController } from '../../../src/channels/youdu/youdu-controller.mjs';
import {
  BotWorkspaceStore,
  createWorkspaceAwareController,
} from '../../../src/channels/shared/bot-workspace-store.mjs';
import { YOUDU_ENDPOINTS as CLIENT_ENDPOINTS, normalizeSnapshot } from '../../../plugin-src/client/channels/youdu/api.js';
import { YouduSettingsTab } from '../../../plugin-src/client/channels/youdu/index.js';
import {
  YOUDU_ENDPOINTS as HOST_ENDPOINTS,
  createYouduRpcHandler,
} from '../../../plugin-src/host/channels/youdu/rpc.mjs';

const { act, create } = TestRenderer;

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node?.children?.map(textOf).join('') ?? '';
}

const CATALOG = Object.freeze({
  groups: [{
    id: 'deepseek',
    name: 'DeepSeek',
    models: [{
      id: 'deepseek-chat',
      name: 'DeepSeek Chat',
      reasoning: { defaultEffort: 'medium', efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] },
    }],
  }],
  failures: [],
});

const SELECTION = Object.freeze({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' });

function fakeCredentials() {
  const values = new Map();
  return {
    async resolve(ref) {
      return values.has(ref) ? { value: values.get(ref) } : null;
    },
    async set(ref, value) { values.set(ref, value); },
    async unset(ref) { values.delete(ref); },
  };
}

function fakeRuntimeFactory() {
  return async () => ({
    start: async () => {},
    stop: async () => {},
    status: { ready: true, youduConnectionState: 'connected', harnessReachable: true },
  });
}

async function withController(run, { modelCatalog = () => CATALOG } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-youdu-bot-settings-'));
  try {
    const configStore = await new YouduConfigStore(join(dir, 'config.json')).load();
    const workspaces = await new BotWorkspaceStore(
      join(dir, 'workspaces.json'),
      { defaultWorkspace: dir },
    ).load();
    const state = { sessionFor: () => null };
    const raw = new YouduController({
      credentials: fakeCredentials(),
      configStore,
      createRuntime: fakeRuntimeFactory(),
      ensureBot: (botConfig) => workspaces.ensure(botConfig.botId),
      logger: { info() {}, warn() {}, error() {} },
    });
    const controller = createWorkspaceAwareController(raw, {
      workspaces,
      stateFor: () => state,
      agentPresetCatalog: () => ({ items: [] }),
      modelCatalog,
    });
    await raw.attachBot({ botId: 'oc_demo', secret: 'secret-1', wsHost: 'push.example.com' });
    await run({ controller, workspaces });
    await raw.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('updateModel validates the model against the Harness catalog', async () => {
  await withController(async ({ controller }) => {
    const botId = controller.status().bots[0].botId;
    await controller.updateModel(botId, SELECTION);
    assert.deepEqual(controller.status().bots[0].model, SELECTION);

    await assert.rejects(
      () => controller.updateModel(botId, { provider: 'deepseek', model: 'unknown' }),
      /模型不存在或不可用/,
    );
    await assert.rejects(
      () => controller.updateModel(botId, { ...SELECTION, reasoningEffort: 'extreme' }),
      /当前模型不支持所选思考强度/,
    );

    // 清空选择后回到跟随默认模型。
    await controller.updateModel(botId, null);
    assert.equal(controller.status().bots[0].model, null);
  });
});

test('updateModel tolerates a Harness without a model catalog provider', async () => {
  await withController(async ({ controller }) => {
    const botId = controller.status().bots[0].botId;
    // 没有目录 ≠ 允许任意模型：选择模型时同样要求目录里存在该模型。
    await assert.rejects(() => controller.updateModel(botId, SELECTION), /模型不存在或不可用/);
    await controller.updateModel(botId, null);
  }, { modelCatalog: null });
});

test('updateAlias renames the bot and keeps the original name', async () => {
  await withController(async ({ controller }) => {
    const botId = controller.status().bots[0].botId;
    await controller.updateAlias(botId, '客服小度');
    const renamed = controller.status().bots[0].bot;
    assert.equal(renamed.name, '客服小度');
    assert.equal(renamed.originalName, '有度机器人');

    await controller.updateAlias(botId, '');
    const restored = controller.status().bots[0].bot;
    assert.equal(restored.name, '有度机器人');
    assert.equal(restored.alias, undefined);
  });
});

test('the RPC exposes bot.model.set and bot.alias.set and returns catalogs', async () => {
  await withController(async ({ controller }) => {
    const handler = createYouduRpcHandler(controller, {});
    const botId = controller.status().bots[0].botId;

    const status = await handler(HOST_ENDPOINTS.status, {});
    assert.equal(status.ok, true);
    assert.equal(status.value.modelCatalog.groups[0].models[0].id, 'deepseek-chat');

    const model = await handler(HOST_ENDPOINTS.setModel, { botId, model: SELECTION });
    assert.equal(model.ok, true);
    assert.deepEqual(model.value.bots[0].model, SELECTION);

    const alias = await handler(HOST_ENDPOINTS.setAlias, { botId, alias: '客服小度' });
    assert.equal(alias.ok, true);
    assert.equal(alias.value.bots[0].bot.name, '客服小度');
    assert.equal(alias.value.bots[0].bot.alias, '客服小度');

    // 空别名是合法输入：恢复原名。
    const cleared = await handler(HOST_ENDPOINTS.setAlias, { botId, alias: '' });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.value.bots[0].bot.name, '有度机器人');

    const badAlias = await handler(HOST_ENDPOINTS.setAlias, { botId, alias: 'a'.repeat(81) });
    assert.equal(badAlias.ok, false);
    assert.equal(badAlias.error.code, 'youdu-operation-failed');

    const badModel = await handler(HOST_ENDPOINTS.setModel, { botId, model: { provider: '' } });
    assert.equal(badModel.ok, false);
  });
});

test('the client and host agree on the model and alias endpoints', () => {
  assert.equal(CLIENT_ENDPOINTS.setModel, HOST_ENDPOINTS.setModel);
  assert.equal(CLIENT_ENDPOINTS.setAlias, HOST_ENDPOINTS.setAlias);
  assert.equal(CLIENT_ENDPOINTS.setModel, 'bot.model.set');
  assert.equal(CLIENT_ENDPOINTS.setAlias, 'bot.alias.set');
});

test('the settings tab renames the bot and selects a bot model', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    setInterval() { return 1; }, clearInterval() {},
    setTimeout() { return 1; }, clearTimeout() {},
    requestAnimationFrame(callback) { callback(); return 1; }, cancelAnimationFrame() {},
  };
  try {
    await runSettingsTabUiTest();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

async function runSettingsTabUiTest() {
  const BOT_ID = 'yd_1a7d8037a6758b93fe17c1cc';
  const botView = (overrides = {}) => ({
    botId: BOT_ID,
    sourceBotId: 'oc_demo',
    ownerUserId: '*',
    connected: true,
    state: 'connected',
    configured: true,
    bot: { name: '有度机器人', wsHostMasked: 'push.example.com' },
    workspace: 'D:\\Youdu',
    groupHistory: { enabled: true, limit: 50 },
    error: null,
    ...overrides,
  });
  const snapshot = (bot) => ({ revision: 1, modelCatalog: CATALOG, bots: [bot] });
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    if (endpoint === CLIENT_ENDPOINTS.status) return { ok: true, value: snapshot(botView()) };
    calls.push([endpoint, payload]);
    if (endpoint === CLIENT_ENDPOINTS.setAlias) {
      return {
        ok: true,
        value: snapshot(botView({
          bot: { name: payload.alias, alias: payload.alias, originalName: '有度机器人', wsHostMasked: 'push.example.com' },
        })),
      };
    }
    return { ok: true, value: snapshot(botView({ model: payload.model })) };
  };
  const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(YouduSettingsTab, { rpcCall }));
    await flush();
  });

  const card = () => renderer.root.findByProps({ 'data-bot-id': BOT_ID });
  assert.match(textOf(card()), /有度机器人/);

  await act(async () => { card().findByProps({ 'aria-label': '修改别名' }).props.onClick(); await flush(); });
  const dialog = renderer.root.findByProps({ className: 'dim-aliasDialog' });
  await act(async () => {
    dialog.findByType('input').props.onChange({ target: { value: '小度客服' } });
    await flush();
  });
  await act(async () => { dialog.findByProps({ className: 'dim-aliasSave' }).props.onClick(); await flush(); });
  assert.deepEqual(calls[0], ['bot.alias.set', { botId: BOT_ID, alias: '小度客服' }]);
  assert.match(textOf(card()), /小度客服/);

  await act(async () => { card().findByProps({ 'aria-label': '模型' }).props.onClick({ currentTarget: { focus() {} } }); await flush(); });
  const menu = renderer.root.findByProps({ role: 'menu' });
  const choice = menu.findAll((node) => node.props?.role === 'menuitemradio')
    .find((node) => textOf(node).startsWith('DeepSeek Chat'));
  assert.ok(choice, '模型目录必须出现在设置页');
  await act(async () => { choice.props.onClick(); await flush(); });
  assert.deepEqual(calls[1], ['bot.model.set', { botId: BOT_ID, model: { provider: 'deepseek', model: 'deepseek-chat' } }]);
}

test('the client snapshot keeps the model selection, alias and model catalog', () => {
  const snapshot = normalizeSnapshot({
    revision: 7,
    modelCatalog: CATALOG,
    bots: [{
      botId: 'yd_bot',
      connected: true,
      state: 'connected',
      bot: { name: '客服小度', alias: '客服小度', originalName: '有度机器人', wsHostMasked: 'push.example.com' },
      model: SELECTION,
      groupHistory: { enabled: true, limit: 20 },
    }],
  });
  assert.deepEqual(snapshot.modelCatalog.groups[0].models[0].id, 'deepseek-chat');
  assert.deepEqual(snapshot.bots[0].model, SELECTION);
  assert.equal(snapshot.bots[0].bot.name, '客服小度');
  assert.equal(snapshot.bots[0].bot.originalName, '有度机器人');
});
