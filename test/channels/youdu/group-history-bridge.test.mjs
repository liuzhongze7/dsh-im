import assert from 'node:assert/strict';
import test from 'node:test';

import { YouduBridge } from '../../../src/channels/youdu/youdu-bridge.mjs';

function stateFixture(initialSessions = []) {
  const sessions = new Map(initialSessions);
  const seen = new Set();
  const state = {
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => seen.add(id),
    sessionFor: (key) => sessions.get(key) ?? null,
    setSession: async (key, sessionId) => sessions.set(key, sessionId),
    clearSession: async (key) => sessions.delete(key),
  };
  return { state, sessions, seen };
}

function frame(messageId, text, overrides = {}) {
  const body = {
    msgId: messageId,
    chatId: 'chat-1',
    chatType: 'single',
    from: { userId: 'owner-1', name: 'Owner' },
    msgType: 'text',
    text: { content: text },
    ...overrides,
  };
  return { headers: { reqId: `req-${messageId}` }, body };
}

function groupFrame(messageId, text, {
  chatId = 'g-1', userId = 'member-1', name = '成员一', account, atUser = [], createTime = 1_700_000_000_000,
} = {}) {
  return frame(messageId, text, {
    chatId,
    chatType: 'group',
    from: { userId, name, ...(account ? { account } : {}) },
    createTime,
    raw: { decoded: { msgType: 0, atUser } },
  });
}

function makeBot(sent = []) {
  return {
    sendReply: async (target, text) => sent.push({ target, text }),
    sendMessage: async () => {},
    downloadMedia: async () => Buffer.from('x'),
  };
}

function baseHarness({ contents = [], gate } = {}) {
  return {
    ensureRunning: async () => true,
    sessionExists: async () => true,
    createSession: async () => 'session-id',
    ask: async (sessionId, content) => {
      contents.push(content);
      if (gate) await gate;
      return 'mock answer';
    },
  };
}

function bridgeWith(harness, options = {}) {
  const { state } = stateFixture();
  return new YouduBridge({
    bot: makeBot([]),
    harness,
    state,
    ownerUserId: '*',
    botId: 'bot-1',
    groupResponseMode: 'mention',
    ...options,
  });
}

test('group messages that did not address the bot become context for the next mention', async () => {
  const contents = [];
  const bridge = bridgeWith(baseHarness({ contents }));
  await bridge.accept(groupFrame('h-1', '下午三点评审', { userId: 'm-1', name: '张三', createTime: 1_700_000_000_000 }));
  await bridge.accept(groupFrame('h-2', '我参加', { userId: 'm-2', name: '李四', createTime: 1_700_000_060_000 }));
  await bridge.accept(groupFrame('h-3', '会议室 A', { userId: 'm-3', name: '王五', createTime: 1_700_000_120_000 }));
  assert.equal(contents.length, 0, 'messages without a mention must not reach the model');

  await bridge.accept(groupFrame('ask-1', '帮我整理一下', { atUser: ['bot-1'], createTime: 1_700_000_180_000 }));
  assert.equal(contents.length, 1);
  const content = contents[0];
  assert.match(content, /^<dsh_im_group_history note="[^"]+">/);
  assert.match(content, /\n<\/dsh_im_group_history>\n\n\[Current message - respond to this\]\n帮我整理一下$/);
  assert.match(content, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 张三: 下午三点评审/);
  assert.match(content, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 李四: 我参加/);
  assert.match(content, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 王五: 会议室 A/);
  // 旧到新：第一条在最前，最后一条最靠近当前消息。
  assert.equal(content.indexOf('张三') < content.indexOf('李四'), true);
  assert.equal(content.indexOf('李四') < content.indexOf('王五'), true);

  // 回合结束后上下文被消费：下一条 @ 消息不再重复带上同一批群消息。
  await bridge.accept(groupFrame('ask-2', '再来一次', { atUser: ['bot-1'], createTime: 1_700_000_240_000 }));
  assert.equal(contents.length, 2);
  assert.equal(contents[1], '再来一次');
});

test('the mention that triggered the turn is not stored as context itself', async () => {
  const contents = [];
  const bridge = bridgeWith(baseHarness({ contents }));
  await bridge.accept(groupFrame('ask-1', '第一条 @', { atUser: ['bot-1'] }));
  await bridge.accept(groupFrame('ask-2', '第二条 @', { atUser: ['bot-1'] }));
  assert.deepEqual(contents, ['第一条 @', '第二条 @']);
});

