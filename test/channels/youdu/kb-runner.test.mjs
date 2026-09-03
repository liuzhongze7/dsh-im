import assert from 'node:assert/strict';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  BRIDGE_TIMEOUTS,
  createBridgeRequest,
  runYouDuCliBridge,
} from '../../../src/channels/youdu/kb/cli-runner.mjs';

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

function makeChild(captureStdin = true) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = (sig) => { child.killed = true; child.emit('close', null); };
  if (captureStdin) {
    child.__stdin = [];
    child.stdin.on('data', (chunk) => child.__stdin.push(Buffer.from(chunk)));
  }
  return child;
}

/** Normal wiki.list request so the parser can be satisfied inline. */
function wikiListRequest(overrides = {}) {
  return {
    schemaVersion: 2,
    requestId: 'kb-test-1',
    operation: 'kb.wiki.list',
    connection: {
      baseUrl: 'https://host:7443',
      botId: 'src-bot',
      secret: 'super-secret',
      tls: { caPem: '----CA----', allowIpHostnameMismatch: false },
    },
    arguments: {},
    ...overrides,
  };
}

test('createBridgeRequest builds schemaVersion 2 with gids and connection', () => {
  const request = createBridgeRequest({
    requestId: 'kb-x',
    operation: 'kb.doc.read',
    arguments: { docIds: ['d1'], concurrency: 4 },
    account: { botId: 'b', secret: 's', url: 'push.example.com:7443' },
    gids: ['u1'],
  });
  assert.equal(request.schemaVersion, 2);
  assert.equal(request.requestId, 'kb-x');
  assert.equal(request.operation, 'kb.doc.read');
  assert.equal(request.connection.baseUrl, 'https://push.example.com:7443');
  assert.equal(request.connection.secret, 's');
  assert.deepEqual(request.gids, ['u1']);
  assert.deepEqual(request.arguments, { docIds: ['d1'], concurrency: 4 });
});

test('runYouDuCliBridge spawns the CLI with the right argv/options and writes the request to stdin', async () => {
  let spawnFn;
  const childReady = new Promise((resolve) => { spawnFn = resolve; });
  const signaller = (file, args, options) => {
    assert.equal(file, '/fake/bridge');
    assert.deepEqual(args, ['bridge', '--stdin']);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    const child = makeChild();
    spawnFn(child);
    return child;
  };
  const request = wikiListRequest();
  const promise = runYouDuCliBridge(request, {
    resolveBinary: async () => '/fake/bridge',
    spawnProcess: signaller,
  });
  const child = await childReady;
  // The runner has set up listeners and ended stdin by now.
  await once(child.stdin, 'end');
  const stdinPayload = JSON.parse(Buffer.concat(child.__stdin).toString('utf8'));
  assert.equal(stdinPayload.requestId, request.requestId);
  assert.equal(stdinPayload.operation, 'kb.wiki.list');
  assert.equal(stdinPayload.connection.secret, 'super-secret');
  assert.equal(stdinPayload.connection.baseUrl, 'https://host:7443');
  child.stdout.write(line({ schemaVersion: 1, requestId: request.requestId, type: 'start', operation: 'kb.wiki.list' }));
  child.stdout.write(line({ schemaVersion: 1, requestId: request.requestId, type: 'result', data: { wikis: [] } }));
  child.stdout.write(line({ schemaVersion: 1, requestId: request.requestId, type: 'complete', ok: true }));
  child.stdout.end();
  child.emit('close', 0);
  const outcome = await promise;
  assert.deepEqual(outcome, { ok: true, operation: 'kb.wiki.list', data: { wikis: [] } });
});

test('runYouDuCliBridge returns YOUDU_CLI_NOT_INSTALLED when the binary resolver fails', async () => {
  const outcome = await runYouDuCliBridge(wikiListRequest(), {
    resolveBinary: async () => { throw new Error('absent'); },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'YOUDU_CLI_NOT_INSTALLED');
});

test('runYouDuCliBridge reports an inconsistent exit status as a protocol error', async () => {
  let spawnFn;
  const childReady = new Promise((resolve) => { spawnFn = resolve; });
  const signaller = (file, args, options) => {
    const child = makeChild();
    spawnFn(child);
    return child;
  };
  const request = wikiListRequest();
  const promise = runYouDuCliBridge(request, {
    resolveBinary: async () => '/fake/bridge',
    spawnProcess: signaller,
  });
  const child = await childReady;
  child.stdout.write(line({ schemaVersion: 1, requestId: request.requestId, type: 'start', operation: 'kb.wiki.list' }));
  child.stdout.write(line({ schemaVersion: 1, requestId: request.requestId, type: 'result', data: {} }));
  child.stdout.write(line({ schemaVersion: 1, requestId: request.requestId, type: 'complete', ok: true }));
  child.stdout.end();
  child.emit('close', 1); // success parsed but non-zero exit
  const outcome = await promise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'YOUDU_KB_BRIDGE_PROTOCOL_ERROR');
});

