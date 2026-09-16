import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { createTranscriptIngest, parseTsToMs } from './transcript-ingest.mjs';
import { stableSessionSourceRef } from './session-ingest.mjs';
import { cleanMemoryText } from './memory-extraction.mjs';

mock.module('./memory-cycle.mjs', {
  namedExports: { flushRawEmbeddings: async () => ({ attempted: 0, embedded: 0 }) },
});
const { createSessionIngestRuntime } = await import('./session-ingest-runtime.mjs');

function store(initial = []) {
  const entries = new Map(initial.map((entry) => [entry.source_ref, entry]));
  const db = {
    entries,
    query: async (sql, params) => {
      if (sql.includes('MAX(source_turn)')) return { rows: [{ max_turn: entries.size }] };
      if (!sql.includes('INSERT INTO entries')) throw new Error(`unexpected query ${sql}`);
      if (entries.has(params[3])) return { rowCount: 0, rows: [] };
      const entry = {
        id: entries.size + 1,
        role: params[1],
        content: params[2],
        source_ref: params[3],
        source_turn: params[5],
      };
      entries.set(entry.source_ref, entry);
      return { rowCount: 1, rows: [{ id: entry.id }] };
    },
  };
  return db;
}

const bodies = [
  '```js\nconst failures = 296;\n```',
  'https://example.com/required?count=296',
  '| rows | time |\n| 10 | 6.1s |\n조건은 400자 이후에도 유지합니다.',
  'Exact request: `a|b`\n```text\nThe usage limit has been reached\n```',
];

test('transcript ingestion stores code-only, URL-only and table bodies verbatim and replay stays idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-ingest-source-'));
  const path = join(directory, 'session.jsonl');
  await writeFile(
    path,
    bodies
      .map((content, i) =>
        JSON.stringify({
          type: i % 2 ? 'assistant' : 'user',
          timestamp: new Date(1700000000000 + i * 1000).toISOString(),
          message: { content },
        })
      )
      .join('\n') + '\n',
    { flag: 'wx' }
  );
  const db = store();
  let offsets = '{}';
  const ingest = createTranscriptIngest({
    getDb: () => db,
    loadMeta: async () => offsets,
    persistMeta: async (value) => {
      offsets = value;
    },
    projectsRoot: () => directory,
    resolveProjectId: () => null,
  });
  await ingest.loadTranscriptOffsets();
  await ingest.ingestTranscriptFile(path);
  assert.deepEqual(
    [...db.entries.values()].map((entry) => entry.content),
    bodies
  );
  await ingest.ingestTranscriptFile(path);
  assert.equal(db.entries.size, bodies.length);
});

test('session ingestion retains full bodies and cloned replay does not duplicate them', async () => {
  const db = store();
  const runtime = createSessionIngestRuntime({ getDb: () => db, log: () => {}, parseTsToMs });
  const messages = bodies.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content }));
  await runtime.ingestSessionMessages({ sessionId: 's', messages });
  assert.deepEqual(
    [...db.entries.values()].map((entry) => entry.content),
    bodies
  );
  await runtime.ingestSessionMessages({ sessionId: 's', messages: structuredClone(messages) });
  assert.equal(db.entries.size, bodies.length);
  await runtime.ingestSessionMessages({
    sessionId: 's',
    messages: [...structuredClone(messages), { role: 'user', content: bodies[0] }],
  });
  assert.equal(db.entries.size, bodies.length + 1);
});

test('legacy cleaned-source identities still deduplicate without overwriting old rows on replay', async () => {
  const message = { role: 'user', content: bodies[3], timestamp: '2026-09-14T00:00:00.000Z' };
  const cleaned = cleanMemoryText(message.content);
  const sourceRef = stableSessionSourceRef('legacy', message, 'user', cleaned, 0);
  const db = store([{ id: 1, role: 'user', content: cleaned, source_ref: sourceRef, source_turn: 1 }]);
  const runtime = createSessionIngestRuntime({ getDb: () => db, log: () => {}, parseTsToMs });
  await runtime.ingestSessionMessages({ sessionId: 'legacy', messages: [message] });
  assert.equal(db.entries.size, 1);
  assert.equal(db.entries.get(sourceRef).content, cleaned);
});
