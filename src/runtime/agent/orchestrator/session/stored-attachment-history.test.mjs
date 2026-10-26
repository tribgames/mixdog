// Whether an attachment belongs to a session is decided against its whole
// stored conversation (record + compaction archive), not a transcript window.
// The lookup is its own read: it never fills or evicts the window cache, and a
// cleared or capped archive stays out.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-attachment-history-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const sessionsDir = join(dataDir, 'sessions');
mkdirSync(sessionsDir);
const { readStoredSessionTranscript, storedTranscriptCacheStats } = await import('./store-summary-reader.mjs');
const { compactionSegmentLine } = await import('./compaction-archive.mjs');
const { attachmentHistoryRows } = await import('./stored-attachment-history.mjs');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const hash = (char) => char.repeat(64);
const record = (id, name) => ({ id, attachmentRef: id, kind: 'image', name, mimeType: 'image/png', size: 3 });
const userRow = (seq, id) => ({
  id: `arch${seq}_0_1`,
  kind: 'user',
  text: `SECRET TEXT ${seq}`,
  archived: true,
  attachments: [record(id, 'image.png')],
});
const segment = (seq, id) =>
  compactionSegmentLine({
    seq,
    prev: seq > 1 ? seq - 1 : null,
    at: seq,
    items: [userRow(seq, id), { id: `arch${seq}_divider`, kind: 'statusdone', status: 'compacted' }],
  });

/** A stored session of 81 messages whose newest user message carries `recent`,
 *  and an archive of `segments` ([seq, attachment id]) under `archive`. */
function store(sessionId, { recent, segments = [], archive = null }) {
  const messages = Array.from({ length: 40 }, (_, index) => ({ role: 'user', content: `turn ${index}` }));
  messages.push({
    role: 'user',
    content: 'newest',
    meta: { transcript: { messageId: `msg_${sessionId}`, attachments: [record(recent, 'image.png')] } },
  });
  for (let index = 0; index < 40; index += 1) messages.push({ role: 'assistant', content: `reply ${index}` });
  const recordPath = join(sessionsDir, `${sessionId}.json`);
  writeFileSync(
    recordPath,
    JSON.stringify({
      id: sessionId,
      createdAt: 1_000,
      updatedAt: 2_000,
      lastUsedAt: 2_000,
      status: 'idle',
      owner: 'user',
      messages,
      ...(archive ? { compaction: { archive } } : {}),
    })
  );
  if (segments.length) {
    const archivePath = join(sessionsDir, `${sessionId}.compaction-archive.jsonl`);
    writeFileSync(archivePath, `${segments.map(([seq, id]) => segment(seq, id)).join('\n')}\n`);
  }
}

const named = (items) =>
  attachmentHistoryRows(items).flatMap((row) => (row.attachments ?? []).map((entry) => entry.id));
const historyIds = async (sessionId) =>
  ((await readStoredSessionTranscript(sessionId, { attachmentHistory: true }))?.items ?? []).flatMap((row) =>
    (row.attachments ?? []).map((entry) => entry.id)
  );

test('the whole stored history names attachments the tail window no longer holds, metadata only', async () => {
  store('sess_hist_whole', {
    recent: hash('b'),
    segments: [[1, hash('a')]],
    archive: { nextSeq: 2 },
  });
  const window = await readStoredSessionTranscript('sess_hist_whole', { transcriptItemLimit: 32 });
  assert.equal(window.items.length, 32);
  assert.deepEqual(named(window.items), []);

  const history = await readStoredSessionTranscript('sess_hist_whole', { attachmentHistory: true });
  assert.deepEqual((await historyIds('sess_hist_whole')).sort(), [hash('a'), hash('b')].sort());
  // Only attachment metadata crosses: no row text, tool output or ids of rows.
  for (const row of history.items) {
    assert.deepEqual(Object.keys(row).sort(), ['attachments', 'kind']);
    assert.deepEqual(Object.keys(row.attachments[0]).sort(), ['id', 'kind', 'mimeType', 'name', 'size']);
  }
  assert.equal(JSON.stringify(history).includes('SECRET TEXT'), false);
});

