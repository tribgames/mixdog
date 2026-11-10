import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHELL_OUTPUT_RETENTION_MS, sweepExpiredShellOutput } from './shell-exec-output.mjs';

test('shell output sweep drops spill files past retention and keeps recent ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-shell-output-retention-'));
  try {
    const now = Date.now();
    const expired = join(dir, 'shell_old.stdout');
    const recent = join(dir, 'shell_new.stdout');
    const emptyRecent = join(dir, 'shell_new.stderr');
    writeFileSync(expired, 'old output');
    writeFileSync(recent, 'new output');
    writeFileSync(emptyRecent, '');
    const expiredSeconds = (now - SHELL_OUTPUT_RETENTION_MS - 60_000) / 1000;
    utimesSync(expired, expiredSeconds, expiredSeconds);

    await sweepExpiredShellOutput(dir, now);

    assert.equal(existsSync(expired), false);
    assert.equal(existsSync(recent), true);
    assert.equal(existsSync(emptyRecent), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shell output sweep tolerates a missing directory', async () => {
  await sweepExpiredShellOutput(join(tmpdir(), `mixdog-shell-output-missing-${process.pid}-${Date.now()}`));
});
