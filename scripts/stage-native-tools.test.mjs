import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { STAGED_NATIVE_TOOL_KINDS, stageNativeTools } from './stage-native-tools.mjs';

const fakeDownload = async (kind, target, cacheDir) => {
  const file = join(cacheDir, `${kind}-${target.platform}-${target.arch}`);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, `${kind} for ${target.platform}-${target.arch}`);
  return file;
};

test('graph, patch and spawn are staged under native-tools with the installed names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stage-native-tools-'));
  const staged = await stageNativeTools({ root, platform: 'linux', arch: 'arm64', download: fakeDownload });
  assert.deepEqual(
    staged.map((file) => file.slice(root.length + 1).replaceAll('\\', '/')),
    STAGED_NATIVE_TOOL_KINDS.map((kind) => `native-tools/mixdog-${kind}`),
  );
  assert.equal(await readFile(staged[1], 'utf8'), 'patch for linux-arm64');
  if (process.platform !== 'win32') assert.equal((await stat(staged[0])).mode & 0o777, 0o755);
});

test('Windows tools carry the exe suffix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stage-native-tools-'));
  const staged = await stageNativeTools({ root, platform: 'win32', arch: 'x64', download: fakeDownload });
  assert.ok(staged.every((file) => file.endsWith('.exe')));
});

test('a platform without published tools is refused before any download', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stage-native-tools-'));
  await assert.rejects(
    stageNativeTools({ root, platform: 'freebsd', arch: 'x64', download: () => assert.fail('downloaded') }),
    /not published for freebsd-x64/,
  );
});