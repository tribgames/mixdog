/**
 * PG-backed webhook store — the single source of truth for webhook endpoint
 * definitions (schema `webhooks`, table `webhooks.endpoints`) and the
 * delivery dedup log (`webhooks.deliveries`).
 *
 * This module mirrors schedules-db.mjs: a lazy connection keyed per resolved
 * dataDir runs idempotent DDL exactly once per process, serialized across
 * concurrent first-boot processes on the adapter's schema-bootstrap advisory
 * lock. It covers the file-store API surface currently in
 * channels/lib/webhook/deliveries.mjs (loadEndpointConfig, appendDelivery,
 * deliveryExists, _readEndpointSecret) so call sites can migrate off the
 * per-endpoint WEBHOOK.md + deliveries.jsonl files later. No call-site
 * changes are made in this scope.
 *
 * All queries fully-qualify their tables so they are correct regardless of
 * the connection search_path.
 */

import { ensurePgInstance, withSchemaBootstrapLock } from '../memory/lib/pg/adapter.mjs';
import { resolvePluginData } from './plugin-paths.mjs';
import { readdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { readMarkdownDocument } from './markdown-frontmatter.mjs';

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
    await migrateLegacyWebhooks(db, dataDir);
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
// One-time legacy WEBHOOK.md migration (additive; runs once per dataDir on
// first getDb, right after DDL). Imports every `<dataDir>/webhooks/<name>/
// WEBHOOK.md` (+ its `secret` side file) not already present in the table (by
// name), then DELETES the webhooks/ directory. The legacy file reading is
// inlined here on purpose so this migration never depends on the file-store
// deliveries.mjs module (which another scope may remove). Old per-endpoint
// deliveries files are intentionally NOT imported — dedup history resets,
// which is acceptable. Partial failure keeps the directory in place and logs,
// so the next boot retries the un-imported entries idempotently.
// ---------------------------------------------------------------------------
async function migrateLegacyWebhooks(db, dataDir) {
  const dir = join(dataDir, 'webhooks');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // no legacy webhooks/ dir -> nothing to migrate
  }
  let imported = 0;
  let skipped = 0;
  const failed = [];
  // Per-endpoint dirs safe to delete this run: those imported now, or already
  // present in the table (a prior run imported them). Anything unrecognized —
  // a dir with no WEBHOOK.md, a stray file, a failed import — is left in place.
  const removable = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    try {
      const { rows } = await db.query('SELECT 1 FROM webhooks.endpoints WHERE name = $1', [name]);
      if (rows.length) { skipped++; removable.push(name); continue; }
      let md;
      try { md = readFileSync(join(dir, name, 'WEBHOOK.md'), 'utf8'); }
      catch { skipped++; continue; }
      const { frontmatter, body } = readMarkdownDocument(md);
      let secret = null;
      try { secret = String(readFileSync(join(dir, name, 'secret'), 'utf8')).trim() || null; }
      catch { secret = null; }
      const channel = String(frontmatter.channel || '').trim();
      const enabled = frontmatter.enabled !== 'false' && frontmatter.enabled !== false;
      await db.query(
        `INSERT INTO webhooks.endpoints
           (name, description, channel_id, role, model, parser, secret, instructions, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (name) DO NOTHING`,
        [
          name,
          String(frontmatter.description || '').trim(),
          channel || null,
          'webhook-handler',
          frontmatter.model ? String(frontmatter.model).trim() : null,
          frontmatter.parser ? String(frontmatter.parser).trim() : null,
          secret,
          String(body || '').trim(),
          enabled,
        ],
      );
      imported++;
      removable.push(name);
    } catch (err) {
      failed.push(name);
      console.error(`[webhooks] migration failed for "${name}": ${err?.message || err}`);
    }
  }
  // User chose deletion over a `.migrated` rename. Delete only the recognized
  // per-endpoint dirs (imported now or already in the table); never blow away
  // unimported/unrelated entries. Failed imports keep their dir for the next
  // boot to retry (idempotent via the name check above).
  for (const name of removable) {
    try { rmSync(join(dir, name), { recursive: true, force: true }); }
    catch (err) { console.error(`[webhooks] could not delete migrated dir "${name}": ${err?.message || err}`); }
  }
  // Remove the parent webhooks/ only once it is empty — anything unrecognized
  // (stray files, WEBHOOK.md-less dirs, failed imports) keeps it alive.
  let parentGone = false;
  try {
    if (readdirSync(dir).length === 0) { rmdirSync(dir); parentGone = true; }
  } catch (err) {
    console.error(`[webhooks] could not remove empty webhooks/: ${err?.message || err}`);
  }
  const tail = failed.length ? `${failed.length} failed (${failed.join(', ')}); ` : '';
  console.error(`[webhooks] migrated ${imported} legacy webhook(s) (${skipped} skipped); ${tail}${parentGone ? 'removed webhooks/' : 'kept webhooks/ (non-empty)'}`);
}

