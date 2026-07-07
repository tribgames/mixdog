// Proves deferred agent/tool *completion* notifications are DROPPED on drain
// (never replayed out-of-order on a later session resume) while genuine
// user/steering messages in the same queue survive with order preserved.
// Owner decision: out-of-order replay is worse than loss.
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
} = await import('../src/runtime/agent/orchestrator/session/manager/pending-messages.mjs');

function completionEntry(text) {
  return { content: text, text, notificationKind: COMPLETION_NOTIFICATION_KIND, enqueuedAt: Date.now() };
}

test('drain drops completion notifications, keeps user messages in order', async () => {
  const sid = 'sess_drop_test_1';
  enqueuePendingMessage(sid, 'user first');
  enqueuePendingMessage(sid, completionEntry('Async agent task xyz finished.\n\nResult:\n> done'));
  enqueuePendingMessage(sid, 'user second');

  // Let the buffered persist flush to disk so we also verify the on-disk marker
  // (the shape a later resume would drain).
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 30));
  const store = JSON.parse(readFileSync(join(dataDir, 'session-pending-messages.json'), 'utf8'));
  const persistedQueue = store.sessions[sid] || [];
  const marked = persistedQueue.filter((e) => e && typeof e === 'object' && e.notificationKind === COMPLETION_NOTIFICATION_KIND);
  assert.equal(marked.length, 1, 'completion notification persisted as a marked object');
  assert.ok(persistedQueue.includes('user first') && persistedQueue.includes('user second'), 'user messages persisted as plain strings');

  const drained = drainPendingMessages(sid).map((m) => (typeof m === 'string' ? m : m.text));
  assert.deepEqual(drained, ['user first', 'user second'], 'completion dropped; user messages kept in order');
  assert.ok(!drained.some((t) => /finished/.test(t)), 'no completion prose replayed');

  // A second drain (post-resume) yields nothing — the completion was discarded,
  // not deferred.
  assert.deepEqual(drainPendingMessages(sid), []);
});

test.after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Proves the shared tagger (used by notify.mjs, tool-exec.mjs, runtime-core.mjs)
// yields entries drain drops, while a real user message survives in order.
test('markCompletionEntry path is dropped on drain; user message survives', () => {
  const sid = 'sess_drop_test_2';
  enqueuePendingMessage(sid, 'real user question');
  enqueuePendingMessage(sid, markCompletionEntry('Async agent task abc finished.\n\nResult:\n> ok'));
  const drained = drainPendingMessages(sid).map((m) => (typeof m === 'string' ? m : m.text));
  assert.deepEqual(drained, ['real user question']);
});
