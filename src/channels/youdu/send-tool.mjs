// 「把这条内容发到有度」的会话级路由与工具。
//
// 背景：有度渠道的回复原本只走「入站消息回调回传」（respond_msg 按该条消息的 reqId）。
// 因此在 DSH 网页端继续一个已经绑定有度的会话时（回合不是有度消息触发的），
// 模型没有任何办法把内容送回有度——用户看到的是「我在 DSH 里让它发，群里什么都没有」。
//
// 这里补上显式通道：bridge 每次收到某个会话的入站消息时，把该会话的回传路由
// 和「按路由投递」的函数登记进来（同一进程内的模块级单例，与 KB run context、
// outbound artifact registry 同一套做法）；工具按 `exec.agent.session.header.id`
// 找到登记项，把文字直接投递、或把文件交给渠道的 deliverArtifact。

const bindings = new Map();

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * 登记一个会话的出站路由。同会话重复登记时用最新的路由覆盖（群/私聊切换、
 * 会话重绑都会走到这里）。
 */
export function bindYouduOutboundRoute(sessionId, binding) {
  const id = cleanString(sessionId);
  if (!id) return;
  if (!binding || typeof binding !== 'object') {
    throw new TypeError('Youdu outbound binding is required');
  }
  if (typeof binding.sendText !== 'function' && typeof binding.sendFile !== 'function') {
    throw new TypeError('Youdu outbound binding needs sendText or sendFile');
  }
  bindings.set(id, Object.freeze({ ...binding }));
}

/** 读取会话的出站路由（不删除：绑定随会话存活，直到被重新绑定或清理）。 */
export function getYouduOutboundRoute(sessionId) {
  const id = cleanString(sessionId);
  return id ? bindings.get(id) : undefined;
}

/** 会话被清理/机器人停止时释放绑定。 */
export function releaseYouduOutboundRoute(sessionId) {
  const id = cleanString(sessionId);
  if (!id) return false;
  return bindings.delete(id);
}

/** 清空绑定（测试或整插件停用）。 */
export function clearYouduOutboundRoutes(sessionId) {
  const id = cleanString(sessionId);
  if (id) bindings.delete(id);
  else bindings.clear();
}

export const YOUDU_SEND_TOOL = 'dsh_im_send_to_youdu';

function missingContextError() {
  const error = new Error(
    'YOUDU_IM_CONTEXT_REQUIRED: 当前会话没有绑定任何有度会话，无法发送；'
    + '请让用户在对应的有度会话里先发一条消息（或用 /session 绑定）后再试。',
  );
  error.code = 'youdu-im-context-required';
  return error;
}

function resolveSessionId(exec) {
  return cleanString(exec?.agent?.session?.header?.id)
    ?? cleanString(exec?.agent?.session?.id);
}

function normalizeText(args) {
  return typeof args?.text === 'string' ? args.text.trim() : '';
}

function normalizePath(args) {
  return cleanString(args?.path);
}

/**
 * Build the explicit outbound tool. `registry` is injectable for tests; production
 * uses the module singleton the bridge binds into.
 */
export function createYouduSendTool({ registry = { get: getYouduOutboundRoute } } = {}) {
  const definition = Object.freeze({
    name: YOUDU_SEND_TOOL,
    description:
      'Send text (or a readable file) to the Youdu conversation that the current '
      + 'Harness Session is bound to. Use this when the user asks you to send, forward '
      + 'or relay something into Youdu (for example from the DSH web client). Plain '
      + 'assistant text is never relayed to Youdu by itself. Provide either `text` or '
      + '`path` (a Markdown file can act as the message body).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: {
          type: 'string',
          description: 'Message body to deliver to the bound Youdu conversation.',
        },
        path: {
          type: 'string',
          description:
            'Absolute path (or workspace-relative path) of a file to deliver to the '
            + 'bound Youdu conversation, such as a Markdown file written as the reply.',
        },
        fileName: {
          type: 'string',
          description: 'Optional display name for the delivered file.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean' },
          kind: { type: 'string' },
          route: { type: 'string' },
        },
        required: ['delivered', 'kind', 'route'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.delivered
          ? `Sent the ${value.kind} to the bound Youdu conversation (${value.route}).`
          : 'Nothing was sent.',
      }],
    },
    async execute(args, exec) {
      const sessionId = resolveSessionId(exec);
      const binding = sessionId ? registry.get(sessionId) : undefined;
      if (!binding) throw missingContextError();

      const text = normalizeText(args);
      const filePath = normalizePath(args);
      if (!text && !filePath) {
        const error = new TypeError('Provide text or path to send to Youdu');
        error.code = 'youdu-send-nothing-to-send';
        throw error;
      }

      const route = typeof binding.describeRoute === 'function'
        ? binding.describeRoute()
        : 'youdu';

      if (text) {
        if (typeof binding.sendText !== 'function') throw missingContextError();
        await binding.sendText(text, { signal: exec?.signal });
      }
      if (filePath) {
        if (typeof binding.sendFile !== 'function') throw missingContextError();
        await binding.sendFile(filePath, {
          fileName: cleanString(args?.fileName) || undefined,
          workspace: cleanString(exec?.agent?.session?.header?.cwd) || undefined,
          signal: exec?.signal,
        });
      }
      return {
        delivered: true,
        kind: text && filePath ? 'text+file' : (text ? 'text' : 'file'),
        route,
      };
    },
  });

  return {
    definition,
    /** Cordis-style installer: registers the tool and its prompt hint. */
    install(ctx) {
      if (typeof ctx?.tools?.register !== 'function') return false;
      ctx.tools.register(definition);
      ctx.systemPrompt?.section?.({
        name: 'dsh-im:youdu-send',
        order: 116,
        text: `当前会话绑定了一个有度会话时，要把内容发回有度（用户说“发到群里 / 回复到有度 / 转达给某人”）必须调用 ${YOUDU_SEND_TOOL}：文字用 \`text\`，文件或 Markdown 正文用 \`path\`；普通助手文字不会自动转发到有度。`,
      });
      return true;
    },
  };
}

/** Register the outbound tool on the injected tools service. */
export function installYouduSendTool(ctx, { registry } = {}) {
  if (typeof ctx?.tools?.register !== 'function') return false;
  return createYouduSendTool({ registry }).install(ctx);
}
