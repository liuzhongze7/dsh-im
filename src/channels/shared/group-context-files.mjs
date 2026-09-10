import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  InboundFileError,
  displayFileName,
  parseInboundDirectoryName,
  storageFileName,
} from './inbound-file.mjs';

/**
 * 群聊上下文附件：把群里未寻址消息携带的图片/文件，用与提示链路相同的媒体接口
 * 下载下来，落到机器人工作区的临时目录，供模型在被 @ 的那一轮按相对路径读取。
 *
 * 目录形如 `<workspace>/.dsh-im/group-context/<群>/<yyyyMMdd-HHmmss>-<消息id>/01-名字`：
 * 群一层便于人工翻找，消息一层带时间戳便于按保留期清理，也与 `inbound` 的命名口径一致。
 */
export const GROUP_CONTEXT_DIRECTORY = join('.dsh-im', 'group-context');
/** 消息目录里记录“谁、什么时候、发了哪些文件”的旁挂文件，供清单重建（重启后也能读到）。 */
export const GROUP_CONTEXT_META_FILE = '.meta.json';
/** 默认保留 7 天；-1 表示永久保留，0 表示下一次清理即删除。 */
export const DEFAULT_GROUP_CONTEXT_RETENTION_HOURS = 24 * 7;
export const KEEP_GROUP_CONTEXT_FOREVER = -1;
export const DEFAULT_GROUP_CONTEXT_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;
/** 每次注入清单时最多列出最近多少条群消息的附件。 */
export const DEFAULT_GROUP_CONTEXT_RECENT_LIMIT = 10;
export const MAX_CHAT_DIRECTORY_CHARS = 60;
export const MAX_MESSAGE_DIRECTORY_CHARS = 40;

// 有度的群 id 形如 `{0798E01E-CD68-42BB-813C-EB51593BB0F5}`，花括号在路径里合法，
// 保留下来便于照着有度客户端的会话 id 直接翻目录；其余不安全字符一律换成下划线。
const SEGMENT_UNSAFE = /[^\p{L}\p{N}._\-{}]/gu;

function directorySegment(value, fallback, maxChars) {
  const cleaned = (typeof value === 'string' ? value : '')
    .replace(SEGMENT_UNSAFE, '_')
    .replace(/^\.+/, '')
    .slice(0, maxChars);
  return cleaned || fallback;
}

/** 群标识 → 目录名（有度的群 id 含花括号等字符，必须净化后才能当路径）。 */
export function groupContextChatSegment(chatId) {
  return directorySegment(chatId, 'chat', MAX_CHAT_DIRECTORY_CHARS);
}

function padded(value) {
  return String(value).padStart(2, '0');
}

/** 消息目录名：`yyyyMMdd-HHmmss-<消息id>`，前缀供清理逻辑解析时间。 */
export function groupContextMessageSegment(messageId, now = new Date()) {
  const stamp = `${now.getFullYear()}${padded(now.getMonth() + 1)}${padded(now.getDate())}`
    + `-${padded(now.getHours())}${padded(now.getMinutes())}${padded(now.getSeconds())}`;
  const id = directorySegment(messageId, 'message', MAX_MESSAGE_DIRECTORY_CHARS);
  return `${stamp}-${id}`;
}

/** 保留期归一化：非整数按默认值，任何负数都视为永久保留。 */
export function normalizeGroupContextRetention(value, fallback = DEFAULT_GROUP_CONTEXT_RETENTION_HOURS) {
  if (typeof value === 'number' && value < 0) return KEEP_GROUP_CONTEXT_FOREVER;
  if (Number.isInteger(value) && value >= 0) return value;
  return fallback;
}

function loadedFile(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { data: Buffer.from(value) };
  }
  const raw = value?.data ?? value?.buffer;
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    return {
      data: Buffer.from(raw),
      name: value?.name ?? value?.filename,
      mediaType: value?.mediaType ?? value?.mimetype,
    };
  }
  const stream = value?.stream ?? value;
  if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
    return {
      stream,
      name: value?.name ?? value?.filename,
      mediaType: value?.mediaType ?? value?.mimetype,
    };
  }
  return null;
}