test('messages that arrive while the turn runs stay for the next turn', async () => {
  const contents = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = bridgeWith(baseHarness({ contents, gate }));
  await bridge.accept(groupFrame('h-1', '开工前的讨论', { userId: 'm-1', name: '张三' }));
  const turn = bridge.accept(groupFrame('ask-1', '开始吧', { atUser: ['bot-1'] }));
  // 等到回合确实开始（快照已取走）以后再让群里继续说话。
  while (contents.length === 0) await new Promise((resolve) => { setImmediate(resolve); });
  // accept 里同步记录这条消息，但它要排队等当前回合结束才被处理。
  const queued = bridge.accept(groupFrame('h-2', '补充一句', { userId: 'm-2', name: '李四' }));
  release();
  await turn;
  await queued;
  assert.match(contents[0], /开工前的讨论/);

  await bridge.accept(groupFrame('ask-2', '继续', { atUser: ['bot-1'] }));
  assert.match(contents[1], /补充一句/);
  assert.equal(contents[1].includes('开工前的讨论'), false, 'consumed context must not be injected twice');
});

test('only the newest messages within the configured limit are injected', async () => {
  const contents = [];
  const bridge = bridgeWith(baseHarness({ contents }), { groupHistory: { enabled: true, limit: 2 } });
  for (let index = 1; index <= 4; index += 1) {
    await bridge.accept(groupFrame(`h-${index}`, `消息${index}`, { userId: `m-${index}`, name: `成员${index}` }));
  }
  await bridge.accept(groupFrame('ask-1', '总结', { atUser: ['bot-1'] }));
  const content = contents[0];
  assert.equal(content.includes('消息4'), true);
  assert.equal(content.includes('消息3'), true);
  assert.equal(content.includes('消息2'), false);
  assert.equal(content.includes('消息1'), false);
});

test('a disabled cache neither stores group messages nor injects one', async () => {
  for (const groupHistory of [{ enabled: false, limit: 50 }, { enabled: true, limit: 0 }]) {
    const contents = [];
    const bridge = bridgeWith(baseHarness({ contents }), { groupHistory });
    await bridge.accept(groupFrame('h-1', '不应缓存', { userId: 'm-1', name: '张三' }));
    await bridge.accept(groupFrame('ask-1', '在吗', { atUser: ['bot-1'] }));
    assert.deepEqual(contents, ['在吗'], `unexpected content for ${JSON.stringify(groupHistory)}`);
  }
});

test('a sender the group allowlist rejects is not cached, while an allowed mention still works', async () => {
  const contents = [];
  const sent = [];
  const bridge = bridgeWith(baseHarness({ contents }), {
    bot: makeBot(sent),
    groupAccess: {
      getSettings: () => ({ version: 1, groups: { 'g-1': { mode: 'allowlist', users: ['owner-1'] } } }),
    },
  });
  await bridge.accept(groupFrame('h-1', '名单外的消息', { userId: 'm-9', name: '路人' }));
  await bridge.accept(groupFrame('ask-1', '在吗', { userId: 'owner-1', name: 'Owner', atUser: ['bot-1'] }));
  assert.deepEqual(contents, ['在吗'], 'a rejected sender must not leak into the injected context');
});

test('a disabled group neither reaches the model nor caches its messages', async () => {
  const contents = [];
  const sent = [];
  const state = stateFixture();
  const bridge = new YouduBridge({
    bot: makeBot(sent),
    harness: baseHarness({ contents }),
    state: state.state,
    ownerUserId: '*',
    botId: 'bot-1',
    groupAccess: {
      getSettings: () => ({ version: 1, groups: { 'g-1': { mode: 'disabled' } } }),
    },
  });
  await bridge.accept(groupFrame('h-1', '这个群被关掉了', { userId: 'm-1', name: '张三' }));
  await bridge.accept(groupFrame('ask-1', '在吗', { atUser: ['bot-1'] }));
  assert.deepEqual(contents, []);
  assert.deepEqual(sent, []);
  assert.equal(bridge.status.messagesRejected, 1);
});

