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

import { ensurePgInstance, withSchemaBootstrapLock } from '../../memory/lib/pg/adapter.mjs';
import { createPgSchemaDb } from '../../shared/pg-schema-db.mjs';
import { resolvePluginData } from '../../shared/plugin-paths.mjs';
import { ROUTINE_LIMITS } from '../../shared/routine-limits.mjs';

const SCHEMA = 'scheduler';

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
  cwd            text,
  workflow       text,
  attachments    jsonb,
  delivery       text,
  prompt         text NOT NULL,
  enabled        boolean NOT NULL DEFAULT true,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','done')),
  last_fired_at  timestamptz,
  last_scheduled_at timestamptz,
  last_started_at   timestamptz,
  last_success_at   timestamptz,
  last_failed_at    timestamptz,
  next_fire_at   timestamptz,
  deferred_until timestamptz,
  skipped_until  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedules_when_xor CHECK ((when_at IS NOT NULL) <> (when_cron IS NOT NULL))
);
ALTER TABLE scheduler.schedules ADD COLUMN IF NOT EXISTS cwd text;
ALTER TABLE scheduler.schedules ADD COLUMN IF NOT EXISTS workflow text;
ALTER TABLE scheduler.schedules ADD COLUMN IF NOT EXISTS attachments jsonb;
ALTER TABLE scheduler.schedules ADD COLUMN IF NOT EXISTS delivery text;
ALTER TABLE scheduler.schedules ADD COLUMN IF NOT EXISTS last_scheduled_at timestamptz;
ALTER TABLE scheduler.schedules ADD COLUMN IF NOT EXISTS last_started_at timestamptz;
ALTER TABLE scheduler.schedules ADD COLUMN IF NOT EXISTS last_success_at timestamptz;
ALTER TABLE scheduler.schedules ADD COLUMN IF NOT EXISTS last_failed_at timestamptz;
ALTER TABLE scheduler.schedules ADD COLUMN IF NOT EXISTS last_skipped_at timestamptz;
-- The agent a schedule belongs to (its results land in that agent's home
-- thread). Rows from before ownership existed fill with Mixy ('lead').
ALTER TABLE scheduler.schedules ADD COLUMN IF NOT EXISTS owner_agent_id text NOT NULL DEFAULT 'lead';
-- Legacy columns model, workflow and run_as_agent are no longer read or written (kept, not dropped, to avoid a risky migration).
ALTER TABLE scheduler.schedules ADD COLUMN IF NOT EXISTS run_as_agent boolean NOT NULL DEFAULT false;
-- Failed runs in a row: a success or switching it back on resets it; at
-- ROUTINE_LIMITS.pauseAfterFailures the schedule switches itself off.
ALTER TABLE scheduler.schedules ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;
-- Results of finished runs not yet queued for the owner's home thread, by run
-- id ({ state: 'pending' | 'failed', error?, at, result }).
ALTER TABLE scheduler.schedules ADD COLUMN IF NOT EXISTS result_delivery jsonb;
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

function rowToDef(row) {
  if (!row) return null;
  return {
    name: row.name,
    description: row.description,
    whenAt: row.when_at,
    whenCron: row.when_cron,
    timezone: row.timezone,
    target: row.target,
    channelId: row.channel_id,
    cwd: row.cwd,
    attachments: row.attachments || null,
    delivery: row.delivery || null,
    prompt: row.prompt,
    enabled: row.enabled,
    status: row.status,
    lastFiredAt: row.last_fired_at,
    lastScheduledAt: row.last_scheduled_at,
    lastStartedAt: row.last_started_at,
    lastSuccessAt: row.last_success_at,
    lastFailedAt: row.last_failed_at,
    lastSkippedAt: row.last_skipped_at,
    ownerAgentId: row.owner_agent_id || 'lead',
    consecutiveFailures: Number(row.consecutive_failures) || 0,
    resultDelivery: row.result_delivery || null,
    nextFireAt: row.next_fire_at,
    deferredUntil: row.deferred_until,
    skippedUntil: row.skipped_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLS =
  'name, description, when_at, when_cron, timezone, target, channel_id, cwd, attachments, delivery, prompt, enabled, status, last_fired_at, last_scheduled_at, last_started_at, last_success_at, last_failed_at, last_skipped_at, owner_agent_id, consecutive_failures, result_delivery, next_fire_at, deferred_until, skipped_until, created_at, updated_at';

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
  if (!def?.name) throw new Error('upsertSchedule: def.name is required');
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
    def.cwd ?? null,
    def.attachments ? JSON.stringify(def.attachments) : null,
    def.delivery ?? null,
    def.prompt,
    def.enabled ?? true,
    def.status ?? 'active',
    def.nextFireAt ?? null,
    def.ownerAgentId || 'lead',
  ];
  const { rows } = await db.query(
    `INSERT INTO scheduler.schedules
       (name, description, when_at, when_cron, timezone, target, channel_id, cwd, attachments, delivery, prompt, enabled, status, next_fire_at, owner_agent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (name) DO UPDATE SET
       owner_agent_id = EXCLUDED.owner_agent_id,
       description  = EXCLUDED.description,
       when_at      = EXCLUDED.when_at,
       when_cron    = EXCLUDED.when_cron,
       timezone     = EXCLUDED.timezone,
       target       = EXCLUDED.target,
       channel_id   = EXCLUDED.channel_id,
       cwd          = EXCLUDED.cwd,
       attachments  = EXCLUDED.attachments,
       delivery     = EXCLUDED.delivery,
       prompt       = EXCLUDED.prompt,
       enabled      = EXCLUDED.enabled,
       next_fire_at = EXCLUDED.next_fire_at,
       -- Redefinition clears stale runtime state and reactivates so the
       -- re-registered schedule is due again in listDue.
       status         = 'active',
       deferred_until = NULL,
       skipped_until  = NULL,
       last_fired_at  = NULL,
       last_scheduled_at = NULL,
       last_started_at = NULL,
       last_success_at = NULL,
       last_failed_at = NULL,
       last_skipped_at = NULL,
       consecutive_failures = 0,
       updated_at   = now()
     RETURNING ${COLS}`,
    params
  );
  return rowToDef(rows[0]);
}

