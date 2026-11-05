import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeAppend, encodeCompacted, encodeSessionRecord } from './session-log-format.mjs';
import {
  ABSENT_RECORD_STAMP,
  isSettledRecordStamp,
  readSessionRecordSync,
  readSessionRecordTextSync,
  recordMessageCount,
  recordSession,
  recordStampFingerprint,
  sessionIdsOfNames,
  sessionRecordFiles,
  sessionRecordStampOfSync,
} from './session-record.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-session-record-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const msg = (content) => JSON.stringify({ role: 'user', content });
const writeLog = (id, baseId = id) =>
  writeFileSync(
    join(dir, `${id}.log.jsonl`),
    encodeSessionRecord({ logId: `L-${id}`, id: baseId, header: { id: baseId, title: 't' } }) +
      encodeCompacted(1, [msg('a')])
  );

test('a store dir names the union of json and log ids, nothing else', () => {
  assert.deepEqual(
    sessionIdsOfNames([
      'sess_a.json',
      'sess_a.log.jsonl',
      'sess_b.log.jsonl',
      'sess_c.json',
      'sess_d.compaction-archive.jsonl',
      'sess_e.log.jsonl.damaged-1700000000000-0a1b2c3d',
      'sess_f.log.jsonl.0a1b2c3d4e5f.tmp',
      'sess_g.json.tmp',
      'bad.name.json',
    ]),
    ['sess_a', 'sess_b', 'sess_c']
  );
});

test('the header scan keeps the count, a full replay the messages', () => {
  writeLog('sess_scan');
  appendFileSync(join(dir, 'sess_scan.log.jsonl'), encodeAppend(2, 2, [msg('b')]));
  const scan = readSessionRecordSync(dir, 'sess_scan', { messages: false });
  assert.deepEqual(recordSession(scan, 'sess_scan'), { id: 'sess_scan', title: 't' });
  assert.equal(recordMessageCount(scan, null), 2);
  const full = recordSession(readSessionRecordSync(dir, 'sess_scan'), 'sess_scan');
  assert.deepEqual(
    full.messages.map((m) => m.content),
    ['a', 'b']
  );
  const text = readSessionRecordTextSync(sessionRecordFiles(dir, 'sess_scan'), 'sess_scan');
  assert.equal(text.legacy, false);
  assert.deepEqual(JSON.parse(text.text), full);
});

test('a log whose base names another session holds no session of its file', () => {
  writeLog('sess_file', 'sess_elsewhere');
  assert.equal(recordSession(readSessionRecordSync(dir, 'sess_file'), 'sess_file'), null);
  assert.equal(readSessionRecordTextSync(sessionRecordFiles(dir, 'sess_file'), 'sess_file').text, null);
});

test('the record fingerprint is the log once there is one, and absence is a stamp', () => {
  assert.equal(sessionRecordStampOfSync(dir, 'sess_nothing'), ABSENT_RECORD_STAMP);
  assert.equal(recordStampFingerprint(ABSENT_RECORD_STAMP), null);
  writeFileSync(join(dir, 'sess_fp.json'), JSON.stringify({ id: 'sess_fp' }));
  const legacyOnly = recordStampFingerprint(sessionRecordStampOfSync(dir, 'sess_fp'));
  assert.equal(legacyOnly.size, Buffer.byteLength(JSON.stringify({ id: 'sess_fp' })));
  writeLog('sess_fp');
  const stamp = sessionRecordStampOfSync(dir, 'sess_fp');
  assert.notEqual(recordStampFingerprint(stamp).size, legacyOnly.size);
  // A json written just now is inside the racy window; a log alone never is.
  assert.equal(isSettledRecordStamp(stamp), false);
  writeLog('sess_logonly');
  assert.equal(isSettledRecordStamp(sessionRecordStampOfSync(dir, 'sess_logonly')), true);
});
