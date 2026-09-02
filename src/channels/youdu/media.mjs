/**
 * 有度(Youdu) 出站媒体：把 Harness 生成的结果文件上传到有度 CGI，再用媒体帧发送。
 * 移植自 @youdu/openclaw-youdu 的 media.ts（MIT），此处仅保留最小闭环所需。
 */

import { UPLOAD_MEDIA_URL, HTTP_SCHEME } from './const.mjs';

function escapeMultipartHeader(value) {
  return String(value ?? '').replace(/[\r\n"]/g, '_');
}

function sanitizeFileName(name) {
  return String(name ?? 'media.bin')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'media.bin';
}

export function buildMultipartFileBody({ fieldName, fileName, contentType, content }) {
  const boundary = `----youdu-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${escapeMultipartHeader(fieldName)}"; filename="${escapeMultipartHeader(fileName)}"`,
    `Content-Type: ${contentType || 'application/octet-stream'}`,
    '',
    '',
  ].join('\r\n');
  const footer = `\r\n--${boundary}--\r\n`;
  return {
    body: Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function kindFromContentType(contentType) {
  const normalized = String(contentType ?? '').toLowerCase();
  if (normalized === 'image/svg+xml') return 'file';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  return 'file';
}

export function buildMediaMessageBody(media) {
  const payload = {
    mediaId: media.mediaId,
    name: media.name,
    size: media.size,
    width: media.width,
    height: media.height,
    duration: media.duration,
    contentType: media.contentType,
  };
  switch (media.kind) {
    case 'image': return { msgType: 'image', image: payload };
    case 'audio': return { msgType: 'audio', audio: payload };
    case 'video': return { msgType: 'video', video: payload };
    default: return { msgType: 'file', file: payload };
  }
}

function mediaField(payload, key) {
  return payload?.[key] ?? payload?.data?.[key];
}

/**
 * 上传单个结果文件字节到有度，返回媒体附件（含 mediaId/kind/name 等）。
 * @param {{ host:string, token?:string, fileName:string, contentType?:string, content:Buffer, kind?:string }} params
 */
export async function uploadYouduMedia({ host, token, fileName, contentType, content, kind }) {
  const effectiveKind = kind ?? kindFromContentType(contentType);
  const safeName = sanitizeFileName(fileName);
  const form = buildMultipartFileBody({
    fieldName: 'file',
    fileName: safeName,
    contentType,
    content,
  });
  const headers = { 'Content-Type': form.contentType };
  if (token) headers['x-token'] = token;
  const url = `${HTTP_SCHEME}${host}${UPLOAD_MEDIA_URL}?kind=${encodeURIComponent(effectiveKind)}`;
  const response = await fetch(url, { method: 'POST', headers, body: form.body });
  if (!response?.ok) {
    throw new Error(`Youdu upload failed with HTTP ${response?.status ?? 'unknown'}`);
  }
  const payload = JSON.parse(await response.text());
  const mediaId = String(mediaField(payload, 'mediaId') ?? '');
  if (!mediaId) throw new Error('Youdu upload returned no mediaId');
  return {
    kind: effectiveKind,
    mediaId,
    name: String(mediaField(payload, 'name') ?? safeName),
    size: Number(mediaField(payload, 'size') ?? content.length),
    width: Number(mediaField(payload, 'width') ?? 0) || undefined,
    height: Number(mediaField(payload, 'height') ?? 0) || undefined,
    duration: Number(mediaField(payload, 'duration') ?? 0) || undefined,
    contentType: String(mediaField(payload, 'contentType') ?? contentType ?? ''),
  };
}
