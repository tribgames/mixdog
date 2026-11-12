// A log is appended to, never read back by the process that wrote it: the
// next tenure of a session takes the log up where the last one here left it,
// and a full replay (the first open in a process, a load) holds the
// transcript, never the file.
import assert from 'node:assert/strict';
import fs, { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-log-resume-'));
process.env.MIXDOG_DATA_DIR = root;
const dir = join(root, 'sessions');
mkdirSync(dir);

const { saveSessionDurably, releaseIdleSessionWriter } = await import('../store.mjs');
const { parseSessionLog, readSessionLog, readSessionLogSync, resolveSessionRecordSync } = await import(
  './session-log-reader.mjs'
);
const { encodeAppend, encodeCompacted, encodePatch, encodeSessionRecord } = await import('./session-log-format.mjs');
const { createSessionLog, openSessionLog, resumeSessionLog } = await import('./session-log-writer.mjs');
const { loadLegacySession } = await import('./legacy-session.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  (await import('./session-writer-claim.mjs')).releaseHeldSessionWriters();
  rmSync(root, { recursive: true, force: true });
});

const logPath = (id) => join(dir, `${id}.log.jsonl`);
const stored = (id) =>
  resolveSessionRecordSync({ jsonPath: join(dir, `${id}.json`), logPath: logPath(id), loadLegacy: loadLegacySession });
