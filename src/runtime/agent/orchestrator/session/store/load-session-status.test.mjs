// The agent-status pulse asks every second for the status of each session it
// watches; a session another process is writing changes its record after
// almost every pulse, and each answer replayed the whole log, transcript
// included, to read a field of its header. The status is now read as the log's
// header scan, which reads what was appended since the last read of it.
import '../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-load-status-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'), { recursive: true });

const { loadSession, loadSessionStatus } = await import('../store.mjs');
const { encodeAppend, encodeCompacted, encodePatch, encodeSessionRecord } = await import('./session-log-format.mjs');

test.after(() => rmSync(root, { recursive: true, force: true }));

test("a session another process writes: its status is read from what was appended, and is the status its whole load gives", () => {
  const id = 'sess_status_other_process';
  const logPath = join(root, 'sessions', `${id}.log.jsonl`);
  const message = JSON.stringify({ role: 'user', content: 'k'.repeat(512 * 1024) });
  let text =
    encodeSessionRecord({ logId: 'L1', id, legacy: null, header: { id, title: 't', status: 'idle' } }) +
    encodeCompacted(1, [message]);
  for (let i = 0; i < 40; i += 1) text += encodeAppend(2 + i, 2 + i, [message]);
  writeFileSync(logPath, text);
  const size = statSync(logPath).size;
  assert.ok(size > 20 * 1024 * 1024, `a ${size}-byte log`);

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
    assert.equal(loadSessionStatus(id), 'idle');
    assert.ok(bytes >= size, `the first read took ${bytes} of ${size} bytes`);

    appendFileSync(logPath, encodePatch(42, [['status', '"working"']], []) + encodeAppend(43, 42, [message]));
    bytes = 0;
    assert.equal(loadSessionStatus(id), 'working');
    assert.ok(bytes < size / 10, `the status after an append took ${bytes} of ${size} bytes`);

    appendFileSync(logPath, encodePatch(44, [['status', '"done"']], []));
    bytes = 0;
    assert.equal(loadSessionStatus(id), 'done');
    assert.ok(bytes < size / 10, `the next status took ${bytes} bytes`);
  } finally {
    fs.readSync = readSync;
    fs.readFileSync = readFileSync;
    syncBuiltinESMExports();
  }
  // The whole load is still the whole session, and says the same.
  const loaded = loadSession(id);
  assert.equal(loaded.status, 'done');
  assert.equal(loaded.messages.length, 42);
});

// loadSessionStatus returns the one field a caller of it reads: session-progress.mjs
// (`loadSessionStatus(sessionId) || null`) is its only caller, and the job-views
// session-record.mjs only checks that a manager has it.
test('the status equals the whole load\'s status after a compaction and while a turn is in flight', async () => {
  const { forgetSessionLoadCache } = await import('./load-cache.mjs');
  const { setLiveSession, _clearLiveSession } = await import('./live-state.mjs');
  const { saveSessionDurably } = await import('../store.mjs');
  const { releaseSessionWriter } = await import('./session-writer-claim.mjs');
  const message = (text) => JSON.stringify({ role: 'user', content: text });
  const same = (id, label) => {
    forgetSessionLoadCache(id);
    const whole = loadSession(id)?.status ?? null;
    forgetSessionLoadCache(id);
    assert.equal(loadSessionStatus(id), whole, label);
    return whole;
  };

  // A log that was compacted: its history replaced by a summary, then written on.
  const compacted = 'sess_status_compacted';
  const logPath = join(root, 'sessions', `${compacted}.log.jsonl`);
  let text =
    encodeSessionRecord({ logId: 'L1', id: compacted, legacy: null, header: { id: compacted, title: 't', status: 'idle' } }) +
    encodeCompacted(1, [message('first')]);
  for (let i = 0; i < 20; i += 1) text += encodeAppend(2 + i, 2 + i, [message(`turn ${i}`)]);
  writeFileSync(logPath, text);
  assert.equal(same(compacted, 'before the compaction'), 'idle');
  appendFileSync(logPath, encodeCompacted(22, [message('summary of the turns'), message('the last turn')]));
  assert.equal(same(compacted, 'right after the compaction'), 'idle');
  appendFileSync(logPath, encodePatch(23, [['status', '"running"']], []) + encodeAppend(24, 23, [message('after')]));
  assert.equal(same(compacted, 'after the compaction, written on'), 'running');

  // A turn in flight: the record says one thing, the live copy another, and each
  // reader answers what the whole load answers.
  const flying = 'sess_status_in_flight';
  const session = { id: flying, owner: 'agent', status: 'idle', messages: [{ role: 'user', content: 'go' }] };
  await saveSessionDurably(session);
  assert.equal(same(flying, 'saved, idle'), 'idle');
  setLiveSession({ ...session, status: 'running', messages: [...session.messages, { role: 'assistant', content: 'working' }] });
  try {
    forgetSessionLoadCache(flying);
    const whole = loadSession(flying).status;
    forgetSessionLoadCache(flying);
    assert.equal(loadSessionStatus(flying), whole);
    assert.equal(whole, 'running');
  } finally {
    _clearLiveSession(flying);
    await releaseSessionWriter(flying);
  }
});