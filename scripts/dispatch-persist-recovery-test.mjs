// Regression tests for recoverPending recovery bugs:
//  (a) an entry must survive when notifyFn resolves false (not delivered) and
//      only be removed after a confirmed (truthy) ack.
//  (b) a scoped recovery that matches purely on clientHostPid must NOT stamp
//      the reconnecting filter session's id onto another session's abort — it
//      delivers to the true owner session, and leaves the entry persisted when
//      there is no owner session to target.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addPending,
  recoverPending,
} from '../src/runtime/agent/orchestrator/dispatch-persist.mjs';

const FILE = 'pending-dispatches.json';

function readMap(dir) {
  try {
    const raw = readFileSync(join(dir, FILE), 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch { return {}; }
}

async function waitFor(fn, { timeout = 3000, step = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'dpersist-'));
  return dir;
}

test('(a) only explicit false/0 keeps entry; undefined/void resolve deletes', async () => {
  const dir = tmp();
  try {
    addPending(dir, 'h-a', 'recall', ['q'], 'sid-owner', 1111);
    await waitFor(() => 'h-a' in readMap(dir));

    // Explicit false → undelivered, entry MUST survive for retry.
    recoverPending(dir, () => Promise.resolve(false), {});
    await new Promise((r) => setTimeout(r, 200));
    assert.ok('h-a' in readMap(dir), 'entry removed despite notifyFn=false');

    // Explicit 0 → also undelivered, entry survives.
    recoverPending(dir, () => Promise.resolve(0), {});
    await new Promise((r) => setTimeout(r, 200));
    assert.ok('h-a' in readMap(dir), 'entry removed despite notifyFn=0');

    // undefined/void resolve from a delivered notifyFn → entry removed.
    recoverPending(dir, () => Promise.resolve(undefined), {});
    const gone = await waitFor(() => !('h-a' in readMap(dir)));
    assert.ok(gone, 'entry not removed after undefined (delivered) resolve');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(b) hostPid-only match delivers to true owner session, never the filter session', async () => {
  const dir = tmp();
  try {
    addPending(dir, 'h-b', 'recall', ['q'], 'owner-A', 4242);
    await waitFor(() => 'h-b' in readMap(dir));

    let seen = null;
    // Reconnect as a DIFFERENT session that only shares the host pid.
    recoverPending(dir, (content, meta) => { seen = meta; return Promise.resolve(true); }, {
      sessionId: 'session-B',
      clientHostPid: 4242,
    });
    await waitFor(() => seen != null);
    assert.equal(seen.caller_session_id, 'owner-A', 'stamped filter session instead of true owner');
    assert.notEqual(seen.caller_session_id, 'session-B');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(b) hostPid-only match with no owner session is left persisted, not injected', async () => {
  const dir = tmp();
  try {
    addPending(dir, 'h-c', 'recall', ['q'], null, 5353);
    await waitFor(() => 'h-c' in readMap(dir));

    let called = false;
    recoverPending(dir, () => { called = true; return Promise.resolve(true); }, {
      sessionId: 'session-C',
      clientHostPid: 5353,
    });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(called, false, 'notifyFn fired for an entry with no owner session');
    assert.ok('h-c' in readMap(dir), 'entry with no owner session was not left persisted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('owner-session match still stamps the reconnecting session id', async () => {
  const dir = tmp();
  try {
    addPending(dir, 'h-d', 'recall', ['q'], 'prior-sid', 6464);
    await waitFor(() => 'h-d' in readMap(dir));

    let seen = null;
    recoverPending(dir, (content, meta) => { seen = meta; return Promise.resolve(true); }, {
      sessionId: 'new-sid',
      priorSessionId: 'prior-sid',
      clientHostPid: 6464,
    });
    await waitFor(() => seen != null);
    assert.equal(seen.caller_session_id, 'new-sid', 'owner match should stamp reconnecting session id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('priorSessionId match with no current sessionId keeps the entry owner cid', async () => {
  const dir = tmp();
  try {
    addPending(dir, 'h-e', 'recall', ['q'], 'prior-sid', 7575);
    await waitFor(() => 'h-e' in readMap(dir));

    let seen = null;
    // priorSessionId matches the owner but no current sessionId is supplied →
    // filterSid is null; must fall back to the entry's known owner cid.
    recoverPending(dir, (content, meta) => { seen = meta; return Promise.resolve(true); }, {
      priorSessionId: 'prior-sid',
    });
    await waitFor(() => seen != null);
    assert.equal(seen.caller_session_id, 'prior-sid', 'dropped known owner cid when sessionId absent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
