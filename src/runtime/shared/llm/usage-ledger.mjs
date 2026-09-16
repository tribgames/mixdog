/**
 * Durable usage accounting, independent of diagnostic trace retention.
 * Store numbers and attribution only; never prompts, credentials or tool data.
 * Each insert and its indexed daily/session totals commit in one transaction.
 * There is deliberately no automatic retention or destructive schema repair.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolvePluginData } from '../plugin-paths.mjs';
import { usageRollupDayKey, isConversationUsageSource } from './usage-rollup.mjs';
import { priceUsage } from './cost.mjs';
import { normalizeUsageMeasurement, normalizeLegacyUsageDay } from './usage-measurement.mjs';

const stores = new Map();
const number = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
const text = (value) => (typeof value === 'string' ? value.slice(0, 300) : '');

// Keep the full identifier, not a shortened hash. The tag also makes arbitrary
// UTF-8 request IDs disjoint from binary SHA-256 IDs.
function encodeUsageId(id) {
  const value = String(id);
  const hex = /^[0-9a-f]{64}$/.test(value);
  return Buffer.concat([Buffer.from([hex ? 0 : 1]), Buffer.from(value, hex ? 'hex' : 'utf8')]);
}

const COMPACT_SCHEMA = `
    CREATE TABLE IF NOT EXISTS usage_routes (
        id INTEGER PRIMARY KEY, signature TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS usage_sessions (
        id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS usage_events (
        id BLOB PRIMARY KEY, ts INTEGER NOT NULL, day INTEGER NOT NULL,
        route INTEGER NOT NULL REFERENCES usage_routes(id),
        session INTEGER NOT NULL REFERENCES usage_sessions(id),
        input REAL NOT NULL, output REAL NOT NULL, cache_read REAL NOT NULL, cache_write REAL NOT NULL,
        cost_usd REAL, duration_ms REAL NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS usage_events_time ON usage_events(ts);
`;

// Preserve the old read surface. Only storage changes: every field, including
// the original price JSON and request ID, round-trips through this view.
const EVENT_SELECT = `
    SELECT CASE WHEN substr(e.id,1,1)=X'00'
        THEN lower(hex(substr(e.id,2))) ELSE CAST(substr(e.id,2) AS TEXT) END AS id,
        e.ts, printf('%04d-%02d-%02d',e.day/10000,(e.day/100)%100,e.day%100) AS day,
        json_extract(r.signature,'$[0]') AS provider,
        json_extract(r.signature,'$[1]') AS model,
        json_extract(r.signature,'$[2]') AS kind,
        s.value AS session_id,
        json_extract(r.signature,'$[3]') AS source_type,
        e.input,e.output,e.cache_read,e.cache_write,e.cost_usd,
        json_extract(r.signature,'$[4]') AS cost_source,
        json_extract(r.signature,'$[5]') AS rates,
        json_extract(r.signature,'$[6]') AS origin,
        json_extract(r.signature,'$[7]') AS rank,
        e.duration_ms
    FROM usage_events e
    JOIN usage_routes r ON r.id=e.route
    JOIN usage_sessions s ON s.id=e.session
`;

function compactEventWriter(db) {
  const findEvent = db.prepare('SELECT 1 FROM usage_events WHERE id=?');
  const insertRoute = db.prepare('INSERT OR IGNORE INTO usage_routes(signature) VALUES (?)');
  const findRoute = db.prepare('SELECT id FROM usage_routes WHERE signature=?');
  const insertSession = db.prepare('INSERT OR IGNORE INTO usage_sessions(value) VALUES (?)');
  const findSession = db.prepare('SELECT id FROM usage_sessions WHERE value=?');
  const insert = db.prepare('INSERT INTO usage_events VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  return (row) => {
    for (const key of ['id', 'provider', 'model', 'kind', 'source_type', 'cost_source', 'origin', 'session_id']) {
      if (row[key] == null) throw new Error(`Usage requires ${key}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day)) throw new Error('Usage requires a calendar day');
    const id = encodeUsageId(row.id);
    if (findEvent.get(id)) return false;
    const signature = JSON.stringify([
      String(row.provider),
      String(row.model),
      String(row.kind),
      String(row.source_type),
      String(row.cost_source),
      row.rates ?? null,
      String(row.origin),
      row.rank,
    ]);
    insertRoute.run(signature);
    const route = findRoute.get(signature).id;
    insertSession.run(String(row.session_id));
    const session = findSession.get(String(row.session_id)).id;
    insert.run(
      id,
      row.ts,
      Number(row.day.replaceAll('-', '')),
      route,
      session,
      row.input,
      row.output,
      row.cache_read,
      row.cache_write,
      row.cost_usd,
      row.duration_ms
    );
    return true;
  };
}

function migrateUsageLedger(db, path) {
  let backupPath = null;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Another process may have completed the upgrade while we waited.
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version === 2) {
      db.exec('ROLLBACK');
      return null;
    }
    if (version !== 1) throw new Error(`Unsupported usage ledger version: ${version}`);
    // Hold the writer reservation before taking a coherent backup. A
    // separate read-only connection can VACUUM INTO while WAL readers are
    // allowed; no writer can slip between this snapshot and the migration.
    const backupDir = mkdtempSync(join(dirname(path), `${basename(path)}.v1-backup-`));
    backupPath = join(backupDir, basename(path));
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      reader.prepare('VACUUM INTO ?').run(backupPath);
    } finally {
      reader.close();
    }

    db.exec(COMPACT_SCHEMA);
    const insert = compactEventWriter(db);
    for (const row of db.prepare('SELECT * FROM events').iterate()) insert(row);
    db.exec(`CREATE VIEW usage_events_migration_check AS ${EVENT_SELECT}`);
    const missing = db.prepare('SELECT * FROM events EXCEPT SELECT * FROM usage_events_migration_check LIMIT 1').get();
    const changed = db.prepare('SELECT * FROM usage_events_migration_check EXCEPT SELECT * FROM events LIMIT 1').get();
    if (missing || changed) throw new Error('Usage migration did not preserve every original field');
    const records = db.prepare('SELECT COUNT(*) AS count FROM events').get().count;
    const copied = db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count;
    if (records !== copied) throw new Error('Usage migration record count mismatch');
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Usage migration reference mismatch');
    db.exec(`DROP VIEW usage_events_migration_check; DROP TABLE events;
            CREATE VIEW events AS ${EVENT_SELECT}; PRAGMA user_version=2;`);
    db.exec('COMMIT');
    return { from: 1, to: 2, records, backupPath };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    error.backupPath = backupPath;
    throw error;
  }
}

export function usageRouteKind(provider) {
  if (provider === 'mixdog-local') return 'local';
  if (provider === 'opencode-go') return 'quota-api';
  return provider.endsWith('-oauth') ? 'oauth' : 'api';
}

export function usageLedgerPath() {
  if (process.env.MIXDOG_USAGE_LEDGER_PATH) return process.env.MIXDOG_USAGE_LEDGER_PATH;
  if (process.env.NODE_TEST_CONTEXT) return null;
  return join(resolvePluginData(), 'usage', 'ledger.sqlite');
}

export function usageRecordId(row) {
  const identity = row.responseId
    ? ['response', row.provider, row.model, row.responseId]
    : [
        'record',
        row.ts,
        row.provider,
        row.model,
        row.sessionId || '',
        row.input,
        row.output,
        row.cacheRead,
        row.cacheWrite,
      ];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function makeUsageRecord(args) {
  const provider = text(args.provider);
  const model = text(args.model);
  if (!provider || !model) throw new Error('Usage requires a provider and model');
  const ts = Number(args.ts ?? Date.now());
  if (!Number.isSafeInteger(ts) || ts <= 0) throw new Error('Usage requires a valid timestamp');
  const kind = args.kind || usageRouteKind(provider);
  const priced = priceUsage({ ...args, provider, model, ts });
  const supplied =
    args.costUsd !== null &&
    args.costUsd !== undefined &&
    args.costUsd !== '' &&
    Number.isFinite(Number(args.costUsd)) &&
    Number(args.costUsd) >= 0;
  // OAuth/quota plans have value, not per-request invoices. A backend's
  // quota/cost ticks must not be mistaken for an API bill.
  const subscription = kind === 'oauth' || kind === 'quota-api';
  const reported = args.inputTokensKnown !== false && !subscription && kind !== 'local' && supplied;
  const costUsd = kind === 'local' ? 0 : reported ? Number(args.costUsd) : priced.costUsd;
  const row = {
    ts,
    day: usageRollupDayKey(ts),
    provider,
    model,
    kind,
    sessionId: ['no-session', '(none)'].includes(args.sessionId) ? '' : text(args.sessionId),
    sourceType: text(args.sourceType),
    input: priced.input,
    output: number(args.outputTokens),
    cacheRead: number(args.cacheReadTokens),
    cacheWrite: number(args.cacheWriteTokens),
    costUsd,
    costSource:
      kind === 'local'
        ? 'local'
        : costUsd === null
          ? 'unpriced'
          : subscription
            ? 'subscription'
            : reported
              ? 'provider'
              : 'catalog',
    rates:
      reported || kind === 'local'
        ? {
            requestedModel: priced.rates.requestedModel,
            pricingModel: priced.rates.pricingModel,
            pricingProvider: provider,
            pricingSource: kind === 'local' ? 'local' : 'provider',
          }
        : priced.rates,
    responseId: text(args.responseId),
    origin: args.origin || 'live',
    durationMs: number(args.durationMs),
  };
  row.id = args.id || (row.origin === 'live' && !row.responseId ? randomUUID() : usageRecordId(row));
  return row;
}

export class UsageLedger {
  constructor(path) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== 1 && version !== 2) {
      this.db.close();
      throw new Error(`Unsupported usage ledger version: ${version}`);
    }
    try {
      this.migration = version === 1 ? migrateUsageLedger(this.db, path) : null;
      if (this.migration) {
        this.db.exec('VACUUM');
        const checkpoint = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (checkpoint.busy) throw new Error('Usage migration committed, but compaction checkpoint is busy');
      }
    } catch (error) {
      if (this.migration?.backupPath) error.backupPath ??= this.migration.backupPath;
      this.db.close();
      throw error;
    }
    this.db.exec(`
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            ${COMPACT_SCHEMA}
            CREATE VIEW IF NOT EXISTS events AS ${EVENT_SELECT};
            CREATE TABLE IF NOT EXISTS daily (
                day TEXT NOT NULL, rank INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
                kind TEXT NOT NULL, cost_source TEXT NOT NULL, conversation INTEGER NOT NULL,
                turns INTEGER NOT NULL, input REAL NOT NULL, output REAL NOT NULL,
                cache_read REAL NOT NULL, cache_write REAL NOT NULL, cost_usd REAL NOT NULL,
                duration_ms REAL NOT NULL, imported INTEGER NOT NULL,
                PRIMARY KEY(day,rank,provider,model,kind,cost_source,conversation)
            );
            CREATE TABLE IF NOT EXISTS day_sessions (
                day TEXT NOT NULL, rank INTEGER NOT NULL, session_id TEXT NOT NULL, tokens REAL NOT NULL,
                PRIMARY KEY(day,rank,session_id)
            );
            CREATE TABLE IF NOT EXISTS legacy_days (day TEXT PRIMARY KEY, document TEXT NOT NULL);
            PRAGMA user_version=2;
        `);
    this.insert = compactEventWriter(this.db);
    this.daily = this.db.prepare(`INSERT INTO daily VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(day,rank,provider,model,kind,cost_source,conversation) DO UPDATE SET
            turns=turns+excluded.turns, input=input+excluded.input, output=output+excluded.output,
            cache_read=cache_read+excluded.cache_read, cache_write=cache_write+excluded.cache_write,
            cost_usd=cost_usd+excluded.cost_usd, duration_ms=duration_ms+excluded.duration_ms,
            imported=MAX(imported,excluded.imported)`);
    this.session = this.db.prepare(`INSERT INTO day_sessions VALUES (?,?,?,?)
            ON CONFLICT(day,rank,session_id) DO UPDATE SET tokens=tokens+excluded.tokens`);
  }

  close() {
    this.db.close();
  }
  get(key) {
    return this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value ?? null;
  }
  set(key, value) {
    this.db
      .prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, String(value));
  }

  beginCapture(ts) {
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('liveSince', String(ts));
  }

  indexRecord(row, rank) {
    const conversation = isConversationUsageSource(row.sourceType);
    this.daily.run(
      row.day,
      rank,
      row.provider,
      row.model,
      row.kind,
      row.costSource,
      Number(conversation),
      1,
      row.input,
      row.output,
      row.cacheRead,
      row.cacheWrite,
      row.costUsd ?? 0,
      row.durationMs,
      Number(row.origin !== 'live')
    );
    if (conversation && row.sessionId)
      this.session.run(row.day, rank, row.sessionId, row.input + row.output + row.cacheRead + row.cacheWrite);
  }

  // Caller owns the transaction; only derived indexes are rebuilt.
  rebuildIndexes() {
    this.db.exec('DELETE FROM daily; DELETE FROM day_sessions;');
    for (const row of this.db.prepare('SELECT * FROM events').iterate()) {
      this.indexRecord(
        {
          ...row,
          sourceType: row.source_type,
          sessionId: row.session_id,
          costSource: row.cost_source,
          costUsd: row.cost_usd,
          cacheRead: row.cache_read,
          cacheWrite: row.cache_write,
          durationMs: row.duration_ms,
        },
        row.rank
      );
    }
  }

  record(rows) {
    let inserted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const rank = row.origin === 'gateway' ? 1 : 0;
        if (
          !this.insert({
            ...row,
            session_id: row.sessionId,
            source_type: row.sourceType,
            cache_read: row.cacheRead,
            cache_write: row.cacheWrite,
            cost_usd: row.costUsd,
            cost_source: row.costSource,
            rates: row.rates ? JSON.stringify(row.rates) : null,
            duration_ms: row.durationMs,
            rank,
          })
        )
          continue;
        this.indexRecord(row, rank);
        if (row.origin === 'live' && !this.get('liveSince')) this.set('liveSince', row.ts);
        inserted += 1;
      }
      this.db.exec('COMMIT');
      return inserted;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  preserveLegacyDays(days) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO legacy_days VALUES (?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [day, value] of Object.entries(days || {})) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day)) insert.run(day, JSON.stringify(value));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Read cached amounts; group retained attribution separately for distinct sessions. */
  rollup({ hourlyDay = null, fromDay = '0000-01-01', toDay = '9999-12-31', fromMs = null, toMs = null } = {}) {
    const days = {};
    const hourly = hourlyDay ? { rows: [], unallocated: [] } : null;
    const fromTs = fromMs ?? (fromDay === '0000-01-01' ? 0 : new Date(`${fromDay}T00:00:00`).getTime());
    const end = toDay === '9999-12-31' ? null : new Date(`${toDay}T00:00:00`);
    if (end) end.setDate(end.getDate() + 1);
    const toTs = toMs == null ? (end ? end.getTime() : Number.MAX_SAFE_INTEGER) : toMs + 1;
    const empty = () => ({
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
      costBilled: 0,
      costEstimated: 0,
      costKnownTurns: 0,
      durationMs: 0,
      durationTurns: 0,
      unmeasuredTurns: 0,
      sessions: {},
      sessionsComplete: true,
    });
    const add = (target, row) => {
      const usage = normalizeUsageMeasurement(row.provider, {
        turns: row.turns,
        input: row.input,
        output: row.output,
        cacheRead: row.cache_read,
        cacheWrite: row.cache_write,
        costUsd: row.cost_usd,
        costKnownTurns: row.cost_source !== 'unpriced' ? row.turns : 0,
        costBilled: row.cost_source === 'provider' ? row.cost_usd : 0,
        costEstimated: row.cost_source === 'provider' ? 0 : row.cost_usd,
      });
      for (const field of [
        'turns',
        'input',
        'output',
        'cacheRead',
        'cacheWrite',
        'costUsd',
        'costKnownTurns',
        'costBilled',
        'costEstimated',
        'unmeasuredTurns',
      ]) {
        target[field] += usage[field] || 0;
      }
      target.durationMs += row.duration_ms;
      if (row.duration_ms > 0) target.durationTurns += row.turns;
    };
    // A detail and its terminal summary can overlap on the SAME route.
    // Another provider/model on that day is independent and must survive.
    const best = `SELECT day,provider,model,MIN(rank) AS rank FROM daily
            WHERE day BETWEEN ? AND ? GROUP BY day,provider,model`;
    if (hourly) {
      const start = new Date(`${hourlyDay}T00:00:00`);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      hourly.rows = this.db
        .prepare(`
                SELECT e.ts,e.provider,e.source_type,e.input,e.output,e.cache_read,e.cache_write,e.cost_usd
                FROM events e JOIN (${best}) b USING(day,provider,model,rank)
                WHERE e.ts>=? AND e.ts<? ORDER BY e.ts
            `)
        .all(fromDay, toDay, fromMs == null ? start.getTime() : fromTs, toMs == null ? end.getTime() : toTs)
        .map((row) => {
          const usage = normalizeUsageMeasurement(row.provider, {
            turns: 1,
            input: row.input,
            cacheRead: row.cache_read,
            cacheWrite: row.cache_write,
            costUsd: row.cost_usd,
          });
          return {
            ...row,
            input: usage.input,
            cache_read: usage.cacheRead,
            cache_write: usage.cacheWrite,
            cost_usd: usage.costUsd,
            unmeasuredTurns: usage.unmeasuredTurns || 0,
          };
        });
    }
    // Partial calendar days must be rebuilt from retained timestamps;
    // cached whole-day totals would include usage outside a rolling window.
    const amounts =
      fromMs == null
        ? this.db.prepare(`SELECT d.* FROM daily d JOIN (${best}) b USING(day,provider,model,rank)`).all(fromDay, toDay)
        : this.db
            .prepare(`
                SELECT e.day,e.rank,e.provider,e.model,e.kind,e.cost_source,e.source_type,
                    COUNT(*) AS turns,SUM(e.input) AS input,SUM(e.output) AS output,
                    SUM(e.cache_read) AS cache_read,SUM(e.cache_write) AS cache_write,
                    SUM(e.cost_usd) AS cost_usd,SUM(e.duration_ms) AS duration_ms,
                    MAX(e.origin!='live') AS imported
                FROM events e JOIN (${best}) b USING(day,provider,model,rank)
                WHERE e.ts>=? AND e.ts<?
                GROUP BY e.day,e.rank,e.provider,e.model,e.kind,e.cost_source,e.source_type
            `)
            .all(fromDay, toDay, fromTs, toTs)
            .map((row) => ({
              ...row,
              conversation: isConversationUsageSource(row.source_type),
            }));
    for (const row of amounts) {
      const day = (days[row.day] ||= { ...empty(), models: {}, sessions: {}, conversation: empty() });
      const key = `${row.provider}/${row.model}`;
      const route = (day.models[key] ||= {
        ...empty(),
        provider: row.provider,
        model: row.model,
        kind: row.kind,
        conversation: empty(),
      });
      add(day, row);
      add(route, row);
      if (row.conversation) {
        add(day.conversation, row);
        add(route.conversation, row);
      }
      if (row.imported) day.importedPartial = true;
    }
    // day_sessions cannot attribute an id to a route. Use the retained
    // originals, without modifying them or guessing from account/pool ids.
    // Aggregate compact integer keys BEFORE decoding attribution. The old
    // view decoded JSON and joined every historical request on each open.
    const sessions = this.db
      .prepare(`
            WITH grouped AS (
                SELECT day,route,session,SUM(input) AS input,SUM(output) AS output,
                    SUM(cache_read) AS cacheRead,SUM(cache_write) AS cacheWrite
                FROM usage_events WHERE ts>=? AND ts<?
                GROUP BY day,route,session
            ), attributed AS (
                SELECT printf('%04d-%02d-%02d',e.day/10000,(e.day/100)%100,e.day%100) AS day,
                    json_extract(r.signature,'$[0]') AS provider,
                    json_extract(r.signature,'$[1]') AS model,
                    json_extract(r.signature,'$[3]') AS source_type,
                    json_extract(r.signature,'$[6]') AS origin,
                    json_extract(r.signature,'$[7]') AS rank,
                    s.value AS session_id,e.input,e.output,e.cacheRead,e.cacheWrite
                FROM grouped e JOIN usage_routes r ON r.id=e.route
                JOIN usage_sessions s ON s.id=e.session
            )
            SELECT e.* FROM attributed e JOIN (${best}) b USING(day,provider,model,rank)
        `)
      .all(fromTs, toTs, fromDay, toDay);
    for (const row of sessions) {
      const classified = row.origin !== 'trace' || Boolean(row.source_type);
      if (classified && !isConversationUsageSource(row.source_type)) continue;
      const day = days[row.day];
      const route = day.models[`${row.provider}/${row.model}`];
      for (const target of [day, route, day.conversation, route.conversation]) {
        // Old raw traces used session_id for account/socket scopes too.
        // Without source attribution they cannot establish a session count.
        if (!classified || !row.session_id || ['no-session', '(none)'].includes(row.session_id)) {
          target.sessionsComplete = false;
        } else {
          const usage = normalizeUsageMeasurement(row.provider, row);
          const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
          target.sessions[row.session_id] = (target.sessions[row.session_id] || 0) + tokens;
        }
      }
    }
    // Timeless legacy totals cannot establish membership in a 24-hour window.
    // They remain available in the calendar/history views.
    if (fromMs != null) return hourly ? { days, hourly } : { days };
    for (const row of this.db
      .prepare('SELECT day,document FROM legacy_days WHERE day BETWEEN ? AND ?')
      .all(fromDay, toDay)) {
      const legacy = normalizeLegacyUsageDay(JSON.parse(row.document));
      const day = days[row.day];
      if (!day) {
        days[row.day] = { ...legacy, importedPartial: true };
        if (row.day === hourlyDay) hourly.unallocated.push(...Object.values(legacy.models || {}));
        continue;
      }
      for (const [key, route] of Object.entries(legacy.models || {})) {
        if (day.models[key]) continue;
        // Preserve a disjoint historical route, not an inferred balance
        // of an overlapping one. Whole-day session ids cannot be assigned
        // to just this route, so its session count remains unknown.
        day.models[key] = { ...route, sessionsComplete: false };
        if (row.day === hourlyDay) hourly.unallocated.push(route);
        const merge = (target, source) => {
          if (!source) return;
          for (const field of [
            'turns',
            'input',
            'output',
            'cacheRead',
            'cacheWrite',
            'costUsd',
            'durationMs',
            'durationTurns',
            'unmeasuredTurns',
          ])
            target[field] += number(source[field]);
          target.costKnownTurns +=
            source.costKnownTurns == null
              ? number(source.costUsd) > 0 || route.kind === 'local'
                ? number(source.turns)
                : 0
              : number(source.costKnownTurns);
          target.costBilled += number(source.costBilled);
          target.costEstimated += number(source.costEstimated ?? source.costUsd);
          target.sessionsComplete = false;
        };
        merge(day, route);
        merge(day.conversation, route.conversation);
        day.importedPartial = true;
        if (legacy.restored) day.restored = true;
      }
    }
    return hourly ? { days, hourly } : { days };
  }
}

export function getUsageLedger() {
  const path = usageLedgerPath();
  if (!path) return null;
  if (!stores.has(path)) stores.set(path, new UsageLedger(path));
  return stores.get(path);
}
