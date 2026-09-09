import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { STANDBY_ARGS } from './shell-warm-standby.mjs';

test('warm PowerShell preserves cold command status and output', {
  skip: process.platform !== 'win32', timeout: 60000,
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
    const options = { encoding: 'utf8', timeout: 10000, windowsHide: true };
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
