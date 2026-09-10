import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createProductionController } from '../../../plugin-src/host/channels/youdu/production.mjs';
import { DeliveryService } from '../../../plugin-src/host/delivery-service.mjs';
import { DEFAULT_GROUP_HISTORY_CONFIG } from '../../../src/channels/shared/group-history.mjs';
import { DEFAULT_GROUP_CONTEXT_RETENTION_HOURS } from '../../../src/channels/shared/group-context-files.mjs';

test('Youdu production injects a file ingress executor for inbound attachments', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-youdu-production-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await mkdtemp(join(root, 'workspace-'));
  const dataDir = join(root, 'data');
  const trackedDirectories = [];
  let harnessOptions;

  class ConfigStore {
    async load() { return this; }
    list() { return []; }
  }
  class StateStore {
    async load() { return this; }
  }
  class Harness {
    constructor(options) { harnessOptions = options; }
    stopManagedProcess() {}
  }
  class Controller {
    async close() {}
  }
  class Runtime {}
  const inboundTtl = {
    stagingRetention: () => 'persistent',
    trackStaged: (staged) => staged,
    trackDirectory: (directory) => trackedDirectories.push(directory),
  };
  const ctx = {
    credentials: {},
    apiProxy: {},
    logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
  };

  const production = await createProductionController(ctx, { dataDir, workspace }, {
    ConfigStore,
    StateStore,
    HarnessClient: Harness,
    Controller,
    Runtime,
    createConnectionSupervisor: () => ({
      ready: Promise.resolve(),
      start() { return this; },
      async close() {},
    }),
    inboundTtl,
  });

  // Without this executor HarnessClient fails every attachment with
  // "Harness file ingress is unavailable in this Host process."
  assert.equal(typeof harnessOptions.fileIngressExecutor, 'function');

  const staged = await harnessOptions.fileIngressExecutor({
    sessionId: 'session-1',
    workspace,
    files: [{ name: 'photo.png', mediaType: 'image/png', data: Buffer.from('png-bytes') }],
  });

  assert.equal(staged.files.length, 1);
  assert.equal(staged.files[0].name, 'photo.png');
  assert.equal(staged.files[0].mediaType, 'image/png');
  assert.ok(staged.files[0].path.startsWith(join('.dsh-im', 'inbound')));
  assert.equal(await readFile(join(workspace, staged.files[0].path), 'utf8'), 'png-bytes');
  assert.deepEqual(trackedDirectories, [staged.directory]);

  await production.close();
});

test('Youdu production exposes a delivery adapter that only owns configured bots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-youdu-production-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const workspace = join(root, 'workspace');
  const bot = { botId: 'yd_1a7d8037a6758b93fe17c1cc', sourceBotId: 'oc86aed821c86345e4' };
  const sends = [];

  class ConfigStore {
    async load() { return this; }
    list() { return [bot]; }
  }
  class StateStore {
    async load() { return this; }
    async recordGroup() {}
    async recordPerson() {}
    snapshot() { return { sessions: { 'direct:6463894': 'session-user' }, groups: {}, people: {} }; }
    peopleSnapshot() { return [{ chatId: '6463894', account: 'lewis.liu', name: '刘钟泽', lastSeenAt: null }]; }
  }
  class Harness {
    stopManagedProcess() {}
  }
  class Controller {
    async close() {}
    async sendProactiveText(botId, target, text) {
      sends.push({ botId, target, text });
      return { sent: true };
    }
  }
  class Runtime {}
  const ctx = {
    credentials: {},
    apiProxy: {},
    logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
  };

  const production = await createProductionController(ctx, { dataDir, workspace }, {
    ConfigStore,
    StateStore,
    HarnessClient: Harness,
    Controller,
    Runtime,
    createConnectionSupervisor: () => ({
      ready: Promise.resolve(),
      start() { return this; },
      async close() {},
    }),
  });

  const service = new DeliveryService();
  assert.equal(typeof production.deliveryAdapter, 'object');
  const unregister = service.registerAdapter(production.deliveryAdapter);
  assert.deepEqual(await service.listBots(), [{ botId: bot.botId, channel: 'youdu' }]);

  await service.createTarget(bot.botId, {
    targetId: 'alice',
    kind: 'user',
    route: { chatId: '6463894' },
  });
  assert.deepEqual(await service.send(bot.botId, 'alice', '定时结果'), { sent: true });
  assert.deepEqual(sends, [{
    botId: bot.botId,
    target: { targetId: 'alice', kind: 'user', route: { chatId: '6463894' } },
    text: '定时结果',
  }]);

  // 建议目标带上观察到的联系人名字，方便设置页展示。
  assert.deepEqual(await service.listSuggestions(bot.botId), {
    botId: bot.botId,
    channel: 'youdu',
    suggestions: [
      { kind: 'user', route: { chatId: '6463894' }, name: '刘钟泽' },
    ],
  });

  unregister();
  await production.close();
});

