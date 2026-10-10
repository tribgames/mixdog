/**
 * PG-backed session transcript search (schema `session_search`): the raw
 * user/assistant conversation text of every session under a full-text index,
 * with no embeddings. It opens the shared PG instance directly, like the
 * schedules and webhooks stores, so it never starts the memory runtime.
 *
 * Rows are append-only: compaction may drop old messages from a session file,
 * but their search rows stay, so earlier conversation remains findable until
 * the session itself is deleted.
 */

import { ensurePgInstance, withSchemaBootstrapLock } from '../memory/lib/pg/adapter.mjs';
import { buildFtsPrefixQuery } from '../memory/lib/memory-text-utils.mjs';
import {
  normalizeIngestRole,
  sessionMessageContentForIngest,
  shouldExcludeIngestMessage,
  stableSessionSourceRef,
} from '../memory/lib/session-ingest.mjs';
import { createPgSchemaDb } from '../shared/pg-schema-db.mjs';
import { resolvePluginData } from '../shared/plugin-paths.mjs';

const SCHEMA = 'session_search';

const DDL = `
CREATE SCHEMA IF NOT EXISTS session_search;
CREATE TABLE IF NOT EXISTS session_search.messages (
  source_ref  text PRIMARY KEY,
  session_id  text NOT NULL,
  ordinal     integer NOT NULL,
  role        text NOT NULL CHECK (role IN ('user','assistant')),
  ts          bigint,
  content     text NOT NULL,
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);
CREATE TABLE IF NOT EXISTS session_search.backfill (
  session_id text PRIMARY KEY,
  stamp      text NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON session_search.messages (session_id, ordinal);
CREATE INDEX IF NOT EXISTS messages_tsv_idx ON session_search.messages USING GIN (tsv);
`;

// to_tsvector rejects a document over 1 MB; a single message never needs more
// searchable text than this.
const MAX_CONTENT_CHARS = 100_000;
const SNIPPET_START = '\u0002';
const SNIPPET_STOP = '\u0003';

const getDb = createPgSchemaDb({
  schema: SCHEMA,
  ddl: DDL,
  defaultDataDir: resolvePluginData,
  ensurePg: ensurePgInstance,
  withLock: withSchemaBootstrapLock,
});

function messageTs(m) {
  const raw = m?.ts ?? m?.timestamp;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  const parsed = Date.parse(String(raw ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Search rows for a transcript: the same human/model prose the memory ingest
 *  keeps (synthetic, tool and runtime rows excluded), minus system reminders.
 *  `ordinal` is the message's index in `messages`. */
export function sessionSearchRows(sessionId, messages) {
  const rows = [];
  if (!sessionId || !Array.isArray(messages)) return rows;
  messages.forEach((m, index) => {
    if (!m || typeof m !== 'object') return;
    const role = normalizeIngestRole(m.role);
    if (!role || shouldExcludeIngestMessage(m)) return;
    const raw = sessionMessageContentForIngest(m);
    const content = String(raw || '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
      .trim()
      .slice(0, MAX_CONTENT_CHARS);
    if (!content) return;
    rows.push({
      sourceRef: stableSessionSourceRef(sessionId, m, role, raw, index),
      sessionId,
      ordinal: index,
      role,
      ts: messageTs(m),
      content,
    });
  });
  return rows;
}

/** Idempotent append of a transcript's searchable messages; returns the count
 *  of newly stored rows. Re-sending an already stored message is a no-op. */
export async function appendSessionSearchMessages(sessionId, messages, { dataDir } = {}) {
  const rows = sessionSearchRows(sessionId, messages);
  if (rows.length === 0) return 0;
  const db = await getDb(dataDir);
  const result = await db.query(
    `INSERT INTO session_search.messages (source_ref, session_id, ordinal, role, ts, content)
     SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::bigint[], $6::text[])
     ON CONFLICT (source_ref) DO NOTHING`,
    [
      rows.map((row) => row.sourceRef),
      rows.map((row) => row.sessionId),
      rows.map((row) => row.ordinal),
      rows.map((row) => row.role),
      rows.map((row) => row.ts),
      rows.map((row) => row.content),
    ]
  );
  return Number(result?.rowCount) || 0;
}

export async function deleteSessionSearchMessages(sessionId, { dataDir } = {}) {
  const db = await getDb(dataDir);
  await db.query(`DELETE FROM session_search.messages WHERE session_id = $1`, [sessionId]);
  await db.query(`DELETE FROM session_search.backfill WHERE session_id = $1`, [sessionId]);
}

/** Every session id that still has search rows or a backfill stamp. */
export async function readSessionSearchSessionIds({ dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `SELECT DISTINCT session_id FROM session_search.messages
     UNION SELECT session_id FROM session_search.backfill`
  );
  return rows.map((row) => String(row.session_id));
}

/** Backfill progress: Map(sessionId -> stamp) of sessions already ingested. */
export async function readSessionSearchBackfillStamps({ dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(`SELECT session_id, stamp FROM session_search.backfill`);
  return new Map(rows.map((row) => [String(row.session_id), String(row.stamp)]));
}

export async function recordSessionSearchBackfillStamp(sessionId, stamp, { dataDir } = {}) {
  const db = await getDb(dataDir);
  await db.query(
    `INSERT INTO session_search.backfill (session_id, stamp) VALUES ($1, $2)
     ON CONFLICT (session_id) DO UPDATE SET stamp = EXCLUDED.stamp`,
    [sessionId, stamp]
  );
}

/** Best-matching message per session, strongest sessions first:
 *  [{ sessionId, rank, snippet }]. An empty or unsearchable query returns []. */
export async function searchSessionMessages(query, { limit = 50, dataDir } = {}) {
  const fts = buildFtsPrefixQuery(query);
  if (!fts) return [];
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `WITH q AS (SELECT to_tsquery('simple', $1) AS query),
     hits AS (
       SELECT m.session_id, m.content, ts_rank_cd(m.tsv, q.query) AS rank,
              row_number() OVER (
                PARTITION BY m.session_id
                ORDER BY ts_rank_cd(m.tsv, q.query) DESC, m.ordinal DESC
              ) AS pick
       FROM session_search.messages m, q
       WHERE m.tsv @@ q.query
     )
     SELECT hits.session_id, hits.rank,
            ts_headline('simple', hits.content, q.query,
              'StartSel=${SNIPPET_START}, StopSel=${SNIPPET_STOP}, MaxWords=24, MinWords=8, MaxFragments=1') AS snippet
     FROM hits, q
     WHERE hits.pick = 1
     ORDER BY hits.rank DESC
     LIMIT $2`,
    [fts.query, limit]
  );
  return rows.map((row) => ({
    sessionId: String(row.session_id),
    rank: Number(row.rank) || 0,
    snippet: String(row.snippet || '')
      .replaceAll(SNIPPET_START, '')
      .replaceAll(SNIPPET_STOP, '')
      .replace(/\s+/g, ' ')
      .trim(),
  }));
}
