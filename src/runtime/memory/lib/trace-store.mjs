import { __mixdogMemoryLog } from './memory-log.mjs';

// trace-store.mjs — native-PG trace analytics store for mixdog 0.4.0.
// Uses pg-adapter (schema='trace') so trace_events live in the trace schema.
// Isolated from memory schema; shares the same PG instance.

import { ensurePgInstance, checkedConnect, closePgInstance } from './pg/adapter.mjs';
import { resolve } from 'node:path';
import { cleanupTraceWhenDisabled, traceEnabled } from './trace-mode.mjs';
import { sessionIndexSql } from './pg/compact-indexes.mjs';
import { collectAgentCallRows } from './trace-store/agent-call-rows.mjs';
import { summarizeAgentSessions } from './trace-store/agent-session-summary.mjs';
import { insertLlmRows, insertToolRows, upsertAgentSessions } from './trace-store/agent-call-inserts.mjs';

const dbs = new Map();
const opening = new Map();
const partitionTimers = new Map();

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

// Guard: if a non-partitioned trace_events exists, drop it.
// Trace is regenerable observability data; drop on schema repair to avoid
// stale dependent pollution (indexes are NOT renamed with the table, so RENAME
// would leave old index names bound to the replaced table, making subsequent
// CREATE INDEX IF NOT EXISTS a no-op on the new partitioned root).
async function maybeDropLegacyTable(client) {
  const r = await client.query(`
    SELECT c.relname
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'trace'
      AND  c.relname = 'trace_events'
      AND  c.relkind = 'r'           -- ordinary (non-partitioned) table only
      AND  c.oid NOT IN (
             SELECT partrelid FROM pg_partitioned_table
           )
  `);
  if (r.rows.length > 0) {
    await client.query(`DROP TABLE trace.trace_events CASCADE`);
  }
}

