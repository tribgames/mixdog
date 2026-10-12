import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { shellJobsStatus } from './statusline-segments.mjs';

test('a session keeps its shell jobs while the polling owner pid alternates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-statusline-owners-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const dir = join(root, 'shell-jobs');
    mkdirSync(dir, { recursive: true });
    const jobId = `job_${Date.now()}_owners`;
    writeFileSync(
      join(dir, `${jobId}.json`),
      JSON.stringify({ pid: process.pid, command: 'npm run dev', ownerSessionId: 'sess-a', startedAt: Date.now() })
    );
    writeFileSync(join(dir, `${jobId}.owner-${process.pid}`), '');
    const ownerA = process.pid;
    const ownerB = process.pid + 100_000;
    const sessionCount = (pid) => shellJobsStatus({ clientHostPid: pid, sessionId: 'sess-a' }).count;

    // Warm both owners' caches.
    for (let attempt = 0; attempt < 40 && (sessionCount(ownerA) !== 1 || sessionCount(ownerB) !== 1); attempt += 1) {
      await delay(25);
    }
    for (let poll = 0; poll < 6; poll += 1) {
      assert.equal(sessionCount(poll % 2 ? ownerB : ownerA), 1, `poll ${poll}`);
      await delay(10);
    }
    // The owner-wide aggregate stays pid-scoped.
    assert.equal(shellJobsStatus({ clientHostPid: ownerA }).count, 1);
    assert.equal(shellJobsStatus({ clientHostPid: ownerB }).count, 0);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
