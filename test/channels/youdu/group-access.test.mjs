import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emptyGroupAccess,
  evaluateGroupAccess,
  matchesGroupAccessUser,
  normalizeGroupAccess,
  resolveGroupAccessRule,
  validateGroupAccess,
} from '../../../src/channels/youdu/group-access.mjs';

test('validateGroupAccess accepts every mode and canonicalizes entries', () => {
  const document = validateGroupAccess({
    version: 1,
    groups: {
      'group-a': { mode: 'allowlist', users: ['1001', 'lewis.liu', 'user:1002'] },
      'group-b': { mode: 'open' },
      'group-c': { mode: 'disabled' },
      'group-d': { mode: 'inherit', users: ['ignored'] },
      '*': { mode: 'allowlist', users: ['*'] },
    },
  });
  assert.deepEqual(document.groups['group-a'].users, ['1001', 'lewis.liu', 'user:1002']);
  assert.deepEqual(document.groups['group-b'], { mode: 'open', users: [] });
  assert.deepEqual(document.groups['group-d'], { mode: 'inherit' });
  assert.equal(Object.isFrozen(document), true);
  assert.equal(Object.isFrozen(document.groups['group-a'].users), true);
});

test('validateGroupAccess rejects malformed documents and rules', () => {
  const cases = [
    [null, 'not an object'],
    [{ version: 2, groups: {} }, 'wrong version'],
    [{ version: 1 }, 'missing groups'],
    [{ version: 1, groups: { a: { mode: 'nope' } } }, 'unknown mode'],
    [{ version: 1, groups: { a: { mode: 'open', extra: 1 } } }, 'unknown rule field'],
    [{ version: 1, groups: { a: { mode: 'allowlist', users: [] } } }, 'empty allowlist'],
    [{ version: 1, groups: { a: { mode: 'open', users: ['x', 'x'] } } }, 'duplicate users'],
    [{ version: 1, groups: { a: { mode: 'open', users: 'x' } } }, 'users not a list'],
    [{ version: 1, groups: { '': { mode: 'open' } } }, 'empty chat id'],
    [{ version: 1, groups: {}, extra: true }, 'unknown document field'],
  ];
  for (const [value, label] of cases) {
    assert.throws(() => validateGroupAccess(value), (error) => error?.code === 'group-access-invalid', label);
    assert.equal(normalizeGroupAccess(value), null, `${label} must normalize to null`);
  }
  assert.equal(normalizeGroupAccess(undefined), null);
  assert.equal(normalizeGroupAccess('x'), null);
});

test('resolveGroupAccessRule matches case-insensitively and falls back to the wildcard', () => {
  const document = validateGroupAccess({
    version: 1,
    groups: {
      '{0798E01E-CD68-42BB-813C-EB51593BB0F5}': { mode: 'allowlist', users: ['1001'] },
      '*': { mode: 'disabled' },
    },
  });
  assert.deepEqual(resolveGroupAccessRule(document, '{0798e01e-cd68-42bb-813c-eb51593bb0f5}'), {
    chatId: '{0798E01E-CD68-42BB-813C-EB51593BB0F5}',
    mode: 'allowlist',
    users: ['1001'],
  });
  assert.equal(resolveGroupAccessRule(document, 'other-group').mode, 'disabled');
  assert.equal(resolveGroupAccessRule(document, '   '), null);
  assert.equal(resolveGroupAccessRule(null, 'x'), null);
  assert.equal(resolveGroupAccessRule(emptyGroupAccess(), 'x'), null);
});

test('matchesGroupAccessUser accepts ids, account names, prefixed entries and wildcard', () => {
  assert.equal(matchesGroupAccessUser(['1001'], ['1001', 'lewis.liu']), true);
  assert.equal(matchesGroupAccessUser(['lewis.liu'], ['1001', 'lewis.liu']), true);
  assert.equal(matchesGroupAccessUser(['user:1001'], ['1001']), true);
  assert.equal(matchesGroupAccessUser(['youdu:lewis.liu'], ['LEWIS.LIU']), true);
  assert.equal(matchesGroupAccessUser(['*'], ['1001']), true);
  assert.equal(matchesGroupAccessUser(['1002'], ['1001', 'lewis.liu']), false);
  assert.equal(matchesGroupAccessUser([], ['1001']), false);
  assert.equal(matchesGroupAccessUser(['1001'], []), false);
});

test('evaluateGroupAccess reports inherit, open, allowlist and disabled decisions', () => {
  const document = validateGroupAccess({
    version: 1,
    groups: {
      'g-open': { mode: 'open' },
      'g-allow': { mode: 'allowlist', users: ['1001'] },
      'g-off': { mode: 'disabled' },
      'g-inherit': { mode: 'inherit' },
    },
  });
  assert.deepEqual(evaluateGroupAccess(document, { chatId: 'g-open', senderIds: ['9999'] }), {
    matched: true, allowed: true, reason: 'group-open', rule: { chatId: 'g-open', mode: 'open', users: [] },
  });
  assert.equal(evaluateGroupAccess(document, { chatId: 'g-allow', senderIds: ['1001'] }).allowed, true);
  assert.equal(evaluateGroupAccess(document, { chatId: 'g-allow', senderIds: ['1002'] }).reason, 'group-sender-not-allowed');
  assert.equal(evaluateGroupAccess(document, { chatId: 'g-off', senderIds: ['1001'] }).reason, 'group-disabled');
  assert.deepEqual(evaluateGroupAccess(document, { chatId: 'g-inherit', senderIds: ['1001'] }), {
    matched: false, allowed: true, reason: 'inherit', rule: null,
  });
  assert.deepEqual(evaluateGroupAccess(document, { chatId: 'g-unknown', senderIds: ['1001'] }), {
    matched: false, allowed: true, reason: 'inherit', rule: null,
  });
  assert.deepEqual(evaluateGroupAccess(null, { chatId: 'g-open', senderIds: ['1'] }), {
    matched: false, allowed: true, reason: 'inherit', rule: null,
  });
});
