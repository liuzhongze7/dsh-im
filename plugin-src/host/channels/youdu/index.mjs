import { createProductionController } from './production.mjs';
import { installYouduRpc } from './rpc.mjs';

export const name = 'dsh-im-youdu-host';
export const inject = ['connection', 'credentials', 'typertGateway'];

export async function apply(ctx, config = {}) {
  if (config?.controller) {
    return installYouduRpc(ctx, config.controller, config.rpcOptions, config.rpcAuthority);
  }
  const production = await createProductionController(ctx, config, config.internals);
  const disposeRpc = installYouduRpc(
    ctx,
    production.controller,
    config.rpcOptions,
    config.rpcAuthority,
  );
  ctx.effect(() => async () => {
    await production.close();
  }, 'dsh-im: close Youdu bot connections');
  return disposeRpc;
}

export function createYouduHostPlugin(config) {
  return Object.freeze({ name, inject, apply: (ctx) => apply(ctx, config) });
}

export { createConnectionSupervisor, ConnectionSupervisor } from './connection-supervisor.mjs';
export { createProductionController } from './production.mjs';
export { YOUDU_RPC_CHANNEL, YOUDU_RPC_ENDPOINTS, createYouduRpcHandler, installYouduRpc } from './rpc.mjs';
export { YouduController } from '../../../../src/channels/youdu/youdu-controller.mjs';
export { YouduRuntime } from '../../../../src/channels/youdu/youdu-runtime.mjs';
