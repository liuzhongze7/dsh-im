import { createProductionController } from './production.mjs';
import { installYouduRpc } from './rpc.mjs';
import { installYouduKbTool } from '../../../../src/channels/youdu/kb/tool.mjs';
import { installYouduSendTool } from '../../../../src/channels/youdu/send-tool.mjs';

export const name = 'dsh-im-youdu-host';
export const inject = ['connection', 'credentials', 'typertGateway'];

export async function apply(ctx, config = {}) {
  let log = console;
  try { if (typeof ctx?.logger === 'function') log = ctx.logger('dsh-im:youdu'); } catch { log = console; }
  log.info('[dsh-im-youdu] apply() called');
  if (config?.controller) {
    log.info('[dsh-im-youdu] apply() -> installYouduRpc (controller provided)');
    return installYouduRpc(ctx, config.controller, config.rpcOptions, config.rpcAuthority);
  }
  const production = await createProductionController(ctx, config, config.internals);
  log.info('[dsh-im-youdu] production controller created');
  // 把有度的主动发送接入统一的 DeliveryService（与其它渠道同一条通路）。
  const unregisterDelivery = config.deliveryService && production.deliveryAdapter
    ? config.deliveryService.registerAdapter(production.deliveryAdapter)
    : undefined;
  if (unregisterDelivery) log.info('[dsh-im-youdu] delivery adapter registered');
  // Register the youdu_kb knowledge-base tool host-globally. It resolves its
  // account + gids from the per-session run context bound by the YouDu bridge;
  // absent a bound context it fails closed (YOUDU_IM_CONTEXT_REQUIRED).
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['tools', 'systemPrompt'], (toolCtx) => {
      installYouduKbTool(toolCtx);
      // 显式出站工具：会话绑定有度后，模型可以把文字/文件发回该有度会话
      // （DSH 网页端发起的回合也能发），不依赖入站回调 reqId。
      installYouduSendTool(toolCtx);
    });
  } else {
    installYouduKbTool(ctx);
    installYouduSendTool(ctx);
  }
  const disposeRpc = installYouduRpc(
    ctx,
    production.controller,
    config.rpcOptions,
    config.rpcAuthority,
  );
  log.info('[dsh-im-youdu] /youdu RPC installed');
  ctx.effect(() => async () => {
    try {
      await unregisterDelivery?.();
    } finally {
      await production.close();
    }
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
