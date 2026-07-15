const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

// pg-process.mjs — lower-level PG lifecycle helpers for mixdog 0.4.0
// Track B can wire these into the supervisor; pg-adapter calls them directly.
//
// Public API:
//   startPg({ runtimeDir, pgdataDir, port?, logPath? }) → { pid, port }
//   stopPg({ runtimeDir, pgdataDir })                   → void
//   healthcheckPg({ port, host? })                      → boolean

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'
import { createConnection } from 'net'
import { createServer } from 'net'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pgBin(runtimeDir, name) {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return join(runtimeDir, 'bin', `${name}${ext}`)
}

function libEnv(runtimeDir) {
  // Bundled shared libraries must be visible to the PG binaries at runtime.
  const libDir = join(runtimeDir, 'lib')
  if (process.platform === 'linux') {
    return { ...process.env, LD_LIBRARY_PATH: libDir }
  }
  if (process.platform === 'darwin') {
    return { ...process.env, DYLD_LIBRARY_PATH: libDir }
  }
  // win32: DLLs live in bin/ — add to PATH.
  return { ...process.env, PATH: `${join(runtimeDir, 'bin')};${process.env.PATH}` }
}

// ---------------------------------------------------------------------------
// Free port detection
// ---------------------------------------------------------------------------

function isTcpPortFree(port) {
  return new Promise(resolve => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => { srv.close(); resolve(true) })
    srv.listen(port, '127.0.0.1')
  })
}

const PG_PORT_MIN = 55432
const PG_PORT_MAX = 55632
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

function readPostmasterInfo(pgdataDir) {
  try {
    const lines = readFileSync(join(pgdataDir, 'postmaster.pid'), 'utf8').split('\n')
    const pid = parseInt(lines[0], 10)
    const port = parseInt(lines[3], 10)
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      port: Number.isInteger(port) && port > 0 ? port : null,
    }
  } catch {
    return { pid: null, port: null }
  }
}

function pgIsReady(runtimeDir, env, port) {
  const probe = spawnSync(pgBin(runtimeDir, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(port)], {
    env, stdio: 'pipe', timeout: 3_000, windowsHide: true,
  })
  return probe.status === 0
}

async function awaitExistingPostmaster({ runtimeDir, pgdataDir, env, waitMs }) {
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0)
  let info = readPostmasterInfo(pgdataDir)
  while (info.pid && info.port) {
    if (pgIsReady(runtimeDir, env, info.port)) return { state: 'ready', ...info }
    if (!isPidAlive(info.pid)) return { state: 'dead', ...info }
    if (Date.now() >= deadline) return { state: 'alive-not-ready', ...info }
    await delay(250)
    info = readPostmasterInfo(pgdataDir)
  }
  return { state: 'missing', ...info }
}

async function findFreePort(preferred) {
  // I2: clamp out-of-range callers to the valid window.
  if (preferred < PG_PORT_MIN || preferred > PG_PORT_MAX) preferred = PG_PORT_MIN
  if (await isTcpPortFree(preferred)) return preferred
  for (let p = preferred + 1; p <= PG_PORT_MAX; p++) {
    if (await isTcpPortFree(p)) return p
  }
  throw new Error(`[pg-process] no free port found in range ${preferred}–${PG_PORT_MAX}`)
}

// ---------------------------------------------------------------------------
// postgresql.conf v2 reconcile — appended on every startPg call so existing
// pgdata directories pick up the bgwriter / checkpoint-distribution tuning
// without requiring a fresh initdb.
// ---------------------------------------------------------------------------

const MIXDOG_CONF_V2_MARKER = '# mixdog overrides v2 — bgwriter / checkpoint distribution'

