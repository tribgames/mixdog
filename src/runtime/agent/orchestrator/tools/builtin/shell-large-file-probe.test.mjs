// The large-file shell probe answers with a block only for a path it can
// resolve statically. A token carrying shell expansion or glob magic is
// skipped (the shell is allowed to run), never reported as a probe failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { preflightShellLargeFileProbe } from './shell-analysis.mjs';

test('unresolvable probe targets are skipped, not blocked', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-shell-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(60 * 1024));
  for (const command of ['cat $TARGET', 'cat "${TARGET}"', 'cat $(printf big.txt)', 'cat *.txt', 'cat `ls`']) {
    assert.equal(await preflightShellLargeFileProbe(command, dir), null, command);
  }
});

test('a resolvable large target is blocked with its size', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-shell-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(60 * 1024));
  writeFileSync(join(dir, 'small.txt'), 'x');
  assert.equal(await preflightShellLargeFileProbe('cat small.txt', dir), null);
  const blocked = await preflightShellLargeFileProbe('cat big.txt', dir);
  assert.equal(blocked?.cmd, 'cat');
  assert.equal(blocked?.sizeBytes, 60 * 1024);
  assert.match(blocked?.message ?? '', /large-file shell probe blocked/);
});