const records = (id) =>
  readFileSync(logPath(id), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const message = (text) => ({ role: 'assistant', content: text.padEnd(4 * 1024, 'x') });
const MESSAGE_BYTES = JSON.stringify(message('')).length;

/** A session of fifty 4 KB messages, saved, its tenure here ended. */
async function leftSession(id) {
  const session = {
    id,
    owner: 'user',
    generation: 0,
    closed: false,
    messages: Array.from({ length: 50 }, (_, index) => message(`m${index} `)),
  };
  await saveSessionDurably(session);
  assert.equal(await releaseIdleSessionWriter(id), true);
  return session;
}

/** The bytes read from `path` while `run` goes, by any descriptor opened on it or by name. */
async function bytesReadOf(t, path, run) {
  const { openSync, readSync, readFileSync: readWhole, closeSync } = fs;
  const fds = new Set();
  let bytes = 0;
  fs.openSync = function (name, ...rest) {
    const fd = openSync.call(this, name, ...rest);
    if (String(name) === path) fds.add(fd);
    return fd;
  };
  fs.closeSync = function (fd) {
    fds.delete(fd);
    return closeSync.call(this, fd);
  };
  fs.readSync = function (fd, ...rest) {
    const got = readSync.call(this, fd, ...rest);
    if (fds.has(fd)) bytes += got;
    return got;
  };
  fs.readFileSync = function (name, ...rest) {
    const got = readWhole.call(this, name, ...rest);
    if (fds.has(name) || String(name) === path) bytes += got.length;
    return got;
  };
  syncBuiltinESMExports();
  const restore = () => {
    Object.assign(fs, { openSync, readSync, readFileSync: readWhole, closeSync });
    syncBuiltinESMExports();
  };
  t.after(restore);
  try {
    await run();
  } finally {
    restore();
  }
  return bytes;
}

test('the next tenure of a session takes its log up without reading it and records only what was added', async (t) => {
  const session = await leftSession('sess_resume_appends');
  const before = statSync(logPath(session.id)).size;
  // Another object of the same session holding the same messages, as a turn builds one.
  const next = { ...session, messages: [...session.messages, message('added ')] };
  const read = await bytesReadOf(t, logPath(session.id), () => saveSessionDurably(next));
  assert.ok(read < 1024, `${read} bytes of a ${before}-byte log were read to append to it`);
  const grown = statSync(logPath(session.id)).size - before;
  assert.ok(grown < 2 * MESSAGE_BYTES, `the log grew by ${grown} bytes for one ${MESSAGE_BYTES}-byte message`);
  assert.deepEqual(
    records(session.id)
      .filter((record) => 'messages' in record)
      .map((record) => [record.t, record.messages.length]),
    [
      ['compacted', 50],
      ['append', 1],
    ]
  );
  assert.deepEqual(stored(session.id).session, next);
});

test('a log another writer appended to since is replayed: its record stays, and only a copy built here is recorded after it', async () => {
  const session = await leftSession('sess_resume_foreign');
  const path = logPath(session.id);
  const { seq } = parseSessionLog(readFileSync(path));
  appendFileSync(path, encodePatch(seq + 1, [['title', '"theirs"']], []));
  // The copy the ended tenure wrote is older than the log now.
  session.messages = [...session.messages, message('late ')];
  await assert.rejects(saveSessionDurably(session), { code: 'ESESSIONCHANGED' });
  const built = { ...session, title: 'ours' };
  await saveSessionDurably(built);
  const outcome = stored(session.id);
  assert.ok(outcome.log.seq > seq + 1, `recorded after the foreign record (log at seq ${outcome.log.seq})`);
  assert.deepEqual(outcome.session, built);
  // The replayed log already holds the copy's first fifty messages: they are not recorded again.
  assert.deepEqual(
    records(session.id)
      .filter((record) => 'messages' in record)
      .map((record) => [record.t, record.messages.length]),
    [
      ['compacted', 50],
      ['append', 1],
    ]
  );
});

test('a copy that holds none of a replayed log\'s objects is recorded by what it changed: head and tail stay, the middle is one edit', async () => {
  const session = await leftSession('sess_resume_rebuilt');
  const path = logPath(session.id);
  const { seq } = parseSessionLog(readFileSync(path));
  appendFileSync(path, encodePatch(seq + 1, [['title', '"theirs"']], []));
  // Every message is another object than the one recorded, as after a restart; two in the middle became one.
  const rebuilt = structuredClone(session);
  rebuilt.messages.splice(20, 2, message('changed '));
  await saveSessionDurably(rebuilt);
  assert.deepEqual(
    records(session.id)
      .filter((record) => 'messages' in record)
      .map((record) => [record.t, record.at ?? null, record.del ?? null, record.messages.length]),
    [
      ['compacted', null, null, 50],
      ['edit', 20, 2, 1],
    ]
  );
  assert.deepEqual(stored(session.id).session, rebuilt);
  // The copy's messages are the recorded ones from here on: the next save records only what it adds.
  rebuilt.messages = [...rebuilt.messages, message('next ')];
  await saveSessionDurably(rebuilt);
  assert.deepEqual(
    records(session.id)
      .filter((record) => 'messages' in record)
      .slice(2)
      .map((record) => [record.t, record.messages.length]),
    [['append', 1]]
  );
});

test('a copy that holds none of the objects a tenure left its log with is recorded by what it changed, as on a replayed log', async () => {
  const session = await leftSession('sess_resume_left_rebuilt');
  // The tenure's log is taken up as it was left; every message of the copy is another object than the one it holds.
  const rebuilt = structuredClone(session);
  rebuilt.messages.splice(20, 2, message('changed '));
  await saveSessionDurably(rebuilt);
  assert.deepEqual(
    records(session.id)
      .filter((record) => 'messages' in record)
      .map((record) => [record.t, record.at ?? null, record.del ?? null, record.messages.length]),
    [
      ['compacted', null, null, 50],
      ['edit', 20, 2, 1],
    ]
  );
  assert.deepEqual(stored(session.id).session, rebuilt);
});

const claim = { assertHeld() {}, assertHeldStrict() {} };

test('a recorder closed with everything acknowledged leaves what the next one resumes from; anything else is a replay', async () => {
  const id = 'sess_resume_unit';
  const path = join(dir, `${id}.log.jsonl`);
  const session = { id, title: 'a', messages: [message('one '), message('two ')] };
  const first = createSessionLog({ logPath: path, session, claim });
  session.messages = [...session.messages, message('three ')];
  await first.record(session);
  await first.close();
  const { left } = first;
  assert.ok(left, 'a clean close leaves its state');

  // A message nobody holds any more: nothing to diff against by reference.
  const lost = { ...left, refs: [{ deref: () => undefined }, ...left.refs.slice(1)] };
  assert.equal(resumeSessionLog({ logPath: path, left: lost, claim }), null);
  // The base names another log.
  assert.equal(resumeSessionLog({ logPath: path, left: { ...left, logId: 'another' }, claim }), null);

  const second = resumeSessionLog({ logPath: path, left, claim });
  assert.deepEqual([second.logId, second.seq, second.messageCount], [first.logId, first.seq, 3]);
  assert.equal(second.recordedHeader('title'), 'a');
  session.title = 'b';
  session.messages = [...session.messages, message('four ')];
  await second.record(session);
  await second.close();
  assert.deepEqual(parseSessionLog(readFileSync(path)).messages, session.messages);
  assert.equal(parseSessionLog(readFileSync(path)).header.title, 'b');

  // The file grew since `left` was taken: it is not the file that recorder left.
  assert.equal(resumeSessionLog({ logPath: path, left, claim }), null);
});

test('a log is not taken up under another projection of its messages than the one they were stored under', async () => {
  const id = 'sess_resume_projection';
  const path = join(dir, `${id}.log.jsonl`);
  let version = 1;
  const options = {
    claim,
    projectionKey: () => version,
    projectMessage: (stored) => (version === 1 ? stored : { ...stored, content: 'REDACTED' }),
  };
  const session = { id, messages: [message('secret ')] };
  const first = createSessionLog({ logPath: path, session, ...options });
  await first.close();
  assert.ok(first.left, 'a clean close leaves its state');
  version = 2;
  assert.equal(resumeSessionLog({ logPath: path, left: first.left, ...options }), null);
  // Replayed instead: the message is stored differently now, so it is recorded again.
  const second = openSessionLog({ logPath: path, ...options });
  await second.record(session);
  assert.deepEqual(parseSessionLog(readFileSync(path)).messages, [{ role: 'assistant', content: 'REDACTED' }]);
  // The projection changes during a tenure: what it recorded before is not what would be stored now.
  version = 3;
  await second.close();
  assert.equal(second.left, null);
});

test('a full replay holds the transcript, a block and the line it applies, never the file', async (t) => {
  const path = join(dir, 'sess_resume_replay.log.jsonl');
  const base = encodeSessionRecord({ logId: 'L1', id: 'sess_resume_replay', legacy: null, header: { title: 'a' } });
  const big = (index) => JSON.stringify({ role: 'user', content: `${index} `.padEnd(256 * 1024, 'y') });
  fs.writeFileSync(path, base + encodeCompacted(1, [big(0)]));
  // 40 MB of appends, replaced histories and patches, then a line that is no record and a torn tail.
  for (let seq = 2; seq < 242; seq += 3) {
    appendFileSync(
      path,
      encodeAppend(seq, 2, [big(seq)]) +
        encodeCompacted(seq + 1, [big(seq + 1)]) +
        encodePatch(seq + 2, [['title', JSON.stringify(`t${seq}`)]], [])
    );
  }
  const torn = '{"t":"app';
  appendFileSync(path, `not a record\n${torn}`);
  const size = statSync(path).size;
  assert.ok(size > 32 * 1024 * 1024, `a ${size}-byte log`);
  const whole = parseSessionLog(readFileSync(path));

  const { alloc, allocUnsafe } = Buffer;
  let largest = 0;
  Buffer.alloc = (length, ...rest) => {
    largest = Math.max(largest, length);
    return alloc.call(Buffer, length, ...rest);
  };
  Buffer.allocUnsafe = (length) => {
    largest = Math.max(largest, length);
    return allocUnsafe.call(Buffer, length);
  };
  t.after(() => Object.assign(Buffer, { alloc, allocUnsafe }));
  const sync = readSessionLogSync(path);
  const streamed = await readSessionLog(path);
  Object.assign(Buffer, { alloc, allocUnsafe });

  assert.deepEqual(sync, whole);
  assert.deepEqual(streamed, whole);
  assert.equal(whole.messages.length, 1);
  assert.deepEqual([whole.skipped.length, whole.tornTail.length], [1, torn.length]);
  // An 8 MB block, joined once with the line that began in the block before it.
  assert.ok(largest < 9 * 1024 * 1024, `a ${largest}-byte buffer was asked for to replay a ${size}-byte log`);
});
