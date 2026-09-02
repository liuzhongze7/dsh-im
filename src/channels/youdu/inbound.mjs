/**
 * 有度(Youdu)入站消息解析——把 WS 消息帧 body 统一解析为 Harness 可消费的
 * { text, media }。移植自 @youdu/openclaw-youdu 的 media.ts + message-prepare.ts（MIT）。
 *
 * 最小闭环只关注：普通文本（text.content）、图片/文件/语音/视频附件的识别。
 * 引用消息 msgType=10、合并聊天记录 msgType=12 的深度解析预留后续实现。
 */

/** 媒体种类 */
export const MEDIA_KIND = Object.freeze({
  IMAGE: 'image',
  FILE: 'file',
  AUDIO: 'audio',
  VIDEO: 'video',
});

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function kindFromContentType(contentType) {
  const normalized = String(contentType ?? '').toLowerCase();
  if (normalized === 'image/svg+xml') return MEDIA_KIND.FILE;
  if (normalized.startsWith('image/')) return MEDIA_KIND.IMAGE;
  if (normalized.startsWith('audio/')) return MEDIA_KIND.AUDIO;
  if (normalized.startsWith('video/')) return MEDIA_KIND.VIDEO;
  return MEDIA_KIND.FILE;
}

function kindLabel(kind) {
  switch (kind) {
    case MEDIA_KIND.IMAGE: return '[图片]';
    case MEDIA_KIND.AUDIO: return '[语音]';
    case MEDIA_KIND.VIDEO: return '[视频]';
    default: return '[文件]';
  }
}

function pushMedia(items, kind, node) {
  if (!node?.mediaId) return;
  items.push({
    kind,
    mediaId: node.mediaId,
    name: clean(node.name) ?? undefined,
    size: typeof node.size === 'number' ? node.size : undefined,
    width: typeof node.width === 'number' ? node.width : undefined,
    height: typeof node.height === 'number' ? node.height : undefined,
    duration: typeof node.duration === 'number' ? node.duration : undefined,
    contentType: clean(node.contentType) ?? undefined,
  });
}

/** 从 body 顶层提取媒体附件（image/file/audio/video + media[]）。 */
export function extractInboundMedia(body) {
  const items = [];
  const fallbackKindFromBody = (() => {
    const msgType = String(body.msgType ?? '').toLowerCase();
    if (msgType === 'image' || body.image?.mediaId) return MEDIA_KIND.IMAGE;
    if (msgType === 'audio' || body.audio?.mediaId) return MEDIA_KIND.AUDIO;
    if (msgType === 'video' || body.video?.mediaId) return MEDIA_KIND.VIDEO;
    if (msgType === 'file' || body.file?.mediaId) return MEDIA_KIND.FILE;
    return undefined;
  })();

  for (const media of body.media ?? []) {
    if (!media?.mediaId) continue;
    const kind = String(media.kind ?? '').toLowerCase();
    if (kind === MEDIA_KIND.IMAGE || kind === MEDIA_KIND.AUDIO || kind === MEDIA_KIND.VIDEO) {
      pushMedia(items, kind, media);
      continue;
    }
    if (!kind && fallbackKindFromBody) {
      pushMedia(items, fallbackKindFromBody, media);
      continue;
    }
    pushMedia(items, MEDIA_KIND.FILE, media);
  }
  if (items.length > 0) return items;
  pushMedia(items, MEDIA_KIND.IMAGE, body.image);
  pushMedia(items, MEDIA_KIND.FILE, body.file);
  pushMedia(items, MEDIA_KIND.AUDIO, body.audio);
  pushMedia(items, MEDIA_KIND.VIDEO, body.video);
  return items;
}

/** 从 body 推断 AI 可读的文本（无正文时返回媒体占位）。 */
export function inferInboundMessageText(body) {
  const text = clean(body.text?.content);
  if (text) return text;
  const media = extractInboundMedia(body);
  if (media.length === 0) return '';
  const first = media[0];
  return first.name ? `${kindLabel(first.kind)} ${first.name}` : kindLabel(first.kind);
}

/**
 * 统一入站解析结果。
 * @returns {{ text: string, media: Array, msgType?: string, rawDecoded?: unknown }}
 */
export function parseInboundMessage(body) {
  const text = inferInboundMessageText(body);
  const media = extractInboundMedia(body);
  const processed = {};
  if (body?.msgType !== undefined) processed.msgType = body.msgType;
  if (body?.raw?.decoded !== undefined) processed.rawDecoded = body.raw.decoded;
  return { text, media, ...processed };
}
