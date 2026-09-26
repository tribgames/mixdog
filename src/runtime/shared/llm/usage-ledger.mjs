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
import { rollupUsage } from './usage-ledger-rollup.mjs';
import { SHARE_ENV } from 'node:worker_threads';
import { createWorkerRequestClient } from '../worker-requests.mjs';

// One worker (usage-ledger-worker.mjs) runs the ledger's heavy SQLite work —
// rollups, queued live writes, unpriced-refresh queries and repair writes — on
// its own connections. SHARE_ENV keeps its local-time day boundaries (TZ)
// identical to this thread's. The main thread already reports node:sqlite's
// experimental warning; the worker must not print it again.
// The worker retires after 30 s with nothing queued or in flight (like the
// session save worker) and restarts on the next request. Writes are posted
// one batch at a time, so a retirement can only fall between batches.
const configuredIdleMs = Number(process.env.MIXDOG_USAGE_LEDGER_WORKER_IDLE_MS);
const requestLedgerWorker = createWorkerRequestClient(new URL('./usage-ledger-worker.mjs', import.meta.url), {
  env: SHARE_ENV,
  execArgv: ['--disable-warning=ExperimentalWarning'],
  idleExitMs: Number.isFinite(configuredIdleMs) && configuredIdleMs > 0 ? configuredIdleMs : 30_000,
});

/** Whether the usage-ledger worker thread is currently running. */
export function usageLedgerWorkerRunning() {
  return requestLedgerWorker.running();
}
const stores = new Map();
const ROLLUP_CACHE_LIMIT = 8;
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

function usageRecordId(row) {
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

/** Where a row's cost came from: local runs are free, subscriptions have no invoice, a provider figure beats the catalog. */
export function usageCostSource({ kind, costUsd, subscription, reported = false }) {
  if (kind === 'local') return 'local';
  if (costUsd === null) return 'unpriced';
  if (subscription) return 'subscription';
  return reported ? 'provider' : 'catalog';
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
  let costUsd = priced.costUsd;
  if (kind === 'local') costUsd = 0;
  else if (reported) costUsd = Number(args.costUsd);
  let rates = priced.rates;
  if (reported || kind === 'local') {
    rates = {
      requestedModel: priced.rates.requestedModel,
      pricingModel: priced.rates.pricingModel,
      pricingProvider: provider,
      pricingSource: kind === 'local' ? 'local' : 'provider',
    };
  }
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
    costSource: usageCostSource({ kind, costUsd, subscription, reported }),
    rates,
    responseId: text(args.responseId),
    origin: args.origin || 'live',
    durationMs: number(args.durationMs),
  };
  row.id = args.id || (row.origin === 'live' && !row.responseId ? randomUUID() : usageRecordId(row));
  return row;
}

