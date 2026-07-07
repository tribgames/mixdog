/**
 * PG-backed schedules store — the single source of truth for registered
 * schedules (schema `scheduler`, table `scheduler.schedules`).
 *
 * All schedule readers/writers (scheduler.mjs, config.mjs, channel-admin.mjs)
 * go through this module. Legacy `<dataDir>/schedules/<name>/SCHEDULE.md`
 * files are imported once by the migration hook in getDb and the directory is
 * renamed to `schedules.migrated`; the old file-based schedules-store.mjs has
 * been removed.
 *
 * DDL is idempotent and runs once on the first call per process. All queries
 * fully-qualify `scheduler.schedules` so they are correct regardless of the
 * connection search_path.
 */

import { ensurePgInstance, withSchemaBootstrapLock } from '../memory/lib/pg/adapter.mjs';
import { resolvePluginData } from './plugin-paths.mjs';
import { readdirSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readMarkdownDocument } from './markdown-frontmatter.mjs';

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
    await migrateLegacySchedules(db, dataDir);
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
// One-time legacy SCHEDULE.md migration (additive; runs once per dataDir on
// first getDb, right after DDL). Imports every `<dataDir>/schedules/<name>/
// SCHEDULE.md` not already present in the table (by name), using the same
// days->cron folding as the admin write path, then renames the directory to
// `schedules.migrated` (never deletes user data). Per-entry failures are
// isolated and never block store readiness.
// ---------------------------------------------------------------------------

// Day-name / keyword -> cron day-of-week number (Sun=0 .. Sat=6).
const MIGRATE_DAY_TO_DOW = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

function foldLegacyDaysIntoCron(cron, days) {
  const parts = String(cron || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5 && parts.length !== 6) {
    throw new Error(`invalid cron "${cron}"`);
  }
  const raw = String(days || '').trim().toLowerCase();
  const dowIndex = parts.length - 1;
  // days absent -> keep the cron's own day-of-week field ('0 9 * * 1' stays
  // Monday-only). Only an explicit selector rewrites the dow field.
  if (!raw) return parts.join(' ');
  let dow;
  if (raw === 'daily' || raw === 'everyday' || raw === 'every day') dow = '*';
  else if (raw === 'weekday' || raw === 'weekdays') dow = '1-5';
  else if (raw === 'weekend' || raw === 'weekends') dow = '0,6';
  else {
    const nums = raw.split(/[\s,]+/).filter(Boolean).map((t) => (
      /^[0-6]$/.test(t) ? Number(t) : MIGRATE_DAY_TO_DOW[t]
    ));
    if (nums.some((n) => n === undefined)) {
      throw new Error(`days "${days}" is not a recognizable day selector`);
    }
    dow = nums.join(',');
  }
  parts[dowIndex] = dow;
  return parts.join(' ');
}

async function migrateLegacySchedules(db, dataDir) {
  const dir = join(dataDir, 'schedules');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // no legacy schedules/ dir -> nothing to migrate
  }
  let imported = 0;
  let skipped = 0;
  const failed = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    try {
      const { rows } = await db.query('SELECT 1 FROM scheduler.schedules WHERE name = $1', [name]);
      if (rows.length) { skipped++; continue; }
      let md;
      try { md = readFileSync(join(dir, name, 'SCHEDULE.md'), 'utf8'); }
      catch { skipped++; continue; }
      const { frontmatter, body } = readMarkdownDocument(md);
      const cron = foldLegacyDaysIntoCron(frontmatter.time, frontmatter.days);
      const channel = String(frontmatter.channel || '').trim();
      const enabled = frontmatter.enabled !== 'false' && frontmatter.enabled !== false;
      await db.query(
        `INSERT INTO scheduler.schedules
           (name, description, when_cron, timezone, target, channel_id, model, prompt, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (name) DO NOTHING`,
        [
          name,
          String(frontmatter.description || '').trim(),
          cron,
          frontmatter.timezone ? String(frontmatter.timezone).trim() : null,
          channel ? 'channel' : 'session',
          channel || null,
          frontmatter.model ? String(frontmatter.model).trim() : null,
          String(body || '').trim(),
          enabled,
        ],
      );
      imported++;
    } catch (err) {
      failed.push(name);
      console.error(`[schedules] migration failed for "${name}": ${err?.message || err}`);
    }
  }
  if (failed.length) {
    // Some entries failed to import. Leave schedules/ in place (do NOT rename)
    // so the next boot retries them; already-imported entries are skipped by
    // the name check above, so retry is idempotent.
    console.error(`[schedules] migrated ${imported} legacy schedule(s), ${failed.length} failed (${failed.join(', ')}); leaving schedules/ for retry`);
    return;
  }
  try {
    let target = `${dir}.migrated`;
    if (existsSync(target)) target = `${dir}.migrated-${Date.now()}`;
    renameSync(dir, target);
  } catch (err) {
    console.error(`[schedules] migrated ${imported} legacy schedule(s) but could not rename schedules/: ${err?.message || err}`);
    return;
  }
  console.error(`[schedules] migrated ${imported} legacy schedule(s) (${skipped} skipped); renamed schedules/ -> schedules.migrated`);
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