test('runYouDuCliBridge aborts cleanly and redacts secrets from stderr', async () => {
  let spawnFn;
  const childReady = new Promise((resolve) => { spawnFn = resolve; });
  const signaller = (file, args, options) => {
    const child = makeChild();
    spawnFn(child);
    return child;
  };
  const logs = [];
  const controller = new AbortController();
  const request = wikiListRequest();
  const promise = runYouDuCliBridge(request, {
    resolveBinary: async () => '/fake/bridge',
    spawnProcess: signaller,
    signal: controller.signal,
    logger: { error: (m) => logs.push(m) },
  });
  const child = await childReady;
  controller.abort();
  const outcome = await promise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'YOUDU_KB_ABORTED');
  assert.ok(child.killed);
});

test('runYouDuCliBridge enforces an idle timeout with no progress', async () => {
  let spawnFn;
  const childReady = new Promise((resolve) => { spawnFn = resolve; });
  const signaller = (file, args, options) => {
    const child = makeChild();
    spawnFn(child);
    return child;
  };
  const request = wikiListRequest();
  const promise = runYouDuCliBridge(request, {
    resolveBinary: async () => '/fake/bridge',
    spawnProcess: signaller,
    idleTimeoutMs: 20,
    totalTimeoutMs: 999_999,
    terminationGraceMs: 5,
  });
  const child = await childReady;
  // No stdout progress → idle timer fires at ~20ms and terminates.
  const outcome = await promise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'YOUDU_KB_IDLE_TIMEOUT');
});

test('runYouDuCliBridge enforces the stdout output limit', async () => {
  let spawnFn;
  const childReady = new Promise((resolve) => { spawnFn = resolve; });
  const signaller = (file, args, options) => {
    const child = makeChild();
    spawnFn(child);
    return child;
  };
  const request = wikiListRequest();
  const promise = runYouDuCliBridge(request, {
    resolveBinary: async () => '/fake/bridge',
    spawnProcess: signaller,
    maxStdoutBytes: 32,
    terminationGraceMs: 5,
  });
  const child = await childReady;
  child.stdout.write(Buffer.alloc(64, 0x61)); // 64 bytes over the 32-byte cap
  const outcome = await promise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'YOUDU_KB_OUTPUT_LIMIT');
});

test('runYouDuCliBridge redacts secret/botId/baseUrl from the error message', async () => {
  let spawnFn;
  const childReady = new Promise((resolve) => { spawnFn = resolve; });
  const signaller = (file, args, options) => {
    const child = makeChild();
    spawnFn(child);
    return child;
  };
  const request = wikiListRequest();
  const promise = runYouDuCliBridge(request, {
    resolveBinary: async () => '/fake/bridge',
    spawnProcess: signaller,
  });
  const child = await childReady;
  child.stdout.write(line({ schemaVersion: 1, requestId: request.requestId, type: 'start', operation: 'kb.wiki.list' }));
  child.stdout.write(line({ schemaVersion: 1, requestId: request.requestId, type: 'error', error: { code: 'OPEN_KB_INTERNAL_ERROR', message: 'bad secret super-secret on https://host:7443' } }));
  child.stdout.write(line({ schemaVersion: 1, requestId: request.requestId, type: 'complete', ok: false }));
  child.stdout.end();
  child.emit('close', 1);
  const outcome = await promise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'OPEN_KB_INTERNAL_ERROR');
  assert.equal(outcome.error.message.includes('super-secret'), false);
  assert.equal(outcome.error.message.includes('https://host:7443'), false);
});

test('BRIDGE_TIMEOUTS exposes the documented bounds', () => {
  assert.equal(BRIDGE_TIMEOUTS.idleMs, 130_000);
  assert.equal(BRIDGE_TIMEOUTS.totalMs, 15 * 60_000);
  assert.equal(BRIDGE_TIMEOUTS.terminateGraceMs, 1_000);
});