export class UsageLedger {
  /**
   * `existing: true` attaches another connection to a ledger that an owning
   * UsageLedger already opened, migrated and initialized (the ledger worker's
   * per-request writer): no directory, migration or schema writes.
   */
  constructor(path, { existing = false } = {}) {
    this.path = path;
    if (!existing && path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    this.rollupStamp = null;
    this.rollups = new Map();
    this.pendingRollups = new Map();
    this.writeQueue = [];
    this.writing = null;
    this.captureBegun = false;
    if (existing) {
      this.migration = null;
      this.prepareStatements();
      return;
    }
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
    this.prepareStatements();
  }

  prepareStatements() {
    this.insert = compactEventWriter(this.db);
    this.daily = this.db.prepare(`INSERT INTO daily VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(day,rank,provider,model,kind,cost_source,conversation) DO UPDATE SET
            turns=turns+excluded.turns, input=input+excluded.input, output=output+excluded.output,
            cache_read=cache_read+excluded.cache_read, cache_write=cache_write+excluded.cache_write,
            cost_usd=cost_usd+excluded.cost_usd, duration_ms=duration_ms+excluded.duration_ms,
            imported=MAX(imported,excluded.imported)`);
    this.session = this.db.prepare(`INSERT INTO day_sessions VALUES (?,?,?,?)
            ON CONFLICT(day,rank,session_id) DO UPDATE SET tokens=tokens+excluded.tokens`);
    // Moves on every commit: data_version for other connections (other
    // processes included), total_changes() for this one.
    this.changeStamp = this.db.prepare(
      'SELECT total_changes() AS local,(SELECT data_version FROM pragma_data_version) AS shared'
    );
  }

  /** Run one ledger-worker operation against this ledger's file. */
  workerRequest(op, payload = {}) {
    return requestLedgerWorker({ ...payload, op, path: this.path });
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

  // liveSince is written once and never removed, so after this connection has
  // ensured it exists, later sends skip the per-send write statement.
  beginCapture(ts) {
    if (this.captureBegun) return;
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('liveSince', String(ts));
    this.captureBegun = true;
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

  /**
   * record([row]) without blocking the event loop: rows queue in call order and
   * every row queued while a write is in flight commits in the next single
   * transaction on the ledger worker's own connection (same insert-or-ignore
   * idempotency, BEGIN IMMEDIATE and busy timeout as record()). A batch that
   * fails is retried row by row, so one bad row only fails itself. Resolves
   * once the row is durable. An in-memory ledger has no second connection and
   * records in-thread.
   */
  recordQueued(row) {
    if (this.path === ':memory:') {
      return Promise.resolve().then(() => {
        this.record([row]);
      });
    }
    return new Promise((resolve, reject) => {
      this.writeQueue.push({ row, resolve, reject });
      this.pumpWrites();
    });
  }

  pumpWrites() {
    if (this.writing || this.writeQueue.length === 0) return;
    const batch = this.writeQueue.splice(0);
    this.writing = this.workerRequest('record', { rows: batch.map((entry) => entry.row) })
      .then(
        (outcomes) => {
          batch.forEach((entry, index) => {
            const outcome = outcomes[index];
            if (outcome.error) entry.reject(Object.assign(new Error(outcome.error.message), { code: outcome.error.code }));
            else entry.resolve();
          });
        },
        (error) => {
          for (const entry of batch) entry.reject(error);
        }
      )
      .finally(() => {
        this.writing = null;
        this.pumpWrites();
      });
  }

  /** Resolves once every row queued so far is committed (or has failed). */
  async settleWrites() {
    while (this.writing || this.writeQueue.length) {
      this.pumpWrites();
      await this.writing;
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

  /**
   * Read cached amounts; group retained attribution separately for distinct
   * sessions. Window resolution, the bucket algebra, the three queries and
   * the legacy merge live in usage-ledger-rollup.mjs.
   *
   * A rollup is a pure function of the stored rows and its query, so an
   * unchanged ledger answers a repeated query from memory. The result is
   * shared between callers and must be treated as read-only.
   */
  rollup(options = {}) {
    this.syncRollupStamp();
    const key = JSON.stringify(options);
    const result = this.rollups.get(key) ?? rollupUsage(this.db, options);
    this.rememberRollup(key, result);
    return result;
  }

  /**
   * rollup() with the query run on the shared rollup worker's own read-only
   * connection, so a changed ledger never costs the event loop the full
   * rollup. Shares rollup()'s cache: an unchanged ledger answers from memory
   * and concurrent identical queries share one worker request. An in-memory
   * ledger cannot be opened by a second connection and rolls up in-thread.
   */
  async rollupAsync(options = {}) {
    if (this.path === ':memory:') return this.rollup(options);
    const stamp = this.syncRollupStamp();
    const key = JSON.stringify(options);
    const cached = this.rollups.get(key);
    if (cached) {
      this.rememberRollup(key, cached);
      return cached;
    }
    let pending = this.pendingRollups.get(key);
    if (!pending) {
      pending = this.workerRequest('rollup', { options })
        .then((result) => {
          // A newer stamp cleared the cache meanwhile; never file this
          // answer under it. The worker may have read commits newer than
          // `stamp`, which only means the next stamp change discards it.
          if (this.rollupStamp === stamp) this.rememberRollup(key, result);
          return result;
        })
        .finally(() => {
          if (this.pendingRollups.get(key) === pending) this.pendingRollups.delete(key);
        });
      this.pendingRollups.set(key, pending);
    }
    return pending;
  }

  /** Drop cached and in-flight rollups once any connection has committed. */
  syncRollupStamp() {
    const { local, shared } = this.changeStamp.get();
    const stamp = `${local}:${shared}`;
    if (this.rollupStamp !== stamp) {
      this.rollups.clear();
      this.pendingRollups.clear();
      this.rollupStamp = stamp;
    }
    return stamp;
  }

  rememberRollup(key, result) {
    this.rollups.delete(key);
    this.rollups.set(key, result);
    // Rolling windows (the hour view) change key on every call; keep the
    // most recently used queries only.
    if (this.rollups.size > ROLLUP_CACHE_LIMIT) this.rollups.delete(this.rollups.keys().next().value);
  }
}

export function getUsageLedger() {
  const path = usageLedgerPath();
  if (!path) return null;
  if (!stores.has(path)) stores.set(path, new UsageLedger(path));
  return stores.get(path);
}

// Release every open ledger handle. An open SQLite file cannot be unlinked on
// Windows, so a pristine runtime root that still owns a ledger spends the whole
// rmSync retry budget (50 linear retries ≈ 128s) on EBUSY before giving up.
// Later getUsageLedger() calls reopen lazily.
export function closeUsageLedgers() {
  for (const [path, ledger] of stores) {
    stores.delete(path);
    ledger.close();
  }
}
