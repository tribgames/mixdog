/**
 * PG-backed webhook store — the single source of truth for webhook endpoint
 * definitions (schema `webhooks`, table `webhooks.endpoints`) and the
 * delivery dedup log (`webhooks.deliveries`).
 *
 * This module mirrors schedules-db.mjs: a lazy connection keyed per resolved
 * dataDir runs idempotent DDL exactly once per process, serialized across
 * concurrent first-boot processes on the adapter's schema-bootstrap advisory
 * lock. It is the sole store for endpoints + delivery dedup; the old
 * per-endpoint WEBHOOK.md + deliveries.jsonl file store is fully retired
 * (webhook.mjs reads/writes only through here).
 *
 * All queries fully-qualify their tables so they are correct regardless of
 * the connection search_path.
 */

import { ensurePgInstance, withSchemaBootstrapLock } from '../../memory/lib/pg/adapter.mjs';
import { createPgSchemaDb } from '../../shared/pg-schema-db.mjs';
import { resolvePluginData } from '../../shared/plugin-paths.mjs';
import { ROUTINE_LIMITS } from '../../shared/routine-limits.mjs';

const SCHEMA = 'webhooks';

const DDL = `
CREATE SCHEMA IF NOT EXISTS webhooks;
CREATE TABLE IF NOT EXISTS webhooks.endpoints (
  name         text PRIMARY KEY,
  description  text NOT NULL DEFAULT '',
  role        text NOT NULL DEFAULT '',
  model        text,
  parser       text,
  secret       text,
  instructions text NOT NULL DEFAULT '',
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE webhooks.endpoints ADD COLUMN IF NOT EXISTS cwd text;
ALTER TABLE webhooks.endpoints ADD COLUMN IF NOT EXISTS workflow text;
ALTER TABLE webhooks.endpoints ADD COLUMN IF NOT EXISTS attachments jsonb;
ALTER TABLE webhooks.endpoints ADD COLUMN IF NOT EXISTS delivery text;
ALTER TABLE webhooks.endpoints ALTER COLUMN role SET DEFAULT '';
-- Agent ownership: each endpoint's results post into its owner's home
-- thread; endpoints from before ownership become Mixy's ('lead').
ALTER TABLE webhooks.endpoints ADD COLUMN IF NOT EXISTS owner_agent_id text NOT NULL DEFAULT 'lead';
-- Legacy columns model, workflow and run_as_agent are no longer read or written (kept, not dropped, to avoid a risky migration).
ALTER TABLE webhooks.endpoints ADD COLUMN IF NOT EXISTS run_as_agent boolean NOT NULL DEFAULT false;
-- The latest received event (its payload kept for a manual re-run) and the
-- outcome stamps of the runs it started.
ALTER TABLE webhooks.endpoints ADD COLUMN IF NOT EXISTS last_event_at timestamptz;
ALTER TABLE webhooks.endpoints ADD COLUMN IF NOT EXISTS last_payload jsonb;
ALTER TABLE webhooks.endpoints ADD COLUMN IF NOT EXISTS last_success_at timestamptz;
ALTER TABLE webhooks.endpoints ADD COLUMN IF NOT EXISTS last_failed_at timestamptz;
ALTER TABLE webhooks.endpoints ADD COLUMN IF NOT EXISTS last_skipped_at timestamptz;
-- Failed runs in a row (schedules parity): a success, an edit or switching it
-- back on resets it; at ROUTINE_LIMITS.pauseAfterFailures it switches off.
ALTER TABLE webhooks.endpoints ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;
-- Results of finished runs not yet queued for the owner's home thread, by run id.
ALTER TABLE webhooks.endpoints ADD COLUMN IF NOT EXISTS result_delivery jsonb;
CREATE TABLE IF NOT EXISTS webhooks.deliveries (
  endpoint        text NOT NULL,
  delivery_id     text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  event           text,
  error           text,
  headers_summary jsonb,
  payload_preview text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deliveries_endpoint_id_uniq UNIQUE (endpoint, delivery_id)
);
`;

const getDb = createPgSchemaDb({
  schema: SCHEMA,
  ddl: DDL,
  defaultDataDir: resolvePluginData,
  ensurePg: ensurePgInstance,
  withLock: withSchemaBootstrapLock,
});

// ---------------------------------------------------------------------------
// Row <-> def mapping
// ---------------------------------------------------------------------------

// The stored payload itself is never projected here (readEndpointLastPayload
// is its only read path); rows carry a presence flag.
const ENDPOINT_COLS =
  'name, description, parser, secret, cwd, attachments, delivery, instructions, enabled, owner_agent_id, last_event_at, last_success_at, last_failed_at, last_skipped_at, consecutive_failures, result_delivery, (last_payload IS NOT NULL) AS has_last_payload, created_at, updated_at';

