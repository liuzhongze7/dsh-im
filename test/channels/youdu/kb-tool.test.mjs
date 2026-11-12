import assert from 'node:assert/strict';
import test from 'node:test';

import {
  YOUDU_KB_TOOL,
  createYouduKbTool,
  installYouduKbTool,
  youduKbToolParameters,
} from '../../../src/channels/youdu/kb/tool.mjs';
import {
  bindYouduKbRunContext,
  buildYouduKbRunContext,
  getYouduKbRunContext,
  clearYouduKbRunContext,
} from '../../../src/channels/youdu/kb/kb-run-context.mjs';

function exec(sessionId, overrides = {}) {
  return {
    name: YOUDU_KB_TOOL,
    agent: { session: { header: { id: sessionId, cwd: '/workspace' }, events: [] } },
    callId: 'call-1',
    rootCallId: 'call-1',
    token: Symbol('token'),
    ...overrides,
  };
}

function fakeBridge(...outcomes) {
  const req = [];
  let index = 0;
  return {
    req,
    runBridge: async (request) => { req.push(request); return outcomes[Math.min(index++, outcomes.length - 1)]; },
  };
}

const account = { botId: 'src-bot', secret: 's', url: 'host:7443' };

function toolWith(runBridge) {
  return createYouduKbTool({ runBridge });
}

test('the tool is named youdu_kb and exposes the parameter schema', () => {
  assert.equal(YOUDU_KB_TOOL, 'youdu_kb');
  assert.equal(youduKbToolParameters.additionalProperties, false);
  assert.deepEqual(youduKbToolParameters.required, ['operation']);
  const tool = createYouduKbTool();
  assert.equal(tool.definition.name, 'youdu_kb');
  assert.equal(typeof tool.definition.execute, 'function');
  assert.equal(typeof tool.definition.output.render, 'function');
});

test('the tool fails closed without a trusted run context (self/foreign session)', async () => {
  const tool = toolWith(async () => ({ ok: true, operation: 'kb.wiki.list', data: {} }));
  const result = await tool.definition.execute({ operation: 'kb.wiki.list' }, exec('unknown-session'));
  assert.equal(result.details.ok, false);
  assert.equal(result.details.error.code, 'YOUDU_IM_CONTEXT_REQUIRED');
});

test('kb.wiki.list is forwarded with the bound account + gids', async () => {
  const { runBridge, req } = fakeBridge({ ok: true, operation: 'kb.wiki.list', data: { wikis: [{ id: 'w1' }] } });
  const tool = toolWith(runBridge);
  bindYouduKbRunContext('sess-1', buildYouduKbRunContext(account, { senderId: 'u42' }));
  try {
    const result = await tool.definition.execute({ operation: 'kb.wiki.list' }, exec('sess-1'));
    assert.equal(result.details.ok, true);
    assert.equal(req.length, 1);
    assert.equal(req[0].operation, 'kb.wiki.list');
    assert.deepEqual(req[0].gids, ['u42']);
    assert.deepEqual(req[0].arguments, {});
    assert.equal(req[0].connection.botId, 'src-bot');
  } finally {
    clearYouduKbRunContext();
  }
});

test('kb.doc.read forwards a docIds batch and the result keeps partial/items', async () => {
  const { runBridge, req } = fakeBridge({
    ok: true,
    operation: 'kb.doc.read',
    items: [{ docId: 'd1', ok: true, content: 'a' }, { docId: 'd2', ok: false, error: { code: 'OPEN_KB_NOT_FOUND' } }],
    stats: { total: 2, succeeded: 1, failed: 1 },
    partial: true,
  });
  const tool = toolWith(runBridge);
  bindYouduKbRunContext('sess-2', buildYouduKbRunContext(account, { senderId: 'u1' }));
  try {
    const result = await tool.definition.execute(
      { operation: 'kb.doc.read', docIds: ['d1', 'd2'], concurrency: 3 },
      exec('sess-2'),
    );
    assert.equal(result.details.ok, true);
    assert.deepEqual(req[0].arguments.docIds, ['d1', 'd2']);
    assert.equal(req[0].arguments.concurrency, 3);
    assert.equal(req[0].arguments.output, 'json');
    assert.equal(result.details.partial, true);
    assert.equal(result.details.items[1].ok, false);
  } finally {
    clearYouduKbRunContext();
  }
});

