// Port of @youdu/openclaw-youdu `src/kb/protocol.ts` (origin/codex/youdu-kb-tool).
// Transport- and host-agnostic: knowledge-base operation validation and the
// `@youdu/cli bridge --stdin` JSONL protocol (schemaVersion 1) parser.

export const MAX_RECORD_BYTES = 4 * 1024 * 1024;

export const YOUDU_KB_OPERATIONS = Object.freeze([
  'kb.wiki.list',
  'kb.doc.list',
  'kb.doc.read',
  'kb.doc.versions',
  'kb.doc.version-read',
]);

function inputError(message) {
  const error = new Error(`YOUDU_KB_INVALID_ARGUMENTS: ${message}`);
  error.code = 'YOUDU_KB_INVALID_ARGUMENTS';
  throw error;
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    inputError(`${name} is required and must not be empty`);
  }
  return value.trim();
}

/**
 * Validate raw model arguments and return the canonical `{ operation, arguments }`.
 * Enforces per-operation allowed fields, `docIds` uniqueness/emptiness and the
 * `concurrency` 1..16 bound. Note: `output` is deliberately NOT accepted here —
 * the tool decides the output mode after validation (OpenClaw forces `file`; the
 * dsh-im adaptation keeps inline JSON so the model can answer from the result).
 */
export function validateToolArguments(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    inputError('arguments must be an object');
  }
  const value = raw;
  const operation = value.operation;
  if (typeof operation !== 'string' || !YOUDU_KB_OPERATIONS.includes(operation)) {
    inputError('operation is not supported');
  }
  const allowedByOperation = {
    'kb.wiki.list': new Set(['operation']),
    'kb.doc.list': new Set(['operation', 'wikiId']),
    'kb.doc.read': new Set(['operation', 'docIds', 'concurrency']),
    'kb.doc.versions': new Set(['operation', 'docId']),
    'kb.doc.version-read': new Set(['operation', 'docId', 'versionId']),
  };
  const allowed = allowedByOperation[operation];
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) inputError(`${key} is not allowed for ${operation}`);
  }
  switch (operation) {
    case 'kb.wiki.list':
      return { operation, arguments: {} };
    case 'kb.doc.list':
      return { operation, arguments: { wikiId: nonEmptyString(value.wikiId, 'wikiId') } };
    case 'kb.doc.versions':
      return { operation, arguments: { docId: nonEmptyString(value.docId, 'docId') } };
    case 'kb.doc.version-read':
      return {
        operation,
        arguments: {
          docId: nonEmptyString(value.docId, 'docId'),
          versionId: nonEmptyString(value.versionId, 'versionId'),
        },
      };
    case 'kb.doc.read': {
      if (!Array.isArray(value.docIds) || value.docIds.length === 0) {
        inputError('docIds is required and must not be empty');
      }
      const docIds = value.docIds.map((id) => nonEmptyString(id, 'docIds item'));
      if (new Set(docIds).size !== docIds.length) {
        inputError('docIds must not contain duplicate values');
      }
      const args = { docIds };
      if (value.concurrency !== undefined) {
        if (!Number.isInteger(value.concurrency) || value.concurrency < 1 || value.concurrency > 16) {
          inputError('concurrency must be an integer between 1 and 16');
        }
        args.concurrency = value.concurrency;
      }
      return { operation, arguments: args };
    }
    default:
      inputError('operation is not supported');
  }
}

export class BridgeProtocolError extends Error {
  constructor(message) {
    super(`YOUDU_KB_BRIDGE_PROTOCOL_ERROR: ${message}`);
    this.name = 'BridgeProtocolError';
    this.code = 'YOUDU_KB_BRIDGE_PROTOCOL_ERROR';
  }
}

function objectRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeProtocolError('record must be a JSON object');
  }
  return value;
}

/**
 * Incremental JSONL parser for `@youdu/cli bridge --stdin` responses.
 * Enforces `start/result/item/error/complete` ordering, record-size and schema
 * invariants, per-item `ok` semantics for `kb.doc.read`, and file-mode manifests.
 */
export class BridgeJsonlParser {
  #requestId;
  #operation;
  #expectedDocIds;
  #onRecord;
  #pending = Buffer.alloc(0);
  #started = false;
  #completed = false;
  #resultSeen = false;
  #errorSeen = false;
  #resultData;
  #errorData;
  #items = [];
  #nextSeq = 0;
  #completeOk;
  #stats;

  constructor(requestId, operation, expectedDocIds = [], onRecord) {
    if (typeof requestId !== 'string' || !requestId) {
      throw new TypeError('requestId is required');
    }
    if (!YOUDU_KB_OPERATIONS.includes(operation)) {
      throw new TypeError('operation is not supported');
    }
    this.#requestId = requestId;
    this.#operation = operation;
    this.#expectedDocIds = [...expectedDocIds];
    this.#onRecord = onRecord;
  }

