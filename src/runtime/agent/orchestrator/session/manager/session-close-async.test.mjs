// closeSession lands its barrier as a record in the session's log, off the
// thread: a barrier whose write fails ends the close with that write's own
// error and leaves the record as it was; once writes land again, so does it.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-close-async-'));
process.env.MIXDOG_DATA_DIR = root;

const { closeSession } = await import('./session-close.mjs');
const { saveSessionAsync, getSessionLifecycleCommitError } = await import('../store.mjs');
const { readDurableSessionRecord } = await import('../store/transcript-durability.mjs');
const { _sessionLogIoForTest } = await import('../store/session-log-writer.mjs');
const { settleSessionSummaryIndex } = await import('../store/listing.mjs');
const { flushSessionCloseMetrics } = await import('../store/lifecycle-barriers.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  await flushSessionCloseMetrics();
  (await import('../store/session-writer-claim.mjs')).releaseHeldSessionWriters();
  rmSync(root, { recursive: true, force: true });
});

const session = (id) => ({
  id,
  owner: 'agent',
  agent: 'worker',
  status: 'idle',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [{ role: 'user', content: 'hello' }],
});

/** Every session-log batch write fails with `code` while the test runs. */
function refuseLogWrites(t, code) {
  const io = _sessionLogIoForTest();
  const original = io.writeSync;
  const state = { refused: 0 };
  io.writeSync = () => {
    state.refused++;
    throw Object.assign(new Error(`${code}: injected`), { code });
  };
  t.after(() => {
    io.writeSync = original;
  });
  return state;
}

for (const tombstone of [false, true]) {
  test(`a barrier lands its generation bump without blocking the loop (tombstone=${tombstone})`, async () => {
    const id = `sess_close_async_${tombstone ? 'tombstone' : 'detach'}`;
    await saveSessionAsync(session(id));
    const before = readDurableSessionRecord(id).generation;
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    assert.equal(await closeSession(id, 'cli-agent-close', { tombstone }), true);
    assert.equal(ticked, true, 'the loop ran while the barrier landed');
    const disk = readDurableSessionRecord(id);
    assert.equal(disk.generation, before + 1, 'the generation bump landed');
    assert.equal(disk.closed, tombstone);
    assert.equal(getSessionLifecycleCommitError(id), null);
  });
}

test('a barrier whose write fails fails the close with the write error', async (t) => {
  const id = 'sess_close_async_refused';
  await saveSessionAsync(session(id));
  const before = readDurableSessionRecord(id);
  const refused = refuseLogWrites(t, 'EIO');
  assert.equal(await closeSession(id, 'cli-agent-close', { tombstone: false }), false);
  assert.ok(refused.refused >= 1);
  assert.equal(getSessionLifecycleCommitError(id)?.code, 'EIO');
  assert.deepEqual(readDurableSessionRecord(id), before, 'the record is as it was');
});

test('a barrier that did not land never rides a later save', async (t) => {
  const id = 'sess_close_async_not_carried';
  const copy = session(id);
  await saveSessionAsync(copy);
  const before = readDurableSessionRecord(id);
  const io = _sessionLogIoForTest();
  const write = io.writeSync;
  io.writeSync = () => {
    throw Object.assign(new Error('EIO'), { code: 'EIO' });
  };
  try {
    assert.equal(await closeSession(id, 'cli-agent-close'), false);
  } finally {
    io.writeSync = write;
  }
  copy.messages = [...copy.messages, { role: 'assistant', content: 'after' }];
  await saveSessionAsync(copy, { expectedGeneration: before.generation });
  const disk = readDurableSessionRecord(id);
  assert.equal(disk.closed, false, 'no tombstone landed');
  assert.equal(disk.generation, before.generation);
  assert.deepEqual(
    disk.messages.map((message) => message.content),
    ['hello', 'after']
  );
});
