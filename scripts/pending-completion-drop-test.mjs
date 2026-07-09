// Deferred agent/tool *completion* notifications must:
//   - SURVIVE a LIVE drain (they are the intended model-visible payload, e.g.
//     the idle-resume kick delivering an async task body this process), and
//   - be DROPPED on a RESUME drain (only the persisted copy remains after a
//     restart, where replaying it would inject the body out-of-order).
// Genuine user/steering messages survive with order preserved in both paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect the pending-message spool to a throwaway dir before import so the
// real ~/.mixdog/data spool is never touched.
const dataDir = mkdtempSync(join(tmpdir(), 'mixpend-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const {
  enqueuePendingMessage,
  drainPendingMessages,
  COMPLETION_NOTIFICATION_KIND,
  markCompletionEntry,
  _dropPendingMessageState,
} = await import('../src/runtime/agent/orchestrator/session/manager/pending-messages.mjs');

test('live drain delivers the completion notification and keeps user order', () => {
  const sid = 'sess_live_1';
  enqueuePendingMessage(sid, 'user first');
  enqueuePendingMessage(sid, markCompletionEntry('Async agent task xyz finished.\n\nResult:\n> done'));
  enqueuePendingMessage(sid, 'user second');

  // In-memory queue is populated (live, same process) → completion survives.
  const drained = drainPendingMessages(sid).map((m) => (typeof m === 'string' ? m : m.text));
  assert.ok(drained.includes('user first') && drained.includes('user second'), 'user messages kept');
  assert.ok(drained.some((t) => /finished/.test(t)), 'live completion delivered, not dropped');
  assert.ok(drained.indexOf('user first') < drained.indexOf('user second'), 'user order preserved');
});

test('live drain preserves interleaved [user, completion, user] order', () => {
  // Buffered-persist copies of the live sends carry the same user texts but the
  // completion is filtered out of the persisted path. The in-memory queue is
  // authoritative, so the completion must stay BETWEEN the users and never be
  // flattened to the tail as [user, user, completion].
  const sid = 'sess_live_order';
  enqueuePendingMessage(sid, 'user first');
  enqueuePendingMessage(sid, markCompletionEntry('Async agent task zzz finished.\n\nResult:\n> done'));
  enqueuePendingMessage(sid, 'user second');

  const drained = drainPendingMessages(sid).map((m) => (typeof m === 'string' ? m : m.text));
  const first = drained.indexOf('user first');
  const second = drained.indexOf('user second');
  const completion = drained.findIndex((t) => /finished/.test(t));
  assert.ok(completion !== -1, 'completion present in live drain');
  assert.ok(first < completion && completion < second, 'completion stays between the two users');
});

test('resume drain drops the completion notification, keeps user messages in order', async () => {
  const sid = 'sess_resume_1';
  enqueuePendingMessage(sid, 'user first');
  enqueuePendingMessage(sid, markCompletionEntry('Async agent task xyz finished.\n\nResult:\n> done'));
  enqueuePendingMessage(sid, 'user second');

  // Flush the buffered persist to disk, then drop the in-memory queue → mimic a
  // restart where only the persisted copy survives (the resume path).
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 30));
  const store = JSON.parse(readFileSync(join(dataDir, 'session-pending-messages.json'), 'utf8'));
  const persistedQueue = store.sessions[sid] || [];
  const marked = persistedQueue.filter((e) => e && typeof e === 'object' && e.notificationKind === COMPLETION_NOTIFICATION_KIND);
  assert.equal(marked.length, 1, 'completion notification persisted as a marked object');
  _dropPendingMessageState(sid, { clearPersisted: false });

  const drained = drainPendingMessages(sid).map((m) => (typeof m === 'string' ? m : m.text));
  assert.deepEqual(drained, ['user first', 'user second'], 'completion dropped on resume; user order kept');
  assert.ok(!drained.some((t) => /finished/.test(t)), 'no completion prose replayed on resume');

  // A second drain yields nothing — the completion was discarded, not deferred.
  assert.deepEqual(drainPendingMessages(sid), []);
});

test.after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
