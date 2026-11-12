import assert from 'node:assert/strict';
import test from 'node:test';

import {
  YOUDU_TEXT_CHUNK_LIMIT,
  splitTextForYoudu,
} from '../../../src/channels/youdu/text-chunking.mjs';

test('short text stays in a single message', () => {
  assert.deepEqual(splitTextForYoudu('你好'), ['你好']);
  assert.deepEqual(splitTextForYoudu(''), ['']);
  assert.deepEqual(splitTextForYoudu('x'.repeat(YOUDU_TEXT_CHUNK_LIMIT)), ['x'.repeat(YOUDU_TEXT_CHUNK_LIMIT)]);
});

test('long text is split into messages that never exceed the limit', () => {
  const paragraphs = Array.from({ length: 40 }, (_, index) => `第 ${index} 段：${'内容'.repeat(60)}`);
  const text = paragraphs.join('\n\n');
  const chunks = splitTextForYoudu(text);
  assert.ok(chunks.length > 1, '长文本必须切分');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= YOUDU_TEXT_CHUNK_LIMIT, `chunk too long: ${chunk.length}`);
    assert.ok(chunk.trim().length > 0, '不能产生空消息');
  }
  const rejoined = chunks.join('');
  assert.equal(rejoined, text, '切分不能丢内容，拼接必须等于原文');
});

test('the split prefers paragraph boundaries over hard cuts', () => {
  const text = `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`;
  const chunks = splitTextForYoudu(text);
  // 段落间的空行留在前一片末尾，逐片拼接仍是原文。
  assert.equal(chunks[0], `${'a'.repeat(3000)}\n\n`);
  assert.equal(chunks[1], 'b'.repeat(3000));
  assert.equal(chunks.join(''), text);
});

test('the split falls back to line breaks and whitespace when no paragraph fits', () => {
  const lines = Array.from({ length: 200 }, (_, index) => `line ${index} ${'z'.repeat(20)}`);
  const chunks = splitTextForYoudu(lines.join('\n'), 500);
  for (const chunk of chunks) assert.ok(chunk.length <= 500);
  assert.ok(chunks.every((chunk) => chunk.startsWith('line ')), '每条都应从行首开始');
  assert.equal(chunks.join(''), lines.join('\n'));

  const words = Array.from({ length: 400 }, (_, index) => `word${index}`).join(' ');
  const wordChunks = splitTextForYoudu(words, 200);
  for (const chunk of wordChunks) assert.ok(chunk.length <= 200);
  assert.ok(wordChunks.every((chunk) => /^word\d/.test(chunk) && /word\d/.test(chunk)), '不能把单词劈开');
  assert.equal(wordChunks.join(''), words, '空白不能在切点处丢失');
});

test('the split never cuts a surrogate pair in half', () => {
  const text = '😀'.repeat(3000);
  const chunks = splitTextForYoudu(text, 1000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.equal(/[\uD800-\uDBFF]$/.test(chunk), false, 'chunk must not end with a lone high surrogate');
    assert.equal(/^[\uDC00-\uDFFF]/.test(chunk), false, 'chunk must not start with a lone low surrogate');
    assert.equal(chunk.length <= 1000, true);
  }
});

test('an unusable limit keeps the text in one message', () => {
  const text = 'x'.repeat(10);
  assert.deepEqual(splitTextForYoudu(text, 0), [text]);
  assert.deepEqual(splitTextForYoudu(text, -1), [text]);
  assert.deepEqual(splitTextForYoudu(text, 1.5), [text]);
});
