// A turn's journal is read from where the last read of it stopped. A live
// turn's checkpoint is read for every transcript read of its session, and each
// of those read and replayed every record the journal held. What is read now
// is what was appended since, and the replay equals the whole one whatever
// happened to the file in between: an append that stops mid-record, a rewrite
// in place, a truncation, another turn's header, the journal removed.
import assert from 'node:assert/strict';
import fs, { appendFileSync, copyFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

const root = mkdtempSync(join(tmpdir(), 'mixdog-turn-journal-resume-'));
process.env.MIXDOG_DATA_DIR = root;
test.after(() => rmSync(root, { recursive: true, force: true }));

const { createTurnJournalEncoder, replayTurnJournal } = await import('./turn-checkpoint-journal.mjs');

const header = () => ({
  sessionId: 'sess-resume',
  turnToken: 'tok',
  journalEpoch: 0,
  turnMessages: [{ role: 'user', content: 'go' }],
  interruption: { phase: 'streaming' },
  contextState: null,
  updatedAt: 5,
});

const line = (record) => `${JSON.stringify(record)}\n`;
const head = (turnToken = 'tok', g = 'g0') => line({ s: 0, t: 'h', turnToken, e: 0, g });

// Records `from`..`to` of a long turn: replaced messages, streamed text, a context.
function records(from, to) {
  let text = '';
  for (let s = from; s < to; s += 1) {
    if (s % 3 === 0) text += line({ s, t: 'm', i: 1 + (s % 50), m: { role: 'assistant', content: `answer ${s} ${'x'.repeat(400)}` }, at: 10 + s });
    else if (s % 3 === 1) text += line({ s, t: 'x', d: { ta: `chunk ${s} `, cs: [[`call${s % 7}`, { name: 't', s }]] }, at: 10 + s });
    else text += line({ s, t: 'c', c: { used: s }, at: 10 + s });
  }
  return text;
}

// Bytes the replay reads from `file`, through readSync and readFileSync.
async function withBytesRead(run) {
  let bytes = 0;
  const { readSync, readFileSync } = fs;
  fs.readSync = (...args) => {
    const got = readSync(...args);
    bytes += got;
    return got;
  };
  fs.readFileSync = (...args) => {
    const got = readFileSync(...args);
    bytes += got.length;
    return got;
  };
  syncBuiltinESMExports();
  try {
    return { value: await run(), bytes };
  } finally {
    fs.readSync = readSync;
    fs.readFileSync = readFileSync;
    syncBuiltinESMExports();
  }
}

let copies = 0;
// What a read of `path` from nothing gives: the same bytes under another name.
function whole(path, h = header()) {
  const copy = join(root, `whole-${(copies += 1)}.jsonl`);
  copyFileSync(path, copy);
  return replayTurnJournal(h, copy);
}

test('a replay reads what was appended since the last one, and equals the whole replay', async () => {
  const path = join(root, 'grow.jsonl');
  writeFileSync(path, head() + records(1, 7000));
  const first = replayTurnJournal(header(), path);
  assert.deepEqual(first, whole(path));
  const size = fs.statSync(path).size;
  assert.ok(size > 1_000_000, `a ${size}-byte journal`);

  appendFileSync(path, records(7000, 7040));
  const { value, bytes } = await withBytesRead(() => replayTurnJournal(header(), path));
  assert.deepEqual(value, whole(path));
  assert.notDeepEqual(value, first);
  assert.ok(bytes < size / 20, `${bytes} bytes read to follow 40 records of a ${size}-byte journal`);

  // Nothing appended: nothing but the guard bytes are read, and the answer stands.
  const again = await withBytesRead(() => replayTurnJournal(header(), path));
  assert.deepEqual(again.value, value);
  assert.ok(again.bytes < 4096, `${again.bytes} bytes read for an unchanged journal`);
});

test('a record cut mid-line is read whole once it is finished', () => {
  const path = join(root, 'torn.jsonl');
  const body = head() + records(1, 20);
  writeFileSync(path, body);
  replayTurnJournal(header(), path);
  const next = records(20, 22);
  for (const cut of [1, 7, next.indexOf('\n'), next.indexOf('\n') + 1, next.length - 1, next.length]) {
    writeFileSync(path, body + next.slice(0, cut));
    assert.deepEqual(replayTurnJournal(header(), path), whole(path), `cut at ${cut}`);
  }
  // A cut line that is a whole record (no newline yet) counts, and a line that
  // is later finished with more bytes is the record it then is.
  writeFileSync(path, body + next.slice(0, next.indexOf('\n')));
  const unfinished = replayTurnJournal(header(), path);
  assert.deepEqual(unfinished, whole(path));
  appendFileSync(path, `${next.slice(next.indexOf('\n'))}`);
  assert.deepEqual(replayTurnJournal(header(), path), whole(path));
});

test('a rewritten, truncated or foreign journal is replayed from the start', () => {
  const path = join(root, 'changed.jsonl');
  writeFileSync(path, head() + records(1, 400));
  replayTurnJournal(header(), path);
  // The same length, different records: rewritten in place.
  const rewritten = head() + records(1, 400).replaceAll('answer', 'ANSWER');
  writeFileSync(path, rewritten);
  assert.deepEqual(replayTurnJournal(header(), path), whole(path));
  assert.match(JSON.stringify(replayTurnJournal(header(), path).turnMessages), /ANSWER/);
  // Shorter than what was read.
  truncateSync(path, rewritten.length - 5000);
  assert.deepEqual(replayTurnJournal(header(), path), whole(path));
  // Another turn's header over the same journal bytes: nothing replays onto it.
  const other = { ...header(), turnToken: 'other' };
  assert.deepEqual(replayTurnJournal(other, path), other);
  assert.deepEqual(replayTurnJournal(header(), path), whole(path));
  // A turn reopened with another first record, longer than the last read.
  writeFileSync(path, head('other') + records(1, 800));
  assert.deepEqual(replayTurnJournal(header(), path), header());
  // The journal removed.
  rmSync(path);
  assert.deepEqual(replayTurnJournal(header(), path), header());
});

test('a record that skips a number ends the replay for good, whatever follows', () => {
  const path = join(root, 'gap.jsonl');
  writeFileSync(path, head() + records(1, 10) + records(12, 14));
  const ended = replayTurnJournal(header(), path);
  appendFileSync(path, records(14, 30));
  assert.deepEqual(replayTurnJournal(header(), path), ended);
  assert.deepEqual(replayTurnJournal(header(), path), whole(path));
});

test('what a replay returns is its own: changing it changes no later replay', () => {
  const path = join(root, 'own.jsonl');
  writeFileSync(path, head() + records(1, 30));
  const first = replayTurnJournal(header(), path);
  const expected = structuredClone(first);
  first.turnMessages.length = 0;
  first.interruption.observedToolCalls.length = 0;
  first.turnMessages.push({ role: 'user', content: 'scribble' });
  assert.deepEqual(replayTurnJournal(header(), path), expected);
});

test('a journal opened again in place under the same turn and epoch is replayed from the start', () => {
  // The open is the one writer that rewrites bytes of the journal (it
  // truncates and writes in place, so the inode stays). Opened again within
  // the same millisecond, for the same turn and epoch, only the middle of the
  // new journal can differ from the old one, at the same length.
  const realNow = Date.now;
  Date.now = () => 1000;
  try {
    const open = () => createTurnJournalEncoder({ turnToken: 'tok' }).seed([], null, null, { epoch: 1 }).openLines.join('');
    const path = join(root, 'reopened.jsonl');
    const h = { ...header(), journalEpoch: 1 };
    const body = records(1, 400);
    writeFileSync(path, open() + body);
    const first = replayTurnJournal(h, path);
    assert.deepEqual(first, whole(path, h));
    const middle = body.indexOf('answer 252');
    assert.ok(middle > 2048 && middle < body.length - 2048, 'the change is out of reach of both guards');
    const rewritten = open() + body.replace('answer 252', 'ANSWER 252');
    assert.equal(rewritten.length, (open() + body).length);
    const ino = fs.statSync(path).ino;
    writeFileSync(path, rewritten);
    assert.equal(fs.statSync(path).ino, ino, 'rewritten in place');
    const again = replayTurnJournal(h, path);
    assert.deepEqual(again, whole(path, h));
    assert.match(JSON.stringify(again.turnMessages), /ANSWER 252/);
  } finally {
    Date.now = realNow;
  }
});
// The table of replays keeps, per journal, its first kilobyte: a copy of it.
// A view of the buffer the replay was concatenated in would keep the journal's
// whole bytes alive for as long as the entry lives (a 20 MB buffer per journal,
// up to 16).
test('the replays a table keeps hold no journal buffer alive', () => {
  setFlagsFromString('--expose-gc');
  const collect = runInNewContext('gc');
  const journals = 6;
  const before = (collect(), process.memoryUsage().arrayBuffers);
  for (let n = 0; n < journals; n += 1) {
    const path = join(root, `retain-${n}.jsonl`);
    let text = head();
    for (let s = 1; s <= 10; s += 1) text += line({ s, t: 'm', i: 1, m: { role: 'assistant', content: `${s} ${'y'.repeat(1_000_000)}` }, at: s });
    writeFileSync(path, text);
    replayTurnJournal(header(), path);
  }
  collect();
  const kept = process.memoryUsage().arrayBuffers - before;
  assert.ok(kept < 10_000_000, `${kept} bytes of buffers stay alive after replaying ${journals} journals of 10 MB`);
});