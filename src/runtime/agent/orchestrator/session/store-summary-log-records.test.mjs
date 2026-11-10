// Session-log records (`<id>.log.jsonl`) beside the legacy-json cases of the
// cold reader: a log-only session reads exactly like its legacy twin.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { isolateDataDir, list, sessionsDir } from './store-summary-reader-catalog-fixture.mjs';
import {
  encodeAppend,
  encodeCompacted,
  encodePatch,
  encodeSessionRecord,
  fileFingerprint,
  sha1Hex,
} from './store/session-log-format.mjs';
import {
  listStoredSessionSummariesAsync,
  readStoredSessionCatalogRow,
  readStoredSessionTranscript,
  storedSessionExists,
} from './store-summary-reader.mjs';
import { readWorkerRecordHeader } from './store-agent-worker-header.mjs';

const header = (id) => ({
  id,
  owner: 'user',
  agent: 'lead',
  closed: false,
  generation: 1,
  updatedAt: 1,
  title: 'Same title',
  provider: 'p',
  model: 'm',
});
const messages = [
  { role: 'user', content: 'hello there' },
  { role: 'assistant', content: 'hi' },
];
const jsons = (items) => items.map((item) => JSON.stringify(item));

const legacyPath = (id) => join(sessionsDir(), `${id}.json`);
const logPath = (id) => join(sessionsDir(), `${id}.log.jsonl`);
const writeLegacy = (id, extra = {}) => writeFileSync(legacyPath(id), JSON.stringify({ ...header(id), ...extra, messages }));
const writeLog = (id, baseId = id) =>
  writeFileSync(
    logPath(id),
    encodeSessionRecord({ logId: `L-${id}`, id: baseId, header: header(baseId) }) + encodeCompacted(1, jsons(messages))
  );

// What differs between twins: the id and the file fingerprint.
const content = ({ id: _id, storageMtimeMs: _m, storageSize: _s, ...row }) => row;
const rowOf = (rows, id) => rows.find((row) => row.id === id);
const itemsOf = (value) => value.items.map((item) => [item.kind, item.text]);

test('a log-only session is listed, read and addressed like its legacy twin', async () => {
  isolateDataDir('mixdog-log-records-');
  writeLegacy('sess_legacy');
  writeLog('sess_logonly');

  const rows = list();
  assert.deepEqual(rows.map((row) => row.id).sort(), ['sess_legacy', 'sess_logonly']);
  assert.deepEqual(content(rowOf(rows, 'sess_logonly')), content(rowOf(rows, 'sess_legacy')));
  const refreshed = await listStoredSessionSummariesAsync({ refreshFromStorage: true });
  assert.deepEqual(content(rowOf(refreshed, 'sess_logonly')), content(rowOf(refreshed, 'sess_legacy')));
  assert.deepEqual(
    content(readStoredSessionCatalogRow('sess_logonly')),
    content(readStoredSessionCatalogRow('sess_legacy'))
  );

  assert.equal(storedSessionExists('sess_logonly'), true);
  assert.equal(storedSessionExists('sess_legacy'), true);
  const meta = async (id) => {
    const { id: _id, sessionId: _sessionId, ...rest } = await readStoredSessionTranscript(id, { metadataOnly: true });
    return rest;
  };
  assert.deepEqual(await meta('sess_logonly'), await meta('sess_legacy'));

  const [fromLog, fromJson] = await Promise.all(
    ['sess_logonly', 'sess_legacy'].map((id) => readStoredSessionTranscript(id, { transcriptItemLimit: 50 }))
  );
  assert.ok(itemsOf(fromJson).length > 0);
  assert.deepEqual(itemsOf(fromLog), itemsOf(fromJson));
});

test('records appended to a log reach its catalog row and its transcript', async () => {
  isolateDataDir('mixdog-log-append-');
  writeLog('sess_grow');
  assert.equal(readStoredSessionCatalogRow('sess_grow').messageCount, 2);
  const before = await readStoredSessionTranscript('sess_grow', { transcriptItemLimit: 50 });

  appendFileSync(
    logPath('sess_grow'),
    encodeAppend(2, 3, jsons([{ role: 'user', content: 'one more' }])) + encodePatch(3, [['title', '"Grown"']], [])
  );
  const row = readStoredSessionCatalogRow('sess_grow');
  assert.equal(row.messageCount, 3);
  assert.equal(row.title, 'Grown');
  const after = await readStoredSessionTranscript('sess_grow', { transcriptItemLimit: 50 });
  assert.equal(itemsOf(after).length, itemsOf(before).length + 1);
  assert.equal((await readStoredSessionTranscript('sess_grow', { metadataOnly: true })).title, 'Grown');
});

test('a log created beside a listed json is listed from the log without an index update', () => {
  isolateDataDir('mixdog-log-migrated-');
  writeLegacy('sess_migrated');
  assert.equal(rowOf(list(), 'sess_migrated').title, 'Same title');
  const json = readFileSync(legacyPath('sess_migrated'));
  const legacy = { sha1: sha1Hex(json), ...fileFingerprint(statSync(legacyPath('sess_migrated'))) };
  writeFileSync(
    logPath('sess_migrated'),
    encodeSessionRecord({ logId: 'L-m', id: 'sess_migrated', legacy, header: header('sess_migrated') }) +
      encodeCompacted(1, jsons(messages)) +
      encodePatch(2, [['title', '"From the log"']], [])
  );
  assert.equal(rowOf(list(), 'sess_migrated').title, 'From the log');
});

test('a json an older build wrote beside the log wins; a log of another session is none', async () => {
  isolateDataDir('mixdog-log-seam-');
  // A log born as one (no legacy base): any json beside it diverged.
  writeLog('sess_diverged');
  writeLegacy('sess_diverged', { title: 'written by v1.4.5' });
  assert.equal(readStoredSessionCatalogRow('sess_diverged').title, 'written by v1.4.5');

  writeLog('sess_named', 'sess_other');
  assert.equal(storedSessionExists('sess_named'), false);
  assert.equal(readStoredSessionCatalogRow('sess_named'), null);
  assert.deepEqual(
    list().map((row) => row.id),
    ['sess_diverged']
  );
});

test('a worker header reads the same from a log and from a legacy json', () => {
  isolateDataDir('mixdog-log-header-');
  writeLegacy('sess_hl');
  writeLog('sess_hg');
  const fields = ['owner', 'agent', 'title', 'provider', 'model', 'missing'];
  assert.deepEqual(readWorkerRecordHeader(legacyPath('sess_hg'), fields), readWorkerRecordHeader(legacyPath('sess_hl'), fields));
  assert.deepEqual(readWorkerRecordHeader(legacyPath('sess_hg'), fields), {
    owner: 'user',
    agent: 'lead',
    title: 'Same title',
    provider: 'p',
    model: 'm',
  });
  assert.equal(readWorkerRecordHeader(legacyPath('sess_none'), fields), null);
});