async function init(client) {
  await maybeDropLegacyTable(client);

  // Partitioned root.
  // PK is (id, ts) because PostgreSQL requires the partition key (ts) to be
  // part of every unique/primary constraint on a partitioned table.
  // BIGSERIAL is kept (vs GENERATED ALWAYS AS IDENTITY) for compatibility with
  // the existing pg-adapter helpers that may inspect sequence names.
  await client.query(`
    CREATE TABLE IF NOT EXISTS trace_events (
      id                 BIGSERIAL,
      ts                 BIGINT NOT NULL,
      session_id         TEXT,
      iteration          INTEGER,
      kind               TEXT NOT NULL,
      agent              TEXT,
      model              TEXT,
      tool_name          TEXT,
      tool_ms            INTEGER,
      result_kind        TEXT,
      result_error_category TEXT,
      result_error_first_line TEXT,
      input_tokens       INTEGER,
      output_tokens      INTEGER,
      cached_tokens      INTEGER,
      cache_write_tokens INTEGER,
      duration_ms        INTEGER,
      error_message      TEXT,
      payload            JSONB NOT NULL,
      parent_span_id     BIGINT,
      entry_id           BIGINT,
      PRIMARY KEY (id, ts)
    ) PARTITION BY RANGE (ts)
  `);

  // Default catch-all partition — ensures no INSERT is lost even before named
  // monthly partitions exist.  Rows here cannot be auto-rerouted once a covering
  // partition is added, so ensureCurrentAndNextMonthPartitions() is called on
  // every boot to pre-create upcoming months before rollover.
  await client.query(`
    CREATE TABLE IF NOT EXISTS trace_events_default
      PARTITION OF trace_events DEFAULT
  `);

  // Previous-month partition — created in init only (not on every boot).
  await client.query(`
    DO $$
    DECLARE
      prev_start  BIGINT := extract(epoch from date_trunc('month', now() - interval '1 month'))::BIGINT * 1000;
      prev_end    BIGINT := extract(epoch from date_trunc('month', now()))::BIGINT * 1000;
      prev_name   TEXT   := 'trace_events_' || to_char(now() - interval '1 month', 'YYYY_MM');
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'trace' AND c.relname = prev_name
      ) THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF trace_events FOR VALUES FROM (%s) TO (%s)',
          prev_name, prev_start, prev_end
        );
      END IF;
    END $$
  `);

  // Drift repair MUST run before index creation: an old cluster whose
  // trace_events predates the `agent` column would otherwise die right below
  // at idx_trace_agent_ts (CREATE INDEX references the missing column) before
  // initAgentTables() ever gets a chance to repair it. Reviewer High fix.
  await migrateSchemaDrift(client);

  // BRIN on ts — ~1000× smaller than btree for append-only timeseries; ideal
  // for time-window range scans where rows arrive in roughly ts order.
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_trace_ts_brin      ON trace_events USING BRIN (ts) WITH (pages_per_range = 32)`
  );
  await client.query(`CREATE INDEX IF NOT EXISTS idx_trace_kind_ts     ON trace_events(kind, ts DESC)`);
  await client.query(sessionIndexSql('idx_trace_session'));
  await client.query(`CREATE INDEX IF NOT EXISTS idx_trace_agent_ts    ON trace_events(agent, ts DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_trace_model_ts    ON trace_events(model, ts DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_trace_tool        ON trace_events(tool_name) WHERE kind = 'tool'`);
  // Span-tree and cross-schema recall↔trace correlation — partial indexes so
  // they cover only the (small) fraction of rows where these FKs are set.
  // No FK constraints: self-FKs on partitioned tables are fragile, and
  // entry_id crosses schema boundaries (memory.entries).
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_trace_parent      ON trace_events(parent_span_id) WHERE parent_span_id IS NOT NULL`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_trace_entry       ON trace_events(entry_id)       WHERE entry_id IS NOT NULL`
  );

  // Current + next month created on every boot (see ensureCurrentAndNextMonthPartitions).
  await ensureCurrentAndNextMonthPartitions(client);
}

// ---------------------------------------------------------------------------
// Schema-drift repair — ALTER TABLE ... ADD COLUMN IF NOT EXISTS
// ---------------------------------------------------------------------------
// Observed failure: pg.log repeatedly logs
//   column "agent" of relation "trace_events" does not exist
// and the equivalent for agent_sessions — an older cluster/pgdata created
// before the `agent` column was added to these two tables, so every INSERT/
// UPSERT touching it fails forever until manually patched. CREATE TABLE IF
// NOT EXISTS above is a no-op once the table exists, so it never repairs an
// already-created table with a stale column set. Run these idempotent
// ADD COLUMN migrations on every boot (init() and initAgentTables()) so
// drifted clusters self-heal without a manual ALTER.
async function migrateSchemaDrift(client) {
  // Bounded lock wait: nullable ADD COLUMN is metadata-only once the ACCESS
  // EXCLUSIVE lock is held, but acquiring that lock can queue behind live
  // readers/writers indefinitely and wedge boot (reviewer Medium). 5s is
  // generous for a metadata change; on timeout we leave the drift in place
  // (inserts keep failing as before — no worse) instead of hanging startup.
  //
  // SET LOCAL only affects the enclosing transaction; with pg autocommit each
  // stray statement was its own transaction, so `SET LOCAL lock_timeout` was a
  // no-op that ended immediately and the ALTERs ran with the default (0 =
  // unbounded) timeout — the exact wedge this was meant to prevent. Wrap the
  // whole thing in an explicit transaction so SET LOCAL actually scopes the
  // ALTERs; on any error roll back (leaving drift in place, inserts fail as
  // before — no worse).
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`ALTER TABLE IF EXISTS trace_events ADD COLUMN IF NOT EXISTS agent TEXT`);
    await client.query(`ALTER TABLE IF EXISTS trace_events ADD COLUMN IF NOT EXISTS result_kind TEXT`);
    await client.query(`ALTER TABLE IF EXISTS trace_events ADD COLUMN IF NOT EXISTS result_error_category TEXT`);
    await client.query(`ALTER TABLE IF EXISTS trace_events ADD COLUMN IF NOT EXISTS result_error_first_line TEXT`);
    await client.query(`ALTER TABLE IF EXISTS agent_calls ADD COLUMN IF NOT EXISTS result_kind TEXT`);
    await client.query(`ALTER TABLE IF EXISTS agent_calls ADD COLUMN IF NOT EXISTS result_error_category TEXT`);
    await client.query(`ALTER TABLE IF EXISTS agent_calls ADD COLUMN IF NOT EXISTS result_error_first_line TEXT`);
    await client.query(`ALTER TABLE IF EXISTS agent_sessions ADD COLUMN IF NOT EXISTS agent TEXT`);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    __mixdogMemoryLog(`[trace-store] schema-drift migrate skipped: ${err?.message ?? err}\n`);
  }
}

// ---------------------------------------------------------------------------
// Agent-specific analytic tables (added post-init via initAgentTables)
// ---------------------------------------------------------------------------

// Called once per openTraceDatabase boot, inside the BOOTSTRAP advisory-lock
// scope (see openTraceDatabase) so concurrent first-boot processes don't race
// this DDL. All statements remain IF NOT EXISTS as a second line of defense.
async function initAgentTables(client) {
  // Repair schema drift on already-created tables before anything else
  // (trace_events already exists at this point via init(); agent_sessions
  // is created just below in this same function).
  await migrateSchemaDrift(client);
  // ── agent_calls: one row per tool invocation ─────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_calls (
      id           BIGSERIAL PRIMARY KEY,
      session_id   TEXT        NOT NULL,
      iteration    INT,
      ts           TIMESTAMPTZ NOT NULL,
      tool_name    TEXT,
      tool_kind    TEXT,
      tool_ms      INT,
      tool_args    JSONB,
      result_kind  TEXT,
      result_error_category TEXT,
      result_error_first_line TEXT
    )
  `);
  await client.query(sessionIndexSql('idx_ac_session'));
  await client.query(`CREATE INDEX IF NOT EXISTS idx_ac_ts        ON agent_calls USING BRIN (ts)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_ac_tool_name ON agent_calls (tool_name)`);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_ac_errors_ts ON agent_calls (ts DESC) WHERE result_kind = 'error'`
  );
  // Expression indexes covering the two actual query patterns (md5 dedup + path lookup).
  // The old GIN index had no @> callers and was write-heavy; dropped in favour of these.
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_ac_args_md5  ON agent_calls (session_id, tool_name, md5(tool_args::text))`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_ac_args_path ON agent_calls (session_id, tool_name, (tool_args->>'path'), ts, id)`
  );
  await client.query(`DROP INDEX IF EXISTS idx_ac_args`);

  // ── agent_llm: one row per LLM usage event ───────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_llm (
      id                 BIGSERIAL PRIMARY KEY,
      session_id         TEXT        NOT NULL,
      iteration          INT,
      ts                 TIMESTAMPTZ NOT NULL,
      model              TEXT,
      input_tokens       INT,
      output_tokens      INT,
      cached_tokens      INT,
      cache_write_tokens INT,
      prompt_tokens      INT,
      response_id        TEXT
    )
  `);
  await client.query(sessionIndexSql('idx_al_session'));
  await client.query(`CREATE INDEX IF NOT EXISTS idx_al_ts      ON agent_llm USING BRIN (ts)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_al_model   ON agent_llm (model)`);

  // ── agent_sessions: denormalised summary upserted on each insert ─────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      session_id          TEXT        PRIMARY KEY,
      agent               TEXT,
      model               TEXT,
      started_at          TIMESTAMPTZ,
      last_seen_at        TIMESTAMPTZ,
      tool_calls          INT         NOT NULL DEFAULT 0,
      llm_calls           INT         NOT NULL DEFAULT 0,
      max_iteration       INT         NOT NULL DEFAULT 0,
      total_input_tokens  BIGINT      NOT NULL DEFAULT 0,
      total_output_tokens BIGINT      NOT NULL DEFAULT 0
    )
  `);

  // Repair drift again post-creation for agent_sessions (belt-and-suspenders;
  // no-op when the table was freshly created above with the column present).
  await migrateSchemaDrift(client);
}

// ---------------------------------------------------------------------------
// insertAgentCalls — batch insert tool rows + upsert session summary
// ---------------------------------------------------------------------------
export async function insertAgentCalls(db, events) {
  if (!db || !Array.isArray(events) || events.length === 0) return { calls: 0, llm: 0 };
  const { toolRows, llmRows } = collectAgentCallRows(events);

  // Wrap all three inserts in a single transaction — one flush/fsync.
  // checkedConnect ensures search_path = trace, public on fresh connections;
  // raw _pool.connect() leaves search_path at PG default and agent_* lookups
  // resolve in the wrong schema.
  const client = await checkedConnect(db._pool, 'trace');
  try {
    await client.query('BEGIN');
    await insertToolRows(client, toolRows);
    await insertLlmRows(client, llmRows);
    await upsertAgentSessions(client, summarizeAgentSessions(events, toolRows, llmRows));
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }

  return { calls: toolRows.length, llm: llmRows.length };
}

// Idempotently ensure partitions exist for the current and next calendar month.
// Called from both init() and openTraceDatabase() so the next-month partition
// is always pre-created before rollover; rows never land in the default partition
// for a range that has a covering monthly partition.
async function ensureCurrentAndNextMonthPartitions(client) {
  await client.query(`
    DO $$
    DECLARE
      cur_start  BIGINT := extract(epoch from date_trunc('month', now()))::BIGINT * 1000;
      cur_end    BIGINT := extract(epoch from date_trunc('month', now() + interval '1 month'))::BIGINT * 1000;
      next_start BIGINT := extract(epoch from date_trunc('month', now() + interval '1 month'))::BIGINT * 1000;
      next_end   BIGINT := extract(epoch from date_trunc('month', now() + interval '2 months'))::BIGINT * 1000;
      cur_name   TEXT   := 'trace_events_' || to_char(now(), 'YYYY_MM');
      next_name  TEXT   := 'trace_events_' || to_char(now() + interval '1 month', 'YYYY_MM');
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'trace' AND c.relname = cur_name
      ) THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF trace_events FOR VALUES FROM (%s) TO (%s)',
          cur_name, cur_start, cur_end
        );
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'trace' AND c.relname = next_name
      ) THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF trace_events FOR VALUES FROM (%s) TO (%s)',
          next_name, next_start, next_end
        );
      END IF;
    END $$
  `);
}

// Full trace is personal developer diagnostics. Keep a short rolling window so
// opting in never turns the shared memory database into an unbounded event log.
const TRACE_RETENTION_DAYS = (() => {
  const raw = process.env.MIXDOG_TRACE_RETENTION_DAYS;
  if (raw == null || raw === '') return 7;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 7;
})();
const TRACE_RETENTION_DELETE_BATCH = 5000;

async function dropAgedTracePartitions(client) {
  if (TRACE_RETENTION_DAYS <= 0) return;
  // Whole old partitions reclaim disk immediately. The active cutoff month is
  // row-pruned below because it can contain both retained and expired days.
  const days = TRACE_RETENTION_DAYS;
  await client.query(`
    DO $$
    DECLARE
      cutoff   TEXT := to_char(now() - interval '${days} days', 'YYYY_MM');
      part     RECORD;
    BEGIN
      FOR part IN
        SELECT c.relname
        FROM   pg_class c
        JOIN   pg_namespace n ON n.oid = c.relnamespace
        WHERE  n.nspname = 'trace'
          AND  c.relname ~ '^trace_events_[0-9]{4}_[0-9]{2}$'
          AND  substring(c.relname from 'trace_events_(.*)') < cutoff
      LOOP
        EXECUTE format('DROP TABLE IF EXISTS trace.%I', part.relname);
      END LOOP;
    END $$
  `);
}

// Delete in small transactions so first boot after an update never holds one
// giant lock or allocates a single huge WAL transaction. Autovacuum reuses the
// reclaimed pages; old whole-month partitions are dropped above.
export async function pruneAgedTraceRows(client, nowMs = Date.now()) {
  if (TRACE_RETENTION_DAYS <= 0) return;
  const cutoffMs = nowMs - TRACE_RETENTION_DAYS * 86_400_000;
  const plans = [
    {
      table: 'trace_events',
      sql: `WITH doomed AS (
              SELECT tableoid, ctid FROM trace_events
               WHERE ts < $1 LIMIT $2
            )
            DELETE FROM trace_events target USING doomed
             WHERE target.tableoid = doomed.tableoid AND target.ctid = doomed.ctid`,
    },
    ...['agent_calls', 'agent_llm', 'bridge_calls', 'bridge_llm'].map((table) => ({
      table,
      sql: `DELETE FROM ${table}
             WHERE id = ANY(ARRAY(
               SELECT id FROM ${table}
                WHERE ts < to_timestamp($1 / 1000.0) LIMIT $2
             ))`,
    })),
  ];
  for (const plan of plans) {
    try {
      let guard = 0;
      while (guard++ < 10_000) {
        const result = await client.query(plan.sql, [cutoffMs, TRACE_RETENTION_DELETE_BATCH]);
        if (Number(result.rowCount ?? 0) < TRACE_RETENTION_DELETE_BATCH) break;
        await new Promise((resolvePromise) => setImmediate(resolvePromise));
      }
    } catch (err) {
      __mixdogMemoryLog(`[trace-store] aged-row delete skipped for ${plan.table}: ${err?.message ?? err}\n`);
    }
  }
}

async function runTraceRetention(db) {
  let client;
  try {
    client = await db._pool.connect();
    await client.query(`SET search_path = trace, public`);
    await ensureCurrentAndNextMonthPartitions(client);
    await dropAgedTracePartitions(client);
    await pruneAgedTraceRows(client);
  } catch (err) {
    __mixdogMemoryLog(`[trace-store] retention failed: ${err?.message ?? err}\n`);
  } finally {
    client?.release();
  }
}

async function isBootstrapComplete(client) {
  try {
    // Harden the check: require (a) root is partitioned, (b) schema-version
    // columns parent_span_id and entry_id exist, (c) idx_trace_ts_brin exists,
    // (d) at least one named-month OR default partition exists.
    // A partial failed init (crashed after CREATE TABLE, before indexes) returns
    // false here, triggering a full re-run rather than silently booting broken.
    const r = await client.query(`
      SELECT 1 WHERE
        -- (a) partitioned root exists
        EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_partitioned_table pt ON pt.partrelid = c.oid
          WHERE n.nspname = 'trace' AND c.relname = 'trace_events'
        )
        -- (b) schema-version columns present
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'trace' AND c.relname = 'trace_events'
            AND a.attname IN ('parent_span_id', 'entry_id')
            AND a.attnum > 0 AND NOT a.attisdropped
          HAVING count(*) = 2
        )
        -- (c) BRIN index exists
        AND EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'trace' AND indexname = 'idx_trace_ts_brin'
        )
        -- (d) at least one partition (named-month or default catch-all) exists
        AND EXISTS (
          SELECT 1 FROM pg_inherits i
          JOIN pg_class cp ON cp.oid = i.inhparent
          JOIN pg_namespace n ON n.oid = cp.relnamespace
          WHERE n.nspname = 'trace' AND cp.relname = 'trace_events'
        )
    `);
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

// Advisory lock key — session-scoped, prevents cross-process bootstrap races.
const BOOTSTRAP_LOCK_KEY = `hashtext('mixdog.trace_bootstrap')`;

// ---------------------------------------------------------------------------
// openTraceDatabase
// ---------------------------------------------------------------------------

export async function openTraceDatabase(dataDir) {
  if (!traceEnabled(dataDir)) {
    const cleanup = await cleanupTraceWhenDisabled(dataDir);
    if (cleanup.dropped) {
      __mixdogMemoryLog('[trace-store] disabled; removed existing trace diagnostics\n');
    }
    return null;
  }

  const key = resolve(dataDir);

  if (dbs.get(key)) return dbs.get(key);
  if (opening.has(key)) return opening.get(key);

  const promise = (async () => {
    // pg-adapter with schema='trace' sets search_path=trace,public per connection.
    const { db } = await ensurePgInstance(dataDir, { schema: 'trace' });

    // Acquire a dedicated pool client for bootstrap so the advisory lock is
    // session-scoped to exactly one connection (advisory locks are per-session).
    // The client is released in finally — in both success and error paths.
    const client = await db._pool.connect();
    try {
      // Set search_path on the dedicated client to match the pool default.
      await client.query(`SET search_path = trace, public`);
      // Session-scoped advisory lock — bounded so a stuck holder can't hang
      // boot indefinitely. Try non-blocking first; on contention, set a
      // 30s lock_timeout for the blocking acquire and surface a clear error
      // instead of an unbounded wait.
      const tryAcquire = await client.query(`SELECT pg_try_advisory_lock(${BOOTSTRAP_LOCK_KEY}) AS locked`);
      if (!tryAcquire.rows[0]?.locked) {
        // SET LOCAL only persists inside an explicit transaction — without
        // BEGIN/COMMIT PG resets it immediately, so pg_advisory_lock() would
        // wait unbounded. Wrap the lock_timeout + blocking acquire so the
        // 30s ceiling actually applies.
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL lock_timeout = '30s'`);
          await client.query(`SELECT pg_advisory_lock(${BOOTSTRAP_LOCK_KEY})`);
          await client.query('COMMIT');
        } catch (err) {
          try {
            await client.query('ROLLBACK');
          } catch {}
          // lock_timeout fires as 55P03 (lock_not_available); surface with context.
          throw new Error(`trace-store bootstrap advisory lock timed out (30s): ${err?.message || err}`);
        }
      }
      try {
        // Re-check after acquiring the lock: another process may have completed
        // init while we were waiting.
        if (!(await isBootstrapComplete(client))) {
          await init(client);
        } else {
          // Init already done by another process; still ensure upcoming partitions
          // are pre-created for this boot.
          await ensureCurrentAndNextMonthPartitions(client);
        }
        // Agent-specific analytic tables — moved inside the advisory-lock
        // scope (was previously run after client.release() with no lock,
        // letting concurrent first-boot processes race the agent_calls/
        // agent_llm/agent_sessions CREATE TABLE + migrateSchemaDrift DDL).
        // Reuses the same lock-holding client/session; still idempotent
        // (IF NOT EXISTS everywhere) but no longer racy across processes.
        await initAgentTables(client);
      } finally {
        await client.query(`SELECT pg_advisory_unlock(${BOOTSTRAP_LOCK_KEY})`);
      }
    } finally {
      client.release();
    }

    dbs.set(key, db);
    void runTraceRetention(db);

    // Periodically ensure current + next-month partitions exist so a
    // long-running process never hits the default catch-all partition at
    // month rollover. Fires every 12 h — well ahead of any boundary.
    const _partitionEnsureInterval = setInterval(
      async () => {
        await runTraceRetention(db);
      },
      12 * 60 * 60 * 1000
    );
    _partitionEnsureInterval.unref?.();
    partitionTimers.set(key, _partitionEnsureInterval);

    return db;
  })();

  opening.set(key, promise);
  try {
    return await promise;
  } finally {
    opening.delete(key);
  }
}

