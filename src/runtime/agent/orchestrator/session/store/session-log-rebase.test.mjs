// A session's log does not grow without bound: every open, load and
// transcript read replays the whole file, so a log that outgrew its base is
// replaced by a base of the session as the next save has it.
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-log-rebase-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'));

const { saveSessionDurably } = await import('../store.mjs');
const { resolveSessionRecordSync } = await import('./session-log-reader.mjs');
const { loadLegacySession } = await import('./legacy-session.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');
const { _setRebaseMinBytesForTest } = await import('./session-log-writer.mjs');

const MIN_BYTES = 64 * 1024;
const priorMin = _setRebaseMinBytesForTest(MIN_BYTES);

test.after(async () => {
  _setRebaseMinBytesForTest(priorMin);
  await settleSessionSummaryIndex();
  (await import('./session-writer-claim.mjs')).releaseHeldSessionWriters();
  rmSync(root, { recursive: true, force: true });
});

const logPath = (id) => join(root, 'sessions', `${id}.log.jsonl`);
const record = (id) =>
  resolveSessionRecordSync({
    jsonPath: join(root, 'sessions', `${id}.json`),
    logPath: logPath(id),
    loadLegacy: loadLegacySession,
  });
const base = (id) => JSON.parse(readFileSync(logPath(id), 'utf8').split('\n', 1)[0]);
const message = (text) => ({ role: 'assistant', content: text.padEnd(8 * 1024, 'x') });

/** A session of ten 8 KB messages, saved. */
async function savedSession(id) {
  const session = {
    id,
    owner: 'user',
    generation: 0,
    closed: false,
    messages: Array.from({ length: 10 }, (_, index) => message(`m${index} `)),
  };
  await saveSessionDurably(session);
  return session;
}

/** Saves `count` times, the last message replaced each time: 8 KB more to record, the session no larger. */
async function saveReplacements(session, count, each = () => {}) {
  let recorded = 0;
  for (let step = 0; step < count; step += 1) {
    session.messages = [...session.messages.slice(0, -1), message(`r${step} `)];
    await saveSessionDurably(session);
    recorded += JSON.stringify(session.messages.at(-1)).length;
    each(step);
  }
  return recorded;
}

test('a log that outgrew its base is replaced by a base of the saved session', async () => {
  const session = await savedSession('sess_rebase_outgrown');
  const first = base(session.id);
  const baseBytes = statSync(logPath(session.id)).size;
  let largest = 0;
  const recorded = await saveReplacements(session, 200, () => {
    largest = Math.max(largest, statSync(logPath(session.id)).size);
    assert.deepEqual(record(session.id).session, session);
  });
  assert.ok(recorded > 10 * baseBytes, 'far more was recorded than the session holds');
  // Four bases is where the log is replaced; one save's records may land past it.
  assert.ok(largest < 5 * baseBytes, `the log reached ${largest} bytes over a base of ${baseBytes}`);
  const last = base(session.id);
  assert.notEqual(last.logId, first.logId);
  assert.equal(last.prev.reason, 'size');
});

test('a rebase that does not land leaves the save recorded on the log it had', async (t) => {
  const session = await savedSession('sess_rebase_refused');
  const first = base(session.id);
  const stderr = [];
  const { write } = process.stderr;
  process.stderr.write = (text) => stderr.push(String(text));
  // The proof read of every new base fails: no rebase of this log can land.
  const { readFileSync: realRead } = fs;
  fs.readFileSync = function (path, ...rest) {
    const name = String(path);
    if (name.startsWith(`${logPath(session.id)}.`) && name.endsWith('.tmp')) {
      throw Object.assign(new Error(`EIO: i/o error, read '${name}'`), { code: 'EIO' });
    }
    return realRead.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = realRead;
    syncBuiltinESMExports();
    process.stderr.write = write;
  });
  await saveReplacements(session, 200, () => assert.deepEqual(record(session.id).session, session));
  process.stderr.write = write;
  assert.equal(base(session.id).logId, first.logId, 'the log is still the one it was');
  const refused = stderr.filter((line) => line.includes('log not rebased'));
  // Tried again only once the log doubled: a handful of tries over 200 saves.
  assert.ok(refused.length >= 2 && refused.length <= 8, `${refused.length} tries`);
});
