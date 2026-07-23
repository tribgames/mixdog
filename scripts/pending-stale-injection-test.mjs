// Stale-injection gate: genuine user/steering entries older than the replay
// window (30m) must NOT fire into a session on hydrate/foreign-drain/TUI
// steering restore — they are removed from the spool instead (user report:
// re-entering a session suddenly injected days-old queued messages).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect the spool to a throwaway dir before import so the real
// ~/.mixdog/data spool is never touched.
const dataDir = mkdtempSync(join(tmpdir(), 'mixstale-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const {
  hydratePendingMessages,
  drainPendingMessages,
  drainForeignUserInjections,
  acknowledgePendingMessages,
} = await import('../src/runtime/agent/orchestrator/session/manager/pending-messages.mjs');
const { appendTuiSteeringPersist, drainTuiSteeringPersist, flushTuiSteeringPersist } =
  await import('../src/tui/engine/tui-steering-persist.mjs');

const spoolPath = join(dataDir, 'session-pending-messages.json');
const HOUR = 60 * 60 * 1000;
const texts = (entries) => entries.map((m) => (typeof m === 'string' ? m : m.text));

function writeSpool(mutate) {
  let store = { version: 1, updatedAt: Date.now(), sessions: {}, sessionTouchedAt: {} };
  try { store = JSON.parse(readFileSync(spoolPath, 'utf8')); } catch { /* fresh */ }
  mutate(store);
  writeFileSync(spoolPath, JSON.stringify(store));
}

test('hydrate drops stale user entries and keeps fresh ones', async () => {
  const sid = 'sess_stale_hydrate';
  const now = Date.now();
  writeSpool((store) => {
    store.sessions[sid] = [
      { id: 'stale_a', message: 'queued two hours ago', enqueuedAt: now - 2 * HOUR },
      { id: 'fresh_a', message: 'queued just now', enqueuedAt: now - 1000 },
    ];
    store.sessionTouchedAt[sid] = now - 1000;
  });

  assert.equal(await hydratePendingMessages(sid), 1, 'only the fresh entry hydrates');
  const delivered = drainPendingMessages(sid);
  assert.deepEqual(texts(delivered), ['queued just now']);
  acknowledgePendingMessages(sid, delivered);
  await new Promise((r) => setTimeout(r, 30));
  const store = JSON.parse(readFileSync(spoolPath, 'utf8'));
  assert.equal(store.sessions[sid], undefined, 'stale entry removed from the spool, not deferred');
});

test('foreign drain injects fresh submits and silently removes stale ones', () => {
  const sid = 'sess_stale_foreign';
  const now = Date.now();
  writeSpool((store) => {
    store.sessions[sid] = [
      { id: 'foreign_stale', message: 'stale cross-surface submit', enqueuedAt: now - 3 * HOUR },
      { id: 'foreign_fresh', message: 'fresh cross-surface submit', enqueuedAt: now - 5000 },
    ];
    store.sessionTouchedAt[sid] = now - 5000;
  });

  const taken = drainForeignUserInjections(sid);
  assert.deepEqual(taken, ['fresh cross-surface submit']);
  const store = JSON.parse(readFileSync(spoolPath, 'utf8'));
  assert.equal(store.sessions[sid], undefined, 'stale foreign submit removed alongside the drain');
});

test('legacy string entries age from sessionTouchedAt, not the store updatedAt', async () => {
  const sid = 'sess_stale_legacy';
  const now = Date.now();
  writeSpool((store) => {
    // Legacy plain-string queue (pre-id era) whose session was last touched
    // days ago; the store-wide updatedAt is fresh (any unrelated write).
    store.sessions[sid] = ['days-old legacy message'];
    store.sessionTouchedAt[sid] = now - 3 * 24 * HOUR;
    store.updatedAt = now;
  });

  assert.equal(await hydratePendingMessages(sid), 0, 'stale legacy string never hydrates');
  assert.deepEqual(drainPendingMessages(sid), []);
  assert.deepEqual(drainForeignUserInjections(sid), [], 'stale legacy string never foreign-injects');
});

test('TUI steering restore drops stale rows and keeps fresh ones', async () => {
  const lead = 'sess_stale_steering';
  await appendTuiSteeringPersist(lead, { text: 'fresh steering row' });
  await flushTuiSteeringPersist();
  writeSpool((store) => {
    // Simulate a stale leftover row from a long-dead TUI (old per-row stamp).
    store.sessions[`tui_${lead}`].unshift({ id: 'ts_old', text: 'stale steering row', at: Date.now() - 2 * HOUR });
  });

  const drained = await drainTuiSteeringPersist(lead);
  assert.deepEqual(drained.map((row) => row.text), ['fresh steering row']);
  const store = JSON.parse(readFileSync(spoolPath, 'utf8'));
  assert.equal(store.sessions[`tui_${lead}`], undefined, 'steering key fully consumed');
});

test('TUI steering rows without stamps age from the key touch time', async () => {
  const lead = 'sess_stale_steering_legacy';
  writeSpool((store) => {
    store.sessions[`tui_${lead}`] = [{ id: 'ts_legacy', text: 'legacy stampless row' }];
    store.sessionTouchedAt[`tui_${lead}`] = Date.now() - 2 * HOUR;
  });
  const drained = await drainTuiSteeringPersist(lead);
  assert.deepEqual(drained, [], 'stampless stale row dropped by key age');
});

test.after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
