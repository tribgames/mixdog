import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./prebake-rust.ps1', import.meta.url));
const powershell = ['pwsh', 'powershell'].find((name) => spawnSync(name, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0);

function stage(root, { version = '9.9.9', tamper = false } = {}) {
  const dir = join(root, 'server-cores', 'linux-x64');
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from('bundle bytes');
  writeFileSync(join(dir, 'bundle.tgz'), tamper ? Buffer.from('other bytes') : bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(root, 'server-cores', 'servers.json'), JSON.stringify({ version, binaries: { 'linux-x64': { bundle: { file: 'bundle.tgz', sha256 } } } }));
  return join(root, 'server-cores');
}
const run = (serverCores, out, version = '9.9.9') =>
  spawnSync(powershell, ['-NoProfile', '-File', script, '-ServerCores', serverCores, '-MixdogVersion', version, '-OutDir', out], { encoding: 'utf8' });

test('the prebake copies the staged mixdogd bundle once its digest and version match the server manifest', { skip: !powershell }, () => {
  const root = mkdtempSync(join(tmpdir(), 'prebake-rust-'));
  try {
    const out = join(root, 'out');
    const result = run(stage(root), out);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(out, 'mixdogd-linux-x64.tgz'), 'utf8'), 'bundle bytes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bundle that is not the manifest\'s, or another version, is refused and nothing is copied', { skip: !powershell }, () => {
  const root = mkdtempSync(join(tmpdir(), 'prebake-rust-'));
  try {
    const out = join(root, 'out');
    assert.notEqual(run(stage(root, { tamper: true }), out).status, 0);
    assert.notEqual(run(stage(root), out, '1.0.0').status, 0);
    assert.equal(existsSync(join(out, 'mixdogd-linux-x64.tgz')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
