import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildYouduTlsOptions,
  hostnameOf,
  readBundledCa,
} from '../../../src/channels/youdu/youdu-tls.mjs';

test('IP hosts skip hostname matching but still verify the chain and trust the bundled CA', () => {
  const options = buildYouduTlsOptions('10.0.0.60:7443');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(typeof options.checkServerIdentity, 'function');
  assert.equal(options.checkServerIdentity('anything', {}), undefined);
  assert.ok(Array.isArray(options.ca) && options.ca.length > 0, 'bundled CA merged into the trust list');
  assert.equal(typeof readBundledCa(), 'string');
});

test('domain hosts keep full hostname matching', () => {
  const options = buildYouduTlsOptions('internal.cindacode.com:7443');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.checkServerIdentity, undefined);
  assert.ok(Array.isArray(options.ca) && options.ca.length > 0);
});

test('hostnameOf strips ports, IPv6 brackets and schemes', () => {
  assert.equal(hostnameOf('10.0.0.60:7443'), '10.0.0.60');
  assert.equal(hostnameOf('internal.cindacode.com'), 'internal.cindacode.com');
  assert.equal(hostnameOf('wss://push.example.com:7443'), 'push.example.com');
  assert.equal(hostnameOf('[::1]:7443'), '::1');
  assert.equal(hostnameOf(''), '');
});
