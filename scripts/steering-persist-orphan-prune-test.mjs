// Orphan pruning: session-pending-messages.json buckets from sessions closed
// long ago can never be restored (restore is keyed by the live session id),
// so drain must prune fully-stale foreign buckets while leaving fresh foreign
// buckets (another live window) untouched. Observed live: queued rows from
// sessions closed days earlier lingering in the store forever.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-steer-prune-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const { drainTuiSteeringPersist } = await import('../src/tui/session/tui-steering-persist.mjs');

const FILE = join(dataDir, 'session-pending-messages.json');
const now = Date.now();
const STALE = now - 2 * 60 * 60 * 1000; // 2h ago (TTL is 30min)

test('drain restores own fresh rows, prunes stale foreign buckets, keeps fresh foreign buckets', async () => {
  writeFileSync(FILE, JSON.stringify({
    version: 1,
    updatedAt: now,
    sessions: {
      tui_live1: [{ id: 'ts_a', text: 'restore me', at: now - 60_000 }],
      // Legacy string rows age from sessionTouchedAt — days-old orphan.
      tui_dead1: ['orphaned notification text'],
      tui_dead2: [{ id: 'ts_b', text: 'old row', at: STALE }],
      tui_fresh_other: [{ id: 'ts_c', text: 'another live window', at: now - 30_000 }],
    },
    sessionTouchedAt: {
      tui_live1: now - 60_000,
      tui_dead1: STALE,
      tui_dead2: STALE,
      tui_fresh_other: now - 30_000,
    },
  }));

  const drained = await drainTuiSteeringPersist('live1');
  assert.equal(drained.length, 1);
  assert.equal(drained[0].text, 'restore me');

  const store = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.equal(store.sessions.tui_live1, undefined, 'own bucket consumed');
  assert.equal(store.sessions.tui_dead1, undefined, 'stale legacy orphan pruned');
  assert.equal(store.sessions.tui_dead2, undefined, 'stale row-orphan pruned');
  assert.ok(store.sessions.tui_fresh_other, 'fresh foreign bucket untouched');
  assert.equal(store.sessionTouchedAt.tui_dead1, undefined);
  assert.equal(store.sessionTouchedAt.tui_dead2, undefined);
});
