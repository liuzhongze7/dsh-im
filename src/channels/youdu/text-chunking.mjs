/**
 * 有度出站文本切分。
 *
 * 有度对单条文本消息有长度上限，超出时服务端不会截断，而是整条消息发不出去；
 * 历史上桥接层因此丢过长回复（旧 openclaw 插件按 TEXT_CHUNK_LIMIT = 4000 切分）。
 * 这里把同一口径收拢成一个纯函数，所有出站文本（回调回复、主动投递、发送工具）都先过它。
 */

/** 单条文本上限（UTF-16 码元数），与旧插件的 TEXT_CHUNK_LIMIT 保持一致。 */
export const YOUDU_TEXT_CHUNK_LIMIT = 4000;

/** 距窗口末尾这么靠后的断点才值得用：太靠前会让每条消息都很短、条数暴涨。 */
const SOFT_BREAK_BUDGET = 0.6;

/**
 * 在一个不超过上限的窗口里挑断点：优先空行（段落），其次换行，再次任意空白。
 * 都没有时按窗口硬切。
 */
function pickBreak(window) {
  const earliest = Math.floor(window.length * SOFT_BREAK_BUDGET);
  const paragraph = window.lastIndexOf('\n\n');
  if (paragraph >= earliest) return paragraph + 2;
  const line = window.lastIndexOf('\n');
  if (line >= earliest) return line + 1;
  for (let index = window.length - 1; index >= earliest; index -= 1) {
    if (/\s/u.test(window[index])) return index + 1;
  }
  return window.length;
}

/** 不能把代理对（emoji 等）劈成两半，否则两条消息都会变成乱码。 */
function safeEnd(window, index) {
  const code = window.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? Math.max(1, index - 1) : index;
}

/**
 * 把文本切成多条都不超过 `limit` 的消息；未超限时原样返回单条。
 * 切点尽量落在段落/换行/空白处，不保证保留 markdown 代码块完整（宁可断开也不丢内容）。
 */
export function splitTextForYoudu(text, limit = YOUDU_TEXT_CHUNK_LIMIT) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  if (!Number.isSafeInteger(limit) || limit <= 0 || source.length <= limit) return [source];

  const chunks = [];
  let start = 0;
  while (start < source.length) {
    if (source.length - start <= limit) {
      chunks.push(source.slice(start));
      break;
    }
    const window = source.slice(start, start + limit);
    const end = safeEnd(window, pickBreak(window));
    const chunk = window.slice(0, end).replace(/\s+$/u, '');
    if (chunk) chunks.push(chunk);
    start += end;
    // 断点后的空行/换行不再重复发送，避免每条消息都以空行开头。
    while (start < source.length && (source[start] === '\n' || source[start] === '\r')) start += 1;
  }
  return chunks.length ? chunks : [source];
}
