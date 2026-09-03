// dsh-im equivalent of @youdu/openclaw-youdu `src/kb/run-context.ts`.
//
// OpenClaw threads a trusted inbound YouDu run context into the tool via an
// AsyncLocalStorage + a `before_tool_call` token map. dsh-im tools execute in the
// host process, and the tool reads `exec.agent.session.header.id`. The channel
// bridge and the tool share this process and its module singletons, so the
// equivalent is a module-level `sessionId → runContext` map (mirroring how the
// outbound artifact registry is shared): the bridge binds before `session.ask`,
// and releases after it settles.

const runContexts = new Map();

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * Bind the trusted KB run context for a session. `context` must be frozen and
 * contain at least `account` and `gids` (never expose secrets outside the map).
 */
export function bindYouduKbRunContext(sessionId, context) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  if (!context || typeof context !== 'object') {
    throw new TypeError('YouDu KB run context is required');
  }
  runContexts.set(sessionId, Object.freeze(context));
}

/** Read the bound context without removing it (the bridge releases it). */
export function getYouduKbRunContext(sessionId) {
  return typeof sessionId === 'string' && sessionId ? runContexts.get(sessionId) : undefined;
}

/** Release the bound context (called after the session ask settles). */
export function releaseYouduKbRunContext(sessionId) {
  if (typeof sessionId === 'string' && sessionId) runContexts.delete(sessionId);
}

/**
 * Release run contexts. When a `sessionId` is supplied, drop only that
 * session's context (used by the channel tool's session-disposed handler so a
 * disposed conversation never clears other live sessions); without an argument,
 * clear every bound context (test cleanup / full reset).
 */
export function clearYouduKbRunContext(sessionId) {
  if (typeof sessionId === 'string' && sessionId) runContexts.delete(sessionId);
  else runContexts.clear();
}

/**
 * Build the run context for one inbound request from the bot account config.
 * `account` = `{ botId, secret, url }` (url = the configured ws host); `gids`
 * carries the requesting sender, so the KB server enforces owner ∩ sender.
 */
export function buildYouduKbRunContext(account, { senderId }) {
  const cleanedSender = cleanString(senderId);
  return Object.freeze({
    account: Object.freeze({
      botId: typeof account?.botId === 'string' ? account.botId : '',
      secret: typeof account?.secret === 'string' ? account.secret : '',
      url: typeof account?.url === 'string' ? account.url : '',
    }),
    gids: cleanedSender ? [cleanedSender] : [],
  });
}