// ---------------------------------------------------------------------------
// insertTraceEvents — batch INSERT
// ---------------------------------------------------------------------------

const TRACE_COLS = [
  'ts',
  'session_id',
  'iteration',
  'kind',
  'agent',
  'model',
  'tool_name',
  'tool_ms',
  'result_kind',
  'result_error_category',
  'result_error_first_line',
  'input_tokens',
  'output_tokens',
  'cached_tokens',
  'cache_write_tokens',
  'duration_ms',
  'error_message',
  'payload',
  'parent_span_id',
  'entry_id',
];
const PG_MAX_BIND_PARAMETERS = 65_535;
const TRACE_INSERT_MAX_ROWS = Math.floor(PG_MAX_BIND_PARAMETERS / TRACE_COLS.length);

// ---------------------------------------------------------------------------
// Cross-request trace_events write queue (100ms / 500-row flush window)
// ---------------------------------------------------------------------------

const TRACE_QUEUE_FLUSH_MS = 100;
const TRACE_QUEUE_MAX_ROWS = 500;
// Twenty normal flush batches leaves ample room for ordinary DB jitter while
// bounding producer memory across repeated flush failures.
const TRACE_QUEUE_MAX_PENDING_EVENTS = 10_000;

// Per-db queue state (keyed by db object identity via WeakMap).
const _traceQueues = new WeakMap();

