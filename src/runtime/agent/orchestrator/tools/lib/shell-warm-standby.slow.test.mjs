import { fixtureRoot } from './isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildShellSpawnEnv } from '../builtin/bash-tool/spawn-env.mjs';
import { sessionScratchDir } from '../../../../shared/session-scratch.mjs';
import {
  _resetNativeSpawnClientForTest,
  _setNativeSpawnBinaryForTest,
  ensureNativeSpawnServer,
  shutdownNativeSpawnServer,
} from './native-spawn-client.mjs';
import { STANDBY_ARGS, _parkedShellStandbyForTest, takeWarmShellStandby } from './shell-warm-standby.mjs';

const spawnBinary = ['release', 'debug']
  .map((profile) =>
    resolve('native/mixdog-spawn/target', profile, process.platform === 'win32' ? 'mixdog-spawn.exe' : 'mixdog-spawn')
  )
  .find((path) => existsSync(path));
const hasPwsh =
  process.platform === 'win32' && spawnSync('pwsh', ['-NoLogo', '-Command', '1'], { windowsHide: true }).status === 0;

const standbyHandOff = {
  skip: !(spawnBinary && hasPwsh) && 'needs Windows, pwsh and the built mixdog-spawn',
  timeout: 60000,
};

// `scratchOverride` replaces session B's scratch value in the requested env;
// the command must run in `workDir` and see session B's scratch directory.
async function handOffAcrossSessions(scratchOverride, workDir = fixtureRoot) {
  try {
    _setNativeSpawnBinaryForTest(spawnBinary);
    await ensureNativeSpawnServer();
    const envA = buildShellSpawnEnv(fixtureRoot, process.env, 'sess_standby_a');
    const envB = buildShellSpawnEnv(fixtureRoot, process.env, 'sess_standby_b');
    if (scratchOverride) Object.assign(envB, { TEMP: scratchOverride, TMP: scratchOverride, TMPDIR: scratchOverride });
    assert.notEqual(envA.TEMP, envB.TEMP);
    // Session A's call parks a standby spawned with A's environment.
    assert.equal(takeWarmShellStandby({ shell: 'pwsh', env: envA }), null);
    let parked = _parkedShellStandbyForTest();
    for (let i = 0; i < 200 && !(parked?.native.child.pid > 0); i += 1) {
      await delay(50);
      parked = _parkedShellStandbyForTest();
    }
    assert.ok(parked?.native.child.pid > 0, 'standby was not parked');
    const parkedPid = parked.native.child.pid;
    // Session B takes that very process despite the different scratch paths.
    const standby = takeWarmShellStandby({ shell: 'pwsh', env: envB });
    assert.ok(standby, 'standby was not reused across sessions');
    assert.equal(standby.spawned.child.pid, parkedPid);
    const chunks = [];
    standby.spawned.child.stdout.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    const closed = new Promise((done) => standby.spawned.child.once('close', done));
    standby.feed(
      'Write-Output "$env:TEMP|$env:TMP|$env:TMPDIR|$((Get-Location).ProviderPath)|$([System.Environment]::CurrentDirectory)"',
      workDir
    );
    await closed;
    const dirB = scratchOverride || sessionScratchDir('sess_standby_b');
    assert.equal(Buffer.concat(chunks).toString('utf8').trim(), `${dirB}|${dirB}|${dirB}|${workDir}|${workDir}`);
  } finally {
    _parkedShellStandbyForTest()?.native.child.kill();
    await shutdownNativeSpawnServer('test-finish').catch(() => {});
    _resetNativeSpawnClientForTest();
  }
}

test('a standby parked for one session is reused by another and the command sees its scratch dir', standbyHandOff, () =>
  handOffAcrossSessions(null)
);

test(
  'a hand-off scratch path and project path with typographic apostrophes still parse and run the command',
  standbyHandOff,
  async () => {
    const project = mkdtempSync(join(tmpdir(), 'mixdog-it’s ‘project’ ‚low‛ $x -'));
    try {
      await handOffAcrossSessions('C:\\Data’s ‘space’ ‚low‛\\scratch $x `y', project);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }
);

test('warm PowerShell preserves cold command status and output', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 60000,
}, () => {
  const cases = [
    ['Write-Output "success"', 0],
    ['node -e "process.exit(7)"', 1],
    ['exit 7', 7],
    ['throw "intentional failure"', 1],
    ['Write-Error "intentional failure"', 1],
    ['node -e "process.exit(7)"; Write-Output "recovered"', 0],
    ['npm --mixdog-invalid-option run __mixdog_missing_script__', 1],
  ];
  for (const [script, expected] of cases) {
    const options = { encoding: 'utf8', timeout: 10000, windowsHide: true, cwd: fixtureRoot };
    const cold = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], options);
    const warm = spawnSync('pwsh', STANDBY_ARGS, { ...options, input: script });
    assert.ifError(cold.error);
    assert.ifError(warm.error);
    assert.equal(cold.status, expected, `cold: ${script}`);
    assert.equal(warm.status, cold.status, `warm: ${script}`);
    assert.equal(warm.stdout, cold.stdout, `stdout: ${script}`);
    assert.equal(Boolean(warm.stderr), Boolean(cold.stderr), `stderr presence: ${script}`);
  }
});