test('a per-group allowlist only caches members it allows', async () => {
  const contents = [];
  const bridge = bridgeWith(baseHarness({ contents }), {
    groupAccess: {
      getSettings: () => ({ version: 1, groups: { 'g-1': { mode: 'allowlist', users: ['zhangsan'] } } }),
    },
  });
  await bridge.accept(groupFrame('h-1', '名单内成员', { userId: '10086', account: 'zhangsan', name: '张三' }));
  await bridge.accept(groupFrame('h-2', '名单外成员', { userId: '10087', account: 'luren', name: '路人' }));
  await bridge.accept(groupFrame('ask-1', '在吗', {
    userId: '10086', account: 'zhangsan', name: '张三', atUser: ['bot-1'],
  }));
  assert.match(contents[0], /名单内成员/);
  assert.equal(contents[0].includes('名单外成员'), false);
});

test('the direct chat path never carries group context', async () => {
  const contents = [];
  const bridge = bridgeWith(baseHarness({ contents }));
  await bridge.accept(frame('g-1', '群里没 @ 的消息', {
    chatId: 'g-1', chatType: 'group', from: { userId: 'm-1', name: '张三' },
    raw: { decoded: { msgType: 0, atUser: [] } },
  }));
  await bridge.accept(frame('d-1', '私聊消息', { from: { userId: 'owner-1', name: 'Owner' } }));
  assert.deepEqual(contents, ['私聊消息']);
});

test('a live settings provider changes behaviour without reconnecting the bot', async () => {
  const contents = [];
  let settings = { enabled: true, limit: 50 };
  const bridge = bridgeWith(baseHarness({ contents }), {
    groupHistory: { botId: 'bot-1', getSettings: () => settings },
  });
  await bridge.accept(groupFrame('h-1', '开启时的消息', { userId: 'm-1', name: '张三' }));
  await bridge.accept(groupFrame('ask-1', '第一次', { atUser: ['bot-1'] }));
  assert.match(contents[0], /开启时的消息/);

  settings = { enabled: false, limit: 50 };
  await bridge.accept(groupFrame('h-2', '关闭后的消息', { userId: 'm-1', name: '张三' }));
  await bridge.accept(groupFrame('ask-2', '第二次', { atUser: ['bot-1'] }));
  assert.equal(contents[1], '第二次');

  settings = { enabled: true, limit: 50 };
  await bridge.accept(groupFrame('ask-3', '第三次', { atUser: ['bot-1'] }));
  assert.equal(contents[2], '第三次', 'a re-enabled cache must not resurrect messages from the disabled window');
});

test('a settings provider that throws fails closed', async () => {
  const contents = [];
  const bridge = bridgeWith(baseHarness({ contents }), {
    groupHistory: { botId: 'bot-1', getSettings: () => { throw new Error('settings unavailable'); } },
  });
  await bridge.accept(groupFrame('h-1', '不应缓存', { userId: 'm-1', name: '张三' }));
  await bridge.accept(groupFrame('ask-1', '在吗', { atUser: ['bot-1'] }));
  assert.deepEqual(contents, ['在吗']);
});

test('redelivered group messages are not buffered twice', async () => {
  const contents = [];
  const bridge = bridgeWith(baseHarness({ contents }));
  await bridge.accept(groupFrame('h-1', '只应出现一次', { userId: 'm-1', name: '张三' }));
  await bridge.accept(groupFrame('h-1', '只应出现一次', { userId: 'm-1', name: '张三' }));
  await bridge.accept(groupFrame('ask-1', '在吗', { atUser: ['bot-1'] }));
  assert.equal(contents[0].match(/只应出现一次/g).length, 1);
});

test('group context and the context-enhancement source block coexist', async () => {
  const contents = [];
  const bridge = bridgeWith(baseHarness({ contents }), {
    contextEnhancement: {
      botId: 'bot-1',
      getSettings: () => ({
        group: { enabled: true, fields: ['channel', 'senderName'], guidance: '' },
        direct: { enabled: false, fields: [], guidance: '' },
      }),
    },
  });
  await bridge.accept(groupFrame('h-1', '讨论内容', { userId: 'm-1', name: '张三' }));
  await bridge.accept(groupFrame('ask-1', '总结', { atUser: ['bot-1'] }));
  const content = contents[0];
  assert.match(content, /^<dsh_im_group_history/);
  assert.match(content, /<dsh_im_source>\{"channel":"youdu","senderName":"成员一"\}<\/dsh_im_source>/);
  assert.match(content, /\[Current message - respond to this\]\n<dsh_im_source>/);
});

/** 群里未寻址的多媒体消息：只带 media 节点，没有可用正文。 */
function mediaGroupFrame(messageId, { text = '', ...body } = {}) {
  return frame(messageId, text, {
    chatId: 'g-1',
    chatType: 'group',
    from: { userId: '10086', name: '张三' },
    createTime: 1_700_000_000_000,
    raw: { decoded: { msgType: 0, atUser: [] } },
    ...body,
  });
}