export async function deleteSchedule(name, { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rowCount } = await db.query(`DELETE FROM scheduler.schedules WHERE name = $1`, [name]);
  return rowCount > 0;
}

// Set one column by schedule name. `column` is always a literal from this
// module — never caller input — so interpolating it carries no external value
// into the statement; the name and the value stay bound parameters.
async function updateScheduleColumn(name, column, value, dataDir) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `UPDATE scheduler.schedules SET ${column} = $2, updated_at = now() WHERE name = $1 RETURNING ${COLS}`,
    [name, value]
  );
  return rowToDef(rows[0]);
}

/** Switching a schedule back on clears its failure streak. */
export async function setEnabled(name, enabled, { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `UPDATE scheduler.schedules
        SET enabled = $2, consecutive_failures = CASE WHEN $2 THEN 0 ELSE consecutive_failures END, updated_at = now()
      WHERE name = $1 RETURNING ${COLS}`,
    [name, !!enabled]
  );
  return rowToDef(rows[0]);
}

export async function markFired(name, ts = new Date(), { dataDir } = {}) {
  return updateScheduleColumn(name, 'last_fired_at', ts, dataDir);
}

export async function setNextFire(name, ts, { dataDir } = {}) {
  return updateScheduleColumn(name, 'next_fire_at', ts ?? null, dataDir);
}

export async function advanceScheduleCursor(name, scheduledAt, nextFireAt, { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `UPDATE scheduler.schedules
       SET last_scheduled_at = $2, next_fire_at = $3, updated_at = now()
     WHERE name = $1
       AND status = 'active' AND enabled = true
       AND (last_scheduled_at IS NULL OR last_scheduled_at < $2)
     RETURNING ${COLS}`,
    [name, scheduledAt, nextFireAt ?? null]
  );
  return rowToDef(rows[0]);
}

export async function claimScheduleRun(name, scheduledAt, startedAt, nextFireAt, { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `UPDATE scheduler.schedules
       SET last_scheduled_at = $2, last_started_at = $3, last_fired_at = $3,
           next_fire_at = $4, updated_at = now()
     WHERE name = $1
       AND status = 'active' AND enabled = true
       AND (last_scheduled_at IS NULL OR last_scheduled_at < $2)
     RETURNING ${COLS}`,
    [name, scheduledAt, startedAt, nextFireAt ?? null]
  );
  return rowToDef(rows[0]);
}

export async function markScheduleSuccess(name, ts = new Date(), { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `UPDATE scheduler.schedules SET last_success_at = $2, consecutive_failures = 0, updated_at = now()
      WHERE name = $1 RETURNING ${COLS}`,
    [name, ts]
  );
  return rowToDef(rows[0]);
}

/** One more failure in a row; the one reaching the pause limit switches the
 *  schedule off (claimScheduleRun admits only enabled rows). */
export async function markScheduleFailure(name, ts = new Date(), { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `UPDATE scheduler.schedules
        SET last_failed_at = $2, consecutive_failures = consecutive_failures + 1,
            enabled = enabled AND consecutive_failures + 1 < $3, updated_at = now()
      WHERE name = $1 RETURNING ${COLS}`,
    [name, ts, ROUTINE_LIMITS.pauseAfterFailures]
  );
  return rowToDef(rows[0]);
}

/** Set (`entry`) or clear (null) the undelivered result of run `runId`. */
export async function recordScheduleDelivery(name, runId, entry, { dataDir } = {}) {
  const db = await getDb(dataDir);
  await db.query(
    entry
      ? `UPDATE scheduler.schedules
            SET result_delivery = COALESCE(result_delivery, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)
          WHERE name = $1`
      : `UPDATE scheduler.schedules
            SET result_delivery = NULLIF(COALESCE(result_delivery, '{}'::jsonb) - $2::text, '{}'::jsonb)
          WHERE name = $1`,
    entry ? [name, runId, JSON.stringify(entry)] : [name, runId]
  );
}

/** A fire skipped because the previous run of the same schedule still runs. */
export async function markScheduleSkipped(name, ts = new Date(), { dataDir } = {}) {
  return updateScheduleColumn(name, 'last_skipped_at', ts, dataDir);
}

export async function markDone(name, { dataDir } = {}) {
  const db = await getDb(dataDir);
  const { rows } = await db.query(
    `UPDATE scheduler.schedules SET status = 'done', next_fire_at = NULL, updated_at = now() WHERE name = $1 RETURNING ${COLS}`,
    [name]
  );
  return rowToDef(rows[0]);
}

export async function setDeferred(name, untilTs, { dataDir } = {}) {
  return updateScheduleColumn(name, 'deferred_until', untilTs ?? null, dataDir);
}

export async function setSkippedUntil(name, ts, { dataDir } = {}) {
  return updateScheduleColumn(name, 'skipped_until', ts ?? null, dataDir);
}