function _getQueue(db) {
  let q = _traceQueues.get(db);
  if (!q) {
    q = { pending: [], timer: null, flushPromise: null, droppedEvents: 0 };
    _traceQueues.set(db, q);
  }
  return q;
}

function _pendingEventCount(q) {
  return q.pending.reduce((n, w) => n + w.events.length, 0);
}

function _trimPendingQueue(q) {
  let overflow = _pendingEventCount(q) - TRACE_QUEUE_MAX_PENDING_EVENTS;
  while (overflow > 0 && q.pending.length > 0) {
    const oldest = q.pending[0];
    if (oldest.events.length <= overflow) {
      q.pending.shift();
      q.droppedEvents += oldest.events.length;
      overflow -= oldest.events.length;
    } else {
      oldest.events.splice(0, overflow);
      q.droppedEvents += overflow;
      overflow = 0;
    }
  }
}

function _dropWrittenEvents(wrappers, count) {
  while (count > 0 && wrappers.length > 0) {
    const wrapper = wrappers[0];
    if (wrapper.events.length <= count) {
      wrappers.shift();
      count -= wrapper.events.length;
    } else {
      wrapper.events.splice(0, count);
      count = 0;
    }
  }
}

async function _flushQueue(db, q) {
  // When a flush is already running, callers reuse its promise — but enqueues
  // that arrive during that flush schedule a fresh timer that fires here and
  // is consumed by the early return. Reschedule a follow-up flush so events
  // queued mid-flush don't sit until the next unrelated enqueue.
  if (q.flushPromise) {
    if (q.pending.length > 0) _scheduleFlush(db, q);
    return q.flushPromise;
  }
  const wrappers = q.pending.splice(0);
  if (wrappers.length === 0) return { inserted: 0 };
  const MAX_RETRIES = 3;
  q.flushPromise = (async () => {
    let writtenEvents = 0;
    try {
      const allEvents = wrappers.flatMap((w) => w.events);
      return await _insertTraceEventBatches(db, allEvents, (count) => {
        writtenEvents += count;
      });
    } catch (err) {
      _dropWrittenEvents(wrappers, writtenEvents);
      for (const w of wrappers) w.attempts += 1;
      const keep = wrappers.filter((w) => w.attempts < MAX_RETRIES);
      const dropped = wrappers.filter((w) => w.attempts >= MAX_RETRIES);
      if (dropped.length > 0) {
        __mixdogMemoryLog(
          `[trace-queue] dropped ${dropped.reduce((n, w) => n + w.events.length, 0)} events after ${MAX_RETRIES} retries: ${err?.message}\n`
        );
      }
      q.pending.unshift(...keep);
      _trimPendingQueue(q);
      __mixdogMemoryLog(`[trace-queue] flush error: ${err?.message}\n`);
      throw err;
    } finally {
      q.flushPromise = null;
      // Drain any events that landed in the queue while this flush ran.
      if (q.pending.length > 0) _scheduleFlush(db, q);
    }
  })();
  return q.flushPromise;
}

