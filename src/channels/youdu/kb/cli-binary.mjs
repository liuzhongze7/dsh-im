// Locate the YouDu CLI binary that backs the knowledge-base bridge.
//
// The binary ships inside the plugin (vendor/youdu-cli/bin), so installing the
// plugin never has to reach an npm registry for `@youdu/cli`. Only when the
// vendored copy is missing do we fall back to a user-installed `@youdu/cli`
// platform package.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@xmanrui/dsh-im';

const BINARY_BY_TARGET = Object.freeze({
  'win32-arm64': 'youdu-cli.exe',
  'win32-x64': 'youdu-cli.exe',
  'darwin-arm64': 'youdu-cli',
  'darwin-x64': 'youdu-cli',
  'linux-arm64': 'youdu-cli',
  'linux-x64': 'youdu-cli',
});

function packageRoot() {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(directory, 'package.json');
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
      if (parsed?.name === PACKAGE_NAME) return directory;
    } catch {
      // Keep walking: intermediate directories have no manifest.
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * Resolve the CLI executable to spawn for the current platform.
 *
 * @param {{
 *   root?: string|null,
 *   platformName?: string,
 *   archName?: string,
 *   exists?: (path: string) => boolean,
 * }} [options]
 * @returns {Promise<string>}
 */
export async function resolveYouDuCliBinary(options = {}) {
  const platformName = options.platformName ?? process.platform;
  const archName = options.archName ?? process.arch;
  const key = `${platformName}-${archName}`;
  const executableName = BINARY_BY_TARGET[key];
  if (!executableName) throw new Error(`unsupported platform: ${key}`);

  const exists = options.exists ?? existsSync;
  const root = options.root === undefined ? packageRoot() : options.root;
  if (root) {
    const vendored = join(root, 'vendor', 'youdu-cli', 'bin', executableName);
    if (exists(vendored)) return vendored;
  }

  // Optional fallback for developers who installed the published CLI package.
  const module = await import('@youdu/cli/platform');
  return module.resolveYouDuCliBinary();
}