function rowToEndpoint(row) {
  if (!row) return null;
  return {
    name: row.name,
    description: row.description,
    parser: row.parser,
    cwd: row.cwd,
    attachments: row.attachments || null,
    delivery: row.delivery || null,
    // Never project the plaintext secret through list/load config paths;
    // callers get a presence flag and must fetch the value via
    // readEndpointSecret (the single, explicit secret-read path).
    secretSet: Boolean(row.secret && String(row.secret).trim()),
    instructions: row.instructions,
    enabled: row.enabled,
    ownerAgentId: row.owner_agent_id || 'lead',
    lastEventAt: row.last_event_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastFailedAt: row.last_failed_at || null,
    lastSkippedAt: row.last_skipped_at || null,
    consecutiveFailures: Number(row.consecutive_failures) || 0,
    resultDelivery: row.result_delivery || null,
    hasLastPayload: row.has_last_payload === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DELIVERY_COLS =
  'endpoint, delivery_id, status, event, error, headers_summary, payload_preview, created_at, updated_at';

function rowToDelivery(row) {
  if (!row) return null;
  return {
    endpoint: row.endpoint,
    deliveryId: row.delivery_id,
    status: row.status,
    event: row.event,
    error: row.error,
    headersSummary: row.headers_summary,
    payloadPreview: row.payload_preview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Endpoint definitions
// ---------------------------------------------------------------------------

export async function listEndpoints({ dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(`SELECT ${ENDPOINT_COLS} FROM webhooks.endpoints ORDER BY name`);
  return rows.map(rowToEndpoint);
}

/**
 * Full endpoint config by name (replaces loadEndpointConfig's file read):
 * the frontmatter fields as one object, or null when absent.
 */
export async function loadEndpointConfig(name, { dataDir } = {}) {
  if (!name) return null;
  const db = await getDb(dataDir);
  const { rows } = await db.query(`SELECT ${ENDPOINT_COLS} FROM webhooks.endpoints WHERE name = $1`, [name]);
  return rowToEndpoint(rows[0]);
}

/**
 * Per-endpoint HMAC secret only (replaces _readEndpointSecret's side-file
 * read). Returns the trimmed secret or null.
 */
export async function readEndpointSecret(name, { dataDir } = {}) {
  if (!name) return null;
  const db = await getDb(dataDir);
  const { rows } = await db.query('SELECT secret FROM webhooks.endpoints WHERE name = $1', [name]);
  const s = rows[0]?.secret;
  return s ? String(s).trim() || null : null;
}

/**
 * Insert-or-replace an endpoint by name. On re-upsert every column is reset
 * from the incoming def (enabled and other stale fields included) so a
 * re-registration is a clean redefinition, mirroring upsertSchedule.
 */
export async function upsertEndpoint(def, { dataDir } = {}) {
  if (!def?.name) throw new Error('upsertEndpoint: def.name is required');
  const db = await getDb(dataDir);
  const params = [
    def.name,
    def.description ?? '',
    '',
    def.parser ?? null,
    def.secret ?? null,
    def.cwd ?? null,
    def.attachments ? JSON.stringify(def.attachments) : null,
    def.delivery ?? null,
    def.instructions ?? '',
    def.enabled ?? true,
    def.ownerAgentId || 'lead',
  ];
  // The last event and run stamps survive an edit: they describe deliveries,
  // not the definition.
  const { rows } = await db.query(
    `INSERT INTO webhooks.endpoints
       (name, description, role, parser, secret, cwd, attachments, delivery, instructions, enabled, owner_agent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (name) DO UPDATE SET
       owner_agent_id = EXCLUDED.owner_agent_id,
       description  = EXCLUDED.description,
       role        = EXCLUDED.role,
       parser       = EXCLUDED.parser,
       secret       = EXCLUDED.secret,
       cwd          = EXCLUDED.cwd,
       attachments  = EXCLUDED.attachments,
       delivery     = EXCLUDED.delivery,
       instructions = EXCLUDED.instructions,
       enabled      = EXCLUDED.enabled,
       consecutive_failures = 0,
       updated_at   = now()
     RETURNING ${ENDPOINT_COLS}`,
    params
  );
  return rowToEndpoint(rows[0]);
}

/** Switching an endpoint back on clears its failure streak. */
export async function setEndpointEnabled(name, enabled, { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `UPDATE webhooks.endpoints
        SET enabled = $2, consecutive_failures = CASE WHEN $2 THEN 0 ELSE consecutive_failures END, updated_at = now()
      WHERE name = $1 RETURNING ${ENDPOINT_COLS}`,
    [name, !!enabled]
  );
  return rowToEndpoint(rows[0]);
}

/** Record a received event: its time and payload (`{ body, headers }`), kept
 *  so the app can re-run the endpoint on it. */
export async function recordEndpointEvent(name, payload, at = new Date(), { dataDir } = {}) {
  const db = await getDb(dataDir);
  await db.query(
    'UPDATE webhooks.endpoints SET last_event_at = $2, last_payload = $3, updated_at = now() WHERE name = $1',
    [name, at, JSON.stringify(payload ?? null)]
  );
}

/** The payload of the latest received event, or null before the first. */
export async function readEndpointLastPayload(name, { dataDir } = {}) {
  if (!name) return null;
  const db = await getDb(dataDir);
  const { rows } = await db.query('SELECT last_payload FROM webhooks.endpoints WHERE name = $1', [name]);
  return rows[0]?.last_payload ?? null;
}

const RUN_STAMPS = Object.freeze({
  success: 'last_success_at',
  failed: 'last_failed_at',
  skipped: 'last_skipped_at',
});

/** Stamp a run outcome ('success' | 'failed' | 'skipped') on the endpoint. A
 *  success clears the failure streak; the failure reaching the pause limit
 *  switches the endpoint off (the receiver refuses a disabled endpoint). */
export async function markEndpointRun(name, outcome, at = new Date(), { dataDir } = {}) {
  const column = RUN_STAMPS[outcome];
  if (!column) throw new Error(`markEndpointRun: unknown outcome "${outcome}"`);
  const db = await getDb(dataDir);
  if (outcome === 'failed') {
    await db.query(
      `UPDATE webhooks.endpoints
          SET last_failed_at = $2, consecutive_failures = consecutive_failures + 1,
              enabled = enabled AND consecutive_failures + 1 < $3
        WHERE name = $1`,
      [name, at, ROUTINE_LIMITS.pauseAfterFailures]
    );
    return;
  }
  const streak = outcome === 'success' ? ', consecutive_failures = 0' : '';
  await db.query(`UPDATE webhooks.endpoints SET ${column} = $2${streak} WHERE name = $1`, [name, at]);
}

/** Set (`entry`) or clear (null) the undelivered result of run `runId`. */
export async function recordEndpointDelivery(name, runId, entry, { dataDir } = {}) {
  const db = await getDb(dataDir);
  await db.query(
    entry
      ? `UPDATE webhooks.endpoints
            SET result_delivery = COALESCE(result_delivery, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)
          WHERE name = $1`
      : `UPDATE webhooks.endpoints
            SET result_delivery = NULLIF(COALESCE(result_delivery, '{}'::jsonb) - $2::text, '{}'::jsonb)
          WHERE name = $1`,
    entry ? [name, runId, JSON.stringify(entry)] : [name, runId]
  );
}

export async function deleteEndpoint(name, { dataDir } = {}) {
  const db = await getDb(dataDir);
  // Atomically drop the endpoint AND its delivery log in one statement: a
  // data-modifying CTE deletes the deliveries, the outer DELETE removes the
  // endpoint row, so no orphan deliveries can survive a removed endpoint.
  const { rowCount } = await db.query(
    `WITH del AS (DELETE FROM webhooks.deliveries WHERE endpoint = $1 RETURNING 1)
     DELETE FROM webhooks.endpoints WHERE name = $1`,
    [name]
  );
  return rowCount > 0;
}

// ---------------------------------------------------------------------------
// Delivery dedup log
// ---------------------------------------------------------------------------

/**
 * Atomically claim a delivery id for an endpoint. INSERT ... ON CONFLICT DO
 * NOTHING makes the claim a single indivisible step, so two concurrent POSTs
 * of the same id cannot both win: exactly one insert affects a row.
 * Returns { claimed: true, row } for the winner and { claimed: false,
 * duplicate: true, row } for the loser (row = the existing claim).
 */
export async function claimDelivery(endpoint, deliveryId, fields = {}, { dataDir } = {}) {
  if (!endpoint || !deliveryId) throw new Error('claimDelivery: endpoint and deliveryId are required');
  const db = await getDb(dataDir);
  const params = [
    endpoint,
    deliveryId,
    fields.status ?? 'pending',
    fields.event ?? null,
    fields.headersSummary ?? null,
    fields.payloadPreview ?? null,
  ];
  const { rows } = await db.query(
    `INSERT INTO webhooks.deliveries
       (endpoint, delivery_id, status, event, headers_summary, payload_preview)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (endpoint, delivery_id) DO NOTHING
     RETURNING ${DELIVERY_COLS}`,
    params
  );
  if (rows[0]) return { claimed: true, duplicate: false, row: rowToDelivery(rows[0]) };
  // Lost the race (or a prior claim exists): return the existing row.
  const { rows: existing } = await db.query(
    `SELECT ${DELIVERY_COLS} FROM webhooks.deliveries WHERE endpoint = $1 AND delivery_id = $2`,
    [endpoint, deliveryId]
  );
  return { claimed: false, duplicate: true, row: rowToDelivery(existing[0]) };
}

/**
 * Update the status (and optional event/error) of an existing delivery,
 * keyed by (endpoint, delivery_id). Returns the updated row or null.
 */
export async function updateDeliveryStatus(endpoint, deliveryId, status, fields = {}, { dataDir } = {}) {
  if (!endpoint || !deliveryId) throw new Error('updateDeliveryStatus: endpoint and deliveryId are required');
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `UPDATE webhooks.deliveries
        SET status = $3,
            event = COALESCE($4, event),
            error = COALESCE($5, error),
            updated_at = now()
      WHERE endpoint = $1 AND delivery_id = $2
      RETURNING ${DELIVERY_COLS}`,
    [endpoint, deliveryId, status, fields.event ?? null, fields.error ?? null]
  );
  return rowToDelivery(rows[0]);
}