function _scheduleFlush(db, q) {
  if (q.timer) return;
  q.timer = setTimeout(async () => {
    q.timer = null;
    _flushQueue(db, q).catch((err) => __mixdogMemoryLog(`[trace-queue] flush error: ${err?.message}\n`));
  }, TRACE_QUEUE_FLUSH_MS);
  q.timer.unref?.();
}

// ---------------------------------------------------------------------------
// Exit drain — flush pending trace events before process exit.
// Issue 4: timer is unref()'d so it won't prevent exit; register drain handlers.
// ---------------------------------------------------------------------------

const _registeredExitDbs = new WeakMap();

async function drainTraceQueue(db) {
  const q = _traceQueues.get(db);
  if (!q) return;
  try {
    if (q.timer) {
      clearTimeout(q.timer);
      q.timer = null;
    }
    if (q.flushPromise) await q.flushPromise.catch(() => {});
    if (q.pending.length > 0)
      await _insertTraceEventBatches(
        db,
        q.pending.splice(0).flatMap((w) => w.events)
      );
  } catch (e) {
    __mixdogMemoryLog(`[trace-queue] drain failed: ${e?.message}\n`);
  }
}

function clearTraceQueue(db) {
  const q = _traceQueues.get(db);
  if (!q) return;
  if (q.timer) {
    clearTimeout(q.timer);
    q.timer = null;
  }
  q.pending.length = 0;
  q.flushPromise = null;
  _traceQueues.delete(db);
}

