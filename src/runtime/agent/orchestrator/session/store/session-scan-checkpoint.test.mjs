// What a header scan leaves of a session log for the next process
// (session-scan-checkpoint.mjs) is a place in it, never a copy of its text, and
// it lives as long as the log does: a deleted session leaves none, a log that
// is gone by any other way (a delete by another process, a restored or moved
// data directory) has its checkpoints swept, and a checkpoint of a file that
// has been replaced goes with the next scan of the name.
import '../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-scan-checkpoint-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'), { recursive: true });

const { deleteSession, drainSessionStore, saveSessionDurably } = await import('../store.mjs');
const { sweepStaleSessions } = await import('./sweep/stale-sweep.mjs');
const { readSessionLogSync } = await import('./session-log-reader.mjs');
const { encodeAppend, encodeCompacted, encodeSessionRecord } = await import('./session-log-format.mjs');
const { sessionLogPath, sessionScanCheckpointDir } = await import('./session-paths.mjs');
const { _setScanCheckpointStrideForTest, removeScanCheckpoints, scanCheckpointPath, withScanCheckpointsRetiredSync, sweepOrphanScanCheckpoints } =
  await import('./session-scan-checkpoint.mjs');

test.beforeEach(() => {
  _setScanCheckpointStrideForTest(1);
  rmSync(sessionScanCheckpointDir(), { recursive: true, force: true });
});
test.after(() => {
  _setScanCheckpointStrideForTest(null);
  drainSessionStore();
  rmSync(root, { recursive: true, force: true });
});

const j = (items) => items.map((item) => JSON.stringify(item));
const msg = (text) => ({ role: 'user', content: text });
const scanned = (logPath) => readSessionLogSync(logPath, { messages: false, checkpoints: sessionScanCheckpointDir() });
const leftBy = () => {
  try {
    // The epoch tokens (.epoch) hold a path and a random value, nothing of a log.
    return readdirSync(sessionScanCheckpointDir()).filter((name) => !name.endsWith('.epoch'));
  } catch {
    return [];
  }
};

function writeLog(id, ...texts) {
  const logPath = join(root, 'sessions', `${id}.log.jsonl`);
  writeFileSync(
    logPath,
    encodeSessionRecord({ logId: `L-${id}`, id, legacy: null, header: { id, title: 't' } }) +
      encodeCompacted(1, j([msg(texts[0])])) +
      texts.slice(1).map((text, index) => encodeAppend(2 + index, 2 + index, j([msg(text)]))).join('')
  );
  return logPath;
}

test('a checkpoint holds no byte of the log it is of', () => {
  const secret = 'the-pin-is-482915';
  const logPath = writeLog('sess_cp_bytes', `${secret} ${'a'.repeat(3000)}`, `again ${secret}`, `${secret} last`);
  scanned(logPath);
  const text = readFileSync(scanCheckpointPath(sessionScanCheckpointDir(), logPath), 'latin1');
  const log = readFileSync(logPath);
  assert.ok(text.length > 100, 'a checkpoint was left');
  for (const bytes of [log.subarray(0, 1024), log.subarray(log.length - 1024)]) {
    assert.equal(text.includes(bytes.toString('base64').slice(0, 64)), false, 'no base64 of the log bytes');
    assert.equal(text.includes(bytes.toString('latin1').slice(100, 164)), false, 'no raw log bytes');
  }
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes(Buffer.from(secret).toString('base64')), false);
});

test('deleting a session removes the checkpoints of its log', async () => {
  const id = 'sess_cp_delete';
  const session = { id, owner: 'agent', messages: [msg(`pin 482915 ${'b'.repeat(2000)}`), msg('two'), msg('three')] };
  await saveSessionDurably(session);
  const logPath = sessionLogPath(id);
  scanned(logPath);
  assert.ok(leftBy().length >= 1, 'a checkpoint was left');
  assert.equal(await deleteSession(id), true);
  assert.deepEqual(leftBy(), []);
});

test('a checkpoint of a log that is gone is swept; one of a log that is there stays', async () => {
  const kept = writeLog('sess_cp_kept', 'kept one', 'kept two');
  const gone = writeLog('sess_cp_gone', 'gone one', 'gone two');
  scanned(kept);
  scanned(gone);
  const dir = sessionScanCheckpointDir();
  const unrelated = join(dir, 'notes.json');
  writeFileSync(unrelated, '{}');
  rmSync(gone);
  await sweepStaleSessions({ sweepIdle: false });
  assert.deepEqual(
    readdirSync(dir).filter((name) => name !== 'notes.json'),
    [scanCheckpointPath(dir, kept).slice(dir.length + 1)]
  );
  assert.equal(readFileSync(unrelated, 'utf8'), '{}');
  // A file that does not say which log it is of is not a checkpoint of one that is there.
  writeFileSync(join(dir, `${'0'.repeat(40)}.json`), 'torn');
  assert.equal(await sweepOrphanScanCheckpoints(dir), 1);
  removeScanCheckpoints(dir, kept);
  assert.deepEqual(readdirSync(dir), ['notes.json']);
});

test('a checkpoint of a file that has been replaced under the name goes with the next scan', () => {
  const logPath = writeLog('sess_cp_replaced', 'old content '.repeat(50), 'old two');
  scanned(logPath);
  assert.equal(leftBy().length, 1, 'a checkpoint was left');
  writeLog('sess_cp_replaced', 'new content');
  // One record: below the stride's reach, so the scan leaves none of its own.
  _setScanCheckpointStrideForTest(1 << 30);
  try {
    scanned(logPath);
  } finally {
    _setScanCheckpointStrideForTest(1);
  }
  assert.deepEqual(leftBy(), []);
});

test('the digests are SHA-256, and the sweep removes the epoch token of a log that is gone', async () => {
  const logPath = writeLog('sess_cp_sha256', 'x'.repeat(2000), 'two');
  scanned(logPath);
  const doc = JSON.parse(readFileSync(scanCheckpointPath(sessionScanCheckpointDir(), logPath), 'utf8'));
  assert.match(doc.first, /^[0-9a-f]{64}$/);
  assert.match(doc.guard, /^[0-9a-f]{64}$/);
  const gone = join(root, 'sessions', 'sess_cp_gone.log.jsonl');
  withScanCheckpointsRetiredSync(sessionScanCheckpointDir(), gone, () => {});
  const token = readdirSync(sessionScanCheckpointDir()).find((name) => name.endsWith('.epoch'));
  assert.ok(token, 'a retirement leaves its token');
  assert.equal(await sweepOrphanScanCheckpoints(sessionScanCheckpointDir()), 0, 'a fresh token stays');
  const old = new Date(Date.now() - 3600_000);
  utimesSync(join(sessionScanCheckpointDir(), token), old, old);
  assert.equal(await sweepOrphanScanCheckpoints(sessionScanCheckpointDir()), 1);
  assert.equal(readdirSync(sessionScanCheckpointDir()).includes(token), false);
});