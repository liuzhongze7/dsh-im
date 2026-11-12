// dsh-im port of @youdu/openclaw-youdu `src/kb/tool.ts` (origin/codex/youdu-kb-tool).
// Registers `youdu_kb` as a Harness tool that queries the YouDu knowledge base
// through `@youdu/cli bridge --stdin`. Credentials and gids come only from the
// per-session run context bound by the YouDu channel bridge — never from model
// arguments. Business failures (`OPEN_TOKEN_*`, `OPEN_KB_*`, bridge-side codes)
// are returned as structured `{ ok: false, error }` results, not thrown.

import { randomUUID } from 'node:crypto';

import { createBridgeRequest, runYouDuCliBridge } from './cli-runner.mjs';
import { clearYouduKbRunContext, getYouduKbRunContext } from './kb-run-context.mjs';
import { validateToolArguments } from './protocol.mjs';

export const YOUDU_KB_TOOL = 'youdu_kb';

export const youduKbToolParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operation: {
      type: 'string',
      enum: ['kb.wiki.list', 'kb.doc.list', 'kb.doc.read', 'kb.doc.versions', 'kb.doc.version-read'],
    },
    wikiId: { type: 'string' },
    docIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
    docId: { type: 'string' },
    versionId: { type: 'string' },
    concurrency: { type: 'integer', minimum: 1, maximum: 16 },
  },
  required: ['operation'],
};

function successResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], details: payload };
}

function errorResult(code, message) {
  return successResult({ ok: false, error: { code, message } });
}

function safeBridgeFailure(result) {
  const rawCode = result.error?.code;
  const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(rawCode) ? rawCode : 'YOUDU_KB_REQUEST_FAILED';
  const messages = {
    YOUDU_CLI_NOT_INSTALLED: 'The YouDu CLI platform binary is unavailable; reinstall the YouDu plugin',
    YOUDU_KB_ABORTED: 'The knowledge base request was aborted',
    YOUDU_KB_IDLE_TIMEOUT: 'The knowledge base request stopped making progress',
    YOUDU_KB_TOTAL_TIMEOUT: 'The knowledge base request exceeded its total time limit',
    YOUDU_KB_OUTPUT_LIMIT: 'The YouDu CLI bridge output limit was exceeded',
    YOUDU_KB_BRIDGE_PROTOCOL_ERROR: 'The YouDu CLI bridge returned an invalid response',
    YOUDU_KB_PROCESS_ERROR: 'The YouDu CLI bridge process failed',
  };
  // Business codes (OPEN_KB_*, OPEN_TOKEN_*, ...) keep their already-redacted
  // message so the model can react to the specific reason; bridge-side codes map
  // to a stable, user-safe message.
  const message = messages[code] ?? (
    typeof result.error?.message === 'string' && result.error.message
      ? result.error.message
      : 'The YouDu knowledge base request failed'
  );
  return errorResult(code, message);
}

function sessionIdOf(exec) {
  const sessionId = exec?.agent?.session?.header?.id;
  return typeof sessionId === 'string' && sessionId ? sessionId : null;
}

function renderResult(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

/**
 * Build the `youdu_kb` tool definition. The tool resolves account + gids from the
 * per-session run context (bound by the YouDu bridge), never from model args.
 */
export function createYouduKbTool({
  runBridge = runYouDuCliBridge,
  getRunContext = getYouduKbRunContext,
} = {}) {
  const definition = {
    name: YOUDU_KB_TOOL,
    description: 'Query the current YouDu knowledge base. Use one operation at a time; read documents in one batch.',
    parameters: youduKbToolParameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          operation: { type: 'string' },
          error: {
            type: 'object',
            properties: { code: { type: 'string' }, message: { type: 'string' } },
          },
        },
      },
      render: renderResult,
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      const runContext = sessionId ? getRunContext(sessionId) : undefined;
      // 只在有度 IM 频道挂载；无运行上下文只可能是重放/伪造/跨频道，必须 fail
      // closed，不能静默降级成 owner 全量查询。
      if (!runContext?.account) {
        return errorResult('YOUDU_IM_CONTEXT_REQUIRED', 'youdu_kb requires a trusted inbound YouDu IM run context');
      }
      let validated;
      try {
        validated = validateToolArguments(args);
        // OpenClaw forces output:"file" and has the model `Read` the landed
        // OS-temp files. dsh-im model file tools are workspace-scoped and cannot
        // reach those paths, so we keep the results inline in JSON — the model
        // answers directly from the returned content.
        if (validated.operation === 'kb.doc.list' || validated.operation === 'kb.doc.read') {
          validated.arguments.output = 'json';
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'invalid tool arguments';
        const code = String(message).split(':', 1)[0] || 'YOUDU_KB_INVALID_ARGUMENTS';
        return errorResult(code, message);
      }
      let request;
      try {
        request = createBridgeRequest({
          requestId: `kb_${randomUUID()}`,
          operation: validated.operation,
          arguments: validated.arguments,
          account: runContext.account,
          gids: runContext.gids,
        });
      } catch {
        return errorResult('YOUDU_KB_CONFIG_INVALID', 'The YouDu knowledge base endpoint configuration is invalid');
      }
      const result = await runBridge(request, { signal: exec?.signal });
      return result?.ok ? successResult(result) : safeBridgeFailure(result);
    },
  };
  return Object.freeze({ definition });
}

/**
 * Register `youdu_kb` for the YouDu channel. Called from the YouDu channel host
 * plugin with a `toolCtx` that exposes `tools.register` and `on`. Returns false
 * when those APIs are absent; otherwise registers the tool and hooks session
 * disposal to release run contexts. The tool's own description carries its
 * usage contract — no system-prompt section is injected.
 */
export function installYouduKbTool(ctx, {
  tools = {},
  onSessionDisposed,
} = {}) {
  if (typeof ctx?.tools?.register !== 'function'
    || typeof ctx?.on !== 'function') return false;

  const tool = createYouduKbTool(tools);
  ctx.tools.register(tool.definition);
  const clearContext = onSessionDisposed ?? ((session) => {
    const sessionId = session?.id ?? session?.header?.id;
    if (typeof sessionId === 'string' && sessionId) clearYouduKbRunContext(sessionId);
  });
  ctx.on('session/disposed', (session) => clearContext(session));
  return true;
}
