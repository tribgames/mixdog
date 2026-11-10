import '../../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { renderBackgroundedResult } = await import('./backgrounded-result.mjs');

const flush = () => new Promise((resolve) => setImmediate(resolve));

// A queued command has no job id until it runs; its producer writes the tee
// capture for as long as that run lasts.
test('a queued command keeps its tee capture until its run settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-queued-tee-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const teePath = join(dir, 'producer.log');
  writeFileSync(teePath, 'queued producer output');
  let finish;
  const settled = new Promise((resolve) => {
    finish = resolve;
  });
  renderBackgroundedResult({
    result: { backgrounded: true, settled, stdout: '', stderr: '' },
    command: 'node producer.js | Select-String missing',
    cwd: dir,
    options: {},
    startedAtMs: Date.now(),
    teePlan: { teePath },
    stdout: '',
    stderr: '',
  });
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(existsSync(teePath), true, 'the queued run may still be writing it');
  finish();
  await flush();
  assert.equal(existsSync(teePath), false, 'the settled run releases it');
});
