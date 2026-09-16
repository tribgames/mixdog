import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createTagRegistry } from './tag-registry.mjs';

const HOUR_MS = 60 * 60 * 1000;
const HOST_PID = 4242;

const iso = (ms) => new Date(ms).toISOString();

function makeRegistry(root, mgr) {
  return createTagRegistry({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    mgr,
    emitSubagentEvent: () => {},
  });
}

// anthropic-oauth resolves to the 60m terminal window (resolveAgentTerminalReapMs).
// `updatedAt` may be an ISO string, an epoch-ms number (session-service stamps
// Date.now()) or a numeric string (the same value after a JSON row round-trip).
function workerSession(id, tag, { status = 'idle', updatedAt, createdAt } = {}) {
  return {
    id,
    agentTag: tag,
    ownerSessionId: 'lead-a',
    parentSessionId: 'lead-a',
    agent: 'reviewer',
    provider: 'anthropic-oauth',
    clientHostPid: HOST_PID,
    status,
    createdAt: createdAt || updatedAt,
    updatedAt,
    lastUsedAt: updatedAt,
  };
}

function fakeManager(sessions) {
  const hidden = [];
  const unloaded = [];
  return {
    hidden,
    unloaded,
    getSession: (id) => sessions.get(id) || null,
    listSessions: () => [...sessions.values()].filter((session) => session.closed !== true),
    getSessionRuntime: () => null,
    hideSessionFromList: (id) => { hidden.push(id); },
    unloadSessionRuntime: (id) => { unloaded.push(id); },
  };
}

function writeWorkers(root, workers) {
  writeFileSync(join(root, 'agent-workers.json'), JSON.stringify({ version: 2, workers }));
}

function readStored(root) {
  return JSON.parse(readFileSync(join(root, 'agent-workers.json'), 'utf8'));
}

function storedRows(root) {
  return Object.values(readStored(root).workers || {});
}

function storedTombstones(root) {
  return Object.values(readStored(root).tombstones || {});
}

test('session scan does not resurrect a session the reaper just tombstoned', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-tag-reap-scan-'));
  const now = Date.now();
  const finishedAt = iso(now - 2 * HOUR_MS);
  // The reaper leaves the session record open (the transcript belongs to the
  // parent tab), so it is still listed by the manager after the reap.
  const session = workerSession('child-a', 'review1', { updatedAt: finishedAt });
  const mgr = fakeManager(new Map([[session.id, session]]));
  try {
    writeWorkers(root, {
      'child-a': {
        tag: 'review1',
        sessionId: 'child-a',
        ownerSessionId: 'lead-a',
        agent: 'reviewer',
        provider: 'anthropic-oauth',
        clientHostPid: HOST_PID,
        status: 'idle',
        stage: 'idle',
        updatedAt: finishedAt,
        finishedAt,
      },
    });

    // Boot recovery: the 60m window elapsed long ago -> reap + tombstone.
    const registry = makeRegistry(root, mgr);
    assert.deepEqual(storedRows(root), []);
    assert.equal(storedTombstones(root).some((row) => row.tag === 'review1'), true);
    assert.equal(mgr.hidden.includes('child-a'), true);

    registry.refreshTagsFromSessions({ scanSessions: true });
    registry.flushWorkerIndexMutations();
    assert.deepEqual(storedRows(root), []);
    assert.equal(registry.tags.has('review1'), false);

    assert.deepEqual(registry.agentSessionEntries({ scanSessions: true }), []);
    registry.flushWorkerIndexMutations();
    assert.deepEqual(storedRows(root), []);
    assert.equal(storedTombstones(root).filter((row) => row.tag === 'review1').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanned terminal sessions keep their own stamps and elapsed leases reap at once', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-tag-rebind-stamps-'));
  const now = Date.now();
  const staleStamp = iso(now - 2 * HOUR_MS);
  const recentStamp = iso(now - 10 * 60 * 1000);
  const sessions = new Map([
    ['stale-child', workerSession('stale-child', 'stale1', { updatedAt: staleStamp })],
    ['recent-child', workerSession('recent-child', 'recent1', { updatedAt: recentStamp })],
  ]);
  const mgr = fakeManager(sessions);
  const registry = makeRegistry(root, mgr);
  try {
    registry.refreshTagsFromSessions({ scanSessions: true });
    registry.flushWorkerIndexMutations();

    // Elapsed window: reaped immediately instead of buying a fresh one.
    assert.equal(storedRows(root).some((row) => row.sessionId === 'stale-child'), false);
    assert.equal(storedTombstones(root).some((row) => row.tag === 'stale1'), true);
    assert.equal(mgr.hidden.includes('stale-child'), true);
    assert.equal(registry.tags.has('stale1'), false);

    // Still inside the window: the row inherits the session's terminal stamps
    // and the deadline is derived from them, not from the scan.
    const recent = storedRows(root).find((row) => row.sessionId === 'recent-child');
    assert.ok(recent);
    assert.equal(recent.updatedAt, recentStamp);
    assert.equal(recent.finishedAt, recentStamp);
    assert.equal(recent.reapAt, iso(Date.parse(recentStamp) + HOUR_MS));
    assert.equal(registry.reapTimers.has('recent-child'), true);
  } finally {
    registry.cancelReap('recent-child');
    rmSync(root, { recursive: true, force: true });
  }
});

