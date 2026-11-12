import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { workspaceVersion } from './check-release-version.mjs';
import { setCoreVersion } from './set-core-version.mjs';

const MANIFEST = '[workspace]\nmembers = ["crates/a"]\n\n[workspace.package]\nversion = "1.4.5" # == root package.json version\nedition = "2024"\n\n[workspace.dependencies]\nserde = { version = "1.4.5" }\n';
const LOCK = [
  'version = 4',
  '',
  '[[package]]',
  'name = "mixdog-a"',
  'version = "1.4.5"',
  'dependencies = [',
  ' "serde",',
  ']',
  '',
  '[[package]]',
  'name = "serde"',
  'version = "1.4.5"',
  'source = "registry+https://github.com/rust-lang/crates.io-index"',
  'checksum = "00"',
  '',
  '[[package]]',
  'name = "mixdog-workspace-hack"',
  'version = "0.1.0"',
  '',
].join('\n');

async function tree() {
  const root = await mkdtemp(join(tmpdir(), 'core-version-'));
  await mkdir(join(root, 'native/core'), { recursive: true });
  await writeFile(join(root, 'native/core/Cargo.toml'), MANIFEST);
  await writeFile(join(root, 'native/core/Cargo.lock'), LOCK);
  return root;
}

test('the workspace version and the workspace crates of Cargo.lock move; registry crates and other versions stay', async () => {
  const root = await tree();
  assert.deepEqual(await setCoreVersion('1.4.6', root), { from: '1.4.5', lockEntries: 1 });
  assert.equal(await workspaceVersion(join(root, 'native/core/Cargo.toml')), '1.4.6');
  const manifest = await readFile(join(root, 'native/core/Cargo.toml'), 'utf8');
  assert.match(manifest, /serde = \{ version = "1\.4\.5" \}/);
  assert.match(manifest, /version = "1\.4\.6" # == root package\.json version/);
  const lock = await readFile(join(root, 'native/core/Cargo.lock'), 'utf8');
  assert.match(lock, /name = "mixdog-a"\nversion = "1\.4\.6"/);
  assert.match(lock, /name = "serde"\nversion = "1\.4\.5"\nsource/);
  assert.match(lock, /name = "mixdog-workspace-hack"\nversion = "0\.1\.0"/);
});

test('a version that is not strict MAJOR.MINOR.PATCH changes nothing', async () => {
  const root = await tree();
  await assert.rejects(setCoreVersion('1.4', root), /strict/);
  assert.equal(await readFile(join(root, 'native/core/Cargo.toml'), 'utf8'), MANIFEST);
});

test('the real workspace crates are all found in the real lock file', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const lock = await readFile(join(root, 'native/core/Cargo.lock'), 'utf8');
  const version = await workspaceVersion(join(root, 'native/core/Cargo.toml'));
  const members = [...lock.matchAll(new RegExp(`name = "(mixdog-[^"]+)"\\nversion = "${version.replaceAll('.', '\\.')}"\\n(?!source = )`, 'g'))];
  assert.ok(members.length > 30, `found ${members.length} workspace crates at ${version}`);
});