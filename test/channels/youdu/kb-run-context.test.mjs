import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindYouduKbRunContext,
  buildYouduKbRunContext,
  clearYouduKbRunContext,
  getYouduKbRunContext,
  releaseYouduKbRunContext,
} from '../../../src/channels/youdu/kb/kb-run-context.mjs';

test('bind/get/release round-trips a run context keyed by sessionId', () => {
  const account = { botId: 'src-bot', secret: 's', url: 'host:7443' };
  bindYouduKbRunContext('s1', buildYouduKbRunContext(account, { senderId: 'u1' }));
  const ctx = getYouduKbRunContext('s1');
  assert.equal(ctx.account.botId, 'src-bot');
  assert.equal(ctx.account.secret, 's');
  assert.deepEqual(ctx.gids, ['u1']);
  releaseYouduKbRunContext('s1');
  assert.equal(getYouduKbRunContext('s1'), undefined);
});

test('cross-session isolation and clear', () => {
  const account = { botId: 'b', secret: 's', url: 'h:7443' };
  bindYouduKbRunContext('s1', buildYouduKbRunContext(account, { senderId: 'u1' }));
  bindYouduKbRunContext('s2', buildYouduKbRunContext(account, { senderId: 'u2' }));
  assert.deepEqual(getYouduKbRunContext('s1').gids, ['u1']);
  assert.deepEqual(getYouduKbRunContext('s2').gids, ['u2']);
  clearYouduKbRunContext();
  assert.equal(getYouduKbRunContext('s1'), undefined);
  assert.equal(getYouduKbRunContext('s2'), undefined);
});

test('clear with a sessionId releases only that session', () => {
  const account = { botId: 'b', secret: 's', url: 'h:7443' };
  bindYouduKbRunContext('s1', buildYouduKbRunContext(account, { senderId: 'u1' }));
  bindYouduKbRunContext('s2', buildYouduKbRunContext(account, { senderId: 'u2' }));
  clearYouduKbRunContext('s1');
  assert.equal(getYouduKbRunContext('s1'), undefined);
  assert.equal(getYouduKbRunContext('s2')?.gids?.[0], 'u2', 'an unrelated session must keep its context');
  clearYouduKbRunContext();
});

test('empty sender yields empty gids and a frozen context', () => {
  const ctx = buildYouduKbRunContext({ botId: 'b', secret: 's', url: 'h:7443' }, { senderId: '  ' });
  assert.deepEqual(ctx.gids, []);
  assert.equal(Object.isFrozen(ctx.account), true);
  assert.equal(Object.isFrozen(ctx), true);
  assert.throws(() => { ctx.account.botId = 'x'; }, TypeError);
});

test('bind requires a non-empty sessionId', () => {
  assert.doesNotThrow(() => bindYouduKbRunContext('', buildYouduKbRunContext(null, {})));
  assert.throws(() => bindYouduKbRunContext('s1', null), TypeError);
});
