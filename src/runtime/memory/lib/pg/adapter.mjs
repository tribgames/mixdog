const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

function installPoolErrorHandler(pool, label) {
  if (!pool || typeof pool.on !== 'function') return pool
  pool.on('error', (err, client) => {
    const code = err?.code || err?.errno || ''
    const msg = err?.message || String(err || 'unknown error')
    const pid = client?.processID ? ` pid=${client.processID}` : ''
    const suffix = code ? ` ${code}` : ''
    __mixdogMemoryLog(`[pg-adapter] ${label} idle client error${suffix}${pid}: ${msg}\n`)
  })
  return pool
}

// pg-adapter.mjs — PG connection manager for mixdog 0.4.0
// Single owner: supervisor-pg.ensurePgInstance(dataDir) starts PG.
// pg-adapter calls supervisor-pg — never pg-process directly.
//
// Public API:
//   ensurePgInstance(dataDir, { schema? }) → { db, pool, host, port, runtimeDir, pgdataDir }
//   closePgInstance(dataDir)               → void
//
// The returned `db` exposes the native PG query surface:
//   db.query(sql, params?)          → { rows, rowCount }
//   db.exec(sql)                    → multi-statement; resolves on completion
//   db.transaction(async tx => …)  → auto BEGIN/COMMIT, ROLLBACK on throw

import { resolve } from 'path'
import { ensurePgInstance as supervisorEnsure } from './supervisor.mjs'

// ---------------------------------------------------------------------------
// One-shot bootstrap guard — keyed by resolved dataDir (cluster-level, not schema)
// ---------------------------------------------------------------------------

const _bootstrapped = new Set()

// ---------------------------------------------------------------------------
// Cross-process advisory-lock keys (two-int4 form: classid + objid).
//
// pg advisory locks are CLUSTER-global regardless of which database the session
// is connected to, so a single shared classid namespaces all mixdog first-boot
// locks; distinct objids separate the CREATE DATABASE race from the per-cluster
// extension/schema DDL race. Fixed app-specific keys → concurrent first-boot
// workers serialize on the exact same lock rather than racing the DDL path.
// ---------------------------------------------------------------------------

const ADVISORY_LOCK_CLASSID = 0x6d696478 // "midx" — mixdog bootstrap namespace
const ADVISORY_OBJID_CREATE_DB = 1       // CREATE DATABASE mixdog
export const ADVISORY_OBJID_SCHEMA_BOOTSTRAP = 2 // extensions + schema DDL

// ---------------------------------------------------------------------------
// In-process cache
// ---------------------------------------------------------------------------

const instances = new Map() // `${dataDir}|${schema}` → instance handle
const opening   = new Map() // same key → Promise (dedupe concurrent calls)

// ---------------------------------------------------------------------------
// Per-connection init — WeakSet-guarded so settings run exactly once per client
// ---------------------------------------------------------------------------

const _clientInited = new WeakSet()

async function _initClient(client, schema) {
  if (_clientInited.has(client)) return
  // Set search_path so unqualified table names resolve to the correct schema.
  //
  // CROSS-SCHEMA QUERY RULE: search_path is per-connection and biases every
  // unqualified table reference toward the connection's primary schema. Any
  // query that intentionally touches the OTHER schema (e.g. orphan sweep on
  // memory.entries from a trace-schema connection, or recall × trace JOIN
  // analytics) MUST use fully-qualified names (memory.entries / trace.trace_events).
  // Relying on search_path silently in cross-schema code = bug magnet.
  const sp = schema === 'trace' ? 'trace, public' : 'memory, public'
  await client.query(`SET search_path = ${sp}`)
  // pg_trgm similarity threshold: session-local, must be set per connection.
  await client.query(`SELECT set_limit(0.10)`)
  await client.query(`SET default_transaction_isolation TO 'read committed'`)
  // Mark seen only after all init statements succeed; failure leaves client
  // unmarked so the next checkout retries init.
  _clientInited.add(client)
}

// Wrapper around pool.connect() that runs per-client init before returning.
// Exported so external callers (e.g. trace-store.insertAgentCalls) can obtain
// a connection with search_path already set; raw _pool.connect() leaves it at
// the PG default and unqualified table lookups resolve in the wrong schema.
export async function checkedConnect(pgPool, schema) {
  const client = await pgPool.connect()
  try {
    await _initClient(client, schema)
  } catch (e) {
    client.release()
    throw e
  }
  return client
}
const _checkedConnect = checkedConnect

// ---------------------------------------------------------------------------
// native PG db shim
// ---------------------------------------------------------------------------

