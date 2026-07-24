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

import { ensurePgInstance, withSchemaBootstrapLock } from '../memory/lib/pg/adapter.mjs';
import { resolvePluginData } from './plugin-paths.mjs';

const SCHEMA = 'webhooks';

// ---------------------------------------------------------------------------
// Lazy connection + one-shot idempotent DDL (keyed per resolved dataDir).
// ---------------------------------------------------------------------------

const _ready = new Map(); // dataDir → Promise<db>

const DDL = `
CREATE SCHEMA IF NOT EXISTS webhooks;
CREATE TABLE IF NOT EXISTS webhooks.endpoints (
  name         text PRIMARY KEY,
  description  text NOT NULL DEFAULT '',
  channel_id   text,
  role         text NOT NULL DEFAULT 'webhook-handler',
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

async function getDb(dataDir = resolvePluginData()) {
  if (_ready.has(dataDir)) return _ready.get(dataDir);
  const p = (async () => {
    const { db, pool } = await ensurePgInstance(dataDir, { schema: SCHEMA });
    // Serialize the CREATE TABLE across concurrent first-boot processes on the
    // same cluster-global advisory lock the adapter uses for schema bootstrap,
    // so racing first calls can't run the DDL simultaneously.
    await withSchemaBootstrapLock(pool, () => db.exec(DDL));
    return db;
  })();
  _ready.set(dataDir, p);
  try {
    return await p;
  } catch (err) {
    _ready.delete(dataDir); // let the next call retry DDL after a transient failure
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Row <-> def mapping
// ---------------------------------------------------------------------------

const ENDPOINT_COLS = 'name, description, channel_id, role, model, parser, secret, cwd, workflow, attachments, delivery, instructions, enabled, created_at, updated_at';

function rowToEndpoint(row) {
  if (!row) return null;
  return {
    name:         row.name,
    description:  row.description,
    channelId:    row.channel_id,
    role:         row.role,
    model:        row.model,
    parser:       row.parser,
    cwd:          row.cwd,
    workflow:     row.workflow,
    attachments:  row.attachments || null,
    delivery:     row.delivery || null,
    // Never project the plaintext secret through list/load config paths;
    // callers get a presence flag and must fetch the value via
    // readEndpointSecret (the single, explicit secret-read path).
    secretSet:    Boolean(row.secret && String(row.secret).trim()),
    instructions: row.instructions,
    enabled:      row.enabled,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
  };
}

const DELIVERY_COLS = 'endpoint, delivery_id, status, event, error, headers_summary, payload_preview, created_at, updated_at';

function rowToDelivery(row) {
  if (!row) return null;
  return {
    endpoint:       row.endpoint,
    deliveryId:     row.delivery_id,
    status:         row.status,
    event:          row.event,
    error:          row.error,
    headersSummary: row.headers_summary,
    payloadPreview: row.payload_preview,
    createdAt:      row.created_at,
    updatedAt:      row.updated_at,
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
  if (!def || !def.name) throw new Error('upsertEndpoint: def.name is required');
  const db = await getDb(dataDir);
  const params = [
    def.name,
    def.description ?? '',
    def.channelId ?? null,
    def.role ?? 'webhook-handler',
    def.model ?? null,
    def.parser ?? null,
    def.secret ?? null,
    def.cwd ?? null,
    def.workflow ?? null,
    def.attachments ? JSON.stringify(def.attachments) : null,
    def.delivery ?? null,
    def.instructions ?? '',
    def.enabled ?? true,
  ];
  const { rows } = await db.query(
    `INSERT INTO webhooks.endpoints
       (name, description, channel_id, role, model, parser, secret, cwd, workflow, attachments, delivery, instructions, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (name) DO UPDATE SET
       description  = EXCLUDED.description,
       channel_id   = EXCLUDED.channel_id,
       role         = EXCLUDED.role,
       model        = EXCLUDED.model,
       parser       = EXCLUDED.parser,
       secret       = EXCLUDED.secret,
       cwd          = EXCLUDED.cwd,
       workflow     = EXCLUDED.workflow,
       attachments  = EXCLUDED.attachments,
       delivery     = EXCLUDED.delivery,
       instructions = EXCLUDED.instructions,
       enabled      = EXCLUDED.enabled,
       updated_at   = now()
     RETURNING ${ENDPOINT_COLS}`,
    params,
  );
  return rowToEndpoint(rows[0]);
}

export async function setEndpointEnabled(name, enabled, { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `UPDATE webhooks.endpoints SET enabled = $2, updated_at = now() WHERE name = $1 RETURNING ${ENDPOINT_COLS}`,
    [name, !!enabled],
  );
  return rowToEndpoint(rows[0]);
}

export async function deleteEndpoint(name, { dataDir } = {}) {
  const db = await getDb(dataDir);
  // Atomically drop the endpoint AND its delivery log in one statement: a
  // data-modifying CTE deletes the deliveries, the outer DELETE removes the
  // endpoint row, so no orphan deliveries can survive a removed endpoint.
  const { rowCount } = await db.query(
    `WITH del AS (DELETE FROM webhooks.deliveries WHERE endpoint = $1 RETURNING 1)
     DELETE FROM webhooks.endpoints WHERE name = $1`,
    [name],
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
    params,
  );
  if (rows[0]) return { claimed: true, duplicate: false, row: rowToDelivery(rows[0]) };
  // Lost the race (or a prior claim exists): return the existing row.
  const { rows: existing } = await db.query(
    `SELECT ${DELIVERY_COLS} FROM webhooks.deliveries WHERE endpoint = $1 AND delivery_id = $2`,
    [endpoint, deliveryId],
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
    [endpoint, deliveryId, status, fields.event ?? null, fields.error ?? null],
  );
  return rowToDelivery(rows[0]);
}