test('Youdu production hands each runtime a live group history provider', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-youdu-production-group-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const bot = { botId: 'yd_1a7d8037a6758b93fe17c1cc', sourceBotId: 'oc86aed821c86345e4' };
  const runtimeOptions = [];
  let controllerOptions;

  class ConfigStore {
    async load() { return this; }
    list() { return [bot]; }
    get(botId) { return botId === bot.botId ? bot : null; }
    async save(value) { return value; }
    async remove() { return null; }
  }
  class StateStore {
    async load() { return this; }
  }
  class Harness {
    stopManagedProcess() {}
  }
  class Controller {
    constructor(options) { this.options = options; controllerOptions = options; }
    async close() {}
    status() { return { bots: [{ botId: bot.botId }] }; }
    // 与真实 controller 一样把保存写进设置存储，provider 直接读同一个存储。
    async updateGroupHistory(botId, config) {
      return this.options.settingsStore.setGroupHistory(botId, config);
    }
  }
  class Runtime {
    constructor(options) { runtimeOptions.push(options); }
  }
  const ctx = {
    credentials: {
      async resolve() { return { value: 'secret-1' }; },
      async set() {},
      async unset() {},
    },
    apiProxy: {},
    logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
  };

  const production = await createProductionController(ctx, { dataDir, workspace: join(root, 'w') }, {
    ConfigStore,
    StateStore,
    HarnessClient: Harness,
    Controller,
    Runtime,
    createConnectionSupervisor: () => ({
      ready: Promise.resolve(),
      start() { return this; },
      async close() {},
    }),
  });
  t.after(() => production.close());

  await controllerOptions.createRuntime({ botId: bot.botId, config: bot, secret: 'secret-1' });
  assert.equal(runtimeOptions.length, 1);
  const provider = runtimeOptions[0].groupHistory;
  assert.equal(provider.botId, bot.botId);
  assert.deepEqual(provider.getSettings(), DEFAULT_GROUP_HISTORY_CONFIG);

  await controllerOptions.createRuntime({ botId: bot.botId, config: bot, secret: 'secret-1' });
  assert.notEqual(runtimeOptions[1].groupHistory, provider, 'each runtime owns its own provider');
  assert.equal(runtimeOptions[1].groupHistory.botId, bot.botId);

  // 设置页保存后即时生效，不需要重建 runtime 或重连机器人。
  await production.controller.updateGroupHistory(bot.botId, { enabled: true, limit: 8 });
  assert.deepEqual(provider.getSettings(), { enabled: true, limit: 8 });
  assert.equal(runtimeOptions.length, 2);
});

test('Youdu production stages group context attachments inside the bot workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-youdu-group-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const workspace = join(root, 'workspace');
  const bot = { botId: 'yd_1a7d8037a6758b93fe17c1cc', sourceBotId: 'oc86aed821c86345e4' };
  const runtimeOptions = [];
  let controllerOptions;

  class ConfigStore {
    async load() { return this; }
    list() { return [bot]; }
    get(botId) { return botId === bot.botId ? bot : null; }
    async save(value) { return value; }
    async remove() { return null; }
  }
  class StateStore {
    async load() { return this; }
  }
  class Harness {
    stopManagedProcess() {}
  }
  class Controller {
    constructor(options) { controllerOptions = options; }
    async close() {}
    status() { return { bots: [{ botId: bot.botId }] }; }
  }
  class Runtime {
    constructor(options) { runtimeOptions.push(options); }
  }
  const ctx = {
    credentials: {
      async resolve() { return { value: 'secret-1' }; },
      async set() {},
      async unset() {},
    },
    apiProxy: {},
    logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
  };

  const production = await createProductionController(ctx, { dataDir, workspace }, {
    ConfigStore,
    StateStore,
    HarnessClient: Harness,
    Controller,
    Runtime,
    createConnectionSupervisor: () => ({
      ready: Promise.resolve(),
      start() { return this; },
      async close() {},
    }),
  });
  t.after(() => production.close());

  await controllerOptions.createRuntime({ botId: bot.botId, config: bot, secret: 'secret-1' });
  const files = runtimeOptions[0].groupContextFiles;
  assert.equal(files.botId, bot.botId);
  assert.equal(files.retentionHours, DEFAULT_GROUP_CONTEXT_RETENTION_HOURS);

  const staged = await files.stage({
    chatId: '{0798E01E-CD68-42BB-813C-EB51593BB0F5}',
    messageId: '1777543724',
    files: [{ name: 'photo.png', data: Buffer.from('png-bytes'), mediaType: 'image/png' }],
  });
  assert.equal(staged.files.length, 1);
  const parts = staged.files[0].path.split(/[\\/]+/u);
  assert.deepEqual(parts.slice(0, 3), [
    '.dsh-im', 'group-context', '{0798E01E-CD68-42BB-813C-EB51593BB0F5}',
  ]);
  assert.match(parts[3], /^\d{8}-\d{6}-1777543724$/u);
  assert.equal(parts[4], '01-photo.png');
  // 相对路径落在该 bot 的工作区里，模型按相对路径就能读到。
  assert.equal(await readFile(resolve(workspace, staged.files[0].path), 'utf8'), 'png-bytes');
  assert.deepEqual(await readdir(join(workspace, '.dsh-im', 'group-context')), [
    '{0798E01E-CD68-42BB-813C-EB51593BB0F5}',
  ]);
  // 清单由磁盘索引重建：插件重启后照样能列出这条附件。
  const listing = await files.list({
    chatId: '{0798E01E-CD68-42BB-813C-EB51593BB0F5}',
    limit: 5,
  });
  assert.equal(
    listing.directory.split(/[\\/]+/u).join('/'),
    '.dsh-im/group-context/{0798E01E-CD68-42BB-813C-EB51593BB0F5}',
  );
  assert.equal(listing.messages.length, 1);
  assert.equal(listing.messages[0].messageId, '1777543724');
  assert.equal(listing.messages[0].files[0].name, 'photo.png');
  assert.deepEqual(await files.sweep(), { deleted: 0 });
});

