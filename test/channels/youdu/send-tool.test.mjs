import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindYouduOutboundRoute,
  clearYouduOutboundRoutes,
  createYouduSendTool,
  getYouduOutboundRoute,
  installYouduSendTool,
  releaseYouduOutboundRoute,
  YOUDU_SEND_TOOL,
} from '../../../src/channels/youdu/send-tool.mjs';

function toolContext() {
  const registered = [];
  const sections = [];
  return {
    registered,
    sections,
    ctx: {
      tools: { register: (definition) => registered.push(definition) },
      systemPrompt: { section: (section) => sections.push(section) },
    },
  };
}

function executor(sessionId, extra = {}) {
  return {
    agent: { session: { header: { id: sessionId, cwd: process.cwd() } } },
    callId: 'call-1',
    ...extra,
  };
}

test.afterEach(() => clearYouduOutboundRoutes());

test('youdu send tool registers with the expected name and prompt hint', () => {
  const { ctx, registered, sections } = toolContext();
  assert.equal(installYouduSendTool(ctx), true);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, YOUDU_SEND_TOOL);
  assert.equal(registered[0].parameters.required, undefined);
  assert.deepEqual(Object.keys(registered[0].parameters.properties).sort(), ['fileName', 'path', 'text']);
  assert.equal(sections.length, 1);
  assert.match(sections[0].text, /YOUDU|dsh_im_send_to_youdu/);
});

test('youdu send tool reports the bound route and sends text', async () => {
  const sent = [];
  bindYouduOutboundRoute('session-1', {
    kind: 'group',
    describeRoute: () => '群 g-1',
    sendText: async (text) => { sent.push(text); },
  });
  const { definition } = createYouduSendTool();

  const result = await definition.execute({ text: '你好，群里' }, executor('session-1'));
  assert.deepEqual(result, { delivered: true, kind: 'text', route: '群 g-1' });
  assert.deepEqual(sent, ['你好，群里']);
  assert.deepEqual(definition.output.render(null, result), [{
    type: 'text',
    text: 'Sent the text to the bound Youdu conversation (群 g-1).',
  }]);
});

test('youdu send tool delivers a file with the workspace-relative path and display name', async () => {
  const files = [];
  bindYouduOutboundRoute('session-2', {
    kind: 'group',
    describeRoute: () => '群 g-2',
    sendFile: async (path, options) => { files.push({ path, ...options }); },
  });
  const { definition } = createYouduSendTool();

  const result = await definition.execute(
    { path: 'outbox/reply.md', fileName: '回复.md' },
    executor('session-2'),
  );
  assert.equal(result.delivered, true);
  assert.equal(result.kind, 'file');
  assert.deepEqual(files, [{
    path: 'outbox/reply.md',
    fileName: '回复.md',
    workspace: process.cwd(),
    signal: undefined,
  }]);
});

test('youdu send tool sends text and file together', async () => {
  const calls = [];
  bindYouduOutboundRoute('session-3', {
    kind: 'user',
    describeRoute: () => '私聊 6463894',
    sendText: async () => calls.push('text'),
    sendFile: async () => calls.push('file'),
  });
  const { definition } = createYouduSendTool();

  const result = await definition.execute({ text: 'hello', path: 'a.md' }, executor('session-3'));
  assert.equal(result.kind, 'text+file');
  assert.deepEqual(calls, ['text', 'file']);
});

test('youdu send tool fails closed without a bound route', async () => {
  const { definition } = createYouduSendTool();
  await assert.rejects(
    () => definition.execute({ text: 'hi' }, executor('unbound-session')),
    (error) => error.code === 'youdu-im-context-required'
      && /YOUDU_IM_CONTEXT_REQUIRED/.test(error.message),
  );
});

test('youdu send tool rejects an empty request', async () => {
  bindYouduOutboundRoute('session-4', { kind: 'group', sendText: async () => {} });
  const { definition } = createYouduSendTool();
  await assert.rejects(
    () => definition.execute({}, executor('session-4')),
    { code: 'youdu-send-nothing-to-send' },
  );
});

test('youdu outbound routes are kept until replaced, released or cleared', () => {
  bindYouduOutboundRoute('session-5', { kind: 'group', sendText: async () => {} });
  assert.ok(getYouduOutboundRoute('session-5'));
  bindYouduOutboundRoute('session-5', { kind: 'user', sendText: async () => {} });
  assert.equal(getYouduOutboundRoute('session-5').kind, 'user');
  assert.equal(releaseYouduOutboundRoute('session-5'), true);
  assert.equal(getYouduOutboundRoute('session-5'), undefined);
  bindYouduOutboundRoute('session-6', { kind: 'group', sendText: async () => {} });
  clearYouduOutboundRoutes();
  assert.equal(getYouduOutboundRoute('session-6'), undefined);
});

test('youdu outbound binding rejects a binding without any sender', () => {
  assert.throws(
    () => bindYouduOutboundRoute('session-7', { kind: 'group' }),
    /needs sendText or sendFile/,
  );
});
