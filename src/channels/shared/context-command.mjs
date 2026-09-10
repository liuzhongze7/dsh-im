import { t } from './i18n.mjs';

/**
 * `/context` 命令：查看与清空「群聊上下文缓存」（群里没有 @ 机器人、被暂存下来当上下文的消息）。
 *
 * 与 `/new`（新会话）分工：
 * - `/new`：换一个全新 Harness 会话，顺带清空本群待带入的消息；
 * - `/context clear`：只清空待带入的消息，会话与附件都不动（附件按保留期自然过期）。
 */
const CONTEXT_COMMAND = /^\/context(?=$|\s)/iu;
const CONTEXT_STATUS = /^\/context$/iu;
const CONTEXT_CLEAR = /^\/context\s+clear$/iu;

export function isGroupContextCommand(text) {
  return typeof text === 'string' && CONTEXT_COMMAND.test(text.trim());
}

/** 返回 { action: 'status' | 'clear' | 'usage' }；不是该命令时返回 null。 */
export function parseGroupContextCommand(text) {
  const command = typeof text === 'string' ? text.trim() : '';
  if (!CONTEXT_COMMAND.test(command)) return null;
  if (CONTEXT_STATUS.test(command)) return Object.freeze({ action: 'status' });
  if (CONTEXT_CLEAR.test(command)) return Object.freeze({ action: 'clear' });
  return Object.freeze({ action: 'usage' });
}

export function groupContextUsageText() {
  return [
    t('用法：/context 或 /context clear'),
    '',
    t('/context  查看本群上下文缓存状态'),
    t('/context clear  清空本群待带入的消息'),
  ].join('\n');
}

/** 私聊里没有群聊上下文缓存，给出简短说明而不是把这行命令当成提问。 */
export function groupContextDirectText() {
  return [
    t('群聊上下文缓存只在群聊里生效。'),
    '',
    t('/context  查看本群上下文缓存状态'),
    t('/context clear  清空本群待带入的消息'),
  ].join('\n');
}

/** `/context` 的状态文本：开关与条数、待带入的消息数、已下载/仍在下载的群附件数。 */
export function groupContextStatusText({
  active = false, limit = 0, pending = 0, files = 0, downloading = 0, retentionHours = 0,
} = {}) {
  const lines = [
    active
      ? t('本群上下文缓存：开启 · 最近 {limit} 条', { limit })
      : t('本群上下文缓存：未开启'),
    t('待带入的消息：{count} 条', { count: pending }),
    t('本轮可带入的群附件：{files} 个', { files }),
  ];
  if (downloading > 0) {
    lines.push(t('正在下载的群附件：{count} 个（完成后本轮即可带入）', { count: downloading }));
  }
  lines.push(
    retentionHours < 0
      ? t('附件永久保留，可随时按路径取用。')
      : t('附件按保留期清理（当前 {hours} 小时）。', { hours: retentionHours }),
  );
  if (pending > 0) lines.push('', t('发送 /context clear 清空本群待带入的消息。'));
  return lines.join('\n');
}

/** `/context clear` 的结果文本：只清待带入的消息，附件保持不动。 */
export function groupContextClearedText({ cleared = 0 } = {}) {
  return [
    t('已清空本群待带入的上下文（{count} 条消息）。', { count: cleared }),
    t('已下载的群附件仍保留，按保留期自动清理。'),
  ].join('\n');
}

/** 群聊里 `/new` 的结果文本：新会话同时清空待带入的消息。 */
export function groupContextResetText({ cleared = 0 } = {}) {
  return cleared > 0
    ? t('已开启新会话，并清空本群待带入的上下文（{count} 条消息）。', { count: cleared })
    : t('已开启新会话。请 @ 机器人发送你的问题。');
}