function makeCompatDb(pgPool, schema, dataDir) {
  const db = {
    // query: use pool directly for single-statement queries
    query: async (sql, params) => {
      return await withPgRetry(dataDir, schema, async (pool) => {
        const client = await _checkedConnect(pool, schema)
        try {
          return await client.query(sql, params)
        } finally {
          client.release()
        }
      })
    },

    // exec: multi-statement SQL (semicolon-separated); single client for session state
    exec: async (sql) => {
      // Not retried: exec runs arbitrary multi-statement SQL where a partial
      // failure mid-sequence is unobservable from here — replaying the whole
      // string after recovery risks double-applying already-committed
      // statements. On ECONNREFUSED, trigger recovery in the background (so
      // the NEXT call gets a fresh pool) and propagate the original error.
      const pool = instances.get(`${resolve(dataDir)}|${schema}`)?.pool ?? pgPool
      try {
        const client = await _checkedConnect(pool, schema)
        try {
          await client.query(sql)
        } finally {
          client.release()
        }
      } catch (err) {
        if (err?.code === 'ECONNREFUSED') _recoverPgConnection(dataDir, schema).catch(() => {})
        throw err
      }
    },

    // transaction: check out one client, BEGIN, run callback(tx), COMMIT or ROLLBACK
    transaction: async (fn) => {
      // Not retried — same rationale as exec(): a COMMIT that fails with
      // ECONNREFUSED leaves the transaction's applied/rolled-back state
      // unknown to this process; blindly replaying fn() could double-apply
      // side effects. Recover in the background for the next caller and
      // propagate the original error immediately.
      const pool = instances.get(`${resolve(dataDir)}|${schema}`)?.pool ?? pgPool
      const client = await _checkedConnect(pool, schema)
      try {
        await client.query('BEGIN')
        const tx = {
          query: (sql, params) => client.query(sql, params),
          exec:  (sql)         => client.query(sql),
        }
        const result = await fn(tx)
        await client.query('COMMIT')
        return result
      } catch (err) {
        try { await client.query('ROLLBACK') } catch {}
        if (err?.code === 'ECONNREFUSED') _recoverPgConnection(dataDir, schema).catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    // close: drain pool
    close: () => pgPool.end(),

    // Internal access for callers that need raw pool. Getter (not a fixed
    // field) so callers that hold onto `db` across a recovery cycle (e.g.
    // trace-store's checkedConnect/pool.connect() call sites) transparently
    // see the refreshed pool after withPgRetry swaps the cached instance —
    // otherwise db._pool would keep pointing at the dead pre-recovery pool.
    get _pool() {
      return instances.get(`${resolve(dataDir)}|${schema}`)?.pool ?? pgPool
    },
  }
  return db
}

// ---------------------------------------------------------------------------
// Self-healing: pool query fails with ECONNREFUSED (target pg_port down while
// the server process itself stays alive) → discard the stale pool via
// closePgInstance and re-run ensurePgInstance so supervisor-pg restarts/
// re-attaches PG, then retry the failed operation exactly once against the
// fresh pool.
//
// Guards against runaway restart loops:
//   - _recoverInFlight: at most one recovery coroutine per dataDir at a time;
//     concurrent callers await the same promise instead of racing restarts.
//   - _lastRecoverAt / RECOVER_COOLDOWN_MS: after a recovery attempt (success
//     or failure) further ECONNREFUSED hits within the cooldown window
//     surface the original error instead of re-triggering PG restart.
// ---------------------------------------------------------------------------

const RECOVER_COOLDOWN_MS = 15_000
const _lastRecoverAt = new Map()   // dataDirKey → epoch ms of last recovery attempt
const _recoverInFlight = new Map() // dataDirKey → Promise<boolean>

function _instanceKeysForDataDir(dataDirKey) {
  const prefix = `${dataDirKey}|`
  return Array.from(instances.keys()).filter(k => k.startsWith(prefix))
}

async function _recoverPgConnection(dataDir, schema) {
  const dataDirKey = resolve(dataDir)
  // In-flight check FIRST: a concurrent recovery already running for this
  // dataDir must be awaited by every caller (even ones arriving inside the
  // cooldown window that starts once that recovery begins) — otherwise a
  // caller that lands between the in-flight recovery's start and its cooldown
  // stamp would see neither in-flight nor cooldown and could trigger a second
  // redundant restart cycle.
  if (_recoverInFlight.has(dataDirKey)) return _recoverInFlight.get(dataDirKey)
  const now = Date.now()
  const last = _lastRecoverAt.get(dataDirKey) || 0
  if (now - last < RECOVER_COOLDOWN_MS) {
    // Cooldown active — do not hammer PG restart on every failing query.
    return false
  }

  const p = (async () => {
    _lastRecoverAt.set(dataDirKey, Date.now())
    __mixdogMemoryLog(`[pg-adapter] ECONNREFUSED on pool query — recovering PG for dataDir=${dataDirKey}\n`)
    // memory + trace schemas share one PG cluster/port; discard every cached
    // pool for this dataDir so a dead-port pool is never reused after restart.
    // Track every schema whose pool was actually closed here so ALL of them
    // get re-ensured below (not just the schema of the caller that happened
    // to trigger this recovery) — otherwise a sibling schema's cached `db`
    // handle is left pointing at an ended pool (its `_pool` getter falls back
    // to the stale `pgPool` closure var) and its next query throws a
    // "Cannot use a pool after calling end" TypeError instead of recovering.
    const closedSchemas = new Set()
    for (const key of _instanceKeysForDataDir(dataDirKey)) {
      const sch = key.slice(dataDirKey.length + 1)
      try { await closePgInstance(dataDir, { schema: sch }) } catch {}
      closedSchemas.add(sch)
    }
    closedSchemas.add(schema) // the triggering schema, even if it had no cached instance yet
    try {
      for (const sch of closedSchemas) {
        await ensurePgInstance(dataDir, { schema: sch })
      }
      __mixdogMemoryLog(`[pg-adapter] PG reconnect recovery complete for dataDir=${dataDirKey}\n`)
      return true
    } catch (e) {
      __mixdogMemoryLog(`[pg-adapter] PG reconnect recovery failed for dataDir=${dataDirKey}: ${e?.message || e}\n`)
      return false
    }
  })()
  _recoverInFlight.set(dataDirKey, p)
  try {
    return await p
  } finally {
    _recoverInFlight.delete(dataDirKey)
  }
}

/**
 * Run `fn(pool)` against the current pool for (dataDir, schema); on
 * ECONNREFUSED, recover PG (see _recoverPgConnection) and retry once against
 * the refreshed pool. Non-ECONNREFUSED errors and cooldown/in-flight misses
 * propagate the original error unchanged.
 */
async function withPgRetry(dataDir, schema, fn) {
  const key = `${resolve(dataDir)}|${schema}`
  const pool0 = instances.get(key)?.pool
  try {
    return await fn(pool0)
  } catch (err) {
    if (err?.code !== 'ECONNREFUSED') throw err
    const recovered = await _recoverPgConnection(dataDir, schema)
    if (!recovered) throw err
    const pool1 = instances.get(key)?.pool
    if (!pool1) throw err
    return await fn(pool1)
  }
}

// ---------------------------------------------------------------------------
// Instance bootstrap — extensions + schemas (idempotent)
// ---------------------------------------------------------------------------

// Run `fn` while holding the cluster-global schema-bootstrap advisory lock on a
// dedicated client. Concurrent first-boot workers across processes serialize on
// the fixed key so the CREATE TYPE / CREATE EXTENSION / schema DDL path is never
// raced. The lock is session-scoped (held by this client) and released in
// finally; `fn`'s own DDL may run on other pool connections — the lock only has
// to provide cross-process mutual exclusion, not cover the same session.
export async function withSchemaBootstrapLock(pgPool, fn) {
  const client = await pgPool.connect()
  // Tracks whether the advisory lock is provably released. Stays false until a
  // successful pg_advisory_unlock; any failure/uncertainty keeps it false so we
  // never return a still-locked session to the pool.
  let unlockErr = new Error('schema-bootstrap advisory lock release not attempted')
  try {
    await client.query(`SELECT pg_advisory_lock($1, $2)`, [
      ADVISORY_LOCK_CLASSID, ADVISORY_OBJID_SCHEMA_BOOTSTRAP,
    ])
    try {
      return await fn()
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock($1, $2)`, [
          ADVISORY_LOCK_CLASSID, ADVISORY_OBJID_SCHEMA_BOOTSTRAP,
        ])
        unlockErr = null // lock provably released → client is clean to reuse
      } catch (err) {
        unlockErr = err instanceof Error ? err : new Error(String(err))
      }
    }
  } finally {
    // A client whose advisory-lock state is uncertain must never be reused:
    // release(truthy) makes node-pg destroy it instead of pooling it.
    client.release(unlockErr || undefined)
  }
}

async function bootstrapInstance(pgPool, dataDirKey) {
  if (_bootstrapped.has(dataDirKey)) return
  // Serialize the cluster-level DDL across concurrent first-boot processes.
  await withSchemaBootstrapLock(pgPool, async () => {
    // Use a raw client bypassing per-client schema settings (bootstrap targets
    // the cluster level, not a specific schema).
    const client = await pgPool.connect()
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`)
      await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public`)
      await client.query(`CREATE SCHEMA IF NOT EXISTS memory`)
      await client.query(`CREATE SCHEMA IF NOT EXISTS trace`)
    } finally {
      client.release()
    }
  })
  _bootstrapped.add(dataDirKey)
}

// ---------------------------------------------------------------------------
// ensurePgInstance — public API
// ---------------------------------------------------------------------------

/**
 * Ensure a live PG instance and return a native PG db handle.
 *
 * @param {string} dataDir      Plugin data directory.
 * @param {{ schema?: 'memory' | 'trace' }} [opts]
 * @returns {Promise<{ db, pool, host, port, runtimeDir, pgdataDir }>}
 */
export async function ensurePgInstance(dataDir, opts = {}) {
  const schema = opts.schema ?? 'memory'
  const key    = `${resolve(dataDir)}|${schema}`

  if (instances.has(key)) return instances.get(key)
  if (opening.has(key))   return opening.get(key)

  const promise = (async () => {
    // 1. Let supervisor-pg own PG startup and health-checking.
    //    Returns { host, port, runtimeDir, pgdataDir }.
    const { host, port, runtimeDir, pgdataDir } = await supervisorEnsure(dataDir)

    // 2. Connect via node-postgres; auto-create the mixdog database if absent.
    const { default: pg } = await import('pg')

    const PG_USER = 'postgres'
    const PG_DB   = 'mixdog'

    const adminPool = new pg.Pool({
      host, port, user: PG_USER, database: 'postgres',
      password: '', max: 1, idleTimeoutMillis: 5_000,
    })
    installPoolErrorHandler(adminPool, 'admin-pool')
    try {
      // CREATE DATABASE cannot run inside a transaction, so guard the
      // check-then-create with a session-level advisory lock held on a single
      // dedicated client. Concurrent first-boot workers block on the same
      // cluster-global key here and only one issues the CREATE; the rest see
      // the row present after the holder releases. Released in finally.
      const adminClient = await adminPool.connect()
      // Same invariant as withSchemaBootstrapLock: only reuse the client if the
      // advisory lock is provably released.
      let unlockErr = new Error('create-db advisory lock release not attempted')
      try {
        await adminClient.query(`SELECT pg_advisory_lock($1, $2)`, [
          ADVISORY_LOCK_CLASSID, ADVISORY_OBJID_CREATE_DB,
        ])
        try {
          const r = await adminClient.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [PG_DB])
          if (r.rows.length === 0) {
            await adminClient.query(`CREATE DATABASE ${PG_DB}`)
            __mixdogMemoryLog(`[pg-adapter] created database ${PG_DB}\n`)
          }
        } finally {
          try {
            await adminClient.query(`SELECT pg_advisory_unlock($1, $2)`, [
              ADVISORY_LOCK_CLASSID, ADVISORY_OBJID_CREATE_DB,
            ])
            unlockErr = null // lock provably released → client is clean to reuse
          } catch (err) {
            unlockErr = err instanceof Error ? err : new Error(String(err))
          }
        }
      } finally {
        // Uncertain advisory-lock state → destroy the client (truthy release arg)
        // so a still-locked session never re-enters the admin pool.
        adminClient.release(unlockErr || undefined)
      }
    } finally {
      await adminPool.end()
    }

    // 3. Production pool.
    const pgPool = new pg.Pool({
      host, port, user: PG_USER, database: PG_DB,
      password: '', max: 5, idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
    installPoolErrorHandler(pgPool, `pool:${schema}`)

    // 4. Bootstrap extensions + schemas once (idempotent).
    await bootstrapInstance(pgPool, resolve(dataDir))

    // 5. Build the compat db shim.
    const db = makeCompatDb(pgPool, schema, dataDir)

    const result = { db, pool: pgPool, host, port, runtimeDir, pgdataDir }
    instances.set(key, result)
    return result
  })()

  opening.set(key, promise)
  try {
    return await promise
  } finally {
    opening.delete(key)
  }
}

// ---------------------------------------------------------------------------
// closePgInstance — drain pool
// ---------------------------------------------------------------------------

export async function closePgInstance(dataDir, opts = {}) {
  const schema = opts.schema ?? 'memory'
  const key    = `${resolve(dataDir)}|${schema}`
  const inst   = instances.get(key)
  if (!inst) return
  try { await inst.pool.end() } catch {}
  instances.delete(key)
}
