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

test.after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});
