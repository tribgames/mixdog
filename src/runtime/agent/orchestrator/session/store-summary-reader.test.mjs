import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listStoredAgentWorkers } from './store-summary-reader.mjs';

test('agent pool lists living idle workers and drops dead ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-pool-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    writeFileSync(join(root, 'agent-workers.json'), JSON.stringify({
      workers: {
        a: {
          tag: 'review',
          sessionId: 'child-a',
          ownerSessionId: 'lead-a',
          agent: 'reviewer',
          status: 'idle',
          stage: 'idle',
        },
        b: {
          tag: 'work',
          sessionId: 'child-b',
          ownerSessionId: 'lead-b',
          agent: 'worker',
          status: 'running',
          stage: 'running',
        },
        c: {
          tag: 'done',
          sessionId: 'child-c',
          ownerSessionId: 'lead-c',
          agent: 'worker',
          status: 'closed',
          stage: 'closed',
        },
      },
    }));
    const rows = listStoredAgentWorkers();
    assert.deepEqual(rows.map((row) => row.sessionId).sort(), ['child-a', 'child-b']);
    assert.equal(rows.find((row) => row.sessionId === 'child-a')?.status, 'idle');
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