test('Youdu production rejects inbound staging without a workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-youdu-production-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let harnessOptions;

  class ConfigStore {
    async load() { return this; }
    list() { return []; }
  }
  class StateStore {
    async load() { return this; }
  }
  class Harness {
    constructor(options) { harnessOptions = options; }
    stopManagedProcess() {}
  }
  class Controller {
    async close() {}
  }
  class Runtime {}
  const ctx = {
    credentials: {},
    apiProxy: {},
    logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
  };

  const production = await createProductionController(ctx, { dataDir: join(root, 'data') }, {
    ConfigStore,
    StateStore,
    HarnessClient: Harness,
    Controller,
    Runtime,
    createConnectionSupervisor: () => ({
      ready: Promise.resolve(),
      start() { return this; },
      async close() {},
    }),
  });

  assert.throws(
    () => harnessOptions.fileIngressExecutor({
      sessionId: 'session-1',
      workspace: '',
      files: [{ name: 'photo.png', data: Buffer.from('png-bytes') }],
    }),
    (error) => error?.code === 'inbound-file-workspace-unavailable',
  );

  await production.close();
});

test('removing a Youdu bot also drops its delivery targets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-youdu-production-remove-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const bot = { botId: 'yd_1a7d8037a6758b93fe17c1cc', sourceBotId: 'oc86aed821c86345e4' };
  const bots = [bot];
  const secrets = new Map([[bot.botId, 'secret-1']]);

  class ConfigStore {
    async load() { return this; }
    list() { return [...bots]; }
    get(botId) { return bots.find((entry) => entry.botId === botId) ?? null; }
    async save(value) { return value; }
    async remove(botId) {
      const index = bots.findIndex((entry) => entry.botId === botId);
      if (index < 0) return null;
      const [removed] = bots.splice(index, 1);
      return removed;
    }
  }
  class StateStore {
    async load() { return this; }
    async remove() {}
  }
  class Harness {
    stopManagedProcess() {}
  }
  class Runtime {
    constructor() { this.status = { ready: false, youduConnectionState: 'offline', harnessReachable: false }; }
    async start() { return this.status; }
    async stop() {}
  }
  const ctx = {
    credentials: {
      async resolve(ref) { return secrets.has(ref) ? { value: secrets.get(ref) } : null; },
      async set(ref, value) { secrets.set(ref, value); },
      async unset(ref) { secrets.delete(ref); },
    },
    apiProxy: {},
    logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
  };

  const production = await createProductionController(ctx, { dataDir, workspace: join(root, 'w') }, {
    ConfigStore,
    StateStore,
    HarnessClient: Harness,
    Runtime,
    createConnectionSupervisor: () => ({
      ready: Promise.resolve(),
      start() { return this; },
      async close() {},
    }),
  });
  assert.deepEqual(secrets.get(bot.botId), 'secret-1');

  const service = new DeliveryService();
  service.registerAdapter(production.deliveryAdapter);
  await service.createTarget(bot.botId, {
    targetId: 'alice', kind: 'user', route: { chatId: '6463894' },
  });
  assert.equal((await service.listTargets(bot.botId)).targets.length, 1);

  await production.controller.deleteBot(bot.botId);
  assert.deepEqual(bots, []);
  const reloaded = JSON.parse(await readFile(join(dataDir, 'bots', 'delivery.json'), 'utf8'));
  assert.deepEqual(reloaded.bots, {});
  await production.close();
});
