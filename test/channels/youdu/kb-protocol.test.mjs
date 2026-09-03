import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BridgeJsonlParser,
  BridgeProtocolError,
  validateToolArguments,
} from '../../../src/channels/youdu/kb/protocol.mjs';

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

function run(parser, chunks) {
  for (const chunk of chunks) parser.push(Buffer.from(chunk));
  return parser.finish();
}

test('validateToolArguments accepts the five operations with per-op fields', () => {
  assert.deepEqual(validateToolArguments({ operation: 'kb.wiki.list' }), { operation: 'kb.wiki.list', arguments: {} });
  assert.deepEqual(validateToolArguments({ operation: 'kb.doc.list', wikiId: 'w1' }), { operation: 'kb.doc.list', arguments: { wikiId: 'w1' } });
  assert.deepEqual(validateToolArguments({ operation: 'kb.doc.versions', docId: 'd1' }), { operation: 'kb.doc.versions', arguments: { docId: 'd1' } });
  assert.deepEqual(
    validateToolArguments({ operation: 'kb.doc.version-read', docId: 'd1', versionId: 'v1' }),
    { operation: 'kb.doc.version-read', arguments: { docId: 'd1', versionId: 'v1' } },
  );
  assert.deepEqual(
    validateToolArguments({ operation: 'kb.doc.read', docIds: ['a', 'b'], concurrency: 4 }),
    { operation: 'kb.doc.read', arguments: { docIds: ['a', 'b'], concurrency: 4 } },
  );
  assert.deepEqual(
    validateToolArguments({ operation: 'kb.doc.read', docIds: ['a'] }),
    { operation: 'kb.doc.read', arguments: { docIds: ['a'] } },
  );
});

test('validateToolArguments rejects unknown/extra/duplicate/empty and bad bounds', () => {
  assert.throws(() => validateToolArguments(null), /YOUDU_KB_INVALID_ARGUMENTS/);
  assert.throws(() => validateToolArguments({}), /operation is not supported/);
  assert.throws(() => validateToolArguments({ operation: 'kb.unknown' }), /operation is not supported/);
  assert.throws(() => validateToolArguments({ operation: 'kb.doc.list' }), /wikiId is required/);
  assert.throws(() => validateToolArguments({ operation: 'kb.doc.list', wikiId: 'w1', botId: 'secret' }), /botId is not allowed/);
  assert.throws(() => validateToolArguments({ operation: 'kb.doc.versions', docId: 'd1', wikiId: 'w1' }), /wikiId is not allowed/);
  assert.throws(() => validateToolArguments({ operation: 'kb.doc.read', docIds: [] }), /docIds is required/);
  assert.throws(() => validateToolArguments({ operation: 'kb.doc.read', docIds: ['a', 'a'] }), /duplicate/);
  assert.throws(() => validateToolArguments({ operation: 'kb.doc.read', docIds: ['a'], concurrency: 0 }), /concurrency/);
  assert.throws(() => validateToolArguments({ operation: 'kb.doc.read', docIds: ['a'], concurrency: 17 }), /concurrency/);
  assert.throws(() => validateToolArguments({ operation: 'kb.doc.read', docIds: ['a'], concurrency: 2.5 }), /concurrency/);
});

test('normal op lifecycle: start → result → complete', () => {
  const parser = new BridgeJsonlParser('kb-1', 'kb.wiki.list');
  const outcome = run(parser, [
    line({ schemaVersion: 1, requestId: 'kb-1', type: 'start', operation: 'kb.wiki.list' }),
    line({ schemaVersion: 1, requestId: 'kb-1', type: 'result', data: { wikis: [{ id: 'w1' }] } }),
    line({ schemaVersion: 1, requestId: 'kb-1', type: 'complete', ok: true }),
  ]);
  assert.deepEqual(outcome, { ok: true, operation: 'kb.wiki.list', data: { wikis: [{ id: 'w1' }] } });
});

test('doc.read inline batch preserves per-item ok/error and partial', () => {
  const parser = new BridgeJsonlParser('kb-2', 'kb.doc.read', ['d1', 'd2']);
  const outcome = run(parser, [
    line({ schemaVersion: 1, requestId: 'kb-2', type: 'start', operation: 'kb.doc.read' }),
    line({ schemaVersion: 1, requestId: 'kb-2', type: 'item', seq: 0, data: { docId: 'd1', ok: true, content: 'hello' } }),
    line({ schemaVersion: 1, requestId: 'kb-2', type: 'item', seq: 1, data: { docId: 'd2', ok: false, error: { code: 'OPEN_KB_NOT_FOUND' } } }),
    line({ schemaVersion: 1, requestId: 'kb-2', type: 'complete', ok: true, stats: { total: 2, succeeded: 1, failed: 1 } }),
  ]);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.operation, 'kb.doc.read');
  assert.equal(outcome.items.length, 2);
  assert.equal(outcome.stats.total, 2);
  assert.equal(outcome.partial, true);
});