function mergedForwardFrame(messageId) {
  const line = (payload) => Buffer.from(JSON.stringify(payload)).toString('base64');
  return mediaGroupFrame(messageId, {
    msgType: 12,
    raw: {
      decoded: {
        msgType: 12,
        title: '聊天记录',
        list: [
          { sender: 2, senderName: '李四', sendTime: 1_700_000_000_000, content: line({ text: [{ txt: '见附件' }] }) },
          {
            sender: 2,
            senderName: '李四',
            sendTime: 1_700_000_100_000,
            content: line({ msgType: 3, id: 'f-1', name: 'spec.pdf', size: 20_480 }),
          },
        ],
      },
    },
  });
}

test('group media is cached as a text placeholder and never downloaded', async () => {
  const contents = [];
  const downloads = [];
  const bridge = new YouduBridge({
    bot: {
      ...makeBot([]),
      downloadMedia: async (media) => { downloads.push(media); return Buffer.from('x'); },
    },
    harness: baseHarness({ contents }),
    state: stateFixture().state,
    ownerUserId: '*',
    botId: 'bot-1',
    groupResponseMode: 'mention',
    groupHistory: { enabled: true, limit: 50 },
  });

  await bridge.accept(mediaGroupFrame('m-image', { image: { mediaId: 'media-img', name: 'photo.png' } }));
  await bridge.accept(mediaGroupFrame('m-file', { file: { mediaId: 'media-file', name: 'report.pdf', size: 12_345 } }));
  await bridge.accept(mediaGroupFrame('m-audio', { msgType: 'audio', media: [{ mediaId: 'media-audio', name: 'voice.amr' }] }));
  // 带文字说明的图片：正文优先，不额外标注附件（与 openclaw 一致）。
  await bridge.accept(mediaGroupFrame('m-captioned', { text: '看下这张图', image: { mediaId: 'media-img2', name: 'chart.png' } }));

  await bridge.accept(groupFrame('ask-1', '帮我看看', { atUser: ['bot-1'] }));
  const block = contents[0];
  assert.match(block, /张三: \[图片\] photo\.png/);
  assert.match(block, /张三: \[文件\] report\.pdf/);
  assert.match(block, /张三: \[语音\] voice\.amr/);
  assert.match(block, /张三: 看下这张图\n/);
  assert.equal(block.includes('chart.png'), false, 'a captioned attachment is not annotated separately');
  assert.equal(block.includes('media-img'), false, 'no media id may leak into the prompt');
  assert.deepEqual(downloads, [], 'unaddressed group media must never be fetched');
});

test('a forwarded chat record keeps its placeholder lines and still downloads nothing', async () => {
  const contents = [];
  const downloads = [];
  const bridge = new YouduBridge({
    bot: {
      ...makeBot([]),
      downloadMedia: async (media) => { downloads.push(media); return Buffer.from('x'); },
    },
    harness: baseHarness({ contents }),
    state: stateFixture().state,
    ownerUserId: '*',
    botId: 'bot-1',
    groupResponseMode: 'mention',
    groupHistory: { enabled: true, limit: 50 },
  });

  await bridge.accept(mergedForwardFrame('m-merged'));
  await bridge.accept(groupFrame('ask-1', '总结', { atUser: ['bot-1'] }));
  assert.match(contents[0], /\[文件: spec\.pdf\] \(20\.0KB\)/);
  assert.match(contents[0], /聊天记录/);
  assert.deepEqual(downloads, []);
});

/** 模拟“单独接口下载到临时目录”的 provider：记录调用并返回工作区相对路径。 */
function stagingFixture({ fail = false, delayMs = 0 } = {}) {
  const calls = [];
  const loaded = [];
  return {
    calls,
    loaded,
    async stage({ chatId, messageId, files }) {
      calls.push({ chatId, messageId, names: files.map((file) => file.name) });
      for (const file of files) loaded.push(await file.load({ signal: undefined }));
      if (delayMs > 0) await new Promise((resolve) => { setTimeout(resolve, delayMs); });
      if (fail) throw new Error('download failed');
      return {
        files: files.map((file, index) => ({
          name: file.name,
          path: `.dsh-im/group-context/${chatId}/${messageId}/0${index + 1}-${file.name}`,
        })),
        directory: `D:\\workspace\\.dsh-im\\group-context\\${chatId}\\${messageId}`,
      };
    },
  };
}