function unregisterTraceExitDrain(db) {
  const handlers = _registeredExitDbs.get(db);
  if (!handlers) return;
  try {
    process.off('exit', handlers.onExit);
  } catch {}
  try {
    process.off('SIGTERM', handlers.onSigterm);
  } catch {}
  try {
    process.off('beforeExit', handlers.onBeforeExit);
  } catch {}
  _registeredExitDbs.delete(db);
}

export function registerTraceExitDrain(db) {
  if (!db) return;
  if (_registeredExitDbs.has(db)) return;

  async function drainOnExit() {
    await drainTraceQueue(db);
  }

  const onExit = () => {
    const q = _traceQueues.get(db);
    if (q?.pending.length) __mixdogMemoryLog(`[trace-queue] exit with ${q.pending.length} unflushed events\n`);
  };
  const onSigterm = async () => {
    await drainOnExit();
    process.exit(0);
  };

  process.on('exit', onExit);
  process.on('SIGTERM', onSigterm);
  process.once('beforeExit', drainOnExit);

  _registeredExitDbs.set(db, { onExit, onSigterm, onBeforeExit: drainOnExit });
}

export async function closeTraceDatabase(dataDir) {
  const key = resolve(dataDir);
  let db = dbs.get(key);
  if (!db && opening.has(key)) {
    try {
      db = await opening.get(key);
    } catch {
      db = null;
    }
  }
  if (!db) return false;
  const timer = partitionTimers.get(key);
  if (timer) {
    try {
      clearInterval(timer);
    } catch {}
    partitionTimers.delete(key);
  }
  await drainTraceQueue(db);
  clearTraceQueue(db);
  unregisterTraceExitDrain(db);
  dbs.delete(key);
  try {
    await db.close?.();
  } catch {}
  try {
    await closePgInstance(dataDir, { schema: 'trace' });
  } catch {}
  return true;
}

