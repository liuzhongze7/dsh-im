import { managementFetch } from '../../fixtures/management-rpc.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { YOUDU_RPC_CHANNEL as CLIENT_YOUDU_RPC_CHANNEL } from '../../../plugin-src/client/channels/youdu/api.js';
import {
  YOUDU_ENDPOINTS,
  YOUDU_RPC_CHANNEL,
  installYouduRpc,
} from '../../../plugin-src/host/channels/youdu/rpc.mjs';

function controllerFixture() {
  return {
    status: () => ({
      ready: true,
      youduConnectionState: 'connected',
      harnessReachable: true,
      bots: [],
    }),
  };
}

function captureRegistration() {
  const captured = {};
  const dispose = () => {};
  const ctx = {
    connection: { fetch: managementFetch((channel, handler, route) => {
      captured.channel = channel;
      captured.handler = handler;
      captured.route = route;
      return dispose;
    }) },
  };
  return { ctx, captured, dispose };
}

test('Youdu management RPC installs on the shared /api carrier the client calls', async () => {
  const { ctx, captured, dispose } = captureRegistration();
  assert.equal(installYouduRpc(ctx, controllerFixture(), {}, 'loopback'), dispose);
  assert.equal(captured.channel, '/youdu');
  assert.equal(captured.route.path, '/api/dsh-im/youdu');
  assert.deepEqual(captured.route.methods, ['POST']);
  assert.equal(captured.route.requestBody, 'buffered');
  const result = await captured.handler(YOUDU_ENDPOINTS.status, {});
  assert.equal(result.ok, true);
});

test('Youdu host and client agree on the management RPC channel', () => {
  assert.equal(CLIENT_YOUDU_RPC_CHANNEL, YOUDU_RPC_CHANNEL);
  assert.equal(`/api/dsh-im${YOUDU_RPC_CHANNEL}`, '/api/dsh-im/youdu');
});

test('Youdu management RPC stays loopback-only by default', async () => {
  const { ctx, captured } = captureRegistration();
  installYouduRpc(ctx, controllerFixture(), {}, undefined);
  await assert.rejects(
    captured.handler(YOUDU_ENDPOINTS.status, {}, undefined, { host: 'remote.example' }),
    /HTTP 403/,
  );
});

test('Youdu management RPC requires the shared Fetch registry instead of the legacy RPC channel', () => {
  assert.throws(
    () => installYouduRpc({ connection: { rpc: { handle: () => {} } } }, controllerFixture(), {}, undefined),
    /Host Connection Fetch registry is required/,
  );
});
