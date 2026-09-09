import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProductionController } from '../../../plugin-src/host/channels/youdu/production.mjs';

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
