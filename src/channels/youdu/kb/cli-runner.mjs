// Port of @youdu/openclaw-youdu `src/kb/cli-runner.ts` (origin/codex/youdu-kb-tool).
// Spawns `@youdu/cli bridge --stdin`, writes a schemaVersion 2 request to stdin,
// and parses the JSONL response with bounds (stdout/stderr), idle/total timeouts,
// abort support and credential redaction.

import { spawn as nodeSpawn } from 'node:child_process';

import { resolveYouDuCliBinary } from './cli-binary.mjs';
import { buildYouDuKbEndpoint } from './endpoint.mjs';
import { BridgeJsonlParser } from './protocol.mjs';

export const BRIDGE_TIMEOUTS = Object.freeze({
  // One idle window covers a 30s exchange + 30s KB call + one refresh/exchange
  // and retry, plus scheduling margin.
  idleMs: 130_000,
  // Batch reads may advance in several concurrency windows, but no Tool process
  // may run without a hard ceiling.
  totalMs: 15 * 60_000,
  terminateGraceMs: 1_000,
});

const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

export function createBridgeRequest({ requestId, operation, arguments: bridgeArguments, account, gids }) {
  const endpoint = buildYouDuKbEndpoint(account.url);
  const cleanedGids = (gids ?? []).map((gid) => String(gid).trim()).filter((gid) => gid.length > 0);
  const connection = {
    baseUrl: endpoint.baseUrl,
    botId: account.botId,
    secret: account.secret,
    tls: endpoint.tls,
  };
  const request = {
    schemaVersion: 2,
    requestId,
    operation,
    connection,
    arguments: bridgeArguments,
  };
  if (cleanedGids.length > 0) request.gids = cleanedGids;
  return request;
}

function failure(operation, code, message) {
  return { ok: false, operation, error: { code, message } };
}

