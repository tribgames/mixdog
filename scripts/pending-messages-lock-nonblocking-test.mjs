import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'mixpend-lock-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const {
  hydratePendingMessages,
  drainPendingMessages,
  drainForeignUserInjections,
  acknowledgePendingMessages,
} = await import('../src/runtime/agent/orchestrator/session/manager/pending-messages.mjs');

test('held pending spool lock does not block the completion-loop drain', async () => {
  const sid = 'sess_lock_held';
  const spool = join(dataDir, 'session-pending-messages.json');
  const lock = `${spool}.lock`;
  // Let the module's one-shot orphan sweep complete before reproducing the
  // runtime completion scenario; the debugger lock is acquired mid-session.
  await new Promise((resolve) => setImmediate(resolve));
  writeFileSync(spool, JSON.stringify({
    version: 1,
    updatedAt: Date.now(),
    sessions: { [sid]: ['persisted steering'] },
    sessionTouchedAt: { [sid]: Date.now() },
  }));
  // A live-pid foreign token is deliberately not stale-reclaimable.
  writeFileSync(lock, `${process.pid} ${Date.now()} debugger-held-lock\n`);

  const started = Date.now();
  let loopTickAt = 0;
  const loopTick = new Promise((resolve) => {
    setTimeout(() => {
      loopTickAt = Date.now();
      resolve();
    }, 25);
  });
  const hydration = hydratePendingMessages(sid);

  // The terminal path is synchronous but now memory-only.
  assert.deepEqual(drainPendingMessages(sid), []);
  await loopTick;
  assert.ok(loopTickAt - started < 250, `event loop stalled ${loopTickAt - started}ms`);

  await new Promise((resolve) => setTimeout(resolve, 1000));
  unlinkSync(lock);
  await hydration;
  const delivered = drainPendingMessages(sid);
  assert.deepEqual(delivered.map((entry) => entry.text), ['persisted steering']);
  const stored = JSON.parse(readFileSync(spool, 'utf8'));
  assert.equal(stored.sessions[sid].length, 1, 'hydrate is read-only until delivery ack');
  acknowledgePendingMessages(sid, delivered);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const acknowledged = JSON.parse(readFileSync(spool, 'utf8'));
  assert.equal(acknowledged.sessions[sid], undefined);
});

test('foreign-injection polling never waits on a live spool writer', async () => {
  const sid = 'sess_foreign_lock_held';
  const spool = join(dataDir, 'session-pending-messages.json');
  const lock = `${spool}.lock`;
  writeFileSync(spool, JSON.stringify({
    version: 1,
    updatedAt: Date.now(),
    sessions: { [sid]: [{ id: 'foreign-1', message: 'from another surface', enqueuedAt: Date.now() }] },
    sessionTouchedAt: { [sid]: Date.now() },
  }));
  writeFileSync(lock, `${process.pid} ${Date.now()} async-writer\n`);
  const started = Date.now();
  assert.deepEqual(await drainForeignUserInjections(sid), []);
  assert.ok(Date.now() - started < 50, `foreign drain blocked ${Date.now() - started}ms`);
  unlinkSync(lock);
  assert.deepEqual(await drainForeignUserInjections(sid), [
    { text: 'from another surface', id: 'foreign-1' },
  ]);
});

test('64 session injection polls collapse into one non-blocking spool batch', async () => {
  const spool = join(dataDir, 'session-pending-messages.json');
  const now = Date.now();
  const sessionIds = Array.from({ length: 64 }, (_, index) => `sess_batch_${index}`);
  writeFileSync(spool, JSON.stringify({
    version: 1,
    updatedAt: now,
    sessions: Object.fromEntries(sessionIds.map((sid, index) => [
      sid,
      [{ id: `foreign-${index}`, message: `message-${index}`, enqueuedAt: now }],
    ])),
    sessionTouchedAt: Object.fromEntries(sessionIds.map((sid) => [sid, now])),
  }));
  let loopTicked = false;
  setTimeout(() => { loopTicked = true; }, 0);
  const started = Date.now();
  const drained = await Promise.all(sessionIds.map((sid) => drainForeignUserInjections(sid)));
  assert.equal(loopTicked, true, 'batch yields to the event loop before filesystem work');
  assert.ok(Date.now() - started < 500, `batched drains took ${Date.now() - started}ms`);
  assert.deepEqual(
    drained.map((entries) => entries[0]?.text),
    sessionIds.map((_, index) => `message-${index}`),
  );
  const stored = JSON.parse(readFileSync(spool, 'utf8'));
  assert.equal(Object.keys(stored.sessions).length, 0);
});

test.after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});