test('doc.read file-mode manifest (result summary + complete.stats)', () => {
  const parser = new BridgeJsonlParser('kb-3', 'kb.doc.read', ['d1', 'd2']);
  const outcome = run(parser, [
    line({ schemaVersion: 1, requestId: 'kb-3', type: 'start', operation: 'kb.doc.read' }),
    line({ schemaVersion: 1, requestId: 'kb-3', type: 'result', data: { output: 'file', operation: 'doc.read', directory: '/tmp/x', total: 2, succeeded: 1, failed: 1 } }),
    line({ schemaVersion: 1, requestId: 'kb-3', type: 'complete', ok: true, stats: { total: 2, succeeded: 1, failed: 1 } }),
  ]);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.data.output, 'file');
  assert.equal(outcome.partial, true);
});

test('error lifecycle returns a structured failure', () => {
  const parser = new BridgeJsonlParser('kb-4', 'kb.doc.list', ['d1']);
  const outcome = run(parser, [
    line({ schemaVersion: 1, requestId: 'kb-4', type: 'start', operation: 'kb.doc.list' }),
    line({ schemaVersion: 1, requestId: 'kb-4', type: 'error', error: { code: 'OPEN_KB_PERMISSION_DENIED', message: 'no access' } }),
    line({ schemaVersion: 1, requestId: 'kb-4', type: 'complete', ok: false }),
  ]);
  assert.deepEqual(outcome, { ok: false, operation: 'kb.doc.list', error: { code: 'OPEN_KB_PERMISSION_DENIED', message: 'no access' } });
});

test('parser handles split UTF-8 and arbitrary chunk boundaries', () => {
  const parser = new BridgeJsonlParser('kb-5', 'kb.wiki.list');
  // Deliberately split a multi-byte Chinese character across chunks.
  const record = line({ schemaVersion: 1, requestId: 'kb-5', type: 'start', operation: 'kb.wiki.list' });
  const result = line({ schemaVersion: 1, requestId: 'kb-5', type: 'result', data: { name: '知识库' } });
  const done = line({ schemaVersion: 1, requestId: 'kb-5', type: 'complete', ok: true });
  const all = `${record}${result}${done}`;
  const sliced = [];
  for (let i = 0; i < all.length; i += 1) sliced.push(all[i]);
  const outcome = run(parser, sliced);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.data, { name: '知识库' });
});

test('parser rejects bad order, duplicate, trailing, unknown type and wrong seq', () => {
  assert.throws(
    () => run(new BridgeJsonlParser('k', 'kb.wiki.list'), [line({ schemaVersion: 1, requestId: 'k', type: 'result', data: {} })]),
    BridgeProtocolError,
  );
  assert.throws(
    () => run(new BridgeJsonlParser('k', 'kb.wiki.list'), [
      line({ schemaVersion: 1, requestId: 'k', type: 'start', operation: 'kb.wiki.list' }),
      line({ schemaVersion: 1, requestId: 'k', type: 'start', operation: 'kb.wiki.list' }),
    ]),
    BridgeProtocolError,
  );
  assert.throws(
    () => run(new BridgeJsonlParser('k', 'kb.doc.read', ['a', 'b']), [
      line({ schemaVersion: 1, requestId: 'k', type: 'start', operation: 'kb.doc.read' }),
      line({ schemaVersion: 1, requestId: 'k', type: 'item', seq: 1, data: { docId: 'b', ok: true } }),
      line({ schemaVersion: 1, requestId: 'k', type: 'complete', ok: true, stats: { total: 2, succeeded: 2, failed: 0 } }),
    ]),
    BridgeProtocolError,
  );
  assert.throws(
    () => run(new BridgeJsonlParser('k', 'kb.wiki.list'), [
      line({ schemaVersion: 1, requestId: 'k', type: 'start', operation: 'kb.wiki.list' }),
      line({ schemaVersion: 1, requestId: 'k', type: 'unknown', data: {} }),
    ]),
    BridgeProtocolError,
  );
  assert.throws(
    () => run(new BridgeJsonlParser('k', 'kb.wiki.list'), [
      line({ schemaVersion: 1, requestId: 'k', type: 'start', operation: 'kb.wiki.list' }),
      line({ schemaVersion: 1, requestId: 'k', type: 'result', data: { a: 1 } }),
      line({ schemaVersion: 1, requestId: 'k', type: 'complete', ok: true }),
      line({ schemaVersion: 1, requestId: 'k', type: 'result', data: { a: 2 } }),
    ]),
    BridgeProtocolError,
  );
});

test('parser rejects requestId mismatch and incomplete lifecycle', () => {
  assert.throws(
    () => run(new BridgeJsonlParser('want', 'kb.wiki.list'), [
      line({ schemaVersion: 1, requestId: 'other', type: 'start', operation: 'kb.wiki.list' }),
    ]),
    BridgeProtocolError,
  );
  assert.throws(
    () => run(new BridgeJsonlParser('k', 'kb.wiki.list'), [
      line({ schemaVersion: 1, requestId: 'k', type: 'start', operation: 'kb.wiki.list' }),
      line({ schemaVersion: 1, requestId: 'k', type: 'result', data: {} }),
    ]),
    BridgeProtocolError,
  );
});
