import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Tray Quit ends the daemon with process.exit() while sessions are still open,
// so nothing closes them: /tmp kept the transcript owner registry of that run.

const spillDir = pathToFileURL(
  new URL('./transcript-spill/spill-dir.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
).href;

function runChild(source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('the transcript owner registry of a process that exits is removed with it', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-exit-registry-'));
  try {
    const file = runChild(`
      import { writeOwnerRegistry } from ${JSON.stringify(spillDir)};
      writeOwnerRegistry(${JSON.stringify(root)});
      console.log(${JSON.stringify(join(root, 'mixdog-transcript-owner-'))} + process.pid + '.json');
      process.exit(0);
    `);
    assert.ok(file.endsWith('.json'));
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an owner registry rewritten by a PID-reuse successor is left alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-exit-registry-'));
  try {
    const file = runChild(`
      import { writeFileSync } from 'node:fs';
      import { writeOwnerRegistry } from ${JSON.stringify(spillDir)};
      writeOwnerRegistry(${JSON.stringify(root)});
      const file = ${JSON.stringify(join(root, 'mixdog-transcript-owner-'))} + process.pid + '.json';
      writeFileSync(file, JSON.stringify({ pid: process.pid, nonce: 'someone-else' }));
      console.log(file);
      process.exit(0);
    `);
    assert.equal(existsSync(file), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
