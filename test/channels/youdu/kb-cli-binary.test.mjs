import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveYouDuCliBinary } from '../../../src/channels/youdu/kb/cli-binary.mjs';

async function fakeRoot(executable) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-cli-'));
  const bin = join(root, 'vendor', 'youdu-cli', 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, executable), '');
  return { root, bin };
}

test('the vendored binary is preferred over any installed package', async () => {
  const { root, bin } = await fakeRoot('youdu-cli.exe');
  const binary = await resolveYouDuCliBinary({ root, platformName: 'win32', archName: 'x64' });
  assert.equal(binary, join(bin, 'youdu-cli.exe'));
});

test('the target decides the executable name inside the vendor directory', async () => {
  for (const [platformName, archName] of [['linux', 'x64'], ['darwin', 'arm64'], ['win32', 'arm64']]) {
    const executable = platformName === 'win32' ? 'youdu-cli.exe' : 'youdu-cli';
    const { root, bin } = await fakeRoot(executable);
    const binary = await resolveYouDuCliBinary({ root, platformName, archName });
    assert.equal(binary, join(bin, executable));
  }
});

test('an unsupported target is rejected before any lookup', async () => {
  await assert.rejects(
    resolveYouDuCliBinary({ root: null, platformName: 'aix', archName: 'ppc64' }),
    /unsupported platform: aix-ppc64/,
  );
});

test('the packaged plugin finds its own vendored binary', { skip: process.platform !== 'win32' }, async () => {
  const binary = await resolveYouDuCliBinary();
  assert.match(binary, /vendor[\\/]youdu-cli[\\/]bin[\\/]youdu-cli\.exe$/);
});
