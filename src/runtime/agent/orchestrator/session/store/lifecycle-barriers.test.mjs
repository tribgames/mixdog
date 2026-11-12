// Lifecycle barriers (detach bump, close tombstone) are records in the
// session's log: a copy issued for an older ownership is dropped after them,
// a save in flight when one lands is not lost, and a legacy json is only read.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-lifecycle-barriers-'));
process.env.MIXDOG_DATA_DIR = root;
const dir = join(root, 'sessions');
mkdirSync(dir);

const { saveSessionAsync, bumpSessionGeneration, markSessionClosed, loadSession, releaseIdleSessionWriter } =
  await import('../store.mjs');
const { SAVE_OUTCOME_DROPPED, SAVE_OUTCOME_SAVED, _liveSessions } = await import('./live-state.mjs');
const { forgetSessionLoadCache } = await import('./load-cache.mjs');
const { _sessionLogIoForTest } = await import('./session-log-writer.mjs');
const { resolveSessionRecordSync } = await import('./session-log-reader.mjs');
const { loadLegacySession } = await import('./legacy-session.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  (await import('./session-writer-claim.mjs')).releaseHeldSessionWriters();
  rmSync(root, { recursive: true, force: true });
});

const files = (id) => ({ jsonPath: join(dir, `${id}.json`), logPath: join(dir, `${id}.log.jsonl`) });
const stored = (id) => resolveSessionRecordSync({ ...files(id), loadLegacy: loadLegacySession });
const texts = (session) => session.messages.map((message) => message.content);

function makeSession(id, generation = 1) {
  return { id, generation, closed: false, messages: [{ role: 'user', content: 'first' }] };
}

test('a detach bump drops a later save of the copy it detached, and keeps the transcript', async () => {
  const id = 'sess_barrier_detach';
  const copy = makeSession(id);
  assert.equal(await saveSessionAsync(copy, { expectedGeneration: 1 }), SAVE_OUTCOME_SAVED);
  assert.equal(await bumpSessionGeneration(id), 2);
  copy.messages = [...copy.messages, { role: 'assistant', content: 'late' }];
  assert.equal(await saveSessionAsync(copy, { expectedGeneration: 1 }), SAVE_OUTCOME_DROPPED);
  const outcome = stored(id);
  assert.equal(outcome.kind, 'log');
  assert.equal(outcome.session.generation, 2);
  assert.deepEqual(texts(outcome.session), ['first']);
});

test('a close tombstone outranks an older copy, and closing again keeps its generation and time', async () => {
  const id = 'sess_barrier_close';
  await saveSessionAsync(makeSession(id), { expectedGeneration: 1 });
  assert.equal(await markSessionClosed(id, 'test'), 2);
  const closed = stored(id).session;
  assert.equal(closed.closed, true);
  assert.equal(await saveSessionAsync(makeSession(id, 2), { expectedGeneration: 2 }), SAVE_OUTCOME_DROPPED);
  assert.equal(await markSessionClosed(id, 'test'), 2);
  const again = stored(id).session;
  assert.equal(again.generation, 2);
  assert.equal(again.updatedAt, closed.updatedAt);
});

test('a barrier over a legacy json records it in a new log and leaves the json as it was', async () => {
  const id = 'sess_barrier_legacy';
  const text = JSON.stringify({ id, generation: 4, closed: false, messages: [{ role: 'user', content: 'old' }] });
  writeFileSync(files(id).jsonPath, text);
  assert.equal(await bumpSessionGeneration(id), 5);
  assert.equal(readFileSync(files(id).jsonPath, 'utf8'), text, 'the json is only read');
  const outcome = stored(id);
  assert.equal(outcome.kind, 'log');
  assert.equal(outcome.session.generation, 5);
  assert.deepEqual(texts(outcome.session), ['old']);
});

// A barrier whose batch reached the file but whose fsync failed: the caller is
// told it did not land, so the log must not hold it either.
async function failBarrier(run) {
  const io = _sessionLogIoForTest();
  const real = io.fsync;
  io.fsync = (_fd, done) => done(Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }));
  try {
    return await run();
  } finally {
    io.fsync = real;
  }
}

test('a close barrier that failed leaves neither its tombstone in the log nor the live copy closed', async () => {
  const id = 'sess_barrier_failed_close';
  const copy = makeSession(id);
  await saveSessionAsync(copy, { expectedGeneration: 1 });
  assert.equal(await failBarrier(() => markSessionClosed(id, 'test')), null);
  const record = stored(id).session;
  assert.equal(record.closed, false, 'the log holds no tombstone');
  assert.equal(record.generation, 1);
  const live = loadSession(id);
  assert.equal(live.closed, false);
  assert.equal(live.generation, 1);
  assert.equal(await markSessionClosed(id, 'test'), 2, 'closing again lands');
  assert.equal(stored(id).session.closed, true);
});

test('a session whose barrier failed saves its later turns and closes on retry', async () => {
  const id = 'sess_barrier_failed_then_saves';
  await saveSessionAsync(makeSession(id), { expectedGeneration: 1 });
  // A copy read from the record, as a resumed session is, bound to the log as it stood.
  await releaseIdleSessionWriter(id);
  forgetSessionLoadCache(id);
  _liveSessions.delete(id);
  const copy = loadSession(id);
  copy.messages = [...copy.messages, { role: 'assistant', content: 'second' }];
  await saveSessionAsync(copy, { expectedGeneration: 1 });
  assert.equal(await failBarrier(() => markSessionClosed(id, 'test')), null);
  assert.equal(loadSession(id), copy, 'the live copy keeps speaking for the session');
  copy.messages = [...copy.messages, { role: 'user', content: 'third' }];
  assert.equal(await saveSessionAsync(copy, { expectedGeneration: 1 }), SAVE_OUTCOME_SAVED);
  assert.deepEqual(texts(stored(id).session), ['first', 'second', 'third']);
  assert.equal(stored(id).session.closed, false);
  assert.equal(await markSessionClosed(id, 'test'), 2);
  assert.equal(stored(id).session.closed, true);
});

test('a save in flight when the detach bump lands is not lost and never lands after it', async () => {
  for (let round = 0; round < 4; round++) {
    const id = `sess_barrier_inflight_${round}`;
    const copy = makeSession(id);
    await saveSessionAsync(copy, { expectedGeneration: 1 });
    copy.messages = [...copy.messages, { role: 'assistant', content: `answer ${round}` }];
    const inFlight = saveSessionAsync(copy, { expectedGeneration: 1 });
    const bumped = bumpSessionGeneration(id);
    assert.equal(await inFlight, SAVE_OUTCOME_SAVED);
    assert.equal(await bumped, 2);
    const session = stored(id).session;
    assert.equal(session.generation, 2);
    assert.deepEqual(texts(session), ['first', `answer ${round}`]);
  }
});
