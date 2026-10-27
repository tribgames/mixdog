import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isSkippedWatchPath } from './ingest/transcript-discovery.mjs';
import { mergeCycle1Results } from './memory-cycle1.mjs';
import { readMemoryCodeFingerprint } from './memory-fingerprint.mjs';
import { runFullBackfill } from './memory-ops-policy.mjs';
import { registerTraceExitDrain } from './trace-store.mjs';

test('isSkippedWatchPath matches whole segments only', () => {
  assert.equal(isSkippedWatchPath('tmp'), true);
  assert.equal(isSkippedWatchPath('a/plugins/b'), true);
  assert.equal(isSkippedWatchPath('a\\cache'), true);
  assert.equal(isSkippedWatchPath('C--Project-tmpfiles'), false);
  assert.equal(isSkippedWatchPath('my-cached-app'), false);
  assert.equal(isSkippedWatchPath('pluginsystem'), false);
});

test('memory fingerprint ignores *.test.mjs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
  try {
    fs.mkdirSync(path.join(root, 'src/runtime/memory'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/runtime/memory/a.mjs'), 'export const a = 1;');
    const before = readMemoryCodeFingerprint(root);
    fs.writeFileSync(path.join(root, 'src/runtime/memory/a.test.mjs'), 'x');
    assert.equal(readMemoryCodeFingerprint(root), before);
    fs.writeFileSync(path.join(root, 'src/runtime/memory/a.mjs'), 'export const a = 2;');
    assert.notEqual(readMemoryCodeFingerprint(root), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mergeCycle1Results merges timing and embedding_dirty', () => {
  const merged = mergeCycle1Results(
    {
      processed: 1,
      timing: { llmMs: 10, groupingCalls: 1 },
      embedding_dirty: { deferred: true, attempted: 1, succeeded: 1, failed: 0, failed_ids: [] },
    },
    {
      processed: 2,
      timing: { llmMs: 5, commitMs: 3 },
      embedding_dirty: { deferred: false, attempted: 2, succeeded: 1, failed: 1, failed_ids: [7] },
    }
  );
  assert.deepEqual(merged.timing, { llmMs: 15, groupingCalls: 1, commitMs: 3 });
  assert.deepEqual(merged.embedding_dirty, {
    deferred: false,
    attempted: 3,
    succeeded: 2,
    failed: 1,
    failed_ids: [7],
  });
});

test('runFullBackfill scope=workspace only ingests transcripts from the workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-'));
  try {
    const cwds = new Map();
    for (const [dir, cwd] of [
      ['p1', path.join(root, 'ws')],
      ['p2', path.join(root, 'other')],
    ]) {
      fs.mkdirSync(path.join(root, dir));
      const fp = path.join(root, dir, 's.jsonl');
      fs.writeFileSync(fp, '{}');
      cwds.set(fp, cwd);
    }
    const run = async (scope) => {
      const seen = [];
      const res = await runFullBackfill(
        { query: async () => ({ rows: [{ c: 0 }] }) },
        {
          window: 'all',
          scope,
          projectsRoot: root,
          workspaceCwd: path.join(root, 'ws'),
          cwdFromTranscriptPath: (fp) => cwds.get(fp),
          ingestTranscriptFile: async (fp) => {
            seen.push(fp);
            return 1;
          },
          runCycle1: async () => ({ processed: 0 }),
          flushEmbeddings: async () => ({ succeeded: 0 }),
        }
      );
      return { seen, res };
    };
    const ws = await run('workspace');
    assert.equal(ws.res.files, 1);
    assert.deepEqual(ws.seen, [path.join(root, 'p1', 's.jsonl')]);
    assert.equal((await run('all')).res.files, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('trace SIGTERM handler does not force exit and restores default only when sole', async () => {
  const db = {};
  const before = new Set(process.listeners('SIGTERM'));
  registerTraceExitDrain(db);
  const handler = process.listeners('SIGTERM').find((l) => !before.has(l));
  const realKill = process.kill;
  const realExit = process.exit;
  const calls = [];
  process.kill = (...a) => calls.push(['kill', ...a]);
  process.exit = (...a) => calls.push(['exit', ...a]);
  try {
    const other = () => {};
    process.on('SIGTERM', other);
    await handler();
    assert.deepEqual(calls, []);
    process.off('SIGTERM', other);

    // sole handler: re-register and expect default termination re-raised
    const solo = new Set(process.listeners('SIGTERM'));
    const db2 = {};
    registerTraceExitDrain(db2);
    const h2 = process.listeners('SIGTERM').find((l) => !solo.has(l));
    const others = process.listeners('SIGTERM').filter((l) => l !== h2);
    for (const l of others) process.off('SIGTERM', l);
    try {
      await h2();
    } finally {
      for (const l of others) process.on('SIGTERM', l);
    }
    assert.deepEqual(calls, [['kill', process.pid, 'SIGTERM']]);
  } finally {
    process.kill = realKill;
    process.exit = realExit;
  }
});
