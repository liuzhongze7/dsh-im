# Research: Porting youdu_kb into DeepSeek Harness (dsh-im youdu channel)

> Researcher output for team `youdu-kb-tool-dsh`, task t1 (requirements).
> Sources: plugin `@youdu/openclaw-youdu` branch `origin/codex/youdu-kb-tool` (worktree `D:\Youdu\Client_Code\plugin-kb-research`), and dsh-im `feat/youdu-channel` (`D:\Youdu\Client_Code\dsh-im`).
>
> Core files studied (plugin branch): `src/kb/{protocol,tool,cli-runner,endpoint,run-context,request-context,tool-policy}.ts`, `src/youdu-cli.d.ts`, `skills/youdu-kb-tool/SKILL.md`.
> dsh-im side: `plugin-src/host/index.mjs`, `plugin-src/host/channels/youdu/{index,production,rpc}.mjs`, `src/channels/shared/semantic/artifact.mjs`, `src/channels/youdu/{youdu-runtime,youdu-bridge,youdu-controller,config-store,harness-client}.mjs`, `src/channels/shared/workspace-session.mjs`, `src/channels/shared/harness-client.mjs`.

---

## 1. youdu_kb tool contract (what must be reproduced)

### 1.1 Tool & 5 operations

Plugin defining module (`src/kb/tool.ts`) exports `youduKbToolFactory` that returns a `youdu_kb` tool, or `null` when `messageChannel ?? channelId !== 'youdu'`.

| operation | required args | notes |
|---|---|---|
| `kb.wiki.list` | (none) | list accessible wiki spaces |
| `kb.doc.list` | `wikiId` | full nested doc tree for a wiki |
| `kb.doc.read` | `docIds[]` (min 1, unique), optional `concurrency` 1–16 | batch read; `output:"file"` forced by tool |
| `kb.doc.versions` | `docId` | version list |
| `kb.doc.version-read` | `docId`, `versionId` | read a specific historical version |

Parameter schema (`youduKbToolParameters`): `{ operation: string enum(5); wikiId, docId, versionId: string; docIds: array<string> minItems 1; concurrency: integer 1..16 }`, `additionalProperties: false`, `required: [operation]`. Model must never pass `botId/secret/baseUrl/chatId/messageId/senderId` (the skill forbids it; validation rejects unknown fields).

### 1.2 @youdu/cli bridge request (the wire contract, schemaVersion 2)

`createBridgeRequest` (`src/kb/cli-runner.ts`) builds one request; `runYouDuCliBridge` serializes it to JSON and writes it to stdin of the CLI. argv: `["bridge", "--stdin"]`, `shell: false`, `windowsHide: true`.

```jsonc
{
  "schemaVersion": 2,
  "requestId": "kb_<uuid>",
  "operation": "kb.doc.read",
  "connection": {
    "baseUrl": "https://<host>:7443",
    "botId": "<derived yd_...botId>",
    "secret": "<resolved secret>",
    "tls": { "caPem": "<bundled CA PEM>", "allowIpHostnameMismatch": false }
  },
  "gids": ["<senderGid>"],          // omitted when empty
  "arguments": { "docIds": [...], "concurrency": 4 }
}
```

Key properties:
- `baseUrl` = `https://<hostname>:7443` (fixed port `PORT = 7443`). Host comes from the bot's configured "url"/host (plugin: `config.channels.youdu.url`; dsh-im equivalent: `wsHost` → `normalizeWsHost`). An already-schemed host is normalized to the same HTTPS endpoint.
- `tls.caPem` = bundled CA (`cert/cacert-2026-03-19.pem`). `allowIpHostnameMismatch = true` **only** when the hostname is a literal IP (`net.isIP(host) !== 0`); domain hosts keep full chain verification.
- `botId/secret` come only from trusted runtime config/credentials — never from model args. Plugin reads `config.channels.youdu.{botId,secret,url}`.
- `gids` = the requesting user's GID(s). In the plugin, `gids = [event.senderId]`, with the comment "权限按 [owner, sender] 取交集" — i.e. the KB server enforces permission as the intersection of the bot owner's grants and the requesting user's identities. This is the only model-visible/user-bound identity and must come from a trusted inbound YouDu IM run context.

### 1.3 Bridge response (JSONL over stdout, schemaVersion 1)

Parsed by `BridgeJsonlParser` (`src/kb/protocol.ts`). Newline-delimited records, each `{ schemaVersion: 1, requestId, type, ... }`; `requestId` must match; `complete` must be the final record; 4 MiB per-record cap.