// Lines emitted into postgresql.conf for v2. effective_io_concurrency is
// posix_fadvise-only; PG rejects non-zero values on Windows with an invalid-
// parameter error on every reload. Skip it there.
function buildV2Block() {
  const lines = [
    '',
    MIXDOG_CONF_V2_MARKER,
    'checkpoint_completion_target = 0.9',  // spread checkpoint write across 90% of timeout window
    'bgwriter_lru_maxpages = 1000',        // up to 1000 dirty pages per round (default 100)
    'bgwriter_delay = 50ms',               // wake bgwriter every 50ms (default 200ms)
  ]
  if (process.platform !== 'win32') {
    lines.push('effective_io_concurrency = 32')  // I/O concurrency hint (POSIX only)
  }
  return lines.join('\n') + '\n'
}

// Migration: an earlier v2 always emitted effective_io_concurrency. On Windows
// that line is invalid — strip it so pg_ctl reload stops logging a parse error
// every cycle.
function stripWindowsInvalidLines(conf) {
  if (process.platform !== 'win32') return conf
  return conf.replace(/^effective_io_concurrency\s*=\s*\d+\s*\r?\n/m, '')
}

function ensureConfV2(pgdataDir) {
  const confPath = join(pgdataDir, 'postgresql.conf')
  if (!existsSync(confPath)) return false
  const original = readFileSync(confPath, 'utf8')
  let conf = stripWindowsInvalidLines(original)
  const stripped = conf !== original
  const hasMarker = conf.includes(MIXDOG_CONF_V2_MARKER)
  if (hasMarker && !stripped) return false
  if (!hasMarker) conf = conf + buildV2Block()
  writeFileSync(confPath, conf)
  return true
}

// Public reconcile: idempotent conf v2 append + pg_ctl reload on a running
// instance. Single source of truth for v2 application — supervisor and other
// callers route through this rather than re-implementing the conf/reload pair.
// All v2 settings are reload-applicable (no restart required).
export function reconcileConfV2(runtimeDir, pgdataDir) {
  const applied = ensureConfV2(pgdataDir)
  if (!applied) return { applied: false, reloaded: false }
  const reload = spawnSync(pgBin(runtimeDir, 'pg_ctl'), ['reload', '-D', pgdataDir], {
    env: libEnv(runtimeDir), stdio: 'pipe', timeout: 5_000, windowsHide: true,
  })
  const reloaded = reload.status === 0
  if (reloaded) {
    __mixdogMemoryLog('[pg-process] postgresql.conf v2 overrides applied via pg_ctl reload\n')
  } else {
    __mixdogMemoryLog(`[pg-process] pg_ctl reload after v2 append failed (non-fatal): ${reload.stderr?.toString() || ''}\n`)
  }
  return { applied, reloaded }
}

// ---------------------------------------------------------------------------
// startPg
// ---------------------------------------------------------------------------

