// TLS 连接选项（对齐 openclaw-youdu `src/tls.ts`）：
// - 始终校验证书链（rejectUnauthorized: true），并加载自带 CA `cert/cacert-*.pem`，
//   与 node 默认 CA 合并，使 youdu 服务器（私有 CA 签发）能验证通过。
// - 配置为 IP 直连时，跳过 hostname 匹配（服务器证书签发给域名而非 IP），但证书链仍校验。
//
// 之前 dsh-im 的 youdu WebSocket/媒体请求没有传 tlsOptions，导致 IP 直连报
// "unable to verify the first certificate"。

import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import * as tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { Agent, fetch as undiciFetch } from 'undici';

const CA_FILENAME = 'cacert-2026-03-19.pem';
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

/** 从起始目录向上找到最近的包根（含 package.json）。 */
function packageRoot(startDirectory) {
  let dir = startDirectory;
  while (dir && dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return null;
}

/** 读取包内自带 CA（cert/cacert-*.pem）；读不到时返回 undefined。 */
export function readBundledCa() {
  try {
    const root = packageRoot(moduleDirectory);
    const path = root ? join(root, 'cert', CA_FILENAME) : null;
    if (!path || !existsSync(path)) return undefined;
    const value = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trim();
    return value ? `${value}\n` : undefined;
  } catch {
    return undefined;
  }
}

function defaultCaCertificates() {
  if (typeof tls.getCACertificates === 'function') {
    return tls.getCACertificates('default');
  }
  return [...tls.rootCertificates];
}

/** 从 `host[:port]`、`[ipv6]:port` 或完整 URL 中取出裸 hostname。 */
export function hostnameOf(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
    try { return new URL(raw).hostname; } catch { return ''; }
  }
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end > 0) return raw.slice(1, end);
  }
  const colons = (raw.match(/:/g) ?? []).length;
  if (colons === 1) return raw.slice(0, raw.lastIndexOf(':'));
  return raw;
}

/**
 * 构建 youdu 服务器的 TLS 连接选项。
 * @param {string} configuredHost 已 normalize 的 host[:port]（如 `10.0.0.60:7443`）
 */
export function buildYouduTlsOptions(configuredHost) {
  const hostname = hostnameOf(configuredHost);
  const isIpHost = hostname ? isIP(hostname) !== 0 : false;
  const bundled = readBundledCa();
  const options = { rejectUnauthorized: true };
  if (bundled) options.ca = [...defaultCaCertificates(), bundled];
  if (isIpHost) options.checkServerIdentity = () => undefined;
  return options;
}

/**
 * 构建媒体上传/下载用的 HTTP 传输：使用与 WebSocket 相同的 TLS 选项
 * （自带 CA + IP 直连跳过 hostname 匹配）。返回的函数带 `close()` 以释放连接池。
 */
export function createYouduTransport(tlsOptions) {
  const dispatcher = new Agent({ connect: tlsOptions });
  const transport = async (request) => {
    const headers = {};
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      if (value !== undefined) headers[key] = String(value);
    }
    const controller = new AbortController();
    const externalSignal = request.signal;
    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    let timer;
    if (request.timeoutMs && request.timeoutMs > 0) {
      timer = setTimeout(
        () => controller.abort(new Error(`Youdu request timed out after ${request.timeoutMs}ms`)),
        request.timeoutMs,
      );
    }
    try {
      const response = await undiciFetch(request.url, {
        method: request.method,
        headers,
        body: request.body,
        signal: controller.signal,
        dispatcher,
      });
      const arrayBuffer = await response.arrayBuffer();
      const normalized = {};
      response.headers.forEach((value, key) => { normalized[key.toLowerCase()] = value; });
      return { statusCode: response.status, headers: normalized, body: Buffer.from(arrayBuffer) };
    } finally {
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      if (timer) clearTimeout(timer);
    }
  };
  transport.close = () => dispatcher.close();
  return transport;
}
