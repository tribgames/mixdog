import assert from 'node:assert/strict';
import fs, { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import {
  encodeAppend,
  encodeCompacted,
  encodeEdit,
  encodePatch,
  encodeRollback,
  encodeSessionRecord,
  jsonEqual,
  sha1Hex,
} from './session-log-format.mjs';
import {
  parseSessionLog,
  resolveSessionRecord,
  resolveSessionRecordSync,
  scanSessionLogHeader,
  sessionFromLog,
  parseSessionRecordStamp,
  sessionRecordStamp,
  sessionRecordStampSync,
} from './session-log-reader.mjs';
import { loadLegacy } from './session-log-legacy-loader.fixture.mjs';

const root = mkdtempSync(join(tmpdir(), 'mixdog-session-log-reader-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const j = (items) => items.map((item) => JSON.stringify(item));
const msg = (text, role = 'user') => ({ role, content: text });

function baseLines({ header = { title: 't' }, messages = [], legacy = null, id = 'sess_1' } = {}) {
  return encodeSessionRecord({ logId: 'L1', id, legacy, header: { id, ...header } }) + encodeCompacted(1, j(messages));
}

test('replays every record type in sequence', () => {
  const text =
    baseLines({ messages: [msg('sys', 'system'), msg('a')] }) +
    encodeAppend(2, 4, j([msg('b', 'assistant'), msg('c')])) +
    encodeEdit(3, 4, 0, 1, j([msg('sys2', 'system')])) +
    encodePatch(4, [['title', '"renamed"'], ['usage', '{"in":3}']], []) +
    encodeRollback(5, 3) +
    encodePatch(6, [], ['usage']) +
    encodeAppend(7, 4, j([msg('d', 'assistant')]));
  const log = parseSessionLog(Buffer.from(text));
  assert.equal(log.valid, true);
  assert.equal(log.seq, 7);
  assert.equal(log.damage, null);
  assert.deepEqual(sessionFromLog(log), {
    id: 'sess_1',
    title: 'renamed',
    messages: [msg('sys2', 'system'), msg('a'), msg('b', 'assistant'), msg('d', 'assistant')],
  });
});

test('the transcript is rebuilt from the last compaction, header patches from the start', () => {
  const text =
    baseLines({ messages: [msg('a')] }) +
    encodePatch(2, [['title', '"early"']], []) +
    encodeAppend(3, 2, j([msg('b')])) +
    encodeCompacted(4, j([msg('summary', 'system')])) +
    encodeAppend(5, 2, j([msg('e')]));
  const log = parseSessionLog(Buffer.from(text));
  assert.equal(log.replayFrom, 4);
  assert.deepEqual(log.messages, [msg('summary', 'system'), msg('e')]);
  assert.equal(log.header.title, 'early');
});

test('a torn tail is skipped and reported; a torn line between records is skipped', () => {
  const good = baseLines({ messages: [msg('a')] }) + encodeAppend(2, 2, j([msg('b')]));
  const partial = '{"t":"append","s":3,"len":3,"mess';
  const torn = parseSessionLog(Buffer.from(good + partial));
  assert.deepEqual(torn.tornTail, { offset: Buffer.byteLength(good), length: partial.length });
  assert.equal(torn.seq, 2);
  assert.equal(torn.messageCount, 2);
  // A torn line that got its newline (crash, then repair) and records after it.
  const repaired = `${good}{"t":"append","s":3,"le\n${encodeAppend(3, 3, j([msg('c')]))}`;
  const log = parseSessionLog(Buffer.from(repaired));
  assert.equal(log.damage, null);
  assert.equal(log.skipped.length, 1);
  assert.deepEqual(log.messages.map((m) => m.content), ['a', 'b', 'c']);
});

test('mid-file damage stops replay at the sequence gap', () => {
  const head = baseLines({ messages: [msg('a')] }) + encodeAppend(2, 2, j([msg('b')]));
  // Record 3 lost to garbage; records 4.. must not be replayed over the gap.
  const text = `${head}\u0000\u0000garbage\n${encodeAppend(4, 4, j([msg('d')]))}`;
  const log = parseSessionLog(Buffer.from(text));
  assert.equal(log.valid, true);
  assert.equal(log.seq, 2);
  assert.deepEqual(log.damage, {
    offset: Buffer.byteLength(head) + 10,
    expectedSeq: 3,
    foundSeq: 4,
    reason: 'sequence',
  });
  assert.deepEqual(log.messages.map((m) => m.content), ['a', 'b']);
  // A record that does not fit the transcript before it is damage too.
  const bad = parseSessionLog(Buffer.from(head + encodeAppend(3, 9, j([msg('x')]))));
  assert.equal(bad.damage.reason, 'length');
  assert.equal(bad.seq, 2);
});

test('a log without its base pair is invalid', () => {
  assert.equal(parseSessionLog(Buffer.from('')).valid, false);
  assert.equal(parseSessionLog(Buffer.from(encodeAppend(0, 1, j([msg('a')])))).valid, false);
  const onlySession = parseSessionLog(
    Buffer.from(encodeSessionRecord({ logId: 'L', id: 's', header: { id: 's' } }))
  );
  assert.equal(onlySession.valid, false);
  assert.equal(onlySession.damage.reason, 'no-history');
});

test('the header scan keeps no transcript but counts it', async () => {
  const path = join(root, 'scan.log.jsonl');
  writeFileSync(path, baseLines({ messages: [msg('a'), msg('b')] }) + encodePatch(2, [['title', '"x"']], []));
  const scan = await scanSessionLogHeader(path);
  assert.equal(scan.messages, undefined);
  assert.equal(scan.messageCount, 2);
  assert.equal(scan.header.title, 'x');
  assert.equal(await scanSessionLogHeader(join(root, 'none.log.jsonl')), null);
});

test('jsonEqual compares as JSON stores values', () => {
  assert.equal(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), true);
  assert.equal(jsonEqual({ a: 1, u: undefined }, { a: 1 }), true);
  assert.equal(jsonEqual([undefined], [null]), true);
  assert.equal(jsonEqual({ a: 1 }, { a: '1' }), false);
  assert.equal(jsonEqual({ a: [1] }, { a: [1, 2] }), false);
  assert.equal(jsonEqual({ a: null }, {}), false);
});

function writeLegacy(name, doc) {
  const path = join(root, `${name}.json`);
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

function legacyOf(path) {
  const st = statSync(path);
  return { sha1: sha1Hex(readFileSync(path)), size: st.size, mtimeMs: st.mtimeMs };
}

test('the legacy seam: legacy, log, touched, diverged, orphan, absent', async () => {
  const id = 'sess_seam';
  const doc = { id, title: 'old', messages: [msg('a')] };
  const jsonPath = writeLegacy(id, doc);
  const logPath = join(root, `${id}.log.jsonl`);
  const args = { jsonPath, logPath, loadLegacy };

  const legacy = await resolveSessionRecord(args);
  assert.equal(legacy.kind, 'legacy');
  assert.equal(legacy.session.title, 'old');
  assert.deepEqual(legacy.legacy, legacyOf(jsonPath));

  writeFileSync(
    logPath,
    baseLines({ id, header: { title: 'old', generation: 0, closed: false }, messages: doc.messages, legacy: legacy.legacy }) +
      encodePatch(2, [['title', '"new"']], [])
  );
  const fromLog = await resolveSessionRecord(args);
  assert.equal(fromLog.kind, 'log');
  assert.equal(fromLog.session.title, 'new');
  assert.equal(resolveSessionRecordSync(args).kind, 'log');

  // Same bytes, new mtime: the sha1 settles it.
  utimesSync(jsonPath, new Date(), new Date(Date.now() + 5000));
  assert.equal((await resolveSessionRecord(args)).kind, 'log');

  // An older build wrote the json after a downgrade.
  writeFileSync(jsonPath, JSON.stringify({ ...doc, title: 'written by v1.4.5' }));
  const diverged = await resolveSessionRecord(args);
  assert.equal(diverged.kind, 'diverged');
  assert.equal(diverged.session.title, 'written by v1.4.5');
  assert.equal(diverged.log.logId, 'L1');
  assert.equal(resolveSessionRecordSync(args).kind, 'diverged');

  rmSync(jsonPath);
  const orphan = await resolveSessionRecord(args);
  assert.equal(orphan.kind, 'orphan');
  assert.equal(orphan.session.title, 'new');

  rmSync(logPath);
  assert.equal((await resolveSessionRecord(args)).kind, 'absent');
});

test('a legacy json holding another session is unreadable, not loaded', async () => {
  const jsonPath = writeLegacy('sess_named', { id: 'sess_other', messages: [] });
  const outcome = await resolveSessionRecord({ jsonPath, logPath: join(root, 'sess_named.log.jsonl'), loadLegacy });
  assert.equal(outcome.kind, 'legacy-unreadable');
});

test('a session born as a log is diverged by any json beside it', async () => {
  const id = 'sess_native';
  const jsonPath = join(root, `${id}.json`);
  const logPath = join(root, `${id}.log.jsonl`);
  writeFileSync(logPath, baseLines({ id, messages: [msg('a')] }));
  assert.equal((await resolveSessionRecord({ jsonPath, logPath, loadLegacy })).kind, 'log');
  writeLegacy(id, { id, messages: [] });
  assert.equal((await resolveSessionRecord({ jsonPath, logPath, loadLegacy })).kind, 'diverged');
});

test('the record stamp changes with every append', async () => {
  const id = 'sess_stamp';
  const jsonPath = join(root, `${id}.json`);
  const logPath = join(root, `${id}.log.jsonl`);
  const before = await sessionRecordStamp({ jsonPath, logPath });
  assert.equal(before, 'log:-|json:-');
  writeFileSync(logPath, baseLines({ id }));
  const first = await sessionRecordStamp({ jsonPath, logPath });
  appendFileSync(logPath, encodePatch(2, [['title', '"y"']], []));
  const second = await sessionRecordStamp({ jsonPath, logPath });
  assert.notEqual(first, before);
  assert.notEqual(second, first);
  assert.match(second, /^log:\d+:\d+:\d+:\d+\|json:-$/);
});

test('the record stamp sees a same-size rewrite in place that restores the mtime', async () => {
  const id = 'sess_stamp_ctime';
  const files = { jsonPath: join(root, `${id}.json`), logPath: join(root, `${id}.log.jsonl`) };
  writeLegacy(id, { id, title: 'aaaa', messages: [] });
  const mtime = new Date(1_700_000_000_000);
  utimesSync(files.jsonPath, mtime, mtime);
  const before = await sessionRecordStamp(files);
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(files.jsonPath, JSON.stringify({ id, title: 'bbbb', messages: [] }));
  utimesSync(files.jsonPath, mtime, mtime);
  const after = await sessionRecordStamp(files);
  assert.equal(parseSessionRecordStamp(after).json.size, parseSessionRecordStamp(before).json.size);
  assert.equal(parseSessionRecordStamp(after).json.mtimeNs, parseSessionRecordStamp(before).json.mtimeNs);
  assert.notEqual(after, before, 'the change time tells the rewrite apart');
});

test('a caller stamp that shows the log absent reads only the json, and the outcome carries it', (t) => {
  const id = 'sess_stamp_reuse';
  const files = { jsonPath: join(root, `${id}.json`), logPath: join(root, `${id}.log.jsonl`) };
  writeLegacy(id, { id, messages: [msg('a')] });
  const stamp = sessionRecordStampSync(files);
  const calls = [];
  const original = { readFileSync: fs.readFileSync, statSync: fs.statSync };
  for (const name of Object.keys(original)) {
    fs[name] = function (path, ...rest) {
      calls.push(`${name}:${basename(String(path))}`);
      return original[name].call(this, path, ...rest);
    };
  }
  syncBuiltinESMExports();
  t.after(() => {
    Object.assign(fs, original);
    syncBuiltinESMExports();
  });
  const outcome = resolveSessionRecordSync({ ...files, loadLegacy, stamp });
  Object.assign(fs, original);
  syncBuiltinESMExports();
  assert.deepEqual(calls, [`readFileSync:${id}.json`], 'one read of the json, no stat, no log read');
  assert.equal(outcome.kind, 'legacy');
  assert.equal(outcome.stamp, stamp);
  assert.deepEqual(outcome.legacy.size, statSync(files.jsonPath).size);
  assert.equal(outcome.legacy.mtimeMs, statSync(files.jsonPath).mtimeMs, 'the fingerprint is the stamp’s, exactly');
  assert.equal(resolveSessionRecordSync({ ...files, loadLegacy }).stamp, null);
});

test('a log whose base names another session than its file is log-invalid', async () => {
  const logPath = join(root, 'sess_named_log.log.jsonl');
  writeFileSync(logPath, baseLines({ id: 'sess_someone_else', messages: [msg('a')] }));
  const args = { jsonPath: join(root, 'sess_named_log.json'), logPath, loadLegacy };
  assert.equal((await resolveSessionRecord(args)).kind, 'log-invalid');
  assert.equal(resolveSessionRecordSync(args).kind, 'log-invalid');
});