test('repeated list reads never extend a terminal row lease', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-tag-list-lease-'));
  const recentStamp = iso(Date.now() - 10 * 60 * 1000);
  const session = workerSession('idle-child', 'idle1', { updatedAt: recentStamp });
  const mgr = fakeManager(new Map([[session.id, session]]));
  const registry = makeRegistry(root, mgr);
  try {
    registry.refreshTagsFromSessions({ scanSessions: true });
    registry.flushWorkerIndexMutations();
    const first = storedRows(root).find((row) => row.sessionId === 'idle-child');
    assert.ok(first);
    assert.equal(first.updatedAt, recentStamp);

    for (let i = 0; i < 3; i += 1) {
      registry.refreshTagsFromSessions({ scanSessions: true });
      const entries = registry.agentSessionEntries({ scanSessions: true });
      assert.equal(entries.some((entry) => entry.tag === 'idle1'), true);
      registry.flushWorkerIndexMutations();
      const row = storedRows(root).find((entry) => entry.sessionId === 'idle-child');
      assert.ok(row);
      assert.equal(row.updatedAt, first.updatedAt);
      assert.equal(row.finishedAt, first.finishedAt);
      assert.equal(row.reapAt, first.reapAt);
    }
  } finally {
    registry.cancelReap('idle-child');
    rmSync(root, { recursive: true, force: true });
  }
});

// session-service (session-service/agent-tree.mjs) stamps createdAt/updatedAt as
// Date.now() numbers, and the row store hands them back as numeric strings.
for (const [label, encode] of [
  ['numeric', (ms) => ms],
  ['numeric string', (ms) => String(ms)],
]) {
  test(`terminal sessions with ${label} stamps reap on their own deadline`, () => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-tag-numeric-stamp-'));
    const now = Date.now();
    const staleMs = now - 2 * HOUR_MS;
    const recentMs = now - 10 * 60 * 1000;
    const sessions = new Map([
      ['stale-child', workerSession('stale-child', 'stale1', { updatedAt: encode(staleMs) })],
      ['recent-child', workerSession('recent-child', 'recent1', { updatedAt: encode(recentMs) })],
    ]);
    const mgr = fakeManager(sessions);
    const registry = makeRegistry(root, mgr);
    try {
      registry.refreshTagsFromSessions({ scanSessions: true });
      registry.flushWorkerIndexMutations();

      assert.equal(storedRows(root).some((row) => row.sessionId === 'stale-child'), false);
      assert.equal(storedTombstones(root).some((row) => row.tag === 'stale1'), true);
      assert.equal(mgr.hidden.includes('stale-child'), true);

      const recent = storedRows(root).find((row) => row.sessionId === 'recent-child');
      assert.ok(recent);
      assert.equal(recent.updatedAt, iso(recentMs));
      assert.equal(recent.finishedAt, iso(recentMs));
      assert.equal(recent.reapAt, iso(recentMs + HOUR_MS));

      for (let i = 0; i < 3; i += 1) {
        registry.refreshTagsFromSessions({ scanSessions: true });
        registry.agentSessionEntries({ scanSessions: true });
        registry.flushWorkerIndexMutations();
        const row = storedRows(root).find((entry) => entry.sessionId === 'recent-child');
        assert.ok(row);
        assert.equal(row.updatedAt, recent.updatedAt);
        assert.equal(row.reapAt, recent.reapAt);
      }
      assert.equal(storedRows(root).some((row) => row.sessionId === 'stale-child'), false);
    } finally {
      registry.cancelReap('recent-child');
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('tag reuse after a reap consumes the tombstone and binds the fresh session', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-tag-reuse-'));
  const now = Date.now();
  const finishedAt = iso(now - 2 * HOUR_MS);
  const reaped = workerSession('child-a', 'review1', { updatedAt: finishedAt });
  const sessions = new Map([[reaped.id, reaped]]);
  const mgr = fakeManager(sessions);
  try {
    writeWorkers(root, {
      'child-a': {
        tag: 'review1',
        sessionId: 'child-a',
        ownerSessionId: 'lead-a',
        agent: 'reviewer',
        provider: 'anthropic-oauth',
        clientHostPid: HOST_PID,
        status: 'idle',
        stage: 'idle',
        updatedAt: finishedAt,
        finishedAt,
      },
    });
    const registry = makeRegistry(root, mgr);
    const context = { clientHostPid: HOST_PID };

    // Spawn path: the tombstone still proves tag ownership and is consumed.
    const tombstone = registry.tagTombstoneForTag('review1', context);
    assert.ok(tombstone);
    assert.equal(tombstone.agent, 'reviewer');
    assert.equal(registry.consumeTagTombstone(tombstone), true);
    assert.equal(registry.tagTombstoneForTag('review1', context), null);

    const respawned = workerSession('child-b', 'review1', {
      status: 'running',
      updatedAt: iso(now),
    });
    sessions.set(respawned.id, respawned);
    registry.bindTag('review1', respawned, { status: 'running', stage: 'running' });
    registry.flushWorkerIndexMutations();

    assert.equal(registry.tags.get('review1'), 'child-b');
    const row = storedRows(root).find((entry) => entry.sessionId === 'child-b');
    assert.ok(row);
    assert.equal(row.tag, 'review1');
    assert.equal(row.status, 'running');
    assert.equal(row.reapAt, null);

    // A following scan keeps the live binding (no tombstone left to block it).
    registry.refreshTagsFromSessions({ scanSessions: true, context });
    registry.flushWorkerIndexMutations();
    assert.equal(registry.tags.get('review1'), 'child-b');
    assert.equal(storedRows(root).some((entry) => entry.sessionId === 'child-b'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
