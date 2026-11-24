/**
 * The in-process Peer every Host gateway request must name.
 *
 * The Host Typert gateway requires `InvokeRemoteRequest.peer` and reads its
 * lifetime signal, so a request without one fails inside the Host with
 * `Cannot read properties of undefined (reading 'signal')` — which surfaces as
 * an opaque `INTERNAL_UNKNOWN` message failure. `ctx.connection.createPeer()`
 * is the Host's public factory for in-process callers; the Peer is disposed
 * with the Context that read `ctx.connection`, so callers must not outlive it.
 */

const peers = new WeakMap();

/**
 * @param {object} ctx - Cordis Host context of the plugin or channel.
 * @returns {object} the shared PeerScope for this Host root.
 */
export function hostPeer(ctx) {
  const scope = ctx?.root ?? ctx;
  if (!scope || !['object', 'function'].includes(typeof scope)) {
    throw new TypeError('dsh-im requires a Cordis Host context to create an in-process Peer');
  }
  const cached = peers.get(scope);
  // A disposed Peer aborts its lifetime signal; a reloaded plugin needs a fresh one.
  if (cached && !cached.signal?.aborted) return cached;
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : ctx?.connection;
  if (!connection || typeof connection.createPeer !== 'function') {
    throw new TypeError('dsh-im requires a Host connection that exposes createPeer');
  }
  const peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
  peers.set(scope, peer);
  return peer;
}
