import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runTree } from '../../../scripts/rust-core/lib/process-tree.mjs';

const script = fileURLToPath(new URL('./prebake-rust.ps1', import.meta.url));
// Each child runs under a deadline and is ended with its tree. Only an executable that is not there skips the tests; a probe
// that times out, fails to clean up or exits non-zero is a failure.
const DEADLINE_MS = 120_000;
let powershell;
for (const name of ['pwsh', 'powershell']) {
  try {
    const probe = await runTree(name, ['-NoProfile', '-Command', '1'], { label: `${name} probe`, deadlineMs: DEADLINE_MS });
    if (probe.status !== 0) throw new Error(`${name} probe exited ${probe.status}: ${probe.stderr.slice(0, 300)}`);
    powershell = name;
    break;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

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
  runTree(powershell, ['-NoProfile', '-File', script, '-ServerCores', serverCores, '-MixdogVersion', version, '-OutDir', out], { label: 'prebake-rust.ps1', deadlineMs: DEADLINE_MS });

test('the prebake copies the staged mixdogd bundle once its digest and version match the server manifest', { skip: !powershell }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'prebake-rust-'));
  try {
    const out = join(root, 'out');
    const result = await run(stage(root), out);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(out, 'mixdogd-linux-x64.tgz'), 'utf8'), 'bundle bytes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bundle that is not the manifest\'s, or another version, is refused and nothing is copied', { skip: !powershell }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'prebake-rust-'));
  try {
    const out = join(root, 'out');
    assert.notEqual((await run(stage(root, { tamper: true }), out)).status, 0);
    assert.notEqual((await run(stage(root), out, '1.0.0')).status, 0);
    assert.equal(existsSync(join(out, 'mixdogd-linux-x64.tgz')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
