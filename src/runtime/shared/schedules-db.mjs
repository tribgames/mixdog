/**
 * PG-backed schedules store — the single source of truth for registered
 * schedules (schema `scheduler`, table `scheduler.schedules`).
 *
 * All schedule readers/writers (scheduler.mjs, config.mjs, channel-admin.mjs)
 * go through this module. It is the sole store for schedules; the old
 * file-based schedules-store.mjs has been retired.
 *
 * DDL is idempotent and runs once on the first call per process. All queries
 * fully-qualify `scheduler.schedules` so they are correct regardless of the
 * connection search_path.
 */

import { ensurePgInstance, withSchemaBootstrapLock } from '../memory/lib/pg/adapter.mjs';
import { resolvePluginData } from './plugin-paths.mjs';

const SCHEMA = 'scheduler';

// ---------------------------------------------------------------------------
// Lazy connection + one-shot idempotent DDL (keyed per resolved dataDir).
// ---------------------------------------------------------------------------

const _ready = new Map(); // dataDir → Promise<db>

const DDL = `
CREATE TABLE IF NOT EXISTS scheduler.schedules (
  name           text PRIMARY KEY,
  description    text NOT NULL DEFAULT '',
  when_at        timestamptz,
  when_cron      text,
  timezone       text,
  target         text NOT NULL CHECK (target IN ('channel','session')),
  channel_id     text,
  model          text,
  prompt         text NOT NULL,
  enabled        boolean NOT NULL DEFAULT true,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','done')),
  last_fired_at  timestamptz,
  next_fire_at   timestamptz,
  deferred_until timestamptz,
  skipped_until  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedules_when_xor CHECK ((when_at IS NOT NULL) <> (when_cron IS NOT NULL))
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

function rowToDef(row) {
  if (!row) return null;
  return {
    name:          row.name,
    description:   row.description,
    whenAt:        row.when_at,
    whenCron:      row.when_cron,
    timezone:      row.timezone,
    target:        row.target,
    channelId:     row.channel_id,
    model:         row.model,
    prompt:        row.prompt,
    enabled:       row.enabled,
    status:        row.status,
    lastFiredAt:   row.last_fired_at,
    nextFireAt:    row.next_fire_at,
    deferredUntil: row.deferred_until,
    skippedUntil:  row.skipped_until,
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
  };
}

const COLS = 'name, description, when_at, when_cron, timezone, target, channel_id, model, prompt, enabled, status, last_fired_at, next_fire_at, deferred_until, skipped_until, created_at, updated_at';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listSchedules({ dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(`SELECT ${COLS} FROM scheduler.schedules ORDER BY name`);
  return rows.map(rowToDef);
}

export async function getSchedule(name, { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(`SELECT ${COLS} FROM scheduler.schedules WHERE name = $1`, [name]);
  return rowToDef(rows[0]);
}

/**
 * Insert-or-replace a schedule by name. Exactly one of `whenAt`/`whenCron`
 * must be provided (enforced by the table's XOR CHECK constraint).
 */
export async function upsertSchedule(def, { dataDir } = {}) {
  if (!def || !def.name) throw new Error('upsertSchedule: def.name is required');
  if (!def.prompt) throw new Error('upsertSchedule: def.prompt is required');
  const db = await getDb(dataDir);
  const params = [
    def.name,
    def.description ?? '',
    def.whenAt ?? null,
    def.whenCron ?? null,
    def.timezone ?? null,
    def.target,
    def.channelId ?? null,
    def.model ?? null,
    def.prompt,
    def.enabled ?? true,
    def.status ?? 'active',
    def.nextFireAt ?? null,
  ];
  const { rows } = await db.query(
    `INSERT INTO scheduler.schedules
       (name, description, when_at, when_cron, timezone, target, channel_id, model, prompt, enabled, status, next_fire_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (name) DO UPDATE SET
       description  = EXCLUDED.description,
       when_at      = EXCLUDED.when_at,
       when_cron    = EXCLUDED.when_cron,
       timezone     = EXCLUDED.timezone,
       target       = EXCLUDED.target,
       channel_id   = EXCLUDED.channel_id,
       model        = EXCLUDED.model,
       prompt       = EXCLUDED.prompt,
       enabled      = EXCLUDED.enabled,
       next_fire_at = EXCLUDED.next_fire_at,
       -- Redefinition clears stale runtime state and reactivates so the
       -- re-registered schedule is due again in listDue.
       status         = 'active',
       deferred_until = NULL,
       skipped_until  = NULL,
       last_fired_at  = NULL,
       updated_at   = now()
     RETURNING ${COLS}`,
    params,
  );
  return rowToDef(rows[0]);
}

export async function deleteSchedule(name, { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rowCount } = await db.query(`DELETE FROM scheduler.schedules WHERE name = $1`, [name]);
  return rowCount > 0;
}

export async function setEnabled(name, enabled, { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `UPDATE scheduler.schedules SET enabled = $2, updated_at = now() WHERE name = $1 RETURNING ${COLS}`,
    [name, !!enabled],
  );
  return rowToDef(rows[0]);
}

export async function markFired(name, ts = new Date(), { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `UPDATE scheduler.schedules SET last_fired_at = $2, updated_at = now() WHERE name = $1 RETURNING ${COLS}`,
    [name, ts],
  );
  return rowToDef(rows[0]);
}

export async function markDone(name, { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `UPDATE scheduler.schedules SET status = 'done', next_fire_at = NULL, updated_at = now() WHERE name = $1 RETURNING ${COLS}`,
    [name],
  );
  return rowToDef(rows[0]);
}

export async function setDeferred(name, untilTs, { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `UPDATE scheduler.schedules SET deferred_until = $2, updated_at = now() WHERE name = $1 RETURNING ${COLS}`,
    [name, untilTs ?? null],
  );
  return rowToDef(rows[0]);
}

export async function setSkippedUntil(name, ts, { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `UPDATE scheduler.schedules SET skipped_until = $2, updated_at = now() WHERE name = $1 RETURNING ${COLS}`,
    [name, ts ?? null],
  );
  return rowToDef(rows[0]);
}

/**
 * Schedules that are eligible to fire at `now`: active, enabled, with a
 * next_fire_at at/before `now`, and not currently deferred or skipped past
 * `now`.
 */
export async function listDue(now = new Date(), { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `SELECT ${COLS} FROM scheduler.schedules
      WHERE status = 'active'
        AND enabled = true
        AND next_fire_at IS NOT NULL
        AND next_fire_at <= $1
        AND (deferred_until IS NULL OR deferred_until <= $1)
        AND (skipped_until  IS NULL OR skipped_until  <= $1)
      ORDER BY next_fire_at`,
    [now],
  );
  return rows.map(rowToDef);
}