Lifecycle:
- `start` (must be first; carries operation) →
- normal ops: exactly one `result` `{data}` then `complete {ok: true}`; or `error {code,message}` + `complete {ok:false}`.
- `kb.doc.read` batch (inline): a sequence of `item {seq, data:{docId, ok, ...}}` with seq from 0 and `docId` matching requested order, then `complete {ok:true, stats:{total,succeeded,failed}}`. `partial=true` when any item `ok=false` (per-item business failures are preserved, not treated as whole-batch failure).
- `kb.doc.read` **file mode** (`output:"file"`): `result` is a manifest summary `{output,operation,directory,manifest,tree/total,succeeded,failed,...}` and `complete` carries `stats`; no item stream. Used by the tool to avoid truncating large doc.list/doc.read results.
- Errors produce a structured `{ok:false, operation, error:{code,message}}`; codes surfaced include `OPEN_KB_*` (permission/not-found/internal), `OPEN_TOKEN_*` (credential), `OPEN_CLIENT_AUTH_FAILED`, `OPEN_SCOPE_FORBIDDEN`, plus bridge-side `YOUDU_CLI_NOT_INSTALLED`, `YOUDU_KB_ABORTED/IDLE_TIMEOUT/TOTAL_TIMEOUT/OUTPUT_LIMIT/BRIDGE_PROTOCOL_ERROR/PROCESS_ERROR`, and `YOUDU_IM_CONTEXT_REQUIRED`, `YOUDU_KB_INVALID_ARGUMENTS`, `YOUDU_KB_CONFIG_INVALID`.

### 1.4 Security posture of the tool

- Fail closed: factory is `null` outside the youdu channel; execution returns `YOUDU_IM_CONTEXT_REQUIRED` when there is no trusted inbound YouDu run context (no silent fallback to owner-full-scan).
- The CLI is the only caller of the KB open API; the tool never does HTTP itself and never exposes connect/event/account fields to the model (skill: "不要传 ... 连接、鉴权、事件字段").
- Runner redacts secret/botId/baseUrl/gids and any `token|signature|sign=...` from diagnostics; never returns argv/env/request/binary path.
- Bounds: stdout 64 MiB aggregate + 4 MiB/record, stderr 64 KiB, idle 130 s, total 15 min, 1 s terminate grace, abortable; exit code cross-checked against `complete.ok`.

### 1.5 How the plugin binds run context (the mechanism to port)

Two files: `src/kb/run-context.ts` (runId/toolCallId token map, hooks `before_tool_call`/`after_tool_call`) and `src/kb/request-context.ts` (`AsyncLocalStorage`). `monitor.ts` calls `bindYouDuKbRunContext(runId, {chatId, messageId, senderId})` after access checks; `registerYouDuKbRunContext` injects a unique token `__youduKbInvocationToken` into tool params on `before_tool_call`; `claimYouDuKbToolContext(toolCallId, rawParams)` consumes the token → trusted event → `senderId`. This is OpenClaw-specific. **DSH needs its own equivalent** (see §2.3).

---

## 2. DSH tool-injection mechanism & the registration point

### 2.1 How tools are injected into Harness (dsh-im host plugin)

`plugin-src/host/index.mjs` `createImHostPlugin().apply(ctx, config)`:
- `ctx.inject(['connection','credentials','typertGateway'])` are declared capabilities.
- In `activateChannels(ctx, ...)`:
  ```js
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['tools', 'systemPrompt'], (artifactCtx) => {
      installOutboundArtifactTool(artifactCtx);
    });
  } else {
    installOutboundArtifactTool(ctx);
  }
  ```
So the canonical registration point for a channel tool is **inside a `ctx.inject(['tools', 'systemPrompt'], (toolCtx) => ...)` callback**, receiving a context that exposes exactly:
- `ctx.tools.register(definition)`
- `ctx.on('tools/result', (exec, result) => ...)`
- `ctx.on('session/event', (session, event) => ...)`
- `ctx.on('session/disposed', (session) => ...)`
- `ctx.systemPrompt.section({ name, order, text })`

`installOutboundArtifactTool` (`src/channels/shared/semantic/artifact.mjs`) returns `false` if those APIs are absent, else registers the tool, hooks `tools/result`, `session/event`, `session/disposed`, and injects a system-prompt section.

### 2.2 Tool definition + exec shape (the contract to follow)

`createOutboundArtifactTool` builds `definition`:

```js
{
  name, description,
  parameters: { type:'object', additionalProperties:false, properties, required },
  output: { schema, render:(_args,value)=>[{type:'text',text}] },
  async execute(args, exec) { ... }
}
```