test('group attachments are downloaded through the media interface and listed for the model', async () => {
  const contents = [];
  const downloads = [];
  const staging = stagingFixture();
  const bridge = new YouduBridge({
    bot: {
      ...makeBot([]),
      downloadMedia: async (media) => {
        downloads.push(media.mediaId);
        return Buffer.from(`bytes-of-${media.mediaId}`);
      },
    },
    harness: baseHarness({ contents }),
    state: stateFixture().state,
    ownerUserId: '*',
    botId: 'bot-1',
    groupResponseMode: 'mention',
    groupHistory: { enabled: true, limit: 50 },
    groupContextFiles: staging,
  });

  await bridge.accept(mediaGroupFrame('m-image', {
    image: { mediaId: 'media-img', name: 'photo.png' },
    createTime: 1_700_000_000_000,
  }));
  await bridge.accept(groupFrame('ask-1', '这张图什么意思', { atUser: ['bot-1'] }));

  assert.deepEqual(staging.calls, [{ chatId: 'g-1', messageId: 'm-image', names: ['photo.png'] }]);
  assert.deepEqual(downloads, ['media-img']);
  assert.deepEqual(staging.loaded, [Buffer.from('bytes-of-media-img')]);
  const content = contents[0];
  assert.match(content, /张三: \[图片\] photo\.png\n/);
  assert.match(content, /<dsh_im_group_files>\n/u);
  const payload = JSON.parse(content.split('\n').find((line) => line.startsWith('{"description"')));
  assert.deepEqual(payload.files, [{
    name: 'photo.png',
    path: '.dsh-im/group-context/g-1/m-image/01-photo.png',
    sender: '张三',
    time: payload.files[0].time,
  }]);
  // 块顺序：历史 → 附件清单 → 当前消息标记 → 当前正文。
  assert.equal(content.indexOf('<dsh_im_group_history') < content.indexOf('<dsh_im_group_files>'), true);
  assert.equal(content.indexOf('<dsh_im_group_files>') < content.indexOf('[Current message - respond to this]'), true);
  assert.equal(content.endsWith('\n这张图什么意思'), true);
});

test('the injection waits for an in-flight attachment download before building the prompt', async () => {
  const contents = [];
  const staging = stagingFixture({ delayMs: 30 });
  const bridge = new YouduBridge({
    bot: { ...makeBot([]), downloadMedia: async () => Buffer.from('bytes') },
    harness: baseHarness({ contents }),
    state: stateFixture().state,
    ownerUserId: '*',
    botId: 'bot-1',
    groupResponseMode: 'mention',
    groupHistory: { enabled: true, limit: 50 },
    groupContextFiles: staging,
    groupHistoryStagingWaitMs: 1_000,
  });

  await bridge.accept(mediaGroupFrame('m-file', { file: { mediaId: 'media-file', name: 'spec.pdf' } }));
  await bridge.accept(groupFrame('ask-1', '看看附件', { atUser: ['bot-1'] }));
  assert.match(contents[0], /01-spec\.pdf/u);
});

test('a slow attachment download degrades to the text placeholder after the bounded wait', async () => {
  const contents = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const staging = {
    async stage() {
      await gate;
      return { files: [{ name: 'late.pdf', path: '.dsh-im/group-context/g-1/m-file/01-late.pdf' }] };
    },
  };
  const bridge = new YouduBridge({
    bot: { ...makeBot([]), downloadMedia: async () => Buffer.from('bytes') },
    harness: baseHarness({ contents }),
    state: stateFixture().state,
    ownerUserId: '*',
    botId: 'bot-1',
    groupResponseMode: 'mention',
    groupHistory: { enabled: true, limit: 50 },
    groupContextFiles: staging,
    groupHistoryStagingWaitMs: 20,
  });

  await bridge.accept(mediaGroupFrame('m-file', { file: { mediaId: 'media-file', name: 'late.pdf' } }));
  await bridge.accept(groupFrame('ask-1', '看看附件', { atUser: ['bot-1'] }));
  assert.match(contents[0], /\[文件\] late\.pdf/u, 'the placeholder is still there');
  assert.equal(contents[0].includes('<dsh_im_group_files>'), false, 'no manifest without staged paths');
  release();
});