// ---------------------------------------------------------------------------
// Row <-> def mapping
// ---------------------------------------------------------------------------

const ENDPOINT_COLS = 'name, description, channel_id, role, model, parser, secret, instructions, enabled, created_at, updated_at';

function rowToEndpoint(row) {
  if (!row) return null;
  return {
    name:         row.name,
    description:  row.description,
    channelId:    row.channel_id,
    role:         row.role,
    model:        row.model,
    parser:       row.parser,
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
    def.instructions ?? '',
    def.enabled ?? true,
  ];
  const { rows } = await db.query(
    `INSERT INTO webhooks.endpoints
       (name, description, channel_id, role, model, parser, secret, instructions, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (name) DO UPDATE SET
       description  = EXCLUDED.description,
       channel_id   = EXCLUDED.channel_id,
       role         = EXCLUDED.role,
       model        = EXCLUDED.model,
       parser       = EXCLUDED.parser,
       secret       = EXCLUDED.secret,
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
 * True when a delivery id has already been recorded for the endpoint (any
 * status). Callers wanting terminal-vs-inflight semantics inspect the row via
 * getDelivery; claimDelivery is the race-safe gate.
 */
export async function deliveryExists(endpoint, deliveryId, { dataDir } = {}) {
  if (!endpoint || !deliveryId) return false;
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    'SELECT 1 FROM webhooks.deliveries WHERE endpoint = $1 AND delivery_id = $2',
    [endpoint, deliveryId],
  );
  return rows.length > 0;
}

export async function getDelivery(endpoint, deliveryId, { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `SELECT ${DELIVERY_COLS} FROM webhooks.deliveries WHERE endpoint = $1 AND delivery_id = $2`,
    [endpoint, deliveryId],
  );
  return rowToDelivery(rows[0]);
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

/**
 * Append a delivery record (claim-or-update convenience covering the old
 * appendDelivery). First write for an id claims it; a later write with the
 * same id updates its status/fields latest-wins.
 *
 * Returns the claim outcome — { claimed, duplicate, row } — NOT a bare row,
 * so a pre-dispatch caller can detect a concurrent duplicate (claimed:false,
 * duplicate:true) and skip re-dispatching an in-flight delivery. `row` is the
 * freshly claimed row when claimed, else the existing row after the
 * latest-wins status/fields update.
 */
export async function appendDelivery(endpoint, entry = {}, { dataDir } = {}) {
  const deliveryId = entry.deliveryId ?? entry.id;
  if (!endpoint || !deliveryId) throw new Error('appendDelivery: endpoint and deliveryId are required');
  const claim = await claimDelivery(endpoint, deliveryId, entry, { dataDir });
  if (claim.claimed) return claim;
  const row = await updateDeliveryStatus(endpoint, deliveryId, entry.status ?? claim.row?.status, entry, { dataDir });
  return { claimed: false, duplicate: true, row };
}
