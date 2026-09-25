import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { settleSessionSummaryIndex, sweepStaleSessions, sweepStaleSessionsCooperative } from './listing.mjs';

// The stale-session sweep against a real temp store: which records it closes,
// deletes, prunes or leaves untouched, and what it reports for each.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const CONVERSATION = [
  { role: 'user', content: 'x' },
  { role: 'assistant', content: 'y' },
];

async function withStore(t, run) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-sweep-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const dir = join(root, 'sessions');
  mkdirSync(dir);
  t.after(async () => {
    // After the sweep returns, its summary-index rebuild worker (spawned by
    // the cold listing of this fresh store) and its deferred prune/upsert
    // flush still write into this data dir, and the flush resolves the index
    // path when it runs: let both finish HERE before the data dir is switched
    // back or removed.
    await settleSessionSummaryIndex();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const now = Date.now();
  const write = (doc, at = doc.updatedAt) => {
    const path = join(dir, `${doc.id}.json`);
    writeFileSync(path, JSON.stringify({ createdAt: at, updatedAt: at, messages: CONVERSATION, ...doc }));
    utimesSync(path, at / 1000, at / 1000);
    return path;
  };
  const sidecar = (name, at) => {
    const path = join(dir, name);
    writeFileSync(path, String(at));
    utimesSync(path, at / 1000, at / 1000);
    return path;
  };
  const read = (id) => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf-8'));
  const exists = (id) => existsSync(join(dir, `${id}.json`));
  await run({ dir, now, write, sidecar, read, exists });
}

test('tombstone pass: mature closed sessions are deleted, young ones kept, open ones untouched', async (t) => {
  await withStore(t, async ({ now, write, exists }) => {
    write({ id: 'old-tomb', owner: 'agent', closed: true, status: 'closed', updatedAt: now - 3 * HOUR });
    write({ id: 'young-tomb', owner: 'agent', closed: true, status: 'closed', updatedAt: now - 10 * MINUTE });
    write({ id: 'open-idle', owner: 'agent', status: 'idle', updatedAt: now - 3 * HOUR });
    const result = sweepStaleSessions({ sweepIdle: false, tombstoneMaxAgeMs: HOUR, isSessionLive: () => false });
    assert.equal(result.tombstonesCleaned, 1);
    assert.deepEqual(
      result.tombstoneDetails.map((d) => d.id),
      ['old-tomb']
    );
    assert.equal(result.cleaned, 0, 'a tombstone-only pass never closes open sessions');
    assert.equal(result.remaining, 2);
    assert.equal(exists('old-tomb'), false);
    assert.equal(exists('young-tomb'), true);
    assert.equal(exists('open-idle'), true);
  });
});

test('idle pass: a stale agent session is closed with its idle minutes, a running or fresh one is kept', async (t) => {
  await withStore(t, async ({ now, write, read }) => {
    write({ id: 'stale-agent', owner: 'agent', status: 'idle', updatedAt: now - 3 * HOUR });
    write({ id: 'fresh-agent', owner: 'agent', status: 'idle', updatedAt: now - MINUTE });
    write({ id: 'running-agent', owner: 'agent', status: 'running', updatedAt: now - 8 * MINUTE });
    write({ id: 'zombie-agent', owner: 'agent', status: 'running', updatedAt: now - 20 * MINUTE });
    const result = sweepStaleSessions(5 * MINUTE, { isSessionLive: () => false });
    assert.equal(result.cleaned, 2);
    assert.deepEqual(result.details.map((d) => [d.id, d.owner]).sort(), [
      ['stale-agent', 'agent'],
      ['zombie-agent', 'agent'],
    ]);
    assert.equal(result.details.find((d) => d.id === 'stale-agent').idleMinutes, 180);
    assert.equal(result.remaining, 2);
    assert.equal(read('stale-agent').closed, true);
    assert.equal(read('zombie-agent').closed, true);
    assert.equal(read('fresh-agent').closed, undefined);
    assert.equal(read('running-agent').closed, undefined);
  });
});

test('user-owned conversations are never closed; a cold blank scratch is reaped instead', async (t) => {
  await withStore(t, async ({ now, write, read, exists }) => {
    write({ id: 'user-chat', owner: 'user', status: 'idle', updatedAt: now - 3 * DAY });
    write({ id: 'blank-cold', owner: 'user', status: 'idle', updatedAt: now - 2 * HOUR, messages: [] });
    write({ id: 'blank-warm', owner: 'user', status: 'idle', updatedAt: now - 10 * MINUTE, messages: [] });
    const result = sweepStaleSessions(5 * MINUTE, { isSessionLive: () => false });
    assert.equal(result.cleaned, 0);
    assert.equal(result.openPruned, 1);
    assert.deepEqual(
      result.openPrunedDetails.map((d) => d.id),
      ['blank-cold']
    );
    assert.equal(read('user-chat').closed, undefined);
    assert.equal(exists('blank-cold'), false);
    assert.equal(exists('blank-warm'), true);
  });
});

test('a live session is protected from close, prune and tombstone deletion', async (t) => {
  await withStore(t, async ({ now, write, read, exists }) => {
    write({ id: 'live-agent', owner: 'agent', status: 'idle', updatedAt: now - 3 * HOUR });
    write({ id: 'live-tomb', owner: 'agent', closed: true, status: 'closed', updatedAt: now - 3 * HOUR });
    const result = sweepStaleSessions({ ttlMs: 5 * MINUTE, tombstoneMaxAgeMs: HOUR, isSessionLive: () => true });
    assert.equal(result.cleaned, 0);
    assert.equal(result.tombstonesCleaned, 0);
    assert.equal(result.remaining, 2);
    assert.equal(read('live-agent').closed, undefined);
    assert.equal(exists('live-tomb'), true);
  });
});

test('retention cap keeps the newest open ephemeral sessions and prunes the rest oldest-first', async (t) => {
  await withStore(t, async ({ now, write, exists }) => {
    for (let i = 0; i < 5; i += 1) {
      write({ id: `agent-${i}`, owner: 'agent', status: 'idle', updatedAt: now - (i + 1) * MINUTE });
    }
    write({ id: 'user-old', owner: 'user', status: 'idle', updatedAt: now - 30 * DAY });
    const result = sweepStaleSessions(HOUR, { isSessionLive: () => false, openMaxCount: 2, openMaxAgeMs: 20 * DAY });
    assert.equal(result.openPruned, 3);
    assert.deepEqual(
      result.openPrunedDetails.map((d) => d.id),
      ['agent-2', 'agent-3', 'agent-4']
    );
    assert.equal(result.remaining, 3, 'two kept agents plus the user session');
    assert.equal(exists('agent-0'), true);
    assert.equal(exists('agent-1'), true);
    assert.equal(exists('user-old'), true, 'user history is never capped');
  });
});

test('orphan heartbeat/presence sidecars older than the TTL are removed; fresh or owned ones stay', async (t) => {
  await withStore(t, async ({ now, write, sidecar }) => {
    write({ id: 'owned', owner: 'agent', status: 'idle', updatedAt: now });
    const ownedHb = sidecar('owned.hb', now - HOUR);
    const staleHb = sidecar('gone.hb', now - HOUR);
    const staleOwn = sidecar('gone.own', now - HOUR);
    const freshHb = sidecar('starting.hb', now - MINUTE);
    const result = sweepStaleSessions(5 * MINUTE, { isSessionLive: () => false });
    assert.equal(result.cleaned, 2);
    assert.equal(existsSync(ownedHb), true);
    assert.equal(existsSync(staleHb), false);
    assert.equal(existsSync(staleOwn), false);
    assert.equal(existsSync(freshHb), true);
  });
});

test('a record naming a different id, or a child of a present parent, is left exactly as it is', async (t) => {
  await withStore(t, async ({ dir, now, write, exists, read }) => {
    const foreign = join(dir, 'claimed.json');
    writeFileSync(
      foreign,
      JSON.stringify({ id: 'other', owner: 'agent', closed: true, status: 'closed', updatedAt: now - 3 * HOUR })
    );
    utimesSync(foreign, (now - 3 * HOUR) / 1000, (now - 3 * HOUR) / 1000);
    write({ id: 'parent', owner: 'user', status: 'idle', updatedAt: now - 3 * DAY });
    write({ id: 'child', owner: 'agent', ownerSessionId: 'parent', status: 'idle', updatedAt: now - 3 * DAY });
    const result = sweepStaleSessions({ ttlMs: 5 * MINUTE, tombstoneMaxAgeMs: HOUR, isSessionLive: () => false });
    assert.equal(result.tombstonesCleaned, 0);
    assert.equal(result.cleaned, 0);
    assert.equal(existsSync(foreign), true);
    assert.equal(exists('child'), true);
    assert.equal(read('child').closed, undefined);
  });
});

test('the cooperative sweep reaches the same verdicts as the synchronous one', async (t) => {
  await withStore(t, async ({ now, write, read }) => {
    write({ id: 'stale-agent', owner: 'agent', status: 'idle', updatedAt: now - 3 * HOUR });
    write({ id: 'old-tomb', owner: 'agent', closed: true, status: 'closed', updatedAt: now - 3 * HOUR });
    const result = await sweepStaleSessionsCooperative({
      ttlMs: 5 * MINUTE,
      tombstoneMaxAgeMs: HOUR,
      isSessionLive: () => false,
      cooperativeSliceMs: 0,
    });
    assert.equal(result.cleaned, 1);
    assert.equal(result.tombstonesCleaned, 1);
    assert.equal(read('stale-agent').closed, true);
  });
});