export async function startPg({
  runtimeDir,
  pgdataDir,
  port: preferredPort = 55432,
  logPath,
  existingWaitMs = 15_000,
}) {
  mkdirSync(pgdataDir, { recursive: true })

  if (process.platform === 'darwin') {
    try { writeFileSync(join(pgdataDir, '.metadata_never_index'), '') } catch {}
  }

  // Idempotent v2 conf reconcile — runs before attach/init. Returns true if
  // the block was just appended (so the attach path can trigger pg_ctl reload).
  // Fresh-init path falls through to confAppend below which already includes v2.
  const v2Applied = ensureConfV2(pgdataDir)
  const env = libEnv(runtimeDir)

  // Pre-check: if postmaster.pid exists and the instance is reachable, attach
  // rather than attempting a second pg_ctl start (which would crash the worker).
  const postmasterPidPath = join(pgdataDir, 'postmaster.pid')
  if (existsSync(postmasterPidPath)) {
    const existing = await awaitExistingPostmaster({
      runtimeDir, pgdataDir, env, waitMs: existingWaitMs,
    })
    if (existing.state === 'ready') {
      __mixdogMemoryLog(`[pg-process] attaching to existing PG pid=${existing.pid} port=${existing.port}\n`)
      // Route through the single reconcile entry point so v1 → v2 conf
      // upgrades land on already-running instances without restart.
      if (v2Applied) reconcileConfV2(runtimeDir, pgdataDir)
      return { pid: existing.pid, port: existing.port, attached: true }
    }
    if (existing.state === 'alive-not-ready') {
      // A postmaster in startup/shutdown still owns this pgdata even when it no
      // longer accepts connections. Starting the same directory on a "free"
      // alternate port produces the observed endless "another server might be
      // running" loop and can corrupt lifecycle state. The supervisor may
      // finish a graceful stop, but this lower layer must never race it.
      throw new Error(
        `[pg-process] existing PG pid=${existing.pid} port=${existing.port} is alive but not ready; refusing concurrent start`,
      )
    }
    // Dead instance — fall through to normal startup; pg_ctl reclaims the stale lock.
  }

  const initdb = pgBin(runtimeDir, 'initdb')
  const pgctl  = pgBin(runtimeDir, 'pg_ctl')

  // initdb if pgdata is not yet initialised (no PG_VERSION file).
  const pgVersionFile = join(pgdataDir, 'PG_VERSION')
  if (!existsSync(pgVersionFile)) {
    __mixdogMemoryLog(`[pg-process] initdb → ${pgdataDir}\n`)
    const r = spawnSync(initdb, [
      '-D', pgdataDir,
      '--auth-local=trust',
      '--no-locale',
      '-E', 'UTF8',
      '-U', 'postgres',
    ], { env, stdio: 'pipe', windowsHide: true })

    if (r.status !== 0) {
      const detail = r.error?.message
        || r.stderr?.toString()
        || r.stdout?.toString()
        || `status=${r.status} signal=${r.signal} (no captured output)`
      throw new Error(`[pg-process] initdb failed: ${detail}`)
    }

    // Append mixdog-specific postgresql.conf overrides.
    // default_transaction_isolation: native PG default is read committed.
    // Native PG does not default to serializable; set isolation level explicitly
    // so behaviour is unambiguous across PG major versions.
    const confPath   = join(pgdataDir, 'postgresql.conf')
    const confAppend = [
      '',
      '# mixdog overrides — appended by pg-process.mjs',
      "default_transaction_isolation = 'read committed'",
      "listen_addresses = '127.0.0.1'",
      'log_min_messages = warning',
      'log_line_prefix = \'%t [%p]: \'',
      '',
      '# Defender/AV latency mitigations',
      'synchronous_commit = off',          // defers fsync ack; trade-off: crash → latest async commits since last WAL flush may be lost; acceptable for local memory store
      'checkpoint_timeout = 15min',        // halves checkpoint frequency vs 5min default; fewer sync storms
      'max_wal_size = 2GB',                // suppresses forced checkpoints driven by WAL volume
      'wal_compression = on',              // smaller WAL segments; fewer bytes for Defender to scan per segment
      'wal_init_zero = off',               // skips zero-fill on new WAL segment; cuts Defender contact at segment creation
      'wal_recycle = off',                 // disables WAL rename/recycle loop; eliminates rename-storm EPERM pattern in pgdata
    ].join('\n') + '\n' + buildV2Block()

    try {
      const existing = readFileSync(confPath, 'utf8')
      writeFileSync(confPath, existing + confAppend)
    } catch (e) {
      __mixdogMemoryLog(`[pg-process] postgresql.conf append failed: ${e?.message}\n`)
    }

    if (process.platform === 'win32') {
      __mixdogMemoryLog(
        `[pg-process] Windows tip: if startup feels slow, add the data folder to Defender exclusions.\n` +
        `  Folder: ${pgdataDir}\n` +
        `  PowerShell (run as admin): Add-MpPreference -ExclusionPath '${pgdataDir}'\n`
      )
    }
  }

  // Choose a free port (guards against stale postmaster from prior crash).
  const port    = await findFreePort(preferredPort)
  const logFile = logPath ?? join(pgdataDir, 'pg.log')

  __mixdogMemoryLog(`[pg-process] pg_ctl start -D ${pgdataDir} -p ${port}\n`)

  const startArgs = [
    'start',
    '-D', pgdataDir,
    '-l', logFile,
    '-o', `-p ${port} -h 127.0.0.1`,
  ]

  // Poll-sleep is intentionally NOT unref'd: while startPg is awaiting readiness
  // it must keep the process alive even if the event loop would otherwise drain.
  // Read pid + port from postmaster.pid (line 1 = pid, line 4 = port). Returns
  // null unless the file exists, pid > 0, and its port matches ours.
  function readPostmaster() {
    try {
      const pidFile = join(pgdataDir, 'postmaster.pid')
      if (!existsSync(pidFile)) return null
      const lines  = readFileSync(pidFile, 'utf8').split('\n')
      const pid    = parseInt(lines[0], 10)
      const pmPort = parseInt(lines[3], 10)
      if (pid > 0 && pmPort === port) return { pid }
      return null
    } catch { return null }
  }

  // pg_isready can succeed a beat before postmaster.pid is fully written; give
  // it a brief window to appear (and confirm the port matches) before trusting.
  async function confirmPid() {
    for (let i = 0; i < 5; i++) {
      const pm = readPostmaster()
      if (pm) return pm.pid
      await delay(100)
    }
    return null
  }

  // Spawn pg_ctl asynchronously (no -w) and poll readiness ourselves. On
  // AV-throttled boxes pg_ctl can lag ~30s behind actual postmaster readiness,
  // so we return the instant pg_isready succeeds rather than waiting on pg_ctl.
  // Only the long-lived child handle is unref'd; poll timers stay ref'd.
  async function startAndWaitReady() {
    // NEVER set `detached` on win32: DETACHED_PROCESS makes the OS ignore
    // `windowsHide`, so pg_ctl + the postmaster it launches allocate a VISIBLE
    // console (see shared/spawn-flags.mjs). Detachment gave no real isolation
    // here anyway: `pg_ctl start` daemonizes the postmaster and exits at once,
    // so the postmaster is already reparented OUT of the Node process tree —
    // detached only isolated the short-lived pg_ctl. Shutdown/reuse target
    // pgdata/postmaster.pid (pg_ctl stop -D, tryReusePgInstance), not a
    // Node-tree taskkill, so `windowsHide` alone is correct on all platforms.
    const child = spawn(pgctl, startArgs, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    child.unref?.()
    let stdout = '', stderr = '', closed = false, exitCode = null
    child.stdout?.on('data', d => { stdout += d.toString() })
    child.stderr?.on('data', d => { stderr += d.toString() })
    child.stdout?.unref?.(); child.stderr?.unref?.()
    child.on('error', err => { closed = true; exitCode = -1; stderr += (err?.message || String(err)) })
    // Use 'close' (stdio flushed), not 'exit', so captured stderr is complete
    // and the "another server might be running" match below never truncates.
    child.on('close', code => { closed = true; exitCode = code })

    const deadline = Date.now() + 30_000
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (pgIsReady(runtimeDir, env, port)) {
        const pid = await confirmPid()
        // pid confirmed with matching port → ready. Otherwise keep polling until
        // the cap (postmaster.pid not yet written or port mismatch).
        if (pid != null) return { ready: true, pid }
      }
      // pg_ctl exited nonzero before PG became reachable — real startup failure.
      if (closed && exitCode !== 0) return { ready: false, exited: true, stdout, stderr }
      if (Date.now() >= deadline) return { ready: false, timeout: true, stdout, stderr }
      await delay(250)
    }
  }

  const r = await startAndWaitReady()
  if (r.ready) return { pid: r.pid, port }

  const errText = r.stderr || r.stdout || ''
  // A cross-process race can still land after the pre-check. Re-probe and
  // attach if that winner becomes ready; never immediate-stop an unknown live
  // postmaster, because synchronous_commit=off makes a crash-stop lossy.
  if (r.exited && errText.includes('another server might be running')) {
    __mixdogMemoryLog(`[pg-process] pg_ctl start: "another server might be running" — probing status\n`)
    const statusR = spawnSync(pgctl, ['status', '-D', pgdataDir], { env, stdio: 'pipe', timeout: 3_000, windowsHide: true })
    __mixdogMemoryLog(`[pg-process] pg_ctl status: ${statusR.stdout?.toString() || statusR.stderr?.toString() || 'no output'}\n`)
    const existing = await awaitExistingPostmaster({
      runtimeDir, pgdataDir, env, waitMs: existingWaitMs,
    })
    if (existing.state === 'ready') {
      __mixdogMemoryLog(`[pg-process] attaching to race winner pid=${existing.pid} port=${existing.port}\n`)
      return { pid: existing.pid, port: existing.port, attached: true }
    }
  }

  const detail = errText || (r.timeout ? '(readiness probe timed out after 30s; no pg_ctl output)' : '(no captured output)')
  throw new Error(`[pg-process] pg_ctl start failed: ${detail}`)
}

