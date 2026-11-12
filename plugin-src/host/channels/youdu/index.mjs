import { createProductionController } from './production.mjs';
import {
  createYouduRpcHandler,
  installYouduRpc,
  YOUDU_RPC_CHANNEL,
} from './rpc.mjs';
import { installProductionChannel } from '../shared/startup.mjs';
import { installYouduKbTool } from '../../../../src/channels/youdu/kb/tool.mjs';
import { installYouduSendTool } from '../../../../src/channels/youdu/send-tool.mjs';

export const name = 'dsh-im-youdu-host';
export const inject = ['connection', 'credentials', 'typertGateway'];

/**
 * 注册有度专属的出站工具（知识库查询 + 会话内主动发送）。
 * 工具只依赖 ctx 与每个会话绑定的有度上下文，与连接初始化无关，因此先于
 * production 安装：连接初始化失败时工具仍在，错误信息由工具自身给出。
 */
function installYouduTools(ctx) {
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['tools', 'systemPrompt'], (toolCtx) => {
      installYouduKbTool(toolCtx);
      // 显式出站工具：会话绑定有度后，模型可以把文字/文件发回该有度会话
      // （DSH 网页端发起的回合也能发），不依赖入站回调 reqId。
      installYouduSendTool(toolCtx);
    });
    return;
  }
  installYouduKbTool(ctx);
  installYouduSendTool(ctx);
}

export async function apply(ctx, config = {}) {
  if (config?.controller) {
    return installYouduRpc(ctx, config.controller, config.rpcOptions, config.rpcAuthority);
  }
  installYouduTools(ctx);
  // 与其它渠道同一条启动通路：先挂管理 RPC（连接未就绪时也能给出错误），
  // 再初始化 production 并注册投递适配器与关闭钩子。
  return installProductionChannel(ctx, config, {
    channel: 'youdu',
    rpcChannel: YOUDU_RPC_CHANNEL,
    createProduction: () => createProductionController(ctx, config, config.internals),
    createHandler: (controller) => createYouduRpcHandler(controller, config.rpcOptions),
  });
}

export function createYouduHostPlugin(config) {
  return Object.freeze({ name, inject, apply: (ctx) => apply(ctx, config) });
}

export { createConnectionSupervisor, ConnectionSupervisor } from './connection-supervisor.mjs';
export { createProductionController } from './production.mjs';
export { YOUDU_RPC_CHANNEL, YOUDU_RPC_ENDPOINTS, createYouduRpcHandler, installYouduRpc } from './rpc.mjs';
export { YouduController } from '../../../../src/channels/youdu/youdu-controller.mjs';
export { YouduRuntime } from '../../../../src/channels/youdu/youdu-runtime.mjs';