/**
 * Enqueue events for async batched insert. Returns immediately; flush happens
 * within TRACE_QUEUE_FLUSH_MS or when TRACE_QUEUE_MAX_ROWS is reached.
 * Callers that need a synchronous result should use insertTraceEvents directly.
 */
export function enqueueTraceEvents(db, events) {
  if (!db || !Array.isArray(events) || events.length === 0) return;
  const q = _getQueue(db);
  q.pending.push({ events: [...events], attempts: 0 });
  // Row cap counts pending EVENTS, not wrappers — a single wrapper with
  // >TRACE_QUEUE_MAX_ROWS events would otherwise sit until the timer.
  _trimPendingQueue(q);
  const pendingEvents = _pendingEventCount(q);
  if (pendingEvents >= TRACE_QUEUE_MAX_ROWS) {
    // Flush immediately when row cap reached — don't wait for timer.
    if (q.timer) {
      clearTimeout(q.timer);
      q.timer = null;
    }
    _flushQueue(db, q).catch((err) => __mixdogMemoryLog(`[trace-queue] flush error: ${err?.message}\n`));
  } else {
    _scheduleFlush(db, q);
  }
}

// Renamed internal: direct DB insert without queuing (used by queue flusher and
// the existing intra-request multi-row path where immediate persistence matters).
async function _insertTraceEventsDirect(db, events) {
  return insertTraceEvents(db, events);
}