test('a lookup neither fills nor evicts the window cache, and repeats are cached under the file identity', async () => {
  store('sess_hist_cache', { recent: hash('c'), segments: [[1, hash('d')]], archive: { nextSeq: 2 } });
  const hits = [];
  const trace = ({ hit }) => hits.push(hit);
  const first = await readStoredSessionTranscript('sess_hist_cache', { transcriptItemLimit: 32, trace });
  const again = await readStoredSessionTranscript('sess_hist_cache', { transcriptItemLimit: 32, trace });
  assert.deepEqual(hits, [false, true]);
  assert.equal(again, first);
  const before = storedTranscriptCacheStats();

  const one = await readStoredSessionTranscript('sess_hist_cache', { attachmentHistory: true });
  const two = await readStoredSessionTranscript('sess_hist_cache', { attachmentHistory: true });
  // Cheap repeats: the same rows, not read again while the files are unchanged.
  assert.equal(two, one);
  assert.deepEqual(storedTranscriptCacheStats(), before);

  const after = await readStoredSessionTranscript('sess_hist_cache', { transcriptItemLimit: 32, trace });
  assert.deepEqual(hits, [false, true, true]);
  assert.equal(after, first);

  // New stored content is a new identity: the rows are read again.
  store('sess_hist_cache', { recent: hash('e'), segments: [[1, hash('d')]], archive: { nextSeq: 2 } });
  assert.deepEqual((await historyIds('sess_hist_cache')).sort(), [hash('d'), hash('e')].sort());
});

test('a cleared or capped archive stays excluded, as for a window', async () => {
  const [one, two, three] = [hash('1'), hash('2'), hash('3')];
  // Segments 1-3 are archived; a clear hid everything through segment 1.
  store('sess_hist_cleared', {
    recent: hash('f'),
    segments: [
      [1, one],
      [2, two],
      [3, three],
    ],
    archive: { nextSeq: 4, clearedThrough: 1 },
  });
  assert.deepEqual((await historyIds('sess_hist_cleared')).sort(), [two, three, hash('f')].sort());
  // The cap dropped the oldest segment from the file: nothing names it.
  store('sess_hist_capped', {
    recent: hash('f'),
    segments: [
      [2, two],
      [3, three],
    ],
    archive: { nextSeq: 4 },
  });
  assert.deepEqual((await historyIds('sess_hist_capped')).sort(), [two, three, hash('f')].sort());
  // A session whose archive sidecar is gone names only its record.
  store('sess_hist_no_archive', { recent: hash('f'), archive: { nextSeq: 3 } });
  assert.deepEqual(await historyIds('sess_hist_no_archive'), [hash('f')]);
});

test('only this session\'s own stored record answers; an absent or foreign one yields nothing', async () => {
  store('sess_hist_own', { recent: hash('9') });
  store('sess_hist_other', { recent: hash('8') });
  assert.deepEqual(await historyIds('sess_hist_own'), [hash('9')]);
  assert.equal(await readStoredSessionTranscript('sess_hist_missing', { attachmentHistory: true }), null);
  assert.equal(await readStoredSessionTranscript('../escape', { attachmentHistory: true }), null);
  // A record whose id is another session's is not served under this name.
  const misnamed = join(sessionsDir, 'sess_hist_misnamed.json');
  writeFileSync(
    misnamed,
    JSON.stringify({ id: 'sess_hist_own', createdAt: 1, updatedAt: 2, status: 'idle', owner: 'user', messages: [] })
  );
  assert.equal(await readStoredSessionTranscript('sess_hist_misnamed', { attachmentHistory: true }), null);
});

test('many unchanged sessions all stay cached on a second pass, within the byte budget', async () => {
  // More than the eight an entry-count LRU would hold: one cache entry per session.
  const sessionIds = Array.from({ length: 12 }, (_, index) => `sess_hist_many_${index}`);
  sessionIds.forEach((sessionId, index) => {
    store(sessionId, { recent: hash(index.toString(16)), segments: [[1, hash('d')]], archive: { nextSeq: 2 } });
  });
  const windowBefore = storedTranscriptCacheStats();
  const firstPass = [];
  for (const sessionId of sessionIds) {
    firstPass.push(await readStoredSessionTranscript(sessionId, { attachmentHistory: true }));
  }
  for (const [index, sessionId] of sessionIds.entries()) {
    const again = await readStoredSessionTranscript(sessionId, { attachmentHistory: true });
    // The very rows of the first pass: nothing was read or parsed again.
    assert.equal(again, firstPass[index], `${sessionId} was evicted`);
  }
  assert.deepEqual(storedTranscriptCacheStats(), windowBefore);
});