test('business OPEN_* errors pass through as structured results', async () => {
  const { runBridge } = fakeBridge({ ok: false, operation: 'kb.doc.list', error: { code: 'OPEN_KB_PERMISSION_DENIED', message: 'no access' } });
  const tool = toolWith(runBridge);
  bindYouduKbRunContext('sess-3', buildYouduKbRunContext(account, { senderId: 'u1' }));
  try {
    const result = await tool.definition.execute({ operation: 'kb.doc.list', wikiId: 'w1' }, exec('sess-3'));
    assert.equal(result.details.ok, false);
    assert.equal(result.details.error.code, 'OPEN_KB_PERMISSION_DENIED');
    assert.equal(result.details.error.message, 'no access');
  } finally {
    clearYouduKbRunContext();
  }
});

test('bridge-side codes map to friendly messages and token errors never surface', async () => {
  const { runBridge } = fakeBridge({ ok: false, operation: 'kb.wiki.list', error: { code: 'YOUDU_CLI_NOT_INSTALLED', message: 'raw' } });
  const tool = toolWith(runBridge);
  bindYouduKbRunContext('sess-4', buildYouduKbRunContext(account, { senderId: 'u1' }));
  try {
    const result = await tool.definition.execute({ operation: 'kb.wiki.list' }, exec('sess-4'));
    assert.equal(result.details.error.code, 'YOUDU_CLI_NOT_INSTALLED');
    assert.equal(result.details.error.message, 'The YouDu CLI platform binary is unavailable; reinstall the YouDu plugin');
    const text = result.content[0].text;
    assert.equal(text.includes('super-secret'), false);
    assert.equal(text.includes('src-bot'), false);
  } finally {
    clearYouduKbRunContext();
  }
});

test('invalid tool arguments return YOUDU_KB_INVALID_ARGUMENTS without reaching the bridge', async () => {
  let reached = false;
  const tool = toolWith(async () => { reached = true; return { ok: true, operation: 'kb.wiki.list', data: {} }; });
  bindYouduKbRunContext('sess-5', buildYouduKbRunContext(account, { senderId: 'u1' }));
  try {
    const result = await tool.definition.execute({ operation: 'kb.doc.read', docIds: [] }, exec('sess-5'));
    assert.equal(result.details.ok, false);
    assert.equal(result.details.error.code, 'YOUDU_KB_INVALID_ARGUMENTS');
    assert.equal(reached, false);
  } finally {
    clearYouduKbRunContext();
  }
});

test('an incomplete account yields YOUDU_KB_CONFIG_INVALID', async () => {
  const tool = toolWith(async () => ({ ok: true, operation: 'kb.wiki.list', data: {} }));
  bindYouduKbRunContext('sess-6', buildYouduKbRunContext({ botId: '', secret: '', url: '' }, { senderId: 'u1' }));
  try {
    const result = await tool.definition.execute({ operation: 'kb.wiki.list' }, exec('sess-6'));
    assert.equal(result.details.error.code, 'YOUDU_KB_CONFIG_INVALID');
  } finally {
    clearYouduKbRunContext();
  }
});

test('installYouduKbTool returns false when tool APIs are absent', () => {
  assert.equal(installYouduKbTool({}), false);
  assert.equal(installYouduKbTool({ tools: {}, systemPrompt: {}, on() {} }), false);
});

test('installYouduKbTool registers the tool without a system prompt and clears on session disposal', () => {
  const registered = [];
  const sections = [];
  const disposed = [];
  const ctx = {
    tools: { register: (definition) => registered.push(definition) },
    systemPrompt: { section: (section) => sections.push(section) },
    on: (event, handler) => { if (event === 'session/disposed') disposed.push(handler); },
  };
  assert.equal(installYouduKbTool(ctx), true);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, YOUDU_KB_TOOL);
  assert.equal(registered[0].description, 'Query the current YouDu knowledge base. Use one operation at a time; read documents in one batch.');
  assert.equal(sections.length, 0, 'the tool must not inject a system-prompt section');
  assert.equal(disposed.length, 1);
  bindYouduKbRunContext('sess-x', buildYouduKbRunContext(account, { senderId: 'u1' }));
  bindYouduKbRunContext('sess-y', buildYouduKbRunContext(account, { senderId: 'u2' }));
  disposed[0]({ id: 'sess-x' });
  assert.equal(getYouduKbRunContext('sess-x'), undefined, 'the disposed session must be released');
  assert.equal(getYouduKbRunContext('sess-y')?.gids?.[0], 'u2', 'a different session must keep its context');
  clearYouduKbRunContext();
});