/**
 * 删除过期的群聊上下文附件目录。只处理名字能解析出 `yyyyMMdd-HHmmss` 的消息目录，
 * 正在下载的目录（isTracked 命中）一律跳过；空掉的群目录会被顺手清掉。
 */
export async function sweepGroupContextFiles(workspace, retentionHours, {
  now = () => new Date(),
  isTracked,
} = {}) {
  if (typeof workspace !== 'string' || !workspace) {
    throw new TypeError('sweepGroupContextFiles requires a workspace');
  }
  if (retentionHours === KEEP_GROUP_CONTEXT_FOREVER) return { deleted: 0 };
  if (retentionHours !== 0 && !(Number.isInteger(retentionHours) && retentionHours > 0)) {
    return { deleted: 0 };
  }
  const root = resolve(workspace, GROUP_CONTEXT_DIRECTORY);
  let canonicalWorkspace;
  let canonicalRoot;
  try {
    [canonicalWorkspace, canonicalRoot] = await Promise.all([
      realpath(workspace),
      realpath(root),
    ]);
  } catch (error) {
    if (error?.code === 'ENOENT') return { deleted: 0 };
    throw error;
  }
  const rootInWorkspace = relative(canonicalWorkspace, canonicalRoot);
  if (!rootInWorkspace || rootInWorkspace.startsWith('..') || isAbsolute(rootInWorkspace)) {
    throw new InboundFileError(
      'group-context-root-outside-workspace',
      'The group context directory does not resolve inside the Harness workspace.',
    );
  }
  let chatEntries;
  try {
    chatEntries = await readdir(canonicalRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { deleted: 0 };
    throw error;
  }
  const current = now();
  let deleted = 0;
  for (const chatEntry of chatEntries) {
    if (!chatEntry.isDirectory()) continue;
    const chatDirectory = join(canonicalRoot, chatEntry.name);
    let messageEntries;
    try {
      messageEntries = await readdir(chatDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const messageEntry of messageEntries) {
      if (!messageEntry.isDirectory()) continue;
      const stagedAt = parseInboundDirectoryName(messageEntry.name);
      if (stagedAt === null) continue;
      const directory = join(chatDirectory, messageEntry.name);
      if (typeof isTracked === 'function' && isTracked(directory)) continue;
      const ageHours = (current - stagedAt) / 3_600_000;
      if (retentionHours !== 0 && ageHours < retentionHours) continue;
      try {
        await rm(directory, { recursive: true, force: true });
        deleted += 1;
      } catch {
        // 单个删不掉不影响其余目录。
      }
    }
    // 空群目录顺手清掉；非空（或删除失败）时保留。
    await rmdir(chatDirectory).catch(() => undefined);
  }
  return { deleted };
}

/**
 * 每个机器人一个实例：负责下载落盘、记录在途目录（避免清理误删），并按间隔节流地
 * 触发过期清理。清理挂在写入路径上，不需要额外的定时器。
 */
export function createGroupContextFiles({
  retentionHours = DEFAULT_GROUP_CONTEXT_RETENTION_HOURS,
  sweepIntervalMs = DEFAULT_GROUP_CONTEXT_SWEEP_INTERVAL_MS,
  now = () => new Date(),
  logger = console,
} = {}) {
  const resolvedRetention = normalizeGroupContextRetention(retentionHours);
  const resolvedInterval = Number.isFinite(sweepIntervalMs) && sweepIntervalMs >= 0
    ? sweepIntervalMs
    : DEFAULT_GROUP_CONTEXT_SWEEP_INTERVAL_MS;
  const inFlight = new Set();
  const sweptAt = new Map();

  function isTracked(directory) {
    return inFlight.has(directory);
  }

  async function sweep(workspace) {
    const result = await sweepGroupContextFiles(workspace, resolvedRetention, { now, isTracked });
    sweptAt.set(resolve(workspace), now().getTime());
    return result;
  }

  function sweepIfDue(workspace) {
    const key = resolve(workspace);
    const last = sweptAt.get(key);
    if (resolvedRetention === KEEP_GROUP_CONTEXT_FOREVER) return Promise.resolve({ deleted: 0 });
    if (Number.isFinite(last) && now().getTime() - last < resolvedInterval) {
      return Promise.resolve({ deleted: 0 });
    }
    // 清理是后台行为：失败只记日志，绝不影响当前消息的处理。
    const task = sweep(workspace).catch((error) => {
      logger.warn?.('[dsh-im] group context sweep failed', error);
      return { deleted: 0 };
    });
    sweptAt.set(key, now().getTime());
    return task;
  }

  /**
   * 下载并落盘一条群消息的附件。
   *
   * 未知/越界的附件会抛 `InboundFileError`；调用方按“只留文本占位”降级处理。
   * 下载是逐个进行的，单个失败会清掉已写的部分，避免留下半份附件。
   */
  async function stage({
    workspace, chatId, messageId, sender, timestamp, files, signal,
  } = {}) {
    const sources = Array.isArray(files) ? files.filter(Boolean) : [];
    if (sources.length === 0) return null;
    if (typeof workspace !== 'string' || !isAbsolute(workspace)) {
      throw new InboundFileError(
        'group-context-workspace-unavailable',
        'The bot workspace is unavailable for group context attachments.',
      );
    }
    const chatDirectory = join(resolve(workspace, GROUP_CONTEXT_DIRECTORY), groupContextChatSegment(chatId));
    const directory = join(chatDirectory, groupContextMessageSegment(messageId, now()));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    inFlight.add(directory);

    const staged = [];
    try {
      for (const [index, source] of sources.entries()) {
        signal?.throwIfAborted();
        let value;
        try {
          value = source?.data === undefined
            ? await source?.load?.({ signal })
            : source.data;
        } catch (error) {
          if (signal?.aborted) throw error;
          throw new InboundFileError(
            'group-context-download-failed',
            `Unable to download group attachment ${index + 1}: ${error?.message ?? String(error)}`,
            undefined,
            { cause: error },
          );
        }
        const loaded = loadedFile(value);
        if (!loaded) {
          throw new InboundFileError(
            'group-context-data-invalid',
            `Group attachment ${index + 1} returned no readable data.`,
          );
        }
        const name = displayFileName(loaded.name ?? source?.name, `file-${index + 1}`);
        const storage = storageFileName(name, index);
        const path = join(directory, storage);
        if (loaded.data) {
          await writeFile(path, loaded.data, { mode: 0o600, signal });
        } else {
          try {
            await pipeline(
              loaded.stream,
              createWriteStream(path, { flags: 'wx', mode: 0o600 }),
              { signal },
            );
          } catch (error) {
            if (signal?.aborted) throw error;
            throw new InboundFileError(
              'group-context-download-failed',
              `Unable to stream group attachment ${index + 1}: ${error?.message ?? String(error)}`,
              undefined,
              { cause: error },
            );
          }
        }
        const relativePath = relative(resolve(workspace), path);
        if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
          throw new InboundFileError(
            'group-context-path-invalid',
            'The staged group attachment escaped the bot workspace.',
          );
        }
        const mediaType = loaded.mediaType ?? source?.mediaType;
        staged.push(Object.freeze({
          name,
          storage,
          path: relativePath,
          ...(typeof mediaType === 'string' && mediaType.trim() ? { mediaType: mediaType.trim() } : {}),
        }));
      }
      // 旁挂元数据：清单是注入时从磁盘重建的，重启后也要能还原发送者与时间。
      await writeFile(
        join(directory, GROUP_CONTEXT_META_FILE),
        `${JSON.stringify({
          messageId: typeof messageId === 'string' ? messageId : '',
          sender: typeof sender === 'string' ? sender : '',
          timestamp: Number.isFinite(timestamp) ? timestamp : now().getTime(),
          files: staged.map((file) => ({ name: file.name, storage: file.storage })),
        }, null, 2)}\n`,
        { mode: 0o600, signal },
      );
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      inFlight.delete(directory);
      void sweepIfDue(workspace);
    }
    return Object.freeze({
      files: Object.freeze(staged.map(({ storage, ...rest }) => Object.freeze(rest))),
      directory,
      retentionHours: resolvedRetention,
    });
  }

  /**
   * 从磁盘重建“这个群最近的附件”：列出保留期内最近 limit 条消息目录。
   * 下载中的目录会被跳过（文件可能还不完整），清单因此不依赖进程内状态。
   */
  async function list(workspace, chatId, { limit = DEFAULT_GROUP_CONTEXT_RECENT_LIMIT } = {}) {
    if (typeof workspace !== 'string' || !isAbsolute(workspace)) {
      return { directory: '', messages: [] };
    }
    const chatDirectory = join(resolve(workspace, GROUP_CONTEXT_DIRECTORY), groupContextChatSegment(chatId));
    const directoryPath = relative(resolve(workspace), chatDirectory);
    let entries;
    try {
      entries = await readdir(chatDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return { directory: directoryPath, messages: [] };
      throw error;
    }
    const resolvedLimit = Number.isSafeInteger(limit) && limit > 0
      ? limit
      : DEFAULT_GROUP_CONTEXT_RECENT_LIMIT;
    const current = now().getTime();
    const messages = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const messageDirectory = join(chatDirectory, entry.name);
      if (isTracked(messageDirectory)) continue;
      const stagedAt = parseInboundDirectoryName(entry.name);
      if (stagedAt === null) continue;
      if (resolvedRetention > 0
        && current - stagedAt.getTime() >= resolvedRetention * 3_600_000) continue;
      let fileEntries;
      try {
        fileEntries = await readdir(messageDirectory, { withFileTypes: true });
      } catch {
        continue;
      }
      let meta = null;
      try {
        meta = JSON.parse(await readFile(join(messageDirectory, GROUP_CONTEXT_META_FILE), 'utf8'));
      } catch {
        meta = null;
      }
      const byStorage = new Map(
        (Array.isArray(meta?.files) ? meta.files : [])
          .filter((file) => file && typeof file.storage === 'string')
          .map((file) => [file.storage, typeof file.name === 'string' ? file.name : file.storage]),
      );
      const files = [];
      for (const fileEntry of fileEntries) {
        if (!fileEntry.isFile() || fileEntry.name === GROUP_CONTEXT_META_FILE) continue;
        const relativePath = relative(resolve(workspace), join(messageDirectory, fileEntry.name));
        if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) continue;
        files.push(Object.freeze({
          name: byStorage.get(fileEntry.name)
            ?? fileEntry.name.replace(/^\d+-/u, ''),
          path: relativePath,
        }));
      }
      if (files.length === 0) continue;
      messages.push({
        stagedAt,
        timestamp: Number.isFinite(meta?.timestamp) ? meta.timestamp : stagedAt.getTime(),
        messageId: typeof meta?.messageId === 'string' && meta.messageId
          ? meta.messageId
          : entry.name.replace(/^\d{8}-\d{6}-/u, ''),
        sender: typeof meta?.sender === 'string' ? meta.sender : '',
        files: Object.freeze(files),
      });
    }
    messages.sort((left, right) => right.stagedAt - left.stagedAt);
    return { directory: directoryPath, messages: Object.freeze(messages.slice(0, resolvedLimit)) };
  }

  return Object.freeze({
    retentionHours: resolvedRetention,
    stage,
    list,
    sweep,
    sweepIfDue,
    isTracked,
  });
}