// ---------------------------------------------------------------------------
// stopPg
// ---------------------------------------------------------------------------

export async function stopPg({ runtimeDir, pgdataDir }) {
  const pgctl = pgBin(runtimeDir, 'pg_ctl')
  const env   = libEnv(runtimeDir)

  const r = spawnSync(pgctl, ['stop', '-m', 'fast', '-w', '-D', pgdataDir], {
    env,
    stdio: 'pipe',
    timeout: 15_000,
    windowsHide: true,
  })

  if (r.status !== 0) {
    const msg = r.stderr?.toString() || r.stdout?.toString() || ''
    // Stale postmaster.pid — PG is already down; clean up and continue.
    if (
      msg.includes('no server running') ||
      msg.includes('PID file') ||
      msg.includes('not running')
    ) {
      __mixdogMemoryLog(`[pg-process] stopPg: already stopped (${msg.slice(0, 80)})\n`)
      try { rmSync(join(pgdataDir, 'postmaster.pid'), { force: true }) } catch {}
    } else {
      __mixdogMemoryLog(`[pg-process] pg_ctl stop warning: ${msg}\n`)
    }
  }
}

// Synchronous best-effort variant for a process 'exit' hook (only sync work is
// possible there). One bounded `pg_ctl stop -m fast`; never throws. On Windows
// a force-kill of the daemon can orphan the postmaster mid-write, so this is
// the last-ditch graceful attempt before the process goes away.
export function stopPgSync({ runtimeDir, pgdataDir }) {
  try {
    spawnSync(pgBin(runtimeDir, 'pg_ctl'), ['stop', '-m', 'fast', '-D', pgdataDir], {
      env: libEnv(runtimeDir), stdio: 'ignore', timeout: 8_000, windowsHide: true,
    })
    __mixdogMemoryLog('[pg-process] stopPgSync: pg_ctl stop -m fast issued on exit\n')
  } catch {}
}

// ---------------------------------------------------------------------------
// healthcheckPg
// ---------------------------------------------------------------------------

export async function healthcheckPg({ port, host = '127.0.0.1' }) {
  // Phase 1: TCP listen check (fast, no PG client dependency).
  const tcpOk = await new Promise(resolve => {
    const sock = createConnection({ host, port })
    sock.setTimeout(1000)
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error',   () => { sock.destroy(); resolve(false) })
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
  })
  if (!tcpOk) return false

  // Phase 2: SELECT 1 via a transient pg client.
  let client
  try {
    const { default: pg } = await import('pg')
    client = new pg.Client({
      host, port, user: 'postgres', database: 'postgres', password: '',
      connectionTimeoutMillis: 2000,
    })
    // A socket can terminate after SELECT 1 resolves but before client.end()
    // finishes. Raw pg.Client instances have no pool-level error listener, so
    // keep this transient health probe from turning that narrow race into an
    // uncaught EventEmitter error.
    client.on('error', () => {})
    await client.connect()
    await client.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    if (client) {
      try { await client.end() } catch {}
    }
  }
}
