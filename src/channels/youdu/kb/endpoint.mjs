// Port of @youdu/openclaw-youdu `src/kb/endpoint.ts` (origin/codex/youdu-kb-tool).
// Resolves the KB open-API endpoint (`https://<hostname>:7443`) and its TLS
// options from the bot's configured host. The bundled CA (`cert/youdu-ca.pem`,
// only the YouDu private roots) is read from the package `cert/` directory; IP
// hosts allow hostname/IP mismatch while still verifying the chain against it,
// and domain hosts keep full chain verification.

import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PORT } from '../youdu-protocol/index.js';

const CA_FILENAME = 'youdu-ca.pem';
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

/** Walk up to the nearest package root (where package.json lives). */
function packageRoot(startDirectory) {
  let dir = startDirectory;
  while (dir && dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return null;
}

function readBundledCa() {
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

function configuredHostname(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) throw new Error('YOUDU_KB_CONFIG_INVALID: channels.youdu.url is required');
  try {
    const url = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
      ? new URL(value)
      : new URL(`https://${value}`);
    if (!url.hostname) throw new Error('missing host');
    return url.hostname;
  } catch {
    throw new Error('YOUDU_KB_CONFIG_INVALID: channels.youdu.url must contain a valid host');
  }
}

export function buildYouDuKbEndpoint(configuredUrl) {
  const urlHostname = configuredHostname(configuredUrl);
  const hostname = urlHostname.startsWith('[') && urlHostname.endsWith(']')
    ? urlHostname.slice(1, -1)
    : urlHostname;
  const ipVersion = isIP(hostname);
  const formattedHost = ipVersion === 6 ? `[${hostname}]` : hostname;
  return {
    baseUrl: `https://${formattedHost}:${DEFAULT_PORT}`,
    tls: {
      caPem: readBundledCa(),
      allowIpHostnameMismatch: ipVersion !== 0,
    },
  };
}

export { moduleDirectory };