From the test (`test/outbound-artifact.test.mjs`) the `exec` object is:
```js
exec = { name, agent, callId, rootCallId, token, signal?, ... }
agent = { session: { header: { id: sessionId, cwd: workspace }, events: [...] } }
```
- `exec.agent.session.header.id` = the hosting **Session id** (used to key the artifact registry via `registry.take(sessionId, turn)`).
- `exec.agent.session.header.cwd` = the session **workspace**.
- `exec.signal`, `exec.callId`, `exec.parent` (Code Mode parent), `exec.token` are available; `tools/result` handler receives `(exec, result)` with `result.isError`.

### 2.3 → youdu_kb registration point and how to thread botId/secret/url + gids

**Registration point.** Register the KB tool from the youdu channel host plugin's `apply()` (`plugin-src/host/channels/youdu/index.mjs`), using the same `ctx.inject(['tools','systemPrompt'], ...)` gate, with a new `installYouduKbTool(toolCtx, deps)` mirroring `installOutboundArtifactTool`:

```js
export async function apply(ctx, config = {}) {
  ...
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['tools', 'systemPrompt'], (toolCtx) => installYouduKbTool(toolCtx, {
      resolveAccount: ...        // resolves per-session run context
    }));
  }
  ...
}
```

This keeps the aggregate `index.mjs` untouched and scopes the tool to the youdu channel. Because tools are registered host-globally (once), `installYouduKbTool` must not bake in a single bot's credentials; it resolves them per execution.

**Threading bot context + gids into the tool (the key design gap vs OpenClaw).** OpenClaw uses an AsyncLocalStorage + `before_tool_call` token map. DSH's tool executes inside the Harness session via `ctx.tools.register`, and the host plugin process is the **same** process as the channel bridge (they share module singletons — the artifact registry is a module-level `outboundArtifactRegistry` shared by `harness-client.ask()` and the tool). So the equivalent is a **module-level per-session context map**, analogous to the artifact registry but keyed by `sessionId`:

- Before `session.ask(content, askOptions)` (`askInWorkspaceSession` → `harness-client.ask`), the YouduBridge resolves the run context for that session: `{ sessionId, botId, sourceBotId, baseUrl, secret, ownerUserId, senderId }` and stores it in a map `sessionId → runContext`. `secret` is resolved via `ctx.credentials.resolve(secretRef)` (same as `YouduController.#resolveSecret`). `baseUrl` derived from bot's `wsHost` → `https://<host>:7443`. `senderId` from the inbound message; `ownerUserId` from bot config.
- The tool's `execute(args, exec)` reads `exec.agent.session.header.id`, looks up the run context, and builds the bridge request exactly as `createBridgeRequest` does. It passes `gids = [runContext.senderId]` (matching OpenClaw) so the KB server enforces owner∩sender.
- After the ask settles (`finally`), the bridge releases the context to avoid leakage/reuse across turns.
- If no run context is present in `execute`, return `YOUDU_IM_CONTEXT_REQUIRED` (fail closed).

Recommendation: place the map in a small module (`src/channels/youdu/kb-run-context.mjs`) and expose `bindYouduKbRunContext(sessionId, ctx)` / `takeYouduKbRunContext(sessionId)` / `releaseYouduKbRunContext(sessionId)`, used by both the bridge and the tool — mirroring how `outboundArtifactRegistry` is shared. Alternative: reuse `AsyncLocalStorage` around `session.ask` (as OpenClaw does) — but confirm DSH tool execution actually runs inside the same async chain; the session key map is simpler and matches the existing artifact-registry pattern.

---

## 3. Module division & placement, and @youdu/cli binary

### 3.1 What to port and where

The plugin's KB modules are transport/host-agnostic and can be transplanted largely verbatim (as JS) into dsh-im:

| plugin module | dsh-im target (recommended) |
|---|---|
| `src/kb/protocol.ts` (ops, validation, `BridgeJsonlParser`) | `src/channels/youdu/kb/protocol.mjs` |
| `src/kb/endpoint.ts` (baseUrl/TLS/CA, buildYouDuKbEndpoint) | `src/channels/youdu/kb/endpoint.mjs` |
| `src/kb/cli-runner.ts` (spawn, bounds, timeouts, redaction) | `src/channels/youdu/kb/cli-runner.mjs` |
| `src/kb/tool.ts` (`youduKbToolParameters`, factory, runBridge) | `src/channels/youdu/kb/tool.mjs` |
| `src/kb/run-context.ts` (token run-context for OpenClaw) | → replaced by dsh-im session-context map (`kb-run-context.mjs`) |
| `src/kb/request-context.ts` (AsyncLocalStorage) | optional; only if using ALS approach |
| `src/kb/tool-policy.ts` (auto-add `youdu_kb` to `tools.alsoAllow`) | dsh-im has no `tools.alsoAllow`; tool is always registered for youdu — **not needed** |
| `skills/youdu-kb-tool/SKILL.md` | `skills/youdu-kb-tool/SKILL.md` (dsh-im has no skills dir yet; add one + declare in package.json `files`/bundle, or inline a systemPrompt section) |
| `src/youdu-cli.d.ts` | `src/youdu-cli.d.ts` (or `.mjs`/type stub) — declare `@youdu/cli` + `@youdu/cli/platform` `resolveYouDuCliBinary()` |
| `cert/cacert-2026-03-19.pem` | copy bundled CA into dsh-im (e.g. `src/channels/youdu/cert/`); **must** add, none exists today |

Important language note: the plugin is TypeScript; **dsh-im `src/` is plain `.mjs` (ES modules) and tests are `.test.mjs`**. Port to `.mjs`, and add tests under `test/channels/youdu/` (test command: `node --test test/*.test.mjs test/channels/*/*.test.mjs`).

### 3.2 Endpoint / TLS construction in dsh-im terms

Plugin `endpoint.ts` builds `baseUrl = https://<hostname>:7443` and TLS `{ caPem, allowIpHostnameMismatch: isIP(host)!==0 }`. In dsh-im:
- Field for the host = bot config `wsHost` (resolved from `#isAddressedGroupMessage`/`normalizeWsHost`). But **the KB open API host may differ from the WS host** — the plugin conflates them (`config.channels.youdu.url`). For dsh-im this is the same `wsHost` `host[:port]`; normalize to hostname and force port 7443.
- dsh-im has **no bundled CA cert** (`cert/` is absent). Copy `cert/cacert-2026-03-19.pem` from the plugin and wire `endpoint.mjs` to read it. For IP hosts allow hostname mismatch; keep chain verification otherwise.

### 3.3 @youdu/cli binary acquisition & validation

- `@youdu/cli` is a **runtime dependency** of the plugin (`package.json` `"@youdu/cli": "0.1.3"`), and provides `@youdu/cli/platform` → `resolveYouDuCliBinary()` which returns the platform-specific binary path (pattern: `src/youdu-cli.d.ts`). It is **not** installed anywhere on disk today (`@youdu/cli` absent from dsh-im and plugin `node_modules`), i.e. it is fetched/installed from the registry (or local tarball) as part of packaging.
- dsh-im must add `@youdu/cli` as a runtime dependency (it currently is not). Because dsh-im builds with esbuild (`plugin-src/host/build.mjs`) and not Rollup, mark `@youdu/cli` and `@youdu/cli/platform` as **external** so the resolver and binary are not bundled — runtime resolution must hit the installed package.
- Validation: a smoke test asserting `resolveYouDuCliBinary()` returns an existing executable, plus the injected-spawn test pattern already used by the plugin (`spawnProcess` injection) so tests don't need the real binary.

---

## 4. Acceptance points & risks

### 4.1 Acceptance checklist (for engineer + reviewer)

1. **Registration scoping**: `youdu_kb` is registered only for the youdu channel (via `ctx.inject(['tools','systemPrompt'])` in the youdu channel apply); absent there = not registered. No change to the aggregate `index.mjs` tool path.
2. **Operations & validation**: all 5 ops map exactly; per-op allowed-fields enforcement (reject unknown/extra/duplicate), `doc.read` requires unique non-empty `docIds`, `concurrency` 1–16; outcome matches the plugin's `ValidatedToolArguments`.
3. **Bridge request**: one `@youdu/cli bridge --stdin` spawn per call, `shell:false`, `windowsHide:true`, `schemaVersion:2`, `connection{baseUrl=https://<host>:7443, botId, secret, tls{caPem, allowIpHostnameMismatch=isIP}}`, `gids=[senderId]`, correct `arguments`. Credentials/gids only from the session run context, never model args.
4. **JSONL protocol**: `start/result/item/error/complete` ordering, `requestId` match, 4 MiB record cap, `doc.read` batch `stats` + `partial`, file-mode manifest; inconsistent exit-code → protocol error.
5. **Process bounds**: idle 130 s / total 15 min / 1 s grace, stdout 64 MiB + 4 MiB/record, stderr 64 KiB, abort kill, `resolveBinary` failure → `YOUDU_CLI_NOT_INSTALLED`.
6. **Redaction**: secret/botId/baseUrl/gids/token never in tool output or diagnostics; no argv/env/request/binary path returned.
7. **Fail closed**: no trusted run context → `YOUDU_IM_CONTEXT_REQUIRED`; non-youdu → not registered.
8. **Back-compat**: existing youdu channel connect/send/receive stays intact (`test/channels/youdu/bridge.test.mjs` and the whole suite pass).
9. **Build**: `npm run build` succeeds; `@youdu/cli` externalized; package metadata includes `@youdu/cli` + the CA cert asset.
10. **Tests**: new `test/channels/youdu/kb*.test.mjs` cover validation, parser (arbitrary chunks, split UTF-8, bad order/seq/dup/trailing), runner (fake child: spawn argv/options/stdin, bounds, abort/timeout, abnormal exit, missing binary), tool (5 ops, redaction, fail-closed), and context map (bind/take/release, cross-session isolation).

