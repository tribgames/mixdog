import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { settleSessionSummaryIndex } from './listing.mjs';
import { sweepStaleSessions } from './sweep/stale-sweep.mjs';
import { sweepRecordCacheStats } from './sweep/sweep-record.mjs';

const HOUR = 60 * 60 * 1000;

function writeSession(dir, doc, mtimeMs) {
  const path = join(dir, `${doc.id}.json`);
  writeFileSync(path, JSON.stringify(doc));
  if (mtimeMs) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

test('a session whose file changed between sweeps is judged from its new contents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-sweep-cache-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const sessionsDir = join(root, 'sessions');
    mkdirSync(sessionsDir);
    const old = Date.now() - 48 * HOUR;
    const open = {
      id: 'agent-open',
      owner: 'agent',
      agent: 'reviewer',
      status: 'idle',
      createdAt: old,
      updatedAt: old,
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 'y' },
      ],
    };
    const path = writeSession(sessionsDir, open, old);
    const options = { sweepIdle: false, tombstoneMaxAgeMs: HOUR, isSessionLive: () => false };

    // First pass: open record, nothing to reap; its verdict is now cached.
    let result = await sweepStaleSessions(options);
    assert.equal(result.tombstonesCleaned, 0);
    assert.equal(existsSync(path), true);

    // The file becomes a mature tombstone (new size and mtime): the second
    // pass must see the change instead of the cached open verdict.
    writeSession(sessionsDir, { ...open, closed: true, status: 'closed', updatedAt: old, messages: [] }, old + 1_000);
    result = await sweepStaleSessions(options);
    assert.equal(result.tombstonesCleaned, 1);
    assert.equal(existsSync(path), false);
  } finally {
    // The sweep's summary-index writes land after it returns; let them finish
    // before the data dir goes, or they recreate it.
    await settleSessionSummaryIndex();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a restarted process reuses the persisted verdicts of unchanged sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-sweep-persist-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  // A new process has no memory of earlier passes; moving the data dir away
  // and back drops the in-memory records the same way.
  const restart = () => {
    process.env.MIXDOG_DATA_DIR = join(root, 'elsewhere');
    sweepRecordCacheStats();
    process.env.MIXDOG_DATA_DIR = root;
  };
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const sessionsDir = join(root, 'sessions');
    mkdirSync(sessionsDir);
    const old = Date.now() - 48 * HOUR;
    const open = {
      id: 'agent-kept',
      owner: 'agent',
      agent: 'reviewer',
      status: 'idle',
      createdAt: old,
      updatedAt: old,
      messages: [{ role: 'user', content: 'x' }],
    };
    const path = writeSession(sessionsDir, open, old);
    const options = { sweepIdle: false, tombstoneMaxAgeMs: HOUR, isSessionLive: () => false };
    await sweepStaleSessions(options);
    const parsed = sweepRecordCacheStats().parses;

    restart();
    let result = await sweepStaleSessions(options);
    assert.equal(sweepRecordCacheStats().parses, parsed, 'an unchanged session is not parsed again');
    assert.equal(result.tombstonesCleaned, 0);
    assert.equal(existsSync(path), true);

    // Changed while no process was running: judged from its new contents.
    writeSession(sessionsDir, { ...open, closed: true, status: 'closed', messages: [] }, old + 1_000);
    restart();
    result = await sweepStaleSessions(options);
    assert.equal(result.tombstonesCleaned, 1);
    assert.equal(existsSync(path), false);
  } finally {
    await settleSessionSummaryIndex();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