function redactDiagnostic(value, request) {
  let redacted = String(value);
  for (const sensitive of [
    request.connection.secret,
    request.connection.botId,
    request.connection.baseUrl,
    ...(request.gids ?? []),
  ]) {
    if (sensitive) redacted = redacted.split(sensitive).join('[redacted]');
  }
  redacted = redacted
    .replace(/((?:access[-_ ]?token|event[-_ ]?token|signature|sign)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return redacted.slice(0, DEFAULT_MAX_STDERR_BYTES);
}

async function defaultResolveBinary() {
  return resolveYouDuCliBinary();
}

export async function runYouDuCliBridge(request, options = {}) {
  let binary;
  try {
    binary = await (options.resolveBinary ?? defaultResolveBinary)();
  } catch {
    return failure(request.operation, 'YOUDU_CLI_NOT_INSTALLED', 'The YouDu CLI platform binary is unavailable; reinstall the YouDu plugin');
  }

  const encoded = Buffer.from(JSON.stringify(request));
  if (encoded.byteLength > 1024 * 1024) {
    return failure(request.operation, 'YOUDU_KB_REQUEST_TOO_LARGE', 'The knowledge base request is too large');
  }
  const spawnProcess = options.spawnProcess ?? nodeSpawn;
  let child;
  try {
    child = spawnProcess(binary, ['bridge', '--stdin'], { shell: false, windowsHide: true });
  } catch {
    return failure(request.operation, 'YOUDU_KB_PROCESS_ERROR', 'The YouDu CLI bridge could not be started');
  }

  return new Promise((resolve) => {
    const idleTimeoutMs = options.idleTimeoutMs ?? BRIDGE_TIMEOUTS.idleMs;
    const totalTimeoutMs = options.totalTimeoutMs ?? BRIDGE_TIMEOUTS.totalMs;
    const graceMs = options.terminationGraceMs ?? BRIDGE_TIMEOUTS.terminateGraceMs;
    const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
    const maxStderrBytes = Math.min(options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES, DEFAULT_MAX_STDERR_BYTES);
    let stdoutBytes = 0;
    let stderr = '';
    let stderrBytes = 0;
    let settled = false;
    let terminating = false;
    let terminalFailure;
    let idleTimer;
    let totalTimer;
    let forceTimer;
    let forceSettleTimer;

    const clearTimers = () => {
      for (const timer of [idleTimer, totalTimer, forceTimer, forceSettleTimer]) {
        if (timer) clearTimeout(timer);
      }
      idleTimer = totalTimer = forceTimer = forceSettleTimer = undefined;
    };
    const cleanup = () => {
      clearTimers();
      options.signal?.removeEventListener('abort', onAbort);
      child.stdout.removeListener('data', onStdout);
      child.stderr.removeListener('data', onStderr);
      child.stdin.removeListener('error', onStdinError);
      child.removeListener('error', onProcessError);
      child.removeListener('close', onClose);
    };
    const logStderr = () => {
      const diagnostic = redactDiagnostic(stderr, request);
      if (diagnostic) options.logger?.error?.(`[youdu-kb] bridge stderr: ${diagnostic}`);
    };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!result.ok) logStderr();
      resolve(result);
    };
    const terminate = (result) => {
      if (settled || terminating) return;
      terminating = true;
      terminalFailure = result;
      clearTimers();
      try { child.kill(); } catch { /* close/error or force fallback handles settle */ }
      forceTimer = setTimeout(() => {
        if (settled) return;
        try { child.kill('SIGKILL'); } catch { /* final fallback below still settles */ }
        forceSettleTimer = setTimeout(() => settle(terminalFailure), graceMs);
      }, graceMs);
    };
    const resetIdleTimer = () => {
      if (terminating || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        terminate(failure(request.operation, 'YOUDU_KB_IDLE_TIMEOUT', 'The knowledge base request stopped making progress'));
      }, idleTimeoutMs);
    };
    const parser = new BridgeJsonlParser(request.requestId, request.operation, request.arguments.docIds ?? [], resetIdleTimer);
    const onAbort = () => terminate(failure(request.operation, 'YOUDU_KB_ABORTED', 'The knowledge base request was aborted'));
    const onStdout = (chunk) => {
      if (settled || terminating) return;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxStdoutBytes) {
        terminate(failure(request.operation, 'YOUDU_KB_OUTPUT_LIMIT', 'The YouDu CLI bridge output limit was exceeded'));
        return;
      }
      try {
        parser.push(Buffer.from(chunk));
      } catch {
        terminate(failure(request.operation, 'YOUDU_KB_BRIDGE_PROTOCOL_ERROR', 'The YouDu CLI bridge returned an invalid response'));
      }
    };
    const onStderr = (chunk) => {
      if (stderrBytes >= maxStderrBytes) return;
      const bytes = Buffer.from(chunk);
      const bounded = bytes.subarray(0, maxStderrBytes - stderrBytes);
      stderr += bounded.toString('utf8');
      stderrBytes += bounded.byteLength;
    };
    const onStdinError = () => terminate(failure(request.operation, 'YOUDU_KB_PROCESS_ERROR', 'The YouDu CLI bridge input failed'));
    const onProcessError = () => terminate(failure(request.operation, 'YOUDU_KB_PROCESS_ERROR', 'The YouDu CLI bridge process failed'));
    const onClose = (code) => {
      if (terminalFailure) {
        settle(terminalFailure);
        return;
      }
      let parsed;
      try {
        parsed = parser.finish();
      } catch {
        settle(failure(request.operation, 'YOUDU_KB_BRIDGE_PROTOCOL_ERROR', 'The YouDu CLI bridge returned an invalid response'));
        return;
      }
      const exitMatches = parsed.ok ? code === 0 : code !== null && code !== 0;
      if (!exitMatches) {
        settle(failure(request.operation, 'YOUDU_KB_BRIDGE_PROTOCOL_ERROR', 'The YouDu CLI bridge returned an inconsistent exit status'));
        return;
      }
      if (!parsed.ok) {
        parsed = { ...parsed, error: { ...parsed.error, message: redactDiagnostic(parsed.error.message, request) } };
      }
      settle(parsed);
    };

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.stdin.once('error', onStdinError);
    child.once('error', onProcessError);
    child.once('close', onClose);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    resetIdleTimer();
    totalTimer = setTimeout(() => {
      terminate(failure(request.operation, 'YOUDU_KB_TOTAL_TIMEOUT', 'The knowledge base request exceeded its total time limit'));
    }, totalTimeoutMs);
    if (options.signal?.aborted) onAbort();
    else child.stdin.end(encoded);
  });
}