### 4.2 Risks / open questions

- **@youdu/cli binary availability (high).** Not currently installed anywhere. Adds a runtime dep + platform binary; needs registry/tarball install and explicit build externalization. Until installed, every call returns `YOUDU_CLI_NOT_INSTALLED`. The binary's exact `bridge --stdin` behavior must be validated against the real package (integration smoke test) — the plugin's internal tests use an injected fake process, so the real wire format is only proven by the plugin's `endpoint.test.ts`/`cli-runner.test.ts` (also fake). Confirm `@youdu/cli` publishes a platform resolver.
- **Host sandbox may block piped spawn (high).** `cli-runner` uses `spawn(binary, ['bridge','--stdin'], {stdio:'pipe'})` and reads stdout/stderr/stdin. The DSH host file/command sandbox (as in this session) can return EPERM for `child_process` spawns that capture output through piped stdio, and may restrict process execution in the host plugin process. Must confirm the host plugin is allowed to `spawn` and that the KB tool runner lives in a context where piped stdio is permitted; otherwise the bridge fails at the process layer.
- **Read access to KB file-mode temp results (high, design gap).** The plugin forces `output:"file"` for `doc.list`/`doc.read` and has the model `Read` the landed temp files via shell/Read across arbitrary paths. In dsh-im the model's file tools are workspace-scoped (the artifact tool resolves and `realpath`s within the session workspace). OS-temp KB files may **not** be readable by the Harness model. Decide: (a) return bounded inline JSON and drop file mode; or (b) stage KB output into the session workspace so the model can Read it, then clean up; or (c) confirm Harness Read can open arbitrary paths. This is the biggest behavioral divergence from OpenClaw and needs a concrete choice before implementation.
- **Session context threading / leakage (medium).** Mapping sessionId→runContext and clearing on ask-settle; session reuse across conversation keys or concurrent turns could cross contexts. Key by `promptRpcId`/turn like the artifact registry if per-ask isolation is required; fail closed when a tool call has no bound context. If a non-youdu caller ever shares a session, it must not inherit a youdu context (fail closed).
- **owner∩sender gids semantics (medium).** Plugin sends `gids=[senderId]` and relies on the server to intersect with the bot owner grant. dsh-im has an explicit `ownerUserId`; confirm whether `gids` should be `[ownerUserId, senderId]` or only `[senderId]`, and that the CLI `bridge --stdin` `gids` field means exactly "requesting user identity" (not a permissive list). Validate via a real-KB integration test before finalizing; do not silently expand permission.
- **Secret handling (medium).** `secret` resolved from dsh-im `credentials` store (`credentials.resolve(secretRef)`); must never be written into tool results, `systemPrompt`, or diagnostics; redact as the plugin does. Confirm the run-context does not retain the secret after release.
- **CA cert (medium).** No CA in dsh-im today; must bundle the plugin's `cert/cacert-2026-03-19.pem` (or the current trusted CA). If the KB endpoint uses a different internal CA (openclaw `fix-ca` branch suggests CA friction), confirm which PEM pairs with the target `https://host:7443`.
- **Endpoint host (low/medium).** KB API host = the youdu host — but is the KB open API served on the same `wsHost`? The plugin assumes yes. Validate the open-API base path/host against the `@youdu/cli` implementation; the endpoint module should accept the resolved host explicitly so it is not hard-wired to the WS host if they differ.
- **Tool result truncation inline (medium).** If file mode is dropped, `doc.read` batches beyond the tool-result size limit truncate and defeat the "batch read" · skill. Bound inline output and surface partial/truncated clearly, or keep file mode via workspace staging.