test('a failed attachment download keeps the text placeholder and never breaks the turn', async () => {
  const contents = [];
  const staging = stagingFixture({ fail: true });
  const bridge = new YouduBridge({
    bot: { ...makeBot([]), downloadMedia: async () => { throw new Error('socket closed'); } },
    harness: baseHarness({ contents }),
    state: stateFixture().state,
    ownerUserId: '*',
    botId: 'bot-1',
    groupResponseMode: 'mention',
    groupHistory: { enabled: true, limit: 50 },
    groupContextFiles: staging,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });

  await bridge.accept(mediaGroupFrame('m-image', { image: { mediaId: 'media-img', name: 'photo.png' } }));
  await bridge.accept(groupFrame('ask-1', '在吗', { atUser: ['bot-1'] }));
  assert.equal(contents.length, 1);
  assert.match(contents[0], /张三: \[图片\] photo\.png\n/);
  assert.equal(contents[0].includes('<dsh_im_group_files>'), false, 'no manifest without staged paths');
  assert.equal(contents[0].endsWith('\n在吗'), true);
  assert.equal(staging.calls.length, 1);
});

test('nothing is downloaded for denied groups, disabled caches or direct chats', async () => {
  const contents = [];
  const staging = stagingFixture();
  const downloads = [];
  const bot = {
    ...makeBot([]),
    downloadMedia: async (media) => { downloads.push(media.mediaId); return Buffer.from('x'); },
  };
  const denied = new YouduBridge({
    bot,
    harness: baseHarness({ contents }),
    state: stateFixture().state,
    ownerUserId: '*',
    botId: 'bot-1',
    groupResponseMode: 'mention',
    groupHistory: { enabled: true, limit: 50 },
    groupContextFiles: staging,
    groupAccess: { getSettings: () => ({ version: 1, groups: { 'g-1': { mode: 'disabled' } } }) },
  });
  await denied.accept(mediaGroupFrame('m-denied', { image: { mediaId: 'media-denied', name: 'a.png' } }));

  const disabledCache = new YouduBridge({
    bot,
    harness: baseHarness({ contents }),
    state: stateFixture().state,
    ownerUserId: '*',
    botId: 'bot-1',
    groupResponseMode: 'mention',
    groupHistory: { enabled: true, limit: 0 },
    groupContextFiles: staging,
  });
  await disabledCache.accept(mediaGroupFrame('m-off', { image: { mediaId: 'media-off', name: 'b.png' } }));

  const direct = new YouduBridge({
    bot,
    harness: baseHarness({ contents }),
    state: stateFixture().state,
    ownerUserId: '*',
    botId: 'bot-1',
    groupContextFiles: staging,
  });
  await direct.accept(frame('m-direct', '', {
    from: { userId: 'owner-1', name: 'Owner' },
    image: { mediaId: 'media-direct', name: 'c.png' },
  }));

  assert.deepEqual(staging.calls, [], 'only cached group messages may use the group context store');
  // 私聊图片仍走原有的提示链路（下载交给 Harness 的入站文件管线），与群聊上下文缓存无关。
  assert.deepEqual(downloads, ['media-direct']);
});

test('a quoted image is cached by its name, not by its bytes', async () => {  const contents = [];
  const downloads = [];
  const bridge = new YouduBridge({
    bot: {
      ...makeBot([]),
      downloadMedia: async (media) => { downloads.push(media); return Buffer.from('x'); },
    },
    harness: baseHarness({ contents }),
    state: stateFixture().state,
    ownerUserId: '*',
    botId: 'bot-1',
    groupResponseMode: 'mention',
    groupHistory: { enabled: true, limit: 50 },
  });

  await bridge.accept(frame('quote-1', '', {
    chatId: 'g-1',
    chatType: 'group',
    from: { userId: '10087', name: '李四' },
    createTime: 1_700_000_300_000,
    raw: {
      decoded: {
        msgType: 10,
        atUser: [],
        text: [{ txt: '这张图什么意思' }],
        reference: {
          sender: 10086,
          senderName: '张三',
          time: 1_700_000_000_000,
          text: [{ img: { id: 'ref-img', name: 'shot.png' } }],
        },
      },
    },
  }));
  await bridge.accept(groupFrame('ask-1', '总结', { atUser: ['bot-1'] }));

  assert.match(contents[0], /被回复的消息（发送者: 张三/);
  assert.match(contents[0], /\[图片: shot\.png\]/);
  assert.equal(contents[0].includes('ref-img'), false);
  assert.deepEqual(downloads, []);
});
