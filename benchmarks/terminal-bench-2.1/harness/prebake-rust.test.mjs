import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { stageCore } from '../../../apps/desktop/scripts/stage-core.mjs';
import { SERVER_PLATFORM_TARGETS } from '../../../apps/desktop/src/main/ssh/server-manifest.mjs';
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

/** The server set stage-core.mjs builds, of stand-in binaries and JS runtimes, and the file of its linux-x64 bundle. */
async function stage(root) {
  const targetDir = join(root, 'target');
  for (const target of Object.values(SERVER_PLATFORM_TARGETS)) {
    mkdirSync(join(targetDir, target, 'release'), { recursive: true });
    writeFileSync(join(targetDir, target, 'release', 'mixdogd'), `mixdogd for ${target}`);
  }
  const runtimeDir = join(root, 'runtime');
  const manifest = await stageCore({
    targetDir,
    runtimeDir,
    version: '9.9.9',
    host: { platform: 'linux', arch: 'x64' },
    serversOnly: true,
    buildPayload: async ({ key, payloadDir }) => {
      mkdirSync(join(payloadDir, 'js'), { recursive: true });
      writeFileSync(join(payloadDir, 'js', 'node'), `node for ${key}`);
    },
    verifyPayload: async () => {},
  });
  const serverCores = join(runtimeDir, 'server-cores');
  return { serverCores, bundle: join(serverCores, manifest.binaries['linux-x64'].bundle.asset) };
}
const run = (serverCores, out, version = '9.9.9') =>
  runTree(powershell, ['-NoProfile', '-File', script, '-ServerCores', serverCores, '-MixdogVersion', version, '-OutDir', out], { label: 'prebake-rust.ps1', deadlineMs: DEADLINE_MS });

test('the prebake copies the staged mixdogd bundle once its digest and version match the server manifest', { skip: !powershell }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'prebake-rust-'));
  try {
    const out = join(root, 'out');
    const { serverCores, bundle } = await stage(root);
    const result = await run(serverCores, out);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(join(out, 'mixdogd-linux-x64.tgz')), readFileSync(bundle));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bundle that is not the manifest\'s, or another version, is refused and nothing is copied', { skip: !powershell }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'prebake-rust-'));
  try {
    const out = join(root, 'out');
    const { serverCores, bundle } = await stage(root);
    assert.notEqual((await run(serverCores, out, '1.0.0')).status, 0);
    writeFileSync(bundle, 'other bytes');
    assert.notEqual((await run(serverCores, out)).status, 0);
    assert.equal(existsSync(join(out, 'mixdogd-linux-x64.tgz')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