  push(chunk) {
    if (!chunk || chunk.byteLength === 0) return;
    this.#pending = Buffer.concat([this.#pending, Buffer.from(chunk)]);
    let newline;
    while ((newline = this.#pending.indexOf(0x0a)) >= 0) {
      const record = this.#pending.subarray(0, newline);
      this.#pending = this.#pending.subarray(newline + 1);
      this.#consumeLine(record);
    }
    if (this.#pending.byteLength + 1 > MAX_RECORD_BYTES) {
      throw new BridgeProtocolError('JSONL record exceeds 4 MiB');
    }
  }

  finish() {
    if (this.#pending.byteLength > 0) {
      const finalLine = this.#pending;
      this.#pending = Buffer.alloc(0);
      this.#consumeLine(finalLine);
    }
    if (!this.#completed || this.#completeOk === undefined) {
      throw new BridgeProtocolError('complete record is required');
    }
    if (this.#completeOk) {
      if (this.#errorSeen) throw new BridgeProtocolError('successful lifecycle must not contain error');
      if (this.#operation === 'kb.doc.read') {
        if (this.#resultSeen) {
          // file mode: `result` is a manifest summary; complete carries `stats`.
          if (!this.#stats) throw new BridgeProtocolError('file complete.stats is required');
          const { total, succeeded, failed } = this.#stats;
          if (total !== this.#expectedDocIds.length) {
            throw new BridgeProtocolError('file total must match requested docIds');
          }
          if (succeeded + failed !== total) {
            throw new BridgeProtocolError('file stats counts must add up to total');
          }
          return {
            ok: true,
            operation: this.#operation,
            data: this.#resultData,
            stats: this.#stats,
            partial: failed > 0,
          };
        }
        if (!this.#stats) throw new BridgeProtocolError('batch complete.stats is required');
        const { total, succeeded, failed } = this.#stats;
        if (total !== this.#expectedDocIds.length || total !== this.#items.length) {
          throw new BridgeProtocolError('batch total must match requested docIds and item count');
        }
        if (succeeded + failed !== total) {
          throw new BridgeProtocolError('batch stats counts must add up to total');
        }
        return {
          ok: true,
          operation: this.#operation,
          items: this.#items,
          stats: this.#stats,
          partial: this.#items.some((item) => item.ok === false),
        };
      }
      if (!this.#resultSeen) throw new BridgeProtocolError('normal lifecycle requires one result');
      return { ok: true, operation: this.#operation, data: this.#resultData };
    }
    if (!this.#errorData) throw new BridgeProtocolError('failed lifecycle requires one error');
    return { ok: false, operation: this.#operation, error: this.#errorData };
  }

  #consumeLine(raw) {
    if (raw.byteLength > 0 && raw[raw.byteLength - 1] === 0x0d) {
      raw = raw.subarray(0, raw.byteLength - 1);
    }
    if (raw.byteLength === 0) throw new BridgeProtocolError('empty JSONL record');
    if (raw.byteLength + 1 > MAX_RECORD_BYTES) {
      throw new BridgeProtocolError('JSONL record exceeds 4 MiB');
    }
    if (this.#completed) throw new BridgeProtocolError('complete must be the final record');
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
      throw new BridgeProtocolError('record must be valid UTF-8 JSON');
    }
    const record = objectRecord(parsed);
    if (record.schemaVersion !== 1) throw new BridgeProtocolError('schemaVersion must be 1');
    if (record.requestId !== this.#requestId) throw new BridgeProtocolError('requestId mismatch');
    if (!this.#started) {
      if (record.type !== 'start' || record.operation !== this.#operation) {
        throw new BridgeProtocolError('start must be the first record and match operation');
      }
      this.#started = true;
      this.#onRecord?.();
      return;
    }
    switch (record.type) {
      case 'start':
        throw new BridgeProtocolError('start must be unique');
      case 'result':
        if (this.#resultSeen || this.#errorSeen || this.#items.length > 0) {
          throw new BridgeProtocolError('result is invalid or duplicated');
        }
        if (!('data' in record)) throw new BridgeProtocolError('result.data is required');
        this.#resultSeen = true;
        this.#resultData = record.data;
        this.#onRecord?.();
        return;
      case 'item':
        if (this.#operation !== 'kb.doc.read' || this.#errorSeen || record.seq !== this.#nextSeq) {
          throw new BridgeProtocolError('item seq must increase continuously from 0');
        }
        if (!('data' in record)) throw new BridgeProtocolError('item.data is required');
        const item = objectRecord(record.data);
        if (item.docId !== this.#expectedDocIds[this.#nextSeq]) {
          throw new BridgeProtocolError('item.data.docId must match requested order');
        }
        if (typeof item.ok !== 'boolean') throw new BridgeProtocolError('item.data.ok must be boolean');
        this.#nextSeq += 1;
        this.#items.push(item);
        this.#onRecord?.();
        return;
      case 'error': {
        if (this.#errorSeen || this.#resultSeen) throw new BridgeProtocolError('error is invalid or duplicated');
        const error = objectRecord(record.error);
        if (typeof error.code !== 'string' || typeof error.message !== 'string') {
          throw new BridgeProtocolError('error record is invalid');
        }
        this.#errorSeen = true;
        this.#errorData = { code: error.code, message: error.message };
        this.#onRecord?.();
        return;
      }
      case 'complete':
        if (typeof record.ok !== 'boolean') throw new BridgeProtocolError('complete.ok must be boolean');
        if (this.#operation === 'kb.doc.read' && record.ok === true && !('stats' in record)) {
          throw new BridgeProtocolError('batch complete.stats is required');
        }
        if (record.stats !== undefined) {
          const stats = objectRecord(record.stats);
          for (const field of ['total', 'succeeded', 'failed']) {
            if (!Number.isInteger(stats[field]) || stats[field] < 0) {
              throw new BridgeProtocolError(`complete.stats.${field} must be a non-negative integer`);
            }
          }
          this.#stats = { total: stats.total, succeeded: stats.succeeded, failed: stats.failed };
        }
        this.#completeOk = record.ok;
        this.#completed = true;
        this.#onRecord?.();
        return;
      default:
        throw new BridgeProtocolError('unknown record type');
    }
  }
}
