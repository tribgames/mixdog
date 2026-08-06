// Attach-on-resume liveness: a session whose owner process is GONE must never
// capture a cross-open surface in viewer mode — its submits would spool into a
// queue nobody drains ("Delivered to the live owner…" with no reply, silently
// dropped 30m later). Liveness signals that carry a pid are authoritative;
// pid-less ones fall back to the recorded client host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'mixowner-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const { isSessionOwnerGone } = await import('../src/runtime/agent/orchestrator/session/manager/session-lifecycle.mjs');
const { getStoreDir } = await import('../src/runtime/agent/orchestrator/session/store/paths-heartbeat.mjs');
const { drainForeignUserInjections } = await import('../src/runtime/agent/orchestrator/session/manager/pending-messages.mjs');

// A pid that existed and is now guaranteed gone.
const deadPid = (() => {
  const child = spawnSync(process.execPath, ['-e', '0']);
  return child.pid;
})();

const storeDir = getStoreDir();
function writeSession(id, extra = {}) {
  const now = Date.now();
  const session = {
    id, cwd: process.cwd(), owner: 'user', messages: [], tools: [],
    createdAt: now - 60_000, updatedAt: now, lastUsedAt: now,
    generation: 1, closed: false, ...extra,
  };
  writeFileSync(join(storeDir, `${id}.json`), JSON.stringify(session));
  return session;
}
const sidecar = (id, ext, ts, pid) => writeFileSync(
  join(storeDir, `${id}.${ext}`),
  pid === undefined ? `${ts}\n` : `${ts}\n${pid}\n`,
);
// attach decision == the negation of the viewer self-heal probe
const attaches = (id) => isSessionOwnerGone(id) === false;

test('fresh persisted heartbeat from a DEAD client host does not attach', () => {
  const id = `sess_${deadPid}_1_2_deadhost`;
  writeSession(id, { lastHeartbeatAt: Date.now() - 30_000, clientHostPid: deadPid });
  assert.equal(attaches(id), false, 'killed owner must release the session');
});

test('fresh persisted heartbeat from a LIVE client host still attaches', () => {
  const id = 'sess_1_2_3_livehost';
  writeSession(id, { lastHeartbeatAt: Date.now() - 30_000, clientHostPid: process.pid });
  assert.equal(attaches(id), true, 'live owner keeps single-writer protection');
});

test('session-id prefix pid is the fallback when no client host is recorded', () => {
  const id = `sess_${deadPid}_9_9_prefixonly`;
  writeSession(id, { lastHeartbeatAt: Date.now() - 10_000, clientHostPid: null });
  assert.equal(attaches(id), false, 'dead creator pid from the id prefix releases too');
});

test('fresh .hb sidecar written by a dead pid does not attach', () => {
  const id = 'sess_1_2_3_deadsidecar';
  writeSession(id, { lastHeartbeatAt: Date.now() - 10_000, clientHostPid: process.pid });
  sidecar(id, 'hb', Date.now(), deadPid);
  assert.equal(attaches(id), false, 'recorded sidecar pid outranks a live-looking host');
});

test('fresh .hb sidecar from a live pid attaches even when the recorded host died', () => {
  const id = `sess_${deadPid}_4_4_handoff`;
  writeSession(id, { lastHeartbeatAt: Date.now() - 10_000, clientHostPid: deadPid });
  sidecar(id, 'hb', Date.now(), process.pid);
  assert.equal(attaches(id), true, 'a live re-owner must not be clobbered');
});

test('fresh .own presence from a dead pid does not attach', () => {
  const id = 'sess_1_2_3_deadpresence';
  writeSession(id, { clientHostPid: process.pid });
  sidecar(id, 'own', Date.now(), deadPid);
  assert.equal(attaches(id), false, 'stale presence of a killed owner is cleared');
});

test('stale signals never attach', () => {
  const id = 'sess_1_2_3_cold';
  writeSession(id, { lastHeartbeatAt: Date.now() - 10 * 60_000, clientHostPid: process.pid });
  assert.equal(attaches(id), false);
});

test('foreign-drain mtime gate is per session, not per process', () => {
  const spoolPath = join(dataDir, 'session-pending-messages.json');
  const now = Date.now();
  const a = 'sess_1_2_3_spoola';
  const b = 'sess_1_2_3_spoolb';
  writeFileSync(spoolPath, JSON.stringify({
    version: 1, updatedAt: now,
    sessions: {
      [a]: [{ id: 'fa', message: 'for A', enqueuedAt: now }],
      [b]: [{ id: 'fb', message: 'for B', enqueuedAt: now }],
    },
    sessionTouchedAt: { [a]: now, [b]: now },
  }));
  assert.deepEqual(drainForeignUserInjections(a), [{ text: 'for A', id: 'fa' }]);
  assert.deepEqual(drainForeignUserInjections(b), [{ text: 'for B', id: 'fb' }], 'sibling session must not lose its wake-up');
  const store = JSON.parse(readFileSync(spoolPath, 'utf8'));
  assert.equal(store.sessions[a], undefined);
  assert.equal(store.sessions[b], undefined);
});

test.after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
