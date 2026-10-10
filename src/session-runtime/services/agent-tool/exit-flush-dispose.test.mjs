import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { exitFlushCount } from './helpers.mjs';
import { createLeadWorkerIndex } from './lead-worker-index.mjs';
import { createWorkerIndex } from './worker-index.mjs';

function pair(root) {
  const worker = createWorkerIndex({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    mgr: { getSessionRuntime: () => null },
    tags: new Map(),
    tagAgents: new Map(),
    tagCwds: new Map(),
  });
  const lead = createLeadWorkerIndex({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    workerRowFromSession: worker.workerRowFromSession,
  });
  return { worker, lead };
}

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-dispose-'));
  mkdirSync(join(root, 'sessions'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('constructing and disposing index pairs leaves exitFlushes at its prior size', (t) => {
  const root = tempRoot(t);
  const before = exitFlushCount();
  const pairs = Array.from({ length: 5 }, () => pair(root));
  assert.equal(exitFlushCount(), before + 10);
  for (const { worker, lead } of pairs) {
    worker.dispose();
    lead.dispose();
    worker.dispose();
    lead.dispose();
  }
  assert.equal(exitFlushCount(), before);
});

test('dispose persists pending worker rows before unregistering', (t) => {
  const root = tempRoot(t);
  const { worker, lead } = pair(root);
  const now = new Date().toISOString();
  worker.queueWorkerIndexMutation((byKey) => {
    byKey.set('pending', {
      tag: 'pending',
      sessionId: 'pending',
      ownerSessionId: 'lead-a',
      agent: 'worker',
      status: 'idle',
      stage: 'idle',
      updatedAt: now,
    });
  });
  worker.dispose();
  lead.dispose();
  const stored = JSON.parse(readFileSync(join(root, 'agent-workers.json'), 'utf8'));
  assert.equal(stored.workers.pending?.sessionId, 'pending');
});

test('disposing one runtime leaves workers another runtime in the same process still runs', (t) => {
  const root = tempRoot(t);
  const evicted = pair(root);
  const live = pair(root);
  const now = new Date().toISOString();
  live.worker.queueWorkerIndexMutation((byKey) => {
    byKey.set('busy', {
      tag: 'busy',
      sessionId: 'busy',
      ownerSessionId: 'lead-b',
      agent: 'worker',
      status: 'running',
      stage: 'running',
      runtimePid: process.pid,
      updatedAt: now,
    });
  });
  live.worker.dispose();
  live.lead.dispose();
  evicted.worker.invalidateWorkerRowsCache();
  evicted.worker.dispose();
  evicted.lead.dispose();
  const stored = JSON.parse(readFileSync(join(root, 'agent-workers.json'), 'utf8'));
  assert.equal(stored.workers.busy?.status, 'running');
});