async function _insertTraceEventBatches(db, events, onBatchInserted) {
  let inserted = 0;
  for (let start = 0; start < events.length; start += TRACE_INSERT_MAX_ROWS) {
    const batch = events.slice(start, start + TRACE_INSERT_MAX_ROWS);
    const result = await _insertTraceEventsDirect(db, batch);
    inserted += result.inserted;
    onBatchInserted?.(batch.length);
  }
  return { inserted };
}

export async function insertTraceEvents(db, events) {
  if (!db || !Array.isArray(events) || events.length === 0) return { inserted: 0 };

  const valuePlaceholders = [];
  const params = [];
  let p = 1;

  for (const ev of events) {
    let ts = ev.ts;
    if (typeof ts === 'string') ts = Date.parse(ts);
    ts = Number(ts);
    if (!Number.isFinite(ts)) ts = Date.now();

    const payload = ev.payload != null ? ev.payload : {};

    const cols = [
      ts,
      ev.session_id ?? null,
      ev.iteration != null ? Number(ev.iteration) : null,
      String(ev.kind ?? 'unknown'),
      ev.agent ?? null,
      ev.model ?? null,
      ev.tool_name ?? null,
      ev.tool_ms != null ? Number(ev.tool_ms) : null,
      ev.result_kind ?? ev.resultKind ?? null,
      ev.result_error_category ?? ev.resultErrorCategory ?? null,
      ev.result_error_first_line ?? ev.resultErrorFirstLine ?? null,
      ev.input_tokens != null ? Number(ev.input_tokens) : null,
      ev.output_tokens != null ? Number(ev.output_tokens) : null,
      ev.cached_tokens != null ? Number(ev.cached_tokens) : null,
      ev.cache_write_tokens != null ? Number(ev.cache_write_tokens) : null,
      ev.duration_ms != null ? Number(ev.duration_ms) : null,
      ev.error_message ?? null,
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      ev.parent_span_id != null ? Number(ev.parent_span_id) : null,
      ev.entry_id != null ? Number(ev.entry_id) : null,
    ];
    valuePlaceholders.push(`(${cols.map(() => `$${p++}`).join(', ')})`);
    params.push(...cols);
  }

  const sql = `INSERT INTO trace_events (${TRACE_COLS.join(', ')}) VALUES ${valuePlaceholders.join(', ')}`;
  await db.query(sql, params);
  return { inserted: events.length };
}
