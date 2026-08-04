// Deferred agent/tool *completion* notifications must:
//   - SURVIVE a LIVE drain (they are the intended model-visible payload, e.g.
//     the idle-resume kick delivering an async task body this process), and
//   - be DROPPED on a RESUME drain (only the persisted copy remains after a
//     restart, where replaying it would inject the body out-of-order).
// Genuine user/steering messages survive with order preserved in both paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect the pending-message spool to a throwaway dir before import so the
// real ~/.mixdog/data spool is never touched.
const dataDir = mkdtempSync(join(tmpdir(), 'mixpend-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const {
  enqueuePendingMessage,
  drainPendingMessages,
  hydratePendingMessages,
  acknowledgePendingMessages,
  recordPendingMessageDelivery,
  finalizePendingMessageDelivery,
  releasePendingMessages,
  COMPLETION_NOTIFICATION_KIND,
  markCompletionEntry,
  _dropPendingMessageState,
  _settlePendingMessageWrites,
  _setPendingPersistTailForTest,
} = await import('../src/runtime/agent/orchestrator/session/manager/pending-messages.mjs');
const texts = (entries) => entries.map((m) => (typeof m === 'string' ? m : m.text));
// Deterministic replacement for the old fixed sleeps: wait for the module's own
// buffered persist flush + async spool tails, with a real timeout so a stuck
// write still fails instead of hanging.
const settle = () => _settlePendingMessageWrites({ timeoutMs: 5000 });

test('live drain delivers the completion notification and keeps user order', () => {
  const sid = 'sess_live_1';
  enqueuePendingMessage(sid, 'user first');
  enqueuePendingMessage(sid, markCompletionEntry('Async agent task xyz finished.\n\nResult:\n> done'));
  enqueuePendingMessage(sid, 'user second');

  // In-memory queue is populated (live, same process) → completion survives.
  const delivered = drainPendingMessages(sid);
  const drained = texts(delivered);
  assert.ok(drained.includes('user first') && drained.includes('user second'), 'user messages kept');
  assert.ok(drained.some((t) => /finished/.test(t)), 'live completion delivered, not dropped');
  assert.ok(drained.indexOf('user first') < drained.indexOf('user second'), 'user order preserved');
  acknowledgePendingMessages(sid, delivered);
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

  const delivered = drainPendingMessages(sid);
  const drained = texts(delivered);
  const first = drained.indexOf('user first');
  const second = drained.indexOf('user second');
  const completion = drained.findIndex((t) => /finished/.test(t));
  assert.ok(completion !== -1, 'completion present in live drain');
  assert.ok(first < completion && completion < second, 'completion stays between the two users');
  acknowledgePendingMessages(sid, delivered);
});

test('live drain asynchronously removes already-flushed persisted copies', async () => {
  const sid = 'sess_live_flushed';
  enqueuePendingMessage(sid, 'already flushed');
  await settle();

  const delivered = drainPendingMessages(sid);
  assert.deepEqual(texts(delivered), ['already flushed']);
  acknowledgePendingMessages(sid, delivered);
  await settle();
  const store = JSON.parse(readFileSync(join(dataDir, 'session-pending-messages.json'), 'utf8'));
  assert.equal(store.sessions[sid], undefined, 'delivered live copy removed without a sync drain');
});

test('resume drain drops the completion notification, keeps user messages in order', async () => {
  const sid = 'sess_resume_1';
  enqueuePendingMessage(sid, 'user first');
  enqueuePendingMessage(sid, markCompletionEntry('Async agent task xyz finished.\n\nResult:\n> done'));
  enqueuePendingMessage(sid, 'user second');

  // Flush the buffered persist to disk, then drop the in-memory queue → mimic a
  // restart where only the persisted copy survives (the resume path).
  await settle();
  const store = JSON.parse(readFileSync(join(dataDir, 'session-pending-messages.json'), 'utf8'));
  const persistedQueue = store.sessions[sid] || [];
  const marked = persistedQueue.filter((e) => e && typeof e === 'object' && e.notificationKind === COMPLETION_NOTIFICATION_KIND);
  assert.equal(marked.length, 1, 'completion notification persisted as a marked object');
  _dropPendingMessageState(sid, { clearPersisted: false });

  await hydratePendingMessages(sid);
  const delivered = drainPendingMessages(sid);
  const drained = texts(delivered);
  assert.deepEqual(drained, ['user first', 'user second'], 'completion dropped on resume; user order kept');
  assert.ok(!drained.some((t) => /finished/.test(t)), 'no completion prose replayed on resume');
  acknowledgePendingMessages(sid, delivered);

  // A second drain yields nothing — the completion was discarded, not deferred.
  assert.deepEqual(drainPendingMessages(sid), []);
});

test('hydrate crash before publish leaves durable entries for replay', async () => {
  const sid = 'sess_hydrate_crash';
  enqueuePendingMessage(sid, 'survives crash window');
  await settle();
  await hydratePendingMessages(sid, { beforePublish: () => { throw new Error('simulated crash'); } });
  const store = JSON.parse(readFileSync(join(dataDir, 'session-pending-messages.json'), 'utf8'));
  assert.equal(store.sessions[sid].length, 1, 'hydrate never deletes before memory publish');
  await hydratePendingMessages(sid);
  const delivered = drainPendingMessages(sid);
  assert.deepEqual(texts(delivered), ['survives crash window']);
  acknowledgePendingMessages(sid, delivered);
});

test('ids preserve identical foreign messages and dedupe only replay copies', async () => {
  const sid = 'sess_identical_ids';
  enqueuePendingMessage(sid, 'identical');
  enqueuePendingMessage(sid, 'identical');
  await settle();
  await hydratePendingMessages(sid);
  const delivered = drainPendingMessages(sid);
  assert.equal(delivered.length, 2, 'same text with distinct ids is delivered twice');
  assert.notEqual(delivered[0].id, delivered[1].id);
  acknowledgePendingMessages(sid, [delivered[0]]);
  releasePendingMessages(sid, [delivered[1]]);
  await settle();
  const store = JSON.parse(readFileSync(join(dataDir, 'session-pending-messages.json'), 'utf8'));
  assert.deepEqual(store.sessions[sid].map((entry) => entry.id), [delivered[1].id], 'ack removes only the matching id');
});

test('post-completion hydration sweep picks up a late foreign spool entry', async () => {
  const sid = 'sess_late_foreign';
  await hydratePendingMessages(sid);
  const spool = join(dataDir, 'session-pending-messages.json');
  const store = JSON.parse(readFileSync(spool, 'utf8'));
  store.sessions[sid] = [{ id: 'foreign_late_id', message: 'late foreign message', enqueuedAt: Date.now() }];
  store.sessionTouchedAt[sid] = Date.now();
  writeFileSync(spool, JSON.stringify(store));

  assert.equal(await hydratePendingMessages(sid), 1);
  const delivered = drainPendingMessages(sid);
  assert.deepEqual(texts(delivered), ['late foreign message']);
  acknowledgePendingMessages(sid, delivered);
});

test('enqueue replaces caller ids and delivery tracking stays session-scoped', () => {
  const firstSid = 'sess_untrusted_id_a';
  const secondSid = 'sess_untrusted_id_b';
  enqueuePendingMessage(firstSid, { id: 'caller_id', content: 'first', text: 'first' });
  enqueuePendingMessage(secondSid, { id: 'caller_id', content: 'second', text: 'second' });
  const first = drainPendingMessages(firstSid);
  const second = drainPendingMessages(secondSid);
  assert.notEqual(first[0].id, 'caller_id');
  assert.notEqual(second[0].id, 'caller_id');
  assert.notEqual(first[0].id, second[0].id);
  releasePendingMessages(firstSid, first);
  releasePendingMessages(secondSid, second);
});

test('over-512 unconfirmed ledger IDs are retained and suppress restart replay', async () => {
  const sid = 'sess_delivered_ledger';
  const session = { id: sid, deliveredPendingMessageIds: [] };
  const entries = Array.from({ length: 600 }, (_, i) => ({
    id: `delivered_${i}`,
    content: `message ${i}`,
    text: `message ${i}`,
    enqueuedAt: i + 1,
  }));
  recordPendingMessageDelivery(session, entries);
  assert.equal(session.deliveredPendingMessageIds.length, 600, 'unconfirmed ids are never evicted');

  const { saveSession, setLiveSession, loadSession } = await import('../src/runtime/agent/orchestrator/session/store.mjs');
  saveSession({ ...session, owner: 'user', createdAt: Date.now(), updatedAt: Date.now(), messages: [] });
  setLiveSession(null);
  const spool = join(dataDir, 'session-pending-messages.json');
  const store = JSON.parse(readFileSync(spool, 'utf8'));
  store.sessions[sid] = [{ id: 'delivered_0', message: 'old surviving spool entry', enqueuedAt: Date.now() }];
  store.sessionTouchedAt[sid] = Date.now();
  writeFileSync(spool, JSON.stringify(store));
  assert.equal(await hydratePendingMessages(sid), 0);
  assert.deepEqual(drainPendingMessages(sid), []);
  setLiveSession(null);
  assert.equal(
    loadSession(sid).deliveredPendingMessageIds.includes('delivered_0'),
    false,
    'restart cleanup prunes its now-confirmed id from the durable ledger',
  );
  assert.equal(loadSession(sid).deliveredPendingMessageIds.length, 0, 'spool-absent ledger ids are stale too');
});

test('hydration prunes a ledger id whose spool entry was already deleted', async () => {
  const sid = 'sess_orphaned_ledger_id';
  const { saveSession, setLiveSession, loadSession } = await import('../src/runtime/agent/orchestrator/session/store.mjs');
  saveSession({
    id: sid,
    owner: 'user',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    deliveredPendingMessageIds: ['cleanup_committed_before_crash'],
  });
  setLiveSession(null);
  assert.equal(await hydratePendingMessages(sid), 0);
  setLiveSession(null);
  assert.deepEqual(loadSession(sid).deliveredPendingMessageIds, []);
});

test('spool cleanup waits for durable ledger save', async () => {
  const sid = 'sess_durable_before_ack';
  enqueuePendingMessage(sid, 'ordered cleanup');
  await settle();
  const delivered = drainPendingMessages(sid);
  const session = { id: sid, deliveredPendingMessageIds: [] };
  recordPendingMessageDelivery(session, delivered);
  let releaseSave;
  const durableSave = new Promise((resolve) => { releaseSave = resolve; });
  const completing = finalizePendingMessageDelivery(session, delivered, durableSave);
  await new Promise((r) => setImmediate(r));
  let store = JSON.parse(readFileSync(join(dataDir, 'session-pending-messages.json'), 'utf8'));
  assert.equal(store.sessions[sid].length, 1, 'spool remains until ledger save is durable');
  releaseSave();
  await completing;
  store = JSON.parse(readFileSync(join(dataDir, 'session-pending-messages.json'), 'utf8'));
  assert.equal(store.sessions[sid], undefined);
  assert.deepEqual(session.deliveredPendingMessageIds, []);
});

// --- settle-seam self-tests: the deterministic wait must not skip a tail the
// next flush overwrites, and must fail (not hang) on a stuck one. ---

test('settle awaits a pre-existing tail even when the next flush overwrites it', async () => {
  const sid = 'sess_settle_pre_tail';
  let releasePre;
  let preSettled = false;
  const pre = new Promise((resolve) => { releasePre = resolve; });
  _setPendingPersistTailForTest(sid, pre.then(() => { preSettled = true; }));

  // The buffered enqueue makes settle's flush replace this session's tail map
  // entry: a snapshot taken after the flush would lose `pre` entirely.
  enqueuePendingMessage(sid, 'chained after pre-tail');
  await assert.rejects(
    _settlePendingMessageWrites({ timeoutMs: 150 }),
    /did not settle within 150ms/,
    'settle must still be waiting on the overwritten pre-flush tail',
  );
  assert.equal(preSettled, false, 'pre-tail really was outstanding for that whole window');

  releasePre();
  await _settlePendingMessageWrites({ timeoutMs: 5000 });
  assert.equal(preSettled, true, 'settle returned only after the pre-flush tail resolved');
  const store = JSON.parse(readFileSync(join(dataDir, 'session-pending-messages.json'), 'utf8'));
  assert.deepEqual(
    (store.sessions[sid] || []).map((entry) => entry.message),
    ['chained after pre-tail'],
    'the newly chained flush landed too',
  );
  const delivered = drainPendingMessages(sid);
  acknowledgePendingMessages(sid, delivered);
  await _settlePendingMessageWrites({ timeoutMs: 5000 });
});

test('settle rejects within the timeout on a stuck tail or hydration', async () => {
  const tailSid = 'sess_settle_stuck_tail';
  _setPendingPersistTailForTest(tailSid, new Promise(() => {}));
  const tailStart = Date.now();
  await assert.rejects(
    _settlePendingMessageWrites({ timeoutMs: 120 }),
    /did not settle within 120ms/,
    'a never-settling tail must reject, not block',
  );
  assert.ok(Date.now() - tailStart < 3000, 'rejection is bounded by timeoutMs');
  // Replace the stuck tail with a resolved one so it self-removes from the map.
  await _setPendingPersistTailForTest(tailSid, Promise.resolve());
  await new Promise((r) => setImmediate(r));

  const hydrateSid = 'sess_settle_stuck_hydrate';
  // beforePublish never resolves → the hydration promise stays in flight.
  hydratePendingMessages(hydrateSid, { beforePublish: () => new Promise(() => {}) }).catch(() => {});
  const hydrateStart = Date.now();
  await assert.rejects(
    _settlePendingMessageWrites({ timeoutMs: 120 }),
    /did not settle within 120ms/,
    'a stuck hydration must reject, not block',
  );
  assert.ok(Date.now() - hydrateStart < 3000, 'rejection is bounded by timeoutMs');
  _dropPendingMessageState(hydrateSid);
  await _settlePendingMessageWrites({ timeoutMs: 5000 });
});

test.after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
