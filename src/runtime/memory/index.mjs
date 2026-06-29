#!/usr/bin/env bun
const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

process.removeAllListeners('warning')
process.on('warning', () => {})

import http from 'node:http'
import crypto from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function readPluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).version || '0.0.1'
  } catch { return '0.0.1' }
}
const PLUGIN_VERSION = readPluginVersion()
const PROMOTION_FINGERPRINT_ROOTS = ['src/memory']
function collectPromotionFingerprintFiles() {
  const out = []
  const walk = (relDir) => {
    let entries = []
    try { entries = fs.readdirSync(path.join(PLUGIN_ROOT, relDir), { withFileTypes: true }) }
    catch { return }
    for (const ent of entries) {
      const rel = `${relDir}/${ent.name}`.replace(/\\/g, '/')
      if (ent.isDirectory()) {
        walk(rel)
      } else if (ent.isFile() && rel.endsWith('.mjs')) {
        out.push(rel)
      }
    }
  }
  for (const root of PROMOTION_FINGERPRINT_ROOTS) walk(root)
  return out.sort()
}
function readPromotionCodeFingerprint() {
  const hash = crypto.createHash('sha256')
  const files = collectPromotionFingerprintFiles()
  for (const rel of files) {
    hash.update(rel)
    hash.update('\0')
    try {
      hash.update(fs.readFileSync(path.join(PLUGIN_ROOT, rel)))
    } catch {
      hash.update('missing')
    }
    hash.update('\0')
  }
  return `src/memory:${files.length}:${hash.digest('hex').slice(0, 16)}`
}
const BOOT_PROMOTION_CODE_FINGERPRINT = readPromotionCodeFingerprint()

try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
try {
  const { env } = await import('@huggingface/transformers')
  env.backends.onnx.wasm.numThreads = 1
} catch {}

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { TOOL_DEFS } from './tool-defs.mjs'

import {
  openDatabase,
  closeDatabase,
  isBootstrapComplete,
  getMetaValue,
  setMetaValue,
  mergeMetaValue,
  cleanMemoryText,
} from './lib/memory.mjs'
import {
  normalizeIngestRole,
  firstTextContent,
  stableSessionSourceRef,
  sessionMessageContent,
  createIngestTurnAllocator,
} from './lib/session-ingest.mjs'
import { configureEmbedding, embedText, embedTexts, getEmbeddingDims, getEmbeddingDtype, getEmbeddingModelId, getKnownDimsForCurrentModel, isEmbeddingModelReady, primeEmbeddingDims, warmupEmbeddingProvider } from './lib/embedding-provider.mjs'
import { startLlmWorker, stopLlmWorker } from './lib/llm-worker-host.mjs'
import { runCycle1, runCycle2, runCycle3, runUnifiedGate, parseInterval, syncRootEmbedding, applySimpleStatus, applyUpdate, applyMerge, CYCLE2_ACTIVE_TARGET_CAP } from './lib/memory-cycle.mjs'
import { loadConfig as loadAgentConfig } from '../agent/orchestrator/config.mjs'
import { initProviders } from '../agent/orchestrator/providers/registry.mjs'
import { makeAgentDispatch } from '../agent/orchestrator/agent-runtime/agent-dispatch.mjs'
import { getInFlightCycle1 } from './lib/memory-cycle1.mjs'
import { claimAndMarkScheduledCycle, makeCycleRequestSignature, resolveCoalesceMaxRetries, scheduleCoalescedCycleRetry } from './lib/memory-cycle-requests.mjs'
import { searchRelevantHybrid } from './lib/memory-recall-store.mjs'
import { fetchEntriesByIdsScoped } from './lib/memory-recall-id-patch.mjs'
import { retrieveEntries } from './lib/memory-retrievers.mjs'
import { pruneOldEntries } from './lib/memory-maintenance-store.mjs'
import { computeEntryScore } from './lib/memory-score.mjs'
import { runFullBackfill } from './lib/memory-ops-policy.mjs'
import { listCore, addCore, editCore, deleteCore, compactCoreIds, CORE_SUMMARY_MAX } from './lib/core-memory-store.mjs'
import { resolveProjectId, resolveProjectScope } from './lib/project-id-resolver.mjs'
import { openTraceDatabase, closeTraceDatabase, insertTraceEvents, enqueueTraceEvents, insertAgentCalls, registerTraceExitDrain } from './lib/trace-store.mjs'
import { updateJsonAtomicSync, writeJsonAtomicSync } from '../shared/atomic-file.mjs'
import { resolvePluginData } from '../shared/plugin-paths.mjs'
const IS_MEMORY_ENTRY = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
const USE_ARG_DATA_DIR = IS_MEMORY_ENTRY || process.env.MIXDOG_WORKER_MODE === '1'
const DATA_DIR = process.env.MIXDOG_DATA_DIR || (USE_ARG_DATA_DIR ? process.argv[2] : '') || resolvePluginData()
if (!DATA_DIR) {
  __mixdogMemoryLog('[memory-service] memory data dir not set and no explicit data dir provided\n')
  process.exit(1)
}
__mixdogMemoryLog(`[memory-service] DATA_DIR=${DATA_DIR}\n`)

import { execFileSync } from 'child_process'

const RUNTIME_ROOT = process.env.MIXDOG_RUNTIME_ROOT
  ? path.resolve(process.env.MIXDOG_RUNTIME_ROOT)
  : path.join(os.tmpdir(), 'mixdog')

let _periodicAdvertiseInstalled = false
let _periodicAdvertiseTimer = null
// Track the most recently advertised port so the periodic tick re-reads it
// every interval. Without this the setInterval closure binds the FIRST port
// (the upstream we proxied to) and keeps re-advertising the dead upstream
// port after fork-proxy promotion swaps in our own locally-bound port.
let _currentAdvertisedPort = null

function parsePositivePid(value) {
  const pid = Number(value)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

const MEMORY_SERVER_PID = parsePositivePid(process.env.MIXDOG_SERVER_PID) ?? process.pid
const MEMORY_DAEMON_MODE = process.env.MIXDOG_MEMORY_DAEMON === '1'
const MEMORY_IDLE_TTL_MS = Math.max(0, Number(process.env.MIXDOG_MEMORY_IDLE_TTL_MS) || 10 * 60_000)
let _idleShutdownTimer = null

function touchDaemonIdleTimer(reason = 'activity') {
  if (!MEMORY_DAEMON_MODE || MEMORY_IDLE_TTL_MS <= 0) return
  if (_idleShutdownTimer) {
    try { clearTimeout(_idleShutdownTimer) } catch {}
    _idleShutdownTimer = null
  }
  _idleShutdownTimer = setTimeout(() => {
    __mixdogMemoryLog(`[memory-service] daemon idle TTL elapsed after ${reason}; shutting down\n`)
    stop()
      .then(() => process.exit(0))
      .catch((e) => {
        __mixdogMemoryLog(`[memory-service] daemon idle shutdown failed: ${e?.message || e}\n`)
        process.exit(1)
      })
  }, MEMORY_IDLE_TTL_MS)
  _idleShutdownTimer.unref?.()
}

function advertiseMemoryPort(boundPort, attempt = 0) {
  if (!Number.isFinite(boundPort) || boundPort <= 0) return
  _currentAdvertisedPort = boundPort
  const dir = RUNTIME_ROOT
  const file = path.join(dir, 'active-instance.json')
  try {
    fs.mkdirSync(dir, { recursive: true })
    updateJsonAtomicSync(file, (curRaw) => {
      const cur = curRaw ?? {}
      const curMemPort = Number(cur?.memory_port)
      const curMemPid = parsePositivePid(cur?.memory_server_pid)
      const portConflict = Number.isFinite(curMemPort) && curMemPort > 0 && curMemPort !== boundPort
      const otherOwnerAlive =
        curMemPid != null &&
        curMemPid !== MEMORY_SERVER_PID &&
        _isPidAliveLocal(curMemPid)
      if (portConflict && otherOwnerAlive) {
        __mixdogMemoryLog(`[memory-service] skip memory_port advertise port=${boundPort} curMemPort=${curMemPort} curMemPid=${curMemPid} memoryServerPid=${MEMORY_SERVER_PID}\n`)
        return undefined
      }
      const next = {
        ...cur,
        memory_port: boundPort,
        ...(MEMORY_SERVER_PID ? { memory_server_pid: MEMORY_SERVER_PID } : {}),
        updatedAt: Date.now(),
      }
      return next
    }, { compact: true, fsyncDir: true })
    if (!_periodicAdvertiseInstalled) {
      _periodicAdvertiseInstalled = true
      _periodicAdvertiseTimer = setInterval(() => {
        try {
          if (_currentAdvertisedPort != null) {
            advertiseMemoryPort(_currentAdvertisedPort)
          }
        } catch {}
      }, 30_000)
      _periodicAdvertiseTimer.unref?.()
    }
  } catch (e) {
    const transient = e?.code === 'EPERM' || e?.code === 'EBUSY' || e?.code === 'EACCES'
    if (transient && attempt < 3) {
      const retryTimer = setTimeout(() => advertiseMemoryPort(boundPort, attempt + 1), 50 * (attempt + 1))
      retryTimer.unref?.()
      return
    }
    __mixdogMemoryLog(`[memory-service] active-instance memory_port advertise failed: ${e?.message || e}\n`)
  }
}

const LOCK_FILE = path.join(DATA_DIR, '.memory-service.lock')
// Owner-election lock. Separate from LOCK_FILE so single-instance mode keeps
// its kill-the-previous protocol while multi-instance fork-proxy workers use
// atomic CAS for takeover. Created via fs.openSync(path,'wx') — node guarantees
// EEXIST when another process won the race.
const OWNER_LOCK_FILE = path.join(DATA_DIR, '.memory-owner.lock')

function _isPidAliveLocal(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch (e) { return e.code !== 'ESRCH' }
}

function tryAcquireMemoryOwnerLock() {
  // Returns true on success (this process now owns memory worker for the data
  // dir), false when a live peer holds the lock. Stale locks (dead PID) are
  // unlinked and retried atomically. Throws on unexpected fs errors so callers
  // surface lock-system corruption rather than silently downgrading.
  //
  // EPERM/EBUSY/EACCES at openSync are transient — AV scanners (SignKorea /
  // SKCert / ezPDFWS etc) briefly lock newly-created files during inspection.
  // The 0.1.x baseline threw immediately and the worker promoted to
  // permanentlyDegraded, killing memory tools for the rest of the session.
  // Treat the AV error codes as retryable with bounded backoff (~750ms total)
  // before giving up and rethrowing.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = fs.openSync(OWNER_LOCK_FILE, 'wx')
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      return true
    } catch (e) {
      if (e.code === 'EEXIST') {
        let ownerPid = NaN
        try { ownerPid = Number(fs.readFileSync(OWNER_LOCK_FILE, 'utf8').trim()) } catch {}
        if (_isPidAliveLocal(ownerPid)) return false
        // Stale lock: dead owner — unlink and retry exclusive create.
        try { fs.unlinkSync(OWNER_LOCK_FILE) } catch {}
        continue
      }
      const transient = e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES'
      if (transient && attempt < 4) {
        // Sync busy-wait acceptable here: this runs on memory worker boot
        // path, once per process; the parent handler is not blocked.
        const end = Date.now() + 50 * (attempt + 1)
        while (Date.now() < end) {}
        continue
      }
      throw e
    }
  }
  return false
}

function releaseMemoryOwnerLock() {
  try {
    const ownerPid = Number(fs.readFileSync(OWNER_LOCK_FILE, 'utf8').trim())
    if (ownerPid === process.pid) fs.unlinkSync(OWNER_LOCK_FILE)
  } catch {}
}

const BASE_PORT = 3350
const MAX_PORT = 3357

let _traceDb = null

const MEMORY_INSTRUCTIONS_TEXT = ''

function killPreviousServer(pid) {
  if (pid <= 0 || pid === process.pid) return false
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      __mixdogMemoryLog(`[memory-service] Killed previous server PID ${pid}\n`)
      return true
    } catch (e) {
      // Exit code 128 = process not found; treat stale lock as already-dead = success.
      // Status 128 reliably means "process not found" regardless of locale; no text match needed.
      // Status 1 with English text match handles edge cases on some Windows versions.
      const notFoundText = /not found|no running instance/i.test(e.stdout || '')
        || /not found|no running instance/i.test(e.stderr || '')
        || /not found|no running instance/i.test(e.message || '')
      const alreadyDead = e.status === 128 || (e.status === 1 && notFoundText)
      if (alreadyDead) {
        __mixdogMemoryLog(`[memory-service] PID ${pid} already dead (stale lock), proceeding\n`)
        return true
      }
      __mixdogMemoryLog(`[memory-service] taskkill failed for PID ${pid}: ${e.message}\n`)
      return false
    }
  } else {
    // Pre-flight: if the process is already gone, treat stale lock as success.
    try {
      process.kill(pid, 0)
    } catch (e) {
      if (e.code === 'ESRCH') {
        __mixdogMemoryLog(`[memory-service] PID ${pid} already dead (stale lock), proceeding\n`)
        return true
      }
    }
    try { process.kill(pid, 'SIGTERM') } catch {}
    try { process.kill(pid, 'SIGKILL') } catch {}
    // Poll for death up to 2s
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
      } catch (e) {
        if (e.code === 'ESRCH') {
          __mixdogMemoryLog(`[memory-service] Killed previous server PID ${pid}\n`)
          return true
        }
      }
      // Synchronous 50ms sleep via shared buffer spin
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
    __mixdogMemoryLog(`[memory-service] PID ${pid} still alive after SIGKILL\n`)
    return false
  }
}

function acquireLock() {
  // Multi-instance guard. In multi-terminal mode the lock owner is a *peer*
  // memory worker serving recall for another CC session. killPreviousServer
  // would taskkill /F that healthy peer mid-flight, then this fork-proxy
  // mode wouldn't even need a lock anyway. Skip the entire kill-the-previous
  // protocol; fork-proxy detection in init() takes priority. If neither
  // proxy nor lock-owner path applies (race window during simultaneous
  // boot), the worker simply continues without the lock — server-main /
  // PG / port-listen handle the actual conflict cases.
  if (process.env.MIXDOG_MULTI_INSTANCE === '1') return
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockedPid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim())
      if (lockedPid > 0 && lockedPid !== process.pid) {
        const killed = killPreviousServer(lockedPid)
        if (!killed) {
          __mixdogMemoryLog(`[memory-service] Could not kill previous server PID ${lockedPid}, aborting\n`)
          process.exit(1)
        }
        try { fs.unlinkSync(LOCK_FILE) } catch {}
      }
    }
    const fd = fs.openSync(LOCK_FILE, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    try {
      fs.writeSync(fd, String(process.pid))
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    if (e.code === 'EEXIST') {
      __mixdogMemoryLog(`[memory-service] Lock file exists (EEXIST) — another instance is already running, exiting\n`)
      process.exit(0)
    }
    __mixdogMemoryLog(`[memory-service] Lock acquisition failed: ${e.message}\n`)
    process.exit(1)
  }
}

function releaseLock() {
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim()
    if (Number(content) === process.pid) fs.unlinkSync(LOCK_FILE)
  } catch {}
}

import { readSection } from '../shared/config.mjs'

function readMainConfig() {
  return readSection('memory')
}

let db = null
let mainConfig = null
let _cycleInterval = null
let _startupTimeout = null
// Outer-layer cycle1 in-flight tracker (MCP-server scope).
//
// The AUTHORITATIVE guard lives in memory-cycle.mjs:runCycle1 itself — that
// one catches every caller, including direct imports (setup-server backfill,
// policy-layer backfill). This outer tracker is kept as a defense-in-depth
// layer local to the MCP server process: it coalesces simultaneous
// _awaitCycle1Run callers (MCP action, scheduler, flush) onto a shared
// promise so they all observe the SAME result object rather than some
// getting the real stats and others getting `skippedInFlight: true` from
// the inner guard.
let _cycle1InFlight = null // shared cycle1 promise (outer coalesce layer)
let _initialized = false
let _initPromise = null
let _stopPromise = null
let _bootTimestamp = null
let _transcriptOffsets = new Map()
/** @type {Map<string, Promise<unknown>>} */
const _ingestTranscriptTails = new Map()
let _transcriptOffsetsPersistTail = Promise.resolve()
// Boot-edge background warmup. ONNX session creation on the embedding worker
// thread is CPU-heavy, so it must not overlap the worker's own init (DB open,
// schema, cycle wiring). Previously this was gated behind a fixed setTimeout —
// a wall-clock guess at "boot settled". Now the warmup is queued during
// _initStore and fired at the _initRuntime completion edge (see _initRuntime),
// so it starts the instant boot's CPU-heavy work is done — no magic-number
// delay. MIXDOG_EMBED_WARMUP=0 disables it (model loads lazily on first use).
let _pendingEmbeddingWarmup = null
let _embeddingColdRecallLogAt = 0

const TRANSCRIPT_OFFSETS_KEY = 'state.transcript_offsets'
const CYCLE_LAST_RUN_KEY = 'state.cycle_last_run'

function embeddingWarmupEnabled() {
  const raw = String(process.env.MIXDOG_EMBED_WARMUP ?? '1').trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no')
}

function envFlagEnabled(name) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes'
}

function memorySecondaryMode() {
  return envFlagEnabled('MIXDOG_MEMORY_SECONDARY')
}

function embeddingWarmupCanStart() {
  return embeddingWarmupEnabled() && !memorySecondaryMode()
}

function memoryLlmWorkerEnabled() {
  return !memorySecondaryMode() && !envFlagEnabled('MIXDOG_MEMORY_DISABLE_LLM_WORKER')
}

function memoryCyclesEnabled() {
  return !memorySecondaryMode() && !envFlagEnabled('MIXDOG_MEMORY_DISABLE_CYCLES')
}

function secondaryPgAdvertised() {
  if (!memorySecondaryMode()) return true
  const runtimeRoot = process.env.MIXDOG_RUNTIME_ROOT
    ? path.resolve(process.env.MIXDOG_RUNTIME_ROOT)
    : path.join(os.tmpdir(), 'mixdog')
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'active-instance.json'), 'utf8'))
    const port = Number(cur?.pg_port)
    const pgdata = cur?.pg_pgdata ? path.resolve(String(cur.pg_pgdata)) : ''
    return Number.isInteger(port) && port > 0 && pgdata === path.resolve(path.join(DATA_DIR, 'pgdata'))
  } catch {
    return false
  }
}

function assertSecondaryPgAttachable() {
  if (!secondaryPgAdvertised()) {
    throw new Error('memory-service: secondary mode requires an existing primary PG instance')
  }
}

function scheduleBackgroundEmbeddingWarmup(metaPath, metaKey) {
  if (!embeddingWarmupCanStart()) return
  // Queue the warmup; _initRuntime fires it once boot completes.
  _pendingEmbeddingWarmup = () => {
    warmupEmbeddingProvider()
      .then(() => {
        const measured = Number(getEmbeddingDims())
        try {
          writeJsonAtomicSync(metaPath, { ...metaKey, dims: measured }, { lock: true })
        } catch (e) {
          __mixdogMemoryLog(`[memory-service] could not persist embedding-meta: ${e?.message || e}\n`)
        }
      })
      .catch(err => {
        __mixdogMemoryLog(`[memory-service] background warmup failed: ${err?.message || err}\n`)
      })
  }
}

function fireDeferredEmbeddingWarmup() {
  const fire = _pendingEmbeddingWarmup
  if (!fire) return
  _pendingEmbeddingWarmup = null
  fire()
}

async function _initStore() {
  mainConfig = readMainConfig()
  const embeddingConfig = mainConfig?.embedding
  if (embeddingConfig?.provider || embeddingConfig?.ollamaModel || embeddingConfig?.dtype) {
    configureEmbedding({
      provider: embeddingConfig.provider,
      ollamaModel: embeddingConfig.ollamaModel,
      dtype: embeddingConfig.dtype,
    })
  }

  // Persist embedding dims so warmup is off the boot critical path.
  // On a cache hit (provider+model+dtype match) open the DB immediately,
  // prime the known dimensions, then run the model warmup later in the
  // background. If cycle1/recall needs embeddings first, that on-demand
  // call owns the same worker queue and the delayed warmup becomes a no-op.
  const EMBEDDING_META_PATH = path.join(DATA_DIR, 'embedding-meta.json')
  const metaKey = {
    provider: embeddingConfig?.provider ?? null,
    model: getEmbeddingModelId(),
    dtype: getEmbeddingDtype(),
  }
  let dimsResolved = null
  try {
    const saved = JSON.parse(fs.readFileSync(EMBEDDING_META_PATH, 'utf8'))
    if (saved.provider === metaKey.provider && saved.model === metaKey.model && saved.dtype === metaKey.dtype) {
      dimsResolved = Number(saved.dims)
    }
  } catch { /* miss or missing — fall through */ }

  // Registry fallback: model with statically known dims bypasses measurement.
  // Delayed background warmup invariant-checks measured vs registry value;
  // mismatch throws and crashes the worker for fail-fast parity with the cold
  // path's boot-time degraded signal.
  if (dimsResolved == null) {
    const known = getKnownDimsForCurrentModel()
    if (known != null) dimsResolved = known
  }

  if (dimsResolved) {
    primeEmbeddingDims(dimsResolved)
    assertSecondaryPgAttachable()
    db = await openDatabase(DATA_DIR, dimsResolved)
    scheduleBackgroundEmbeddingWarmup(EMBEDDING_META_PATH, metaKey)
  } else {
    if (!embeddingWarmupCanStart()) {
      throw new Error('memory-service: embedding dims unavailable while warmup is disabled')
    }
    // Cold path: meta missed AND model not registered. Sequential.
    await warmupEmbeddingProvider()
    dimsResolved = Number(getEmbeddingDims())
    assertSecondaryPgAttachable()
    db = await openDatabase(DATA_DIR, dimsResolved)
    try {
      writeJsonAtomicSync(EMBEDDING_META_PATH, { ...metaKey, dims: dimsResolved }, { lock: true })
    } catch (e) {
      __mixdogMemoryLog(`[memory-service] could not persist embedding-meta: ${e?.message || e}\n`)
    }
  }

  if (!await isBootstrapComplete(db)) {
    throw new Error('memory-service: bootstrap not complete after openDatabase')
  }
  if (memoryLlmWorkerEnabled()) {
    startLlmWorker()
  } else {
    __mixdogMemoryLog('[memory-service] secondary mode; skipping llm worker\n')
  }
  // Initialize the in-process provider registry so cycle1 can run the agent dispatch
  // LLM locally (makeAgentDispatch → session manager → provider.send). In
  // standalone the memory worker runs as a detached HTTP daemon whose parent
  // has disconnected IPC, so the legacy callAgentDispatch() IPC path is dead on
  // arrival. Mirror the channels worker boot (channels/index.mjs:
  // loadAgentConfig() + initProviders) so the registry is populated before any
  // cycle1 dispatch. The gate MUST match _startCycle1Run's makeAgentDispatch
  // injection condition: cycle1 may dispatch in-process whenever cycles are
  // enabled OR the llm worker is enabled (both exclude secondary mode), so
  // registering only under the llm-worker gate would leave a hole where
  // MIXDOG_MEMORY_DISABLE_LLM_WORKER=1 + cycles enabled hits an empty registry
  // and fails with "Provider not found". Non-fatal: a failure here is logged
  // and cycle1's own callLlm surfaces the unresolved-provider error per call.
  if (memoryCyclesEnabled() || memoryLlmWorkerEnabled()) {
    try {
      const agentCfg = loadAgentConfig()
      await initProviders(agentCfg.providers || {})
    } catch (e) {
      process.stderr.write(`[memory-service] initProviders failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
  _bootTimestamp = Date.now()
  await loadTranscriptOffsets()
}

async function loadTranscriptOffsets() {
  try {
    const raw = await getMetaValue(db, TRANSCRIPT_OFFSETS_KEY, '{}')
    const obj = JSON.parse(raw)
    _transcriptOffsets = new Map(Object.entries(obj))
  } catch {
    _transcriptOffsets = new Map()
  }
}

async function persistTranscriptOffsets() {
  const run = _transcriptOffsetsPersistTail.catch(() => {}).then(async () => {
    try {
      const obj = Object.fromEntries(_transcriptOffsets)
      await setMetaValue(db, TRANSCRIPT_OFFSETS_KEY, JSON.stringify(obj))
    } catch (e) {
      __mixdogMemoryLog(`[memory] persist transcript offsets failed: ${e.message}\n`)
    }
  })
  _transcriptOffsetsPersistTail = run.catch(() => {})
  return run
}

async function getCycleLastRun() {
  try {
    const raw = await getMetaValue(db, CYCLE_LAST_RUN_KEY, '{}')
    const obj = JSON.parse(raw)
    return {
      cycle1: Number(obj.cycle1) || 0,
      cycle2: Number(obj.cycle2) || 0,
      cycle3: Number(obj.cycle3) || 0,
      // Phase B §2.4 auto-restart book-keeping — last time an overdue cycle1
      // triggered an unscheduled run, rate-limited separately from the
      // normal cycle timestamp so a long chain of failures cannot tight-loop.
      cycle1_autoRestart: Number(obj.cycle1_autoRestart) || 0,
      // #13/#14: heartbeat (every attempt, success or skip) and the auto-
      // restart attempt timestamp (committed BEFORE the call) are tracked
      // separately from the success timestamps above so a long string of
      // failed/skipped runs cannot disguise itself as a healthy keeper.
      cycle1_heartbeat: Number(obj.cycle1_heartbeat) || 0,
      cycle1_autoRestart_attempt: Number(obj.cycle1_autoRestart_attempt) || 0,
      // Last cycle2 failure message; cleared to '' on success.
      cycle2_last_error: typeof obj.cycle2_last_error === 'string' ? obj.cycle2_last_error : '',
    }
  } catch {
    return {
      cycle1: 0, cycle2: 0, cycle3: 0, cycle1_autoRestart: 0,
      cycle1_heartbeat: 0, cycle1_autoRestart_attempt: 0,
      cycle2_last_error: '',
    }
  }
}

async function setCycleLastRun(kind, ts) {
  await mergeMetaValue(db, CYCLE_LAST_RUN_KEY, { [kind]: ts })
}

// Raw-row priority lookup for narrow-window queries. Raw rows (is_root=0,
// chunk_root IS NULL) are inserted immediately by ingestTranscriptFile before
// cycle1 runs, so they always carry the freshest turns in the DB.
async function readRawRowsInWindow(db, tsFromMs, tsToMs, hardLimit = 10, { projectScope } = {}) {
  try {
    let sql, params
    if (projectScope === 'common') {
      sql = `SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
              element, category, summary, status, score, last_seen_at, project_id
       FROM entries
       WHERE chunk_root IS NULL AND is_root = 0
         AND ts >= $1 AND ts <= $2
         AND project_id IS NULL
       ORDER BY ts DESC
       LIMIT $3`
      params = [tsFromMs ?? 0, tsToMs ?? Date.now(), hardLimit]
    } else if (projectScope && projectScope !== 'all') {
      sql = `SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
              element, category, summary, status, score, last_seen_at, project_id
       FROM entries
       WHERE chunk_root IS NULL AND is_root = 0
         AND ts >= $1 AND ts <= $2
         AND (project_id IS NULL OR project_id = $3)
       ORDER BY ts DESC
       LIMIT $4`
      params = [tsFromMs ?? 0, tsToMs ?? Date.now(), projectScope, hardLimit]
    } else {
      sql = `SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
              element, category, summary, status, score, last_seen_at, project_id
       FROM entries
       WHERE chunk_root IS NULL AND is_root = 0
         AND ts >= $1 AND ts <= $2
       ORDER BY ts DESC
       LIMIT $3`
      params = [tsFromMs ?? 0, tsToMs ?? Date.now(), hardLimit]
    }
    const rows = (await db.query(sql, params)).rows
    return rows.map(r => ({ ...r, retrievalScore: 0, rrf: 0 }))
  } catch { return [] }
}

function sessionRecallTerms(query) {
  return [...new Set(String(query || '').toLowerCase().match(/[\p{L}\p{N}_./:-]{2,}/gu) || [])]
    .filter((term) => !CORE_RECALL_STOPWORDS.has(term))
    .slice(0, 12)
}

async function recallSessionRows(args = {}) {
  const sessionId = String(args.sessionId || args.session_id || '').trim()
  if (!sessionId) return { text: '(no current session)' }
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 20))
  const terms = sessionRecallTerms(args.query)
  const params = [sessionId]
  const where = ['session_id = $1']
  if (terms.length > 0) {
    const textExpr = `lower(coalesce(content, '') || ' ' || coalesce(element, '') || ' ' || coalesce(summary, ''))`
    const clauses = terms.map((term) => {
      params.push(`%${term}%`)
      return `${textExpr} LIKE $${params.length}`
    })
    where.push(`(${clauses.join(' OR ')})`)
  }
  params.push(limit)
  let rows = (await db.query(`
    SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
           element, category, summary, status, score, last_seen_at, project_id
    FROM entries
    WHERE ${where.join(' AND ')}
    ORDER BY ts DESC, id DESC
    LIMIT $${params.length}
  `, params)).rows
  if (rows.length < limit) {
    const seen = new Set(rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id)))
    const fillLimit = Math.max(0, limit - rows.length)
    const fillRows = fillLimit > 0
      ? (await db.query(`
          SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
                 element, category, summary, status, score, last_seen_at, project_id
          FROM entries
          WHERE session_id = $1
            AND id <> ALL($2::bigint[])
          ORDER BY ts DESC, id DESC
          LIMIT $3
        `, [sessionId, [...seen], fillLimit])).rows
      : []
    if (fillRows.length > 0) rows = [...rows, ...fillRows]
  }
  if (args.includeMembers === true) {
    const rootIds = rows
      .filter((row) => Number(row.is_root) === 1)
      .map((row) => Number(row.id))
      .filter((id) => Number.isFinite(id))
    if (rootIds.length > 0) {
      const members = (await db.query(`
        SELECT id, ts, role, content, session_id, source_turn, project_id, chunk_root
        FROM entries
        WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
        ORDER BY chunk_root ASC, COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
      `, [rootIds])).rows
      const byRoot = new Map(rootIds.map((id) => [id, []]))
      for (const member of members) {
        const root = Number(member.chunk_root)
        if (byRoot.has(root)) byRoot.get(root).push(member)
      }
      for (const row of rows) {
        const id = Number(row.id)
        if (byRoot.has(id)) row.members = byRoot.get(id)
      }
    }
  }
  return { text: renderEntryLines(rows) }
}

async function ingestSessionMessages(args = {}) {
  const sessionId = String(args.sessionId || args.session_id || `session-${Date.now()}`).trim()
  const messages = Array.isArray(args.messages) ? args.messages : []
  // Recall fast-track hydrates the current session before compaction; allow
  // callers to ingest the full in-memory transcript instead of silently
  // clipping long sessions at 500 turns. Default remains conservative.
  const limit = Math.max(1, Math.min(5000, Number(args.limit) || 200))
  const start = Math.max(0, messages.length - limit)
  const projectId = resolveProjectScope(typeof args.cwd === 'string' && args.cwd ? args.cwd : null)
  let considered = 0
  let inserted = 0
  // Monotonic ingest order, independent of the current (post-compaction)
  // array index. source_turn used to be `i+1`, but after compaction shrinks /
  // reindexes session.messages a NEWLY appended turn gets a LOW i and thus a
  // LOW source_turn — and since dump_session_roots / recall order by
  // source_turn first, it would sort BEFORE older pre-compaction rows. Seed a
  // running counter from the current max source_turn for this session so every
  // new row is assigned a turn strictly greater than all previously-ingested
  // ones (true continuation order). Re-ingested (ON CONFLICT) rows keep their
  // original turn and do not consume a new one.
  let prevMaxTurn = 0
  try {
    const maxRow = await db.query(
      `SELECT COALESCE(MAX(source_turn), 0) AS max_turn FROM entries WHERE session_id = $1`,
      [sessionId],
    )
    prevMaxTurn = Number(maxRow.rows?.[0]?.max_turn) || 0
  } catch { prevMaxTurn = 0 }
  const turnAllocator = createIngestTurnAllocator(prevMaxTurn)
  for (let i = start; i < messages.length; i += 1) {
    const m = messages[i]
    if (!m || typeof m !== 'object') continue
    const role = normalizeIngestRole(m.role)
    // Persist the whole session conversation by role: user/assistant carry the
    // dialogue, tool carries tool_results, system/developer carry steering
    // context. Previously only user/assistant were kept, silently dropping
    // recent tool/system/developer state that recall fast-track must surface.
    if (!role) continue
    const content = cleanMemoryText(sessionMessageContent(m))
    if (!content || !content.trim()) continue
    considered += 1
    const tsMs = parseTsToMs(m.ts ?? m.timestamp ?? (Date.now() - (messages.length - i)))
    // Stable per-message identity. The previous `session:${id}#${i+1}` key was
    // positional, so after compaction shrinks/reindexes session.messages a
    // later turn could reuse an old index and be silently skipped by
    // ON CONFLICT DO NOTHING. stableSessionSourceRef hashes only durable
    // fields (role, original ts if present, tool ids, content) — never the
    // synthesized tsMs fallback or the loop index.
    const sourceRef = stableSessionSourceRef(sessionId, m, role, content)
    // Assign the next monotonic turn; only consume it when the row is actually
    // inserted (a conflicting re-ingest keeps its original source_turn).
    const assignedTurn = turnAllocator.peekNext()
    const result = await db.query(`
      INSERT INTO entries(ts, role, content, source_ref, session_id, source_turn, project_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT DO NOTHING
    `, [tsMs, role, content, sourceRef, sessionId, assignedTurn, projectId])
    const rowInserted = Number(result.rowCount ?? result.affectedRows ?? 0) || 0
    if (rowInserted > 0) {
      inserted += rowInserted
      turnAllocator.next()
    }
  }
  return { text: `ingest_session: considered=${considered} inserted=${inserted} session=${sessionId}` }
}

function runTranscriptIngestSerialized(transcriptPath, fn) {
  const key = path.resolve(transcriptPath)
  const prev = _ingestTranscriptTails.get(key) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  _ingestTranscriptTails.set(key, run.catch(() => {}))
  return run
}

function snapshotTranscriptOffset(transcriptPath) {
  const stored = _transcriptOffsets.get(transcriptPath)
  if (!stored) return { bytes: 0, lineIndex: 0 }
  return { bytes: Number(stored.bytes) || 0, lineIndex: Number(stored.lineIndex) || 0 }
}

async function ingestTranscriptFileImpl(transcriptPath, { cwd } = {}) {
  let stat
  try { stat = await fs.promises.stat(transcriptPath) } catch { return 0 }
  const sessionUuid = path.basename(transcriptPath, '.jsonl')
  const prev = snapshotTranscriptOffset(transcriptPath)
  if (stat.size < prev.bytes) {
    prev.bytes = 0
    prev.lineIndex = 0
  }
  if (stat.size <= prev.bytes) return 0

  const fh = await fs.promises.open(transcriptPath, 'r')
  const buf = Buffer.alloc(stat.size - prev.bytes)
  try {
    await fh.read(buf, 0, buf.length, prev.bytes)
  } finally {
    await fh.close()
  }
  const text = buf.toString('utf8')

  const resolvedCwd = typeof cwd === 'string' && cwd ? cwd : cwdFromTranscriptPath(transcriptPath)
  // No cwd resolved -> classify as COMMON (project_id NULL). Falling back to
  // process.cwd() would misclassify rows under the service/plugin cwd.
  const projectId = resolvedCwd ? resolveProjectId(resolvedCwd) : null

  let count = 0
  let index = prev.lineIndex
  // Track the byte boundary of the LAST line we fully consumed (parsed +
  // either inserted or intentionally skipped). On parse failure or
  // transient insert error we stop and leave the boundary untouched so the
  // next sweep retries from the same position. This prevents malformed
  // trailing JSONL (mid-write partial lines) and DB hiccups from being
  // silently consumed forever.
  let lastGoodBytes = prev.bytes
  let lastGoodLineIndex = prev.lineIndex
  let cursor = 0
  while (cursor < text.length) {
    const nl = text.indexOf('\n', cursor)
    // No trailing newline -> partial line still being written; stop here
    // without advancing so the rest is re-read once the writer flushes.
    if (nl === -1) break
    const rawLine = text.slice(cursor, nl)
    const consumedBytes = Buffer.byteLength(rawLine, 'utf8') + 1
    cursor = nl + 1
    const line = rawLine.replace(/\r$/, '')
    if (!line) {
      lastGoodBytes += consumedBytes
      continue
    }
    index += 1
    let parsed
    try { parsed = JSON.parse(line) } catch {
      // Malformed line: do not advance past it; retry on next sweep.
      index -= 1
      break
    }
    const role = parsed.message?.role
    if (role !== 'user' && role !== 'assistant') {
      lastGoodBytes += consumedBytes
      lastGoodLineIndex = index
      continue
    }
    const content = firstTextContent(parsed.message?.content)
    if (!content || !content.trim()) {
      lastGoodBytes += consumedBytes
      lastGoodLineIndex = index
      continue
    }
    const cleaned = cleanMemoryText(content)
    if (!cleaned) {
      lastGoodBytes += consumedBytes
      lastGoodLineIndex = index
      continue
    }
    const tsMs = parseTsToMs(parsed.timestamp ?? parsed.ts ?? Date.now())
    const sourceRef = `transcript:${sessionUuid}#${index}`
    try {
      const result = await db.query(
        `INSERT INTO entries(ts, role, content, source_ref, session_id, source_turn, project_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [tsMs, role, cleaned, sourceRef, sessionUuid, index, projectId]
      )
      if (Number(result.rowCount ?? result.affectedRows ?? 0) > 0) count += 1
      lastGoodBytes += consumedBytes
      lastGoodLineIndex = index
    } catch (e) {
      __mixdogMemoryLog(`[transcript-watch] insert error (${sourceRef}): ${e.message}\n`)
      // Transient insert failure: leave the boundary before this line so
      // the next sweep retries it. Roll back the line counter too.
      index -= 1
      break
    }
  }
  _transcriptOffsets.set(transcriptPath, {
    bytes: lastGoodBytes,
    lineIndex: lastGoodLineIndex,
  })
  await persistTranscriptOffsets()
  return count
}

async function ingestTranscriptFile(transcriptPath, options = {}) {
  return runTranscriptIngestSerialized(transcriptPath, () => ingestTranscriptFileImpl(transcriptPath, options))
}

function parseTsToMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : Date.now()
}

// Extract cwd from the transcript file's JSONL rows. Mixdog embeds
// the session cwd as a top-level `cwd` field on every message row, so
// scanning the first few lines is reliable on all platforms (Windows/Linux)
// without slug-decoding ambiguity. Returns undefined when no cwd is found
// or the extracted path does not exist on disk (falls back to COMMON).
function cwdFromTranscriptPath(fp) {
  let fd
  try {
    fd = fs.openSync(fp, 'r')
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 100 * 1024))
    fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    fd = undefined
    const lines = buf.toString('utf8').split('\n')
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        if (typeof obj.cwd === 'string' && obj.cwd) {
          const candidate = obj.cwd
          try { if (fs.statSync(candidate).isDirectory()) return candidate } catch {}
        }
      } catch {}
    }
  } catch {} finally {
    if (fd != null) { try { fs.closeSync(fd) } catch {} }
  }
  return undefined
}

function _initTranscriptWatcher() {
  const projectsRoot = path.join(os.homedir(), '.mixdog', 'projects')
  const SAFETY_POLL_MS = 5 * 60_000
  const DEBOUNCE_MS = 500
  const watchedFiles = new Map()
  const pendingByFile = new Map()
  const watchers = []
  const intervals = []
  const polledFiles = new Set()
  let safetySweepTimeout = null

  function isWatchable(relOrBase) {
    const base = path.basename(relOrBase)
    if (!base.endsWith('.jsonl') || base.startsWith('agent-')) return false
    if (relOrBase.includes('tmp') || relOrBase.includes('cache') || relOrBase.includes('plugins')) return false
    return true
  }

  async function ingestOne(fp) {
    try {
      if (!fs.existsSync(fp)) return
      const stat = fs.statSync(fp)
      const mtime = stat.mtimeMs
      const prev = watchedFiles.get(fp)
      if (prev && prev >= mtime) return
      const n = await ingestTranscriptFile(fp, { cwd: cwdFromTranscriptPath(fp) })
      // Only mark this mtime as 'consumed' once the persisted offset has
      // fully advanced past the observed file size. On a transient insert
      // error (or a malformed trailing line) ingestTranscriptFile leaves
      // the persisted offset before the failed line for retry; caching
      // the new mtime unconditionally would suppress the next sweep until
      // the file mutated again, losing the retry. Leave the cache
      // untouched on partial advance so the next sweep re-ingests.
      const off = _transcriptOffsets.get(fp)
      if (off && off.bytes >= stat.size) {
        watchedFiles.set(fp, mtime)
      }
      if (n > 0) {
        __mixdogMemoryLog(`[transcript-watch] ingested ${n} entries from ${path.basename(fp)}\n`)
      }
    } catch (e) {
      __mixdogMemoryLog(`[transcript-watch] ingest error: ${e.message}\n`)
    }
  }

  function scheduleIngest(fp) {
    const existing = pendingByFile.get(fp)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      pendingByFile.delete(fp)
      ingestOne(fp)
    }, DEBOUNCE_MS)
    pendingByFile.set(fp, timer)
  }

  async function discoverActiveTranscripts() {
    let topLevel
    try { topLevel = await fs.promises.readdir(projectsRoot) }
    catch { return [] }
    const files = []
    for (const d of topLevel) {
      if (d.includes('tmp') || d.includes('cache') || d.includes('plugins')) continue
      const full = path.join(projectsRoot, d)
      let inner
      try { inner = await fs.promises.readdir(full) } catch { continue }
      for (const f of inner) {
        if (!f.endsWith('.jsonl') || f.startsWith('agent-')) continue
        const fp = path.join(full, f)
        try {
          const stat = await fs.promises.stat(fp)
          files.push({ path: fp, mtime: stat.mtimeMs })
        } catch {}
      }
    }
    const cutoff = Date.now() - 30 * 60_000
    return files.filter(f => f.mtime > cutoff)
  }

  async function safetySweep() {
    try {
      const active = await discoverActiveTranscripts()
      for (const { path: fp } of active) ingestOne(fp)
    } catch (e) {
      __mixdogMemoryLog(`[transcript-watch] safety sweep error: ${e.message}\n`)
    }
  }

  safetySweepTimeout = setTimeout(safetySweep, 3_000)

  // fs.watch({recursive}) is only reliable on win32.
  // darwin: recursive option unreliable — use flat watch per-entry (glob dirs at start).
  // linux/WSL: recursive not supported — use fs.watchFile polling per file found via
  //   the safety sweep, or fall back entirely to safety sweep.
  if (process.platform === 'win32') {
    try {
      const watcher = fs.watch(projectsRoot, { recursive: true, persistent: true }, (_event, filename) => {
        if (!filename) return
        if (!isWatchable(filename)) return
        const fp = path.join(projectsRoot, filename)
        scheduleIngest(fp)
      })
      watcher.on('error', (err) => {
        __mixdogMemoryLog(`[transcript-watch] fs.watch error: ${err.message}\n`)
      })
      watchers.push(watcher)
      __mixdogMemoryLog(`[transcript-watch] fs.watch(recursive) active on ${projectsRoot}\n`)
    } catch (e) {
      __mixdogMemoryLog(`[transcript-watch] fs.watch setup failed: ${e.message} — relying on safety sweep only\n`)
    }
    intervals.push(setInterval(safetySweep, SAFETY_POLL_MS))
  } else if (process.platform === 'darwin') {
    // Flat watch: register a non-recursive watcher on each immediate subdirectory.
    // New subdirs are picked up on the next safety sweep cycle.
    try {
      const registerFlat = (dir) => {
        try {
          const w = fs.watch(dir, { persistent: true }, (_event, filename) => {
            if (!filename) return
            const fp = path.join(dir, filename)
            if (!isWatchable(fp)) return
            scheduleIngest(fp)
          })
          w.on('error', () => { /* ignore individual dir errors */ })
          watchers.push(w)
        } catch { /* dir may not exist yet */ }
      }
      registerFlat(projectsRoot)
      try {
        for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
          if (entry.isDirectory()) registerFlat(path.join(projectsRoot, entry.name))
        }
      } catch { /* best effort */ }
      __mixdogMemoryLog(`[transcript-watch] flat fs.watch active on ${projectsRoot} (darwin)\n`)
    } catch (e) {
      __mixdogMemoryLog(`[transcript-watch] flat watch setup failed: ${e.message} — relying on safety sweep only\n`)
    }
    intervals.push(setInterval(safetySweep, SAFETY_POLL_MS))
  } else {
    // linux/WSL: fs.watch recursive is unsupported. Use fs.watchFile polling for
    // individual files surfaced by the safety sweep, in addition to the sweep itself.
    __mixdogMemoryLog(`[transcript-watch] linux/WSL — using safety sweep + fs.watchFile polling (no recursive watch)\n`)
    // Wrap by reassigning the closure-captured reference is not possible here;
    // instead, register watchFile inside the safety sweep callback by intercepting
    // active file list after each sweep.  The interval already calls safetySweep
    // which calls ingestOne; watchFile additions happen as a side-effect of the sweep.
    const _patchedSweep = async () => {
      try {
        const active = await discoverActiveTranscripts()
        for (const { path: fp } of active) {
          if (!polledFiles.has(fp)) {
            polledFiles.add(fp)
            fs.watchFile(fp, { persistent: false, interval: 2000 }, () => {
              if (isWatchable(fp)) scheduleIngest(fp)
            })
          }
          ingestOne(fp)
        }
      } catch (e) {
        __mixdogMemoryLog(`[transcript-watch] linux sweep error: ${e.message}\n`)
      }
    }
    // Replace the safety sweep interval with the patched version.
    intervals.push(setInterval(_patchedSweep, SAFETY_POLL_MS))
  }

  return {
    stop() {
      if (safetySweepTimeout) { clearTimeout(safetySweepTimeout); safetySweepTimeout = null }
      for (const t of pendingByFile.values()) { try { clearTimeout(t) } catch {} }
      pendingByFile.clear()
      for (const i of intervals) { try { clearInterval(i) } catch {} }
      intervals.length = 0
      for (const w of watchers) { try { w.close() } catch {} }
      watchers.length = 0
      for (const fp of polledFiles) { try { fs.unwatchFile(fp) } catch {} }
      polledFiles.clear()
    },
  }
}

// Phase B §2.4 — cache-keeper health thresholds.
// warning fires when cycle1 is overdue past HEALTH_OVERDUE_MS; an auto-
// restart attempt fires when the warning has been emitted AND the most
// recent unscheduled restart was more than AUTO_RESTART_COOLDOWN_MS ago.
// Both default to 5 min per spec; caller overrides are not exposed yet.
const CYCLE1_HEALTH_OVERDUE_MS = 5 * 60_000
const CYCLE1_AUTO_RESTART_COOLDOWN_MS = 5 * 60_000

// In-process cycle1 LLM adapter. The memory daemon runs makeAgentDispatch()
// locally (provider registry is initialized in _initStore), so cycle1 never
// has to route over the dead IPC agent path (agent-ipc.mjs callAgentDispatch). The
// factory is built once (role/taskType are fixed) and the returned function
// is reshaped to cycle1's call signature: cycle1 invokes
// `callLlm({ role, taskType, mode, preset, timeout, cwd }, userMessage)` and
// expects a raw string, while makeAgentDispatch's function takes a single
// `{ prompt }` object. The adapter maps the two — preset/cwd resolution is
// handled inside makeAgentDispatch via role (cycle1-agent → maint.memory slot).
let _cycle1AgentDispatch = null
function getCycle1CallLlm() {
  if (!_cycle1AgentDispatch) {
    _cycle1AgentDispatch = makeAgentDispatch({
      role: 'cycle1-agent',
      taskType: 'maintenance',
      sourceType: 'memory-cycle',
      // cycle1 parses the full raw line-format response; the agent brief cap
      // (12KB) would truncate a large valid response and append prose, causing
      // partial parsing / omitted / invalid chunks. Opt out so the cycle1
      // no-truncation contract is preserved through makeAgentDispatch.
      brief: false,
    })
  }
  return async (opts = {}, userMessage) => {
    // Preserve cycle1's timeout contract: cycle1 derives `opts.timeout` from
    // config / caller deadline and expects it to bound the call. makeAgentDispatch
    // takes it as a per-call `idleTimeoutMs` (stale watchdog). Map it through;
    // omit when absent/0 so agent defaults apply.
    const callTimeout = Number(opts?.timeout)
    return _cycle1AgentDispatch({
      prompt: String(userMessage ?? ''),
      preset: opts?.preset || undefined,
      ...(Number.isFinite(callTimeout) && callTimeout > 0 ? { idleTimeoutMs: callTimeout } : {}),
    })
  }
}

async function recordCycle1Result(result) {
  const now = Date.now()
  await setCycleLastRun('cycle1_heartbeat', now)
  const skipped = result?.skippedInFlight === true
  const coalescedNoop = result?.coalescedRetryNoop === true
  const allFailed = !skipped
    && Number(result?.chunks ?? 0) === 0
    && Number(result?.processed ?? 0) === 0
    && Number(result?.skipped ?? 0) > 0
  if (!skipped && !coalescedNoop && !allFailed) {
    await setCycleLastRun('cycle1', now)
  }
}

function _startCycle1Run(config = {}, options = {}) {
  // Default to the in-process agent dispatch so every cycle1 path — scheduled,
  // auto-restart, periodic, manual (action:cycle1), backfill drain, rebuild —
  // dispatches locally and the dead IPC fallback in memory-cycle1.mjs is never
  // reached. Explicit options.callLlm (if a caller ever passes one) wins.
  if (typeof options?.callLlm !== 'function') {
    options = { ...options, callLlm: getCycle1CallLlm() }
  }
  _cycle1InFlight = (async () => {
    try {
      const result = await runCycle1(db, config, options, DATA_DIR)
      // #13: heartbeat (attempt) is always recorded so the overdue check
      // can tell the keeper is alive; success timestamp only advances when
      // the run actually did work. Skipped/in-flight runs do NOT count as
      // success because the next overdue check would otherwise see a fake
      // green and stop forcing auto-restarts.
      if (typeof options?.onCoalescedSuccess !== 'function') {
        await recordCycle1Result(result)
      }
      return result
    } finally {
      if (_cycle1InFlight === promise) _cycle1InFlight = null
    }
  })()
  const promise = _cycle1InFlight
  return _cycle1InFlight
}

async function _awaitCycle1Run(config = {}, options = {}) {
  const target = _cycle1InFlight || _startCycle1Run(config, options)
  const callerDeadlineMs = Number(options.callerDeadlineMs) || 0
  if (callerDeadlineMs <= 0) return await target
  // Caller-deadline race. When the channels-side timeout fires, we
  // (a) graceful-return a skippedInFlight envelope so the calling
  // SessionStart slot stops blocking with a 200 OK + flags instead of a
  // 503-class throw, and (b) release the outer in-flight handle. The
  // underlying LLM run keeps progressing in the background — it still
  // owns the inner dedup guard (memory-cycle.mjs _runCycle1InFlight).
  // Releasing the outer handle is what breaks the cascade: any later
  // _awaitCycle1Run call now re-enters _startCycle1Run, whose inner
  // runCycle1 short-circuits with skippedInFlight:true the moment it
  // sees the same db still busy. Returning a graceful object (vs the
  // pre-0.1.198 throw) keeps the channel route response shape stable
  // and lets pollers read inFlight=true rather than parse an error.
  let timer
  const deadlinePromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (_cycle1InFlight === target) _cycle1InFlight = null
      resolve({
        processed: 0,
        chunks: 0,
        skipped: 0,
        sessions: 0,
        skippedInFlight: true,
        timedOutWaiting: true,
        callerDeadlineMs,
      })
    }, callerDeadlineMs)
  })
  try {
    return await Promise.race([target, deadlinePromise])
  } finally {
    clearTimeout(timer)
  }
}

// Periodic cycle1 sizing: only enter when ≥ 20 pending rows have built up,
// then process up to 2 sessions × 50 rows per tick. cycle1 itself keeps each
// classifier window session-isolated. The on-demand path used by SessionStart
// hooks runs with a 1-row threshold and 5×20 windows instead — see
// hooks/session-start.cjs ON_DEMAND_CYCLE1_ARGS.
// mainConfig.cycle1 values still win, so users can override any of these in
// config.json.
function periodicCycle1Config() {
  return {
    min_batch: 20,
    session_cap: 2,
    batch_size: 50,
    concurrency: 2,
    ...(mainConfig?.cycle1 || {}),
  }
}

function scheduledCycle1Signature(config) {
  return makeCycleRequestSignature('cycle1', config, {
    preset: undefined,
    concurrency: undefined,
    maxConcurrent: undefined,
  })
}

function scheduledCycle2Signature(config) {
  return makeCycleRequestSignature('cycle2', config, {
    cascadePreset: undefined,
    concurrency: undefined,
  })
}

function scheduledCycle3ApplyMode(config) {
  const raw = String(config?.cycle3?.applyMode || 'conservative').trim().toLowerCase()
  return (raw === 'proposal' || raw === 'dry-run' || raw === 'dryrun') ? 'proposal' : 'conservative'
}

function scheduledCycle3Signature(config) {
  const retryConfig = config?.cycle3 || config
  return makeCycleRequestSignature('cycle3', retryConfig, {
    applyMode: scheduledCycle3ApplyMode(config),
    apply: undefined,
  })
}

async function enqueueScheduledCycle(kind, intervalMs, signature) {
  const claim = await claimAndMarkScheduledCycle(db, kind, intervalMs, signature, { reason: 'scheduled' })
  return claim.claimed === true
}

async function enqueueScheduledCycle1(intervalMs, _reason = 'scheduled') {
  const config = periodicCycle1Config()
  const signature = scheduledCycle1Signature(config)
  if (await enqueueScheduledCycle('cycle1', intervalMs, signature)) {
    scheduleScheduledCycle1(config, signature)
  }
}

async function enqueueScheduledCycle2(intervalMs, _reason = 'scheduled') {
  const config = mainConfig?.cycle2 || {}
  const signature = scheduledCycle2Signature(config)
  if (await enqueueScheduledCycle('cycle2', intervalMs, signature)) {
    scheduleScheduledCycle2(config, signature)
  }
}

async function enqueueScheduledCycle3(intervalMs, _reason = 'scheduled') {
  const config = mainConfig || {}
  const signature = scheduledCycle3Signature(config)
  if (await enqueueScheduledCycle('cycle3', intervalMs, signature)) {
    scheduleScheduledCycle3(config, signature)
  }
}

function scheduleScheduledCycle1(config, signature, attempt = 0) {
  const maxRetries = resolveCoalesceMaxRetries(config, 3)
  if (attempt > maxRetries) {
    __mixdogMemoryLog('[cycle1] scheduled queue retry cap reached\n')
    return
  }
  scheduleCoalescedCycleRetry(db, 'cycle1', async () => {
    if (_cycle1InFlight) {
      scheduleScheduledCycle1(config, signature, attempt + 1)
      return
    }
    const result = await _awaitCycle1Run(config, {
      coalescedRetry: true,
      onCoalescedSuccess: recordCycle1Result,
    })
    if (result?.skippedInFlight) scheduleScheduledCycle1(config, signature, attempt + 1)
  }, config, signature)
}

function scheduleScheduledCycle2(config, signature, attempt = 0) {
  const maxRetries = resolveCoalesceMaxRetries(config, 3)
  if (attempt > maxRetries) {
    __mixdogMemoryLog('[cycle2] scheduled queue retry cap reached\n')
    return
  }
  scheduleCoalescedCycleRetry(db, 'cycle2', async () => {
    if (_cycle2InFlight) {
      scheduleScheduledCycle2(config, signature, attempt + 1)
      return
    }
    _cycle2InFlight = true
    try {
      const result = await runCycle2(db, config, {
        coalescedRetry: true,
        onCoalescedSuccess: _finalizeCycle2Run,
      }, DATA_DIR)
      if (result?.skippedInFlight) {
        scheduleScheduledCycle2(config, signature, attempt + 1)
      } else if (result?.coalescedRetryNoop) {
        __mixdogMemoryLog('[cycle2] scheduled queue noop\n')
      } else if (result?.ok === false) {
        await _finalizeCycle2Run(result)
      }
    } catch (err) {
      __mixdogMemoryLog(`[cycle2] scheduled queue failed: ${err?.message || err}\n`)
    } finally {
      _cycle2InFlight = false
    }
  }, config, signature)
}

function scheduleScheduledCycle3(config, signature, attempt = 0) {
  const retryConfig = config?.cycle3 || config
  const maxRetries = resolveCoalesceMaxRetries(retryConfig, 3)
  if (attempt > maxRetries) {
    __mixdogMemoryLog('[cycle3] scheduled queue retry cap reached\n')
    return
  }
  scheduleCoalescedCycleRetry(db, 'cycle3', async () => {
    if (_cycle3InFlight) {
      scheduleScheduledCycle3(config, signature, attempt + 1)
      return
    }
    _cycle3InFlight = true
    try {
      const result = await runCycle3(db, config, DATA_DIR, {
        coalescedRetry: true,
        onCoalescedSuccess: () => setCycleLastRun('cycle3', Date.now()),
      })
      if (result?.skippedInFlight) {
        scheduleScheduledCycle3(config, signature, attempt + 1)
      } else if (result?.coalescedRetryNoop) {
        __mixdogMemoryLog('[cycle3] scheduled queue noop\n')
      }
    } catch (err) {
      __mixdogMemoryLog(`[cycle3] scheduled queue failed: ${err?.message || err}\n`)
    } finally {
      _cycle3InFlight = false
    }
  }, retryConfig, signature)
}

async function _finalizeCycle2Run(result) {
  if (result?.skippedInFlight) {
    __mixdogMemoryLog('[cycle2] skipped: in flight\n')
    return
  }
  if (result.ok) {
    await setCycleLastRun('cycle2', Date.now())
    await setCycleLastRun('cycle2_last_error', '')
    __mixdogMemoryLog('[cycle2] completed\n')
  } else {
    await setCycleLastRun('cycle2_last_error', result.error || 'unknown error')
    __mixdogMemoryLog(`[cycle2] failed: ${result.error}\n`)
  }
}

async function checkCycles() {
  // Poll-on-use: re-read memory config each tick so changed enabled/interval
  // values apply without a restart (mirrors search/cwd poll-on-use). The fixed
  // 60s poll bounds latency; manual `memory` tool calls already re-read per-call.
  mainConfig = readMainConfig();
  if (mainConfig?.enabled === false) return

  const cycle1Ms = parseInterval(mainConfig?.cycle1?.interval || '10m')
  const cycle2Ms = parseInterval(mainConfig?.cycle2?.interval || '1h')
  const cycle3Ms = parseInterval(mainConfig?.cycle3?.interval || '24h')

  const now = Date.now()
  const last = await getCycleLastRun()

  // Phase B §2.4 — cache-keeper health check + auto-restart.
  //
  // `last.cycle1 + cycle1Ms` is the next scheduled run time; anything beyond
  // that by > HEALTH_OVERDUE_MS means the keeper missed its window and the
  // Anthropic shard is drifting cold. Emit a warning, and — if we haven't
  // retried in the last cooldown window — force an unscheduled run so the
  // shard gets re-touched before the next Worker / Sub call pays the 2×
  // write premium. Cooldown prevents a tight retry loop when the underlying
  // cause (network, provider outage) is still broken.
  //
  // Cold-start guard: a fresh DB has last.cycle1 = 0, which would make
  // (now - 0 - cycle1Ms) blow past HEALTH_OVERDUE_MS on every first boot
  // and force-trigger the auto-restart branch even though the shard never
  // existed in the first place. The "drifting cold" concept doesn't apply
  // until at least one successful run has anchored a baseline.
  const cycle1OverdueMs = last.cycle1 > 0
    ? Math.max(0, now - last.cycle1 - cycle1Ms)
    : 0
  if (cycle1OverdueMs > CYCLE1_HEALTH_OVERDUE_MS) {
    const lastSeen = last.cycle1 ? new Date(last.cycle1).toISOString() : 'never'
    __mixdogMemoryLog(
      `[cycle1] overdue by ${Math.floor(cycle1OverdueMs / 60_000)}min `
      + `(last=${lastSeen}). Pool B Anthropic shard may be cold.\n`
    )
    const lastAutoRestart = last.cycle1_autoRestart || 0
    if (now - lastAutoRestart >= CYCLE1_AUTO_RESTART_COOLDOWN_MS) {
      // #14: record the attempt timestamp BEFORE the call (so a hung run
      // cannot tight-loop) and the result timestamp only on success. On
      // failure we return immediately instead of falling through into the
      // due branch — falling through would silently re-enter the same
      // failing path within the same tick.
      await setCycleLastRun('cycle1_autoRestart_attempt', now)
      try {
        const result = await _awaitCycle1Run(periodicCycle1Config())
        await setCycleLastRun('cycle1_autoRestart', Date.now())
        __mixdogMemoryLog(
          `[cycle1] auto-restart completed chunks=${result?.chunks ?? 0} processed=${result?.processed ?? 0}\n`
        )
        return
      } catch (e) {
        __mixdogMemoryLog(`[cycle1] auto-restart error: ${e.message}\n`)
        // Cooldown attempt timestamp is committed; do NOT fall through
        // to the due branch — next tick will retry after cooldown.
        return
      }
    }
  }

  if (now - last.cycle1 >= cycle1Ms) {
    await enqueueScheduledCycle1(cycle1Ms, 'scheduled')
  }

  if (now - last.cycle2 >= cycle2Ms) {
    await enqueueScheduledCycle2(cycle2Ms, 'scheduled')
  }

  if (now - last.cycle3 >= cycle3Ms) {
    await enqueueScheduledCycle3(cycle3Ms, 'scheduled')
  }
}
let _cycle2InFlight = false
let _cycle3InFlight = false

// #12: self-rescheduling timer. setInterval would fire ticks regardless of
// whether the previous checkCycles() call had finished; with cycle1/cycle2
// each potentially taking minutes, that races. Use setTimeout that re-arms
// itself only after the prior tick resolves, plus an in-flight guard so a
// stray manual call cannot stack ticks.
let _checkCyclesInFlight = false
async function _runCheckCyclesGuarded() {
  if (_checkCyclesInFlight) return
  _checkCyclesInFlight = true
  try { await checkCycles() }
  catch (e) { __mixdogMemoryLog(`[cycle-tick] error: ${e.message}\n`) }
  finally { _checkCyclesInFlight = false }
}
function _scheduleNextCheck() {
  _cycleInterval = setTimeout(async () => {
    _cycleInterval = null
    try {
      await _runCheckCyclesGuarded()
    } catch (e) {
      __mixdogMemoryLog(`[cycle-tick] re-arm guard caught: ${e?.message || e}\n`)
    } finally {
      // Re-arm regardless of inner outcome — _runCheckCyclesGuarded already
      // swallows its own errors, but defensive try/finally guarantees the
      // periodic tick continues even if a synchronous throw escapes.
      if (_cyclesActive) _scheduleNextCheck()
    }
  }, 60_000)
}
let _cyclesActive = false
let _transcriptWatcher = null
function _startCycles() {
  if (_cyclesActive) return
  _cyclesActive = true
  _scheduleNextCheck()
  _startupTimeout = setTimeout(() => { void _runCheckCyclesGuarded() }, 30_000)
}

function _stopCycles() {
  _cyclesActive = false
  if (_cycleInterval) { clearTimeout(_cycleInterval); _cycleInterval = null }
  if (_startupTimeout) { clearTimeout(_startupTimeout); _startupTimeout = null }
  if (_transcriptWatcher) { try { _transcriptWatcher.stop() } catch {} _transcriptWatcher = null }
}

async function _initRuntime() {
  if (_initialized) return
  await _initStore()
  // Restore the core_entries.id == 1..N invariant once per boot: SERIAL only
  // increments, so deleted rows leave permanent gaps. Fast no-op when already
  // contiguous (or empty). Runs only here — never in cycle2/addCore/deleteCore.
  await compactCoreIds(DATA_DIR)
  if (memoryCyclesEnabled()) {
    _transcriptWatcher = _initTranscriptWatcher()
    _startCycles()
  } else {
    __mixdogMemoryLog('[memory-service] secondary mode; skipping background cycles\n')
  }
  _initialized = true
  // Boot complete — continue straight into the deferred embedding warmup.
  // Fire-and-forget on the embedding worker thread; never awaited so it does
  // not delay init() returning or the memory-ready signal.
  fireDeferredEmbeddingWarmup()
}

function _beginRuntimeInit() {
  if (_initialized) return Promise.resolve()
  if (!_initPromise) {
    _initPromise = _initRuntime().catch((e) => {
      __mixdogMemoryLog(`[memory-service] runtime init failed: ${e?.stack || e?.message || e}\n`)
      _initPromise = null
      throw e
    })
  }
  return _initPromise
}


function parsePeriod(period, hasQuery) {
  if (!period && hasQuery) period = '30d'
  if (!period) return null
  if (period === 'all') return null
  if (period === 'last') return { mode: 'last' }
  // Calendar-day windows: 'today' anchors at local midnight rather than
  // rolling 24h. Without this, a query asking 'today' at 01:30 would silently
  // include yesterday's last 22.5h of activity, mislabelling them as
  // 'today's work'. 'yesterday' is the previous calendar day.
  if (period === 'today') {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return { startMs: start.getTime(), endMs: Date.now() }
  }
  if (period === 'yesterday') {
    const start = new Date()
    start.setDate(start.getDate() - 1)
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setHours(23, 59, 59, 999)
    return { startMs: start.getTime(), endMs: end.getTime() }
  }
  if (period === 'this_week' || period === 'last_week') {
    // R6 P9: calendar Mon-Sun previous/current week. Mon-start ISO
    // convention. Replaces R5 rolling 7-14d range which was empty for
    // sessions where "last week" decisions actually fell on Mon (4/27) of
    // this week. Precise calendar bounds match natural-language intuition.
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    const dayOfWeek = d.getDay()
    const daysSinceMon = (dayOfWeek + 6) % 7
    const thisWeekMon = new Date(d)
    thisWeekMon.setDate(d.getDate() - daysSinceMon)
    if (period === 'this_week') {
      return { startMs: thisWeekMon.getTime(), endMs: Date.now() }
    }
    const lastWeekMon = new Date(thisWeekMon)
    lastWeekMon.setDate(thisWeekMon.getDate() - 7)
    const lastWeekSunEnd = new Date(thisWeekMon.getTime() - 1)
    return { startMs: lastWeekMon.getTime(), endMs: lastWeekSunEnd.getTime() }
  }
  const relMatch = period.match(/^(\d+)(m|h|d)$/)
  if (relMatch) {
    const n = parseInt(relMatch[1])
    const unit = relMatch[2]
    const now = new Date()
    if (unit === 'm') {
      // Minute granularity is for "resume from the previous turn / pick
      // up where we left off" style recall — sub-hour windows where 1h
      // is too coarse. n=0 is invalid (the regex requires \d+ which
      // matches "0" but a zero-width window returns no rows; leave that
      // as caller-supplied no-op).
      const start = new Date(now.getTime() - n * 60_000)
      return { startMs: start.getTime(), endMs: now.getTime() }
    }
    if (unit === 'h') {
      const start = new Date(now.getTime() - n * 3600_000)
      return { startMs: start.getTime(), endMs: now.getTime() }
    }
    const start = new Date(now)
    start.setDate(start.getDate() - n)
    return { startMs: start.getTime(), endMs: now.getTime() }
  }
  const rangeMatch = period.match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/)
  if (rangeMatch) {
    return {
      startMs: Date.parse(rangeMatch[1] + 'T00:00:00'),
      endMs:   Date.parse(rangeMatch[2] + 'T23:59:59.999'),
    }
  }
  const dateMatch = period.match(/^(\d{4}-\d{2}-\d{2})$/)
  if (dateMatch) {
    return {
      startMs: Date.parse(dateMatch[1] + 'T00:00:00'),
      endMs:   Date.parse(dateMatch[1] + 'T23:59:59.999'),
      exact: true,
    }
  }
  return null
}

function formatTs(tsMs) {
  const n = Number(tsMs)
  if (Number.isFinite(n) && n > 1e12) {
    return new Date(n).toLocaleString('sv-SE').slice(0, 16)
  }
  return String(tsMs ?? '').slice(0, 16)
}

const CORE_RECALL_STOPWORDS = new Set([
  'about', 'after', 'again', 'before', 'check', 'color', 'decision', 'decided',
  'earlier', 'memory', 'previous', 'routing', 'stored', 'tell', 'what',
])

function coreRecallTerms(query) {
  return [...new Set(String(query || '').toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) || [])]
    .filter((term) => !CORE_RECALL_STOPWORDS.has(term))
    .slice(0, 8)
}

function normalizeRecallProjectScope(projectScope) {
  const raw = String(projectScope || 'common').trim()
  if (!raw || raw.toLowerCase() === 'common') return null
  if (raw.toLowerCase() === 'all') return '*'
  return raw
}

async function recallCoreRows(query, { projectScope, category, limit } = {}) {
  const terms = coreRecallTerms(query)
  if (terms.length === 0) return []

  const params = []
  const where = []
  const scope = normalizeRecallProjectScope(projectScope)
  if (scope === null) {
    where.push('project_id IS NULL')
  } else if (scope !== '*') {
    params.push(scope)
    where.push(`(project_id IS NULL OR project_id = $${params.length})`)
  }
  if (category != null) {
    const cats = (Array.isArray(category) ? category : [category])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean)
    if (cats.length > 0) {
      const placeholders = cats.map((cat) => {
        params.push(cat)
        return `$${params.length}`
      })
      where.push(`category IN (${placeholders.join(', ')})`)
    }
  }

  const textExpr = `lower(coalesce(element, '') || ' ' || coalesce(summary, ''))`
  const termClauses = terms.map((term) => {
    params.push(`%${term}%`)
    return `${textExpr} LIKE $${params.length}`
  })
  where.push(`(${termClauses.join(' OR ')})`)
  const hitExpr = termClauses.map((clause) => `CASE WHEN ${clause} THEN 1 ELSE 0 END`).join(' + ')
  const rowLimit = Math.max(1, Math.min(10, Number(limit) || 5))
  params.push(rowLimit)

  const rows = (await db.query(`
    SELECT id, element, summary, category, project_id, created_at, updated_at,
           (${hitExpr}) AS hit_count
    FROM core_entries
    WHERE ${where.join(' AND ')}
    ORDER BY hit_count DESC, updated_at DESC, id ASC
    LIMIT $${params.length}
  `, params)).rows

  return rows.map((row) => ({
    ...row,
    id: `core:${row.id}`,
    ts: row.updated_at || row.created_at || Date.now(),
    is_root: 1,
  }))
}

async function handleSearch(args, signal) {
  // Cooperative abort check: throw early if the caller already aborted
  // (IPC cancel handler signals the AbortController before re-entry).
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  if (args?.currentSession === true || args?.sessionId || args?.session_id) {
    return await recallSessionRows(args)
  }
  // id mode (follow-up lookup): caller passed `#N` markers from a prior
  // recall result. Fetch those rows directly + their chunk members,
  // bypassing hybrid search entirely. Output reuses renderEntryLines so
  // the shape stays identical to the search path (chunk members first,
  // root summary fallback).
  if (Array.isArray(args.ids) && args.ids.length > 0) {
    const ids = args.ids
      .map(v => Number(v))
      .filter(v => Number.isFinite(v) && v > 0)
    if (ids.length === 0) return { text: '(no valid ids)' }
    const includeArchived = args.includeArchived !== false
    const category = args.category
    const period = String(args.period ?? '').trim() || undefined
    const temporal = parsePeriod(period, false)
    let projectScope
    if (typeof args.projectScope === 'string' && args.projectScope) {
      projectScope = args.projectScope
    } else {
      const projectId = resolveProjectScope(typeof args.cwd === 'string' && args.cwd ? args.cwd : null)
      projectScope = projectId !== null ? projectId : 'common'
    }
    const excludeStatuses = includeArchived ? [] : ['archived']
    const rows = await fetchEntriesByIdsScoped(db, ids, {
      ts_from: temporal?.startMs,
      ts_to: temporal?.endMs,
      excludeStatuses,
      category,
      projectScope,
    })
    if (rows.length === 0) return { text: '(no results)' }
    // Members for any root rows in the result set.
    const rootIds = rows.filter(r => r.is_root === 1).map(r => Number(r.id))
    const memberLeafIds = new Set()
    if (rootIds.length > 0) {
      const { rows: memberRows } = await db.query(
        `SELECT id, ts, role, content, chunk_root
         FROM entries WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
         ORDER BY ts ASC, id ASC`,
        [rootIds],
      )
      const membersByRoot = new Map()
      for (const m of memberRows) {
        const k = Number(m.chunk_root)
        if (!membersByRoot.has(k)) membersByRoot.set(k, [])
        membersByRoot.get(k).push(m)
        memberLeafIds.add(Number(m.id))
      }
      for (const r of rows) {
        if (r.is_root === 1) r.members = membersByRoot.get(Number(r.id)) ?? []
      }
    }
    // Preserve caller-supplied id order; drop leaves already inlined as a
    // root's chunk member to prevent double emission when the caller names
    // a root and one of its leaves in the same batch.
    const byId = new Map(rows.map(r => [Number(r.id), r]))
    const ordered = ids
      .map(id => byId.get(id))
      .filter(Boolean)
      .filter(r => !(r.is_root === 0 && memberLeafIds.has(Number(r.id))))
    return { text: renderEntryLines(ordered) }
  }
  // Array query — fan out in parallel, each query runs its own hybrid search
  // path, and results are grouped in the response so the caller sees one
  // ranked list per angle. Collapses what would otherwise be N sequential
  // tool calls into a single invocation.
  if (Array.isArray(args.query)) {
    // Dedup + fan-out cap. The cap protects the result envelope from
    // over-eager callers (20+ near-duplicate queries N× the IO) without
    // silently swallowing the caller's intent: when the input exceeds
    // QUERIES_CAP, prepend a one-line note so the caller can see the
    // truncation and re-shape their query list.
    const QUERIES_CAP = 5
    const dedup = [...new Set(args.query.map(q => String(q || '').trim()).filter(Boolean))]
    if (dedup.length === 0) return { text: '' }
    const queries = dedup.slice(0, QUERIES_CAP)
    const dropped = dedup.length - queries.length
    const rest = { ...args }
    delete rest.query
    const deadlineSec = Math.max(1, Number(process.env.MEMORY_FANOUT_DEADLINE_S) || 180)
    const deadlineMs = deadlineSec * 1000
    const fanOutAbort = new AbortController()
    let deadlineTimer
    const deadlineRace = new Promise((_res, rej) => {
      deadlineTimer = setTimeout(() => {
        fanOutAbort.abort(new Error(`memory fan-out deadline exceeded (${deadlineSec}s)`))
        rej(Object.assign(new Error(`memory fan-out deadline exceeded (${deadlineSec}s)`), { _deadline: true }))
      }, deadlineMs)
    })
    let settled
    try {
      // Pre-warm only when the embedding model is already resident. If the
      // process is still cold, keep recall responsive and let the background
      // warmup finish independently instead of making the first query pay the
      // ONNX session-create cost.
      if (isEmbeddingModelReady()) {
        // Race against the same deadline as the fan-out itself: a stuck
        // embedding worker would previously park here indefinitely because
        // the timer hadn't been started yet from the fan-out's perspective.
        await Promise.race([embedTexts(queries), deadlineRace])
      } else if (embeddingWarmupCanStart()) {
        void warmupEmbeddingProvider().catch((err) => {
          __mixdogMemoryLog(`[memory-service] embedding warmup after cold fan-out skipped dense search: ${err?.message || err}\n`)
        })
      }
      settled = await Promise.race([
        Promise.all(queries.map(async (q) => {
          if (fanOutAbort.signal.aborted) throw fanOutAbort.signal.reason
          if (signal?.aborted) throw signal.reason ?? new Error('aborted')
          const sub = await handleSearch({ ...rest, query: q }, signal)
          return `[${q}]\n${sub.text || '(no results)'}`
        })),
        deadlineRace,
      ])
    } catch (err) {
      throw err
    } finally {
      clearTimeout(deadlineTimer)
    }
    const parts = settled
    const header = dropped > 0
      ? `note: ${dedup.length} queries received, ${queries.length} processed, ${dropped} dropped (cap ${QUERIES_CAP})\n\n`
      : ''
    return { text: header + parts.join('\n\n') }
  }
  const query = String(args.query ?? '').trim()
  let period = String(args.period ?? '').trim() || undefined
  // Period and sort are caller-supplied only. Lead is responsible for
  // mapping vague time phrases / chronological intent into the period
  // argument before calling; the engine does not infer them from query
  // text.
  const RECALL_LIMIT_CAP = 100
  const RECALL_OFFSET_CAP = 500
  const requestedLimit = Number(args.limit)
  const requestedOffset = Number(args.offset)
  let limit = Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 10)
  let offset = Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0)
  const recallCapNotes = []
  if (Number.isFinite(requestedLimit) && requestedLimit > RECALL_LIMIT_CAP) {
    limit = RECALL_LIMIT_CAP
    recallCapNotes.push(`limit capped to ${RECALL_LIMIT_CAP} (requested ${requestedLimit})`)
  } else {
    limit = Math.min(RECALL_LIMIT_CAP, limit)
  }
  if (Number.isFinite(requestedOffset) && requestedOffset > RECALL_OFFSET_CAP) {
    offset = RECALL_OFFSET_CAP
    recallCapNotes.push(`offset capped to ${RECALL_OFFSET_CAP} (requested ${requestedOffset})`)
  } else {
    offset = Math.min(RECALL_OFFSET_CAP, offset)
  }
  const recallCapPrefix = recallCapNotes.length ? `${recallCapNotes.join('; ')}\n` : ''
  const sort = args.sort != null ? String(args.sort) : 'importance'
  // Chunk content is the primary recall output. Members default to true so
  // callers receive the raw chunk leaves (the cycle1-produced semantic
  // chunks) rather than just the root's cycle2-compressed summary line.
  // Explicit `includeMembers:false` keeps the legacy summary-only mode.
  const includeMembers = args.includeMembers !== false
  const includeRaw = Boolean(args.includeRaw)
  const includeArchived = args.includeArchived !== false
  const category = args.category
  const temporal = parsePeriod(period, Boolean(query))

  // Derive projectScope from caller cwd (falls back to process.cwd()).
  // Explicit args.projectScope (string) takes priority so callers can
  // override to 'all', 'common', or a specific slug.
  let projectScope
  if (typeof args.projectScope === 'string' && args.projectScope) {
    projectScope = args.projectScope
  } else {
    const projectId = resolveProjectScope(typeof args.cwd === 'string' && args.cwd ? args.cwd : null)
    projectScope = projectId !== null ? projectId : 'common'
  }

  // R11 reviewer M4: calendar-bounded periods disable freshness decay
  // so within-period ranking doesn't downgrade Mon entries vs Sun.
  const CALENDAR_PERIODS = new Set(['yesterday', 'today', 'this_week', 'last_week'])
  const isCalendarPeriod = period != null
    && (CALENDAR_PERIODS.has(period) || /^\d{4}-\d{2}-\d{2}/.test(period))
  const applyFreshness = !isCalendarPeriod

  if (query) {
    const _t0 = Date.now()
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    let queryVector = null
    if (isEmbeddingModelReady()) {
      queryVector = await embedText(query)
    } else {
      const now = Date.now()
      if (now - _embeddingColdRecallLogAt > 10_000) {
        _embeddingColdRecallLogAt = now
        __mixdogMemoryLog('[recall] embedding model cold; returning lexical results while background warmup continues\n')
      }
      if (embeddingWarmupCanStart()) {
        void warmupEmbeddingProvider().catch((err) => {
          __mixdogMemoryLog(`[memory-service] embedding warmup after cold recall failed: ${err?.message || err}\n`)
        })
      }
    }
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const _t1 = Date.now()
    if (process.env.MIXDOG_DEBUG_MEMORY) {
      __mixdogMemoryLog(`[search-time] embed=${_t1 - _t0}ms query="${query.slice(0, 60)}"\n`)
    }
    // Push ts and status filters into the hybrid candidate query so FTS / vec
    // rank inside the requested window, not the whole tree. The previous post-
    // filter approach silently emptied results when relevant matches sat
    // outside `period` (default 30d) and could not bubble through.
    // Recall is history-first: archived roots hold most prior work. Callers
    // that need only live invariants can pass includeArchived:false.
    const excludeStatuses = includeArchived ? [] : ['archived']
    const results = await searchRelevantHybrid(db, query, {
      limit: limit + offset,
      queryVector: Array.isArray(queryVector) ? queryVector : null,
      includeMembers,
      ts_from: temporal?.startMs,
      ts_to: temporal?.endMs,
      applyFreshness,
      projectScope,
      category,
      excludeStatuses,
      // useHotActive was set to true here so default (no-period) calls
      // routed through the mv_hot_active materialized view — a narrow
      // active-roots-only pool. Live usage is dominated by vague-time
      // queries ("recent / lately") where Lead callers omit the period
      // filter, leaving the MV as the sole source. That hid every
      // orphan leaf and every pending root — fresh work from the last 1-60
      // minutes never surfaced. Now that the entries-table CTE legs run
      // against broaden HNSW + GIN trgm partial indexes (the
      // is_root=1 predicate was dropped in the same revision), the
      // entries path is fast enough (1-2 ms ANN on ~10K rows, O(log N)
      // through 1M+) to be the single source of truth. The MV is left in
      // place for now but no longer routed to from search; cycle2 may stop
      // refreshing it in a follow-up commit once nothing else reads it.
      useHotActive: false,
    })
    let filtered = results
    if (sort === 'date') {
      // R11 reviewer L5: NaN guard — entries with null/undefined ts default
      // to 0 so the comparator stays numeric and stable.
      filtered.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
    } else {
      filtered.sort((a, b) => {
        const sa = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
        return (sa(b.retrievalScore ?? b.rrf ?? 0) - sa(a.retrievalScore ?? a.rrf ?? 0))
          || (sa(b.score ?? 0) - sa(a.score ?? 0))
          || (sa(b.ts ?? 0) - sa(a.ts ?? 0))
          || (Number(a.id ?? 0) - Number(b.id ?? 0))
      })
    }
    if (includeRaw) {
      // Reserve slots for raw rows under sort=importance: hybrid rows are
      // already score-sorted descending, so a full hybrid page (limit rows)
      // would shut out raw rows entirely after slice(offset, offset+limit).
      // Reserve up to RAW_RESERVE slots near the top of the post-slice
      // window by trimming the hybrid prefix before merging, then re-sort
      // for sort=date or otherwise append (already ranked) for importance.
      const RAW_FETCH = 20
      const rawRows = await readRawRowsInWindow(
        db,
        temporal?.startMs ?? null,
        temporal?.endMs ?? Date.now(),
        RAW_FETCH,
        { projectScope },
      )
      const seenIds = new Set(filtered.map(r => r.id))
      const newRaw = rawRows.filter(r => !seenIds.has(r.id))
      if (sort === 'date') {
        for (const r of newRaw) filtered.push(r)
        filtered.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
      } else {
        // sort=importance: append raw rows after the hybrid page (mostly
        // ineffective — slice(offset, offset+limit) typically shuts them
        // out). Proper includeRaw paging fix deferred (needs fetching extra rows / paging redesign).
        for (const r of newRaw) filtered.push(r)
      }
    }
    const coreRows = await recallCoreRows(query, { projectScope, category, limit })
    if (coreRows.length > 0) {
      filtered = [...coreRows, ...filtered]
    }
    const sliced = filtered.slice(offset, offset + limit)
    const _t2 = Date.now()
    if (process.env.MIXDOG_DEBUG_MEMORY) {
      __mixdogMemoryLog(`[search-time] hybrid+sort+raw=${_t2 - _t1}ms rows=${filtered.length} sliced=${sliced.length}\n`)
    }
    // Emit a recall trace event so getTraceWithEntries() can correlate
    // this search with the top-ranked memory entry.  One event per
    // handleSearch call (not per returned row) — cheapest meaningful link.
    // parent_span_id left null: the agent-side span id is only known after
    // the DB insert of the loop/tool events, which happens async on the
    // client side and is not available here.
    if (_traceDb && filtered.length > 0) {
      const topHit = filtered[0]
      const topId = topHit?.id != null ? Number(topHit.id) : null
      if (topId !== null && Number.isFinite(topId)) {
        insertTraceEvents(_traceDb, [{
          ts: Date.now(),
          kind: 'recall',
          entry_id: topId,
          payload: { query: query.slice(0, 200), hit_count: filtered.length },
        }]).catch(e => __mixdogMemoryLog(`[trace] insertTraceEvents error: ${e?.message}\n`))
      }
    }
    const out = { text: recallCapPrefix + renderEntryLines(sliced) }
    if (process.env.MIXDOG_DEBUG_MEMORY) {
      __mixdogMemoryLog(`[search-time] render+trace=${Date.now() - _t2}ms total=${Date.now() - _t0}ms textLen=${out.text.length}\n`)
    }
    return out
  }

  const filters = { limit: limit + offset }
  if (temporal?.startMs != null) { filters.ts_from = temporal.startMs; filters.ts_to = temporal.endMs }
  if (temporal?.mode === 'last' && _bootTimestamp) {
    filters.ts_to = _bootTimestamp - 1
  }
  filters.projectScope = projectScope
  if (category != null) filters.category = category
  filters.sort = sort
  if (!includeArchived) filters.excludeStatuses = ['archived']
  if (includeMembers) filters.includeMembers = true
  const rows = await retrieveEntries(db, filters)
  const sliced = rows.slice(offset, offset + limit)
  return { text: recallCapPrefix + renderEntryLines(sliced) }
}

function renderEntryLines(rows) {
  if (!rows || rows.length === 0) return '(no results)'
  const lines = []
  // Bound total emitted lines (roots x members) so a many-member recall can't
  // inject unbounded output. Per-line content is already capped at 1000 chars;
  // this caps the line COUNT. Narrow the query (limit/period/projectScope) for more.
  const RECALL_LINE_CAP = 200
  let _capped = false
  outer:
  for (const r of rows) {
    const hasMembers = Array.isArray(r.members) && r.members.length > 0
    if (hasMembers) {
      // Chunks present: emit each member as its own line. Root row is a
      // grouping artifact for retrieval — the caller wants the chunk
      // content (cycle1 raw), not the cycle2-compressed summary.
      for (const m of r.members) {
        if (lines.length >= RECALL_LINE_CAP) { _capped = true; break outer }
        const mTs = formatTs(m.ts)
        const role = m.role === 'user' ? 'u' : m.role === 'assistant' ? 'a' : (m.role || '?')
        const content = cleanMemoryText(String(m.content ?? '')).slice(0, 1000)
        lines.push(`[${mTs}] ${role}: ${content} #${m.id}`)
      }
    } else {
      if (lines.length >= RECALL_LINE_CAP) { _capped = true; break }
      // No chunks (root not yet chunked by cycle1, or orphan leaf): emit
      // the row itself in the same shape. element/summary fall back to
      // raw content when both are absent.
      const ts = formatTs(r.ts)
      const element = r.element ?? ''
      const summary = r.summary ?? ''
      // Standalone leaf rows (is_root=0, no parent chunks_root resolved
      // into a `members` list) carry their u/a role just like inline
      // chunk members — surface it so the format stays consistent across
      // the two emission paths.
      const rolePrefix = r.is_root === 0 && r.role
        ? (r.role === 'user' ? 'u: ' : r.role === 'assistant' ? 'a: ' : `${r.role}: `)
        : ''
      const body = element || summary
        ? `${element}${summary ? ' — ' + summary : ''}`
        : cleanMemoryText(String(r.content ?? '')).slice(0, 1000)
      lines.push(`[${ts}] ${rolePrefix}${body.slice(0, 1000)} #${r.id}`)
    }
  }
  if (_capped) lines.push(`[recall truncated — showing first ${RECALL_LINE_CAP} lines; narrow the query (limit/period/projectScope) for the rest]`)
  return lines.join('\n')
}

async function dumpSessionRootChunks(args = {}) {
  const sessionId = String(args.sessionId || args.session_id || '').trim()
  if (!sessionId) return { text: '(no current session)', rows: [], chunks: [], isError: true }
  const includeRaw = args.includeRaw !== false
  const limit = Math.max(1, Math.min(1000, Number(args.limit) || 1000))
  const rootRows = (await db.query(`
    SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
           element, category, summary, status, score, last_seen_at, project_id
    FROM entries
    WHERE session_id = $1 AND is_root = 1
    ORDER BY COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
    LIMIT $2
  `, [sessionId, limit])).rows
  const roots = rootRows.map((r) => ({ ...r, members: [] }))
  const rootIds = roots.map((r) => Number(r.id)).filter((id) => Number.isFinite(id))
  const memberRows = rootIds.length > 0
    ? (await db.query(`
        SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root, project_id
        FROM entries
        WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
        ORDER BY chunk_root ASC, COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
      `, [rootIds])).rows
    : []
  const byRoot = new Map(roots.map((r) => [Number(r.id), r]))
  for (const m of memberRows) {
    const root = byRoot.get(Number(m.chunk_root))
    if (root) root.members.push(m)
  }
  let rawRows = []
  if (includeRaw) {
    rawRows = (await db.query(`
      SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root, project_id
      FROM entries
      WHERE session_id = $1
        AND is_root = 0
        AND (chunk_root IS NULL OR chunk_root = id)
      ORDER BY COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
      LIMIT $2
    `, [sessionId, limit])).rows
  }
  const chunks = []
  for (const root of roots) {
    const memberText = root.members
      .map((m) => `${m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : m.role}: ${cleanMemoryText(String(m.content ?? ''))}`)
      .filter(Boolean)
      .join('\n')
    const summary = [root.element, root.summary].map((v) => String(v || '').trim()).filter(Boolean).join(' — ')
    chunks.push({
      id: Number(root.id),
      kind: 'root',
      ts: Number(root.ts) || 0,
      sourceTurn: root.source_turn ?? null,
      category: root.category || null,
      summary,
      text: memberText || cleanMemoryText(String(root.content ?? '')),
      members: root.members,
    })
  }
  for (const raw of rawRows) {
    chunks.push({
      id: Number(raw.id),
      kind: 'raw',
      chunkRoot: raw.chunk_root ?? null,
      ts: Number(raw.ts) || 0,
      sourceTurn: raw.source_turn ?? null,
      category: null,
      summary: '',
      text: `${raw.role === 'assistant' ? 'assistant' : raw.role === 'user' ? 'user' : raw.role}: ${cleanMemoryText(String(raw.content ?? ''))}`,
      members: [],
    })
  }
  chunks.sort((a, b) => {
    const at = Number.isFinite(Number(a.sourceTurn)) ? Number(a.sourceTurn) : 2147483647
    const bt = Number.isFinite(Number(b.sourceTurn)) ? Number(b.sourceTurn) : 2147483647
    return (at - bt) || ((a.ts || 0) - (b.ts || 0)) || ((a.id || 0) - (b.id || 0))
  })
  const text = chunks.length
    ? chunks.map((chunk, idx) => {
        const label = chunk.kind === 'root'
          ? `# chunk ${idx + 1} root=${chunk.id}${chunk.category ? ` category=${chunk.category}` : ''}`
          : `${chunk.chunkRoot == null ? '# raw_pending' : '# raw_terminal'} ${idx + 1} id=${chunk.id}`
        const summary = chunk.summary ? `summary: ${chunk.summary}\n` : ''
        return `${label}\n${summary}${chunk.text}`.trim()
      }).join('\n\n')
    : '(no results)'
  return { text, rows: [...roots, ...rawRows], chunks }
}

async function entryStats() {
  return await db.transaction(async (tx) => {
    const total               = (await tx.query(`SELECT COUNT(*) c FROM entries`)).rows[0].c
    const roots               = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1`)).rows[0].c
    const active_roots        = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'active'`)).rows[0].c
    const archived_roots      = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'archived'`)).rows[0].c
    const unchunked_leaves    = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE chunk_root IS NULL`)).rows[0].c
    const cycle2_pending_roots = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'pending'`)).rows[0].c
    const core_entries        = (await tx.query(`SELECT COUNT(*) c FROM core_entries`)).rows[0].c
    const core_embed_null     = (await tx.query(`SELECT COUNT(*) c FROM core_entries WHERE embedding IS NULL`)).rows[0].c
    const active_core_summaries = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'active' AND core_summary IS NOT NULL`)).rows[0].c
    const active_core_summary_missing = (await tx.query(`
      SELECT COUNT(*) c
      FROM entries
      WHERE is_root = 1
        AND status = 'active'
        AND (core_summary IS NULL OR btrim(core_summary) = '')
    `)).rows[0].c
    const byStatus            = (await tx.query(`SELECT status, COUNT(*) c FROM entries WHERE is_root = 1 GROUP BY status`)).rows
    const byCategory          = (await tx.query(`SELECT category, COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'active' GROUP BY category ORDER BY c DESC`)).rows
    const mvRows              = (await tx.query(`SELECT relispopulated FROM pg_class WHERE relname = 'mv_hot_active' LIMIT 1`)).rows
    const mv_hot_active_populated = mvRows.length ? Boolean(mvRows[0].relispopulated) : null
    return {
      total, roots, active_roots, archived_roots, unchunked_leaves, cycle2_pending_roots,
      core_entries, core_embed_null, active_core_summaries, active_core_summary_missing,
      mv_hot_active_populated,
      byStatus, byCategory,
    }
  })
}

async function _handleMemCycle1(args, config, signal) {
  const minBatchOverride = Number(args?.min_batch)
  const sessionCapOverride = Number(args?.session_cap)
  const batchSizeOverride = Number(args?.batch_size)
  const windowSizeOverride = Number(args?.window_size ?? args?.windowSize)
  const rowsPerSessionOverride = Number(args?.rows_per_session ?? args?.rowsPerSession ?? args?.max_rows_per_session ?? args?.maxRowsPerSession)
  const concurrencyOverride = Number(args?.concurrency)
  const sessionIdOverride = String(args?.sessionId ?? args?.session_id ?? '').trim()
  const baseCycle1 = config?.cycle1 || {}
  let cycle1Config = baseCycle1
  // _runCycle1Impl reads `config?.min_batch ?? config?.cycle1?.min_batch ??
  // default` — top-level wins, so pin the override at top-level only.
  if (Number.isFinite(minBatchOverride) && minBatchOverride > 0) {
    cycle1Config = { ...cycle1Config, min_batch: minBatchOverride }
  }
  if (Number.isFinite(sessionCapOverride) && sessionCapOverride > 0) {
    cycle1Config = { ...cycle1Config, session_cap: sessionCapOverride }
  }
  if (Number.isFinite(batchSizeOverride) && batchSizeOverride > 0) {
    cycle1Config = { ...cycle1Config, batch_size: batchSizeOverride }
  }
  if (Number.isFinite(windowSizeOverride) && windowSizeOverride > 0) {
    cycle1Config = { ...cycle1Config, window_size: windowSizeOverride }
  }
  if (Number.isFinite(rowsPerSessionOverride) && rowsPerSessionOverride > 0) {
    cycle1Config = { ...cycle1Config, rows_per_session: rowsPerSessionOverride }
  }
  if (sessionIdOverride) {
    cycle1Config = { ...cycle1Config, session_id: sessionIdOverride }
  }
  if (Number.isFinite(concurrencyOverride) && concurrencyOverride > 0) {
    cycle1Config = { ...cycle1Config, concurrency: Math.min(8, Math.floor(concurrencyOverride)) }
  }
  const callerDeadlineMs = Number(args?._callerDeadlineMs) || 0
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  const cycle1Options = callerDeadlineMs > 0 ? { callerDeadlineMs, signal } : { signal }
  if (typeof args?._callLlm === 'function') {
    cycle1Options.callLlm = args._callLlm
  }
  const result = await _awaitCycle1Run(
    cycle1Config,
    cycle1Options,
  )
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  const pendingStr = result?.pendingRows != null ? result.pendingRows : 0
  const inFlightStr = result?.skippedInFlight === true ? 'true' : 'false'
  const timedOutPart = result?.timedOutWaiting === true ? ' timedOut=true' : ''
  const omitted = Array.isArray(result?.omitted_row_ids) ? result.omitted_row_ids.length : Number(result?.quality?.omitted_rows || 0)
  const prefiltered = Array.isArray(result?.prefiltered_row_ids) ? result.prefiltered_row_ids.length : Number(result?.quality?.prefiltered_rows || 0)
  const failedRows = Array.isArray(result?.failed_row_ids) ? result.failed_row_ids.length : Number(result?.quality?.failed_rows || 0)
  const invalidChunks = Array.isArray(result?.invalid_chunks) ? result.invalid_chunks.length : Number(result?.quality?.invalid_chunks || 0)
  return {
    ...result,
    text: `cycle1: chunks=${result.chunks} processed=${result.processed} skipped_chunks=${result.skipped}` +
      ` omitted=${omitted} prefiltered=${prefiltered} failed_rows=${failedRows} invalid_chunks=${invalidChunks}` +
      ` pending=${pendingStr} inFlight=${inFlightStr}${timedOutPart}`,
  }
}

async function _handleMemCycle2(args, config, signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  const result = await runCycle2(db, config?.cycle2 || {}, { signal }, DATA_DIR)
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  await _finalizeCycle2Run(result)
  const counts = {
    promoted: result?.promoted || 0,
    archived: result?.archived || 0,
    merged: result?.merged || 0,
    updated: result?.updated || 0,
    kept: result?.kept || 0,
    rejected_verb: result?.rejected_verb || 0,
    merge_rejected: result?.merge_rejected || 0,
    missing_core: result?.missing_core_summary || 0,
    core_backfill: result?.core_embedding_backfill || 0,
    cascade_drop: result?.cascade?.dropped || 0,
    phase_merge: result?.phase_merge?.merged || 0,
    core_overlap: result?.phase_merge?.core_overlap || 0,
  }
  const parts = Object.entries(counts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`)
  if (parts.length) return { text: `cycle2 ${parts.join(' ')}` }
  // No applied counts — disambiguate the "noop" so a broken gate is visible
  // instead of looking like a clean, nothing-to-do run.
  let cause = ''
  if (result?.skippedInFlight) cause = ' (skipped: in-flight)'
  else if (result?.ok === false) cause = ` (error: ${result.error || 'unknown'})`
  else if (result?.gate_failed) cause = ' (gate_failed)'
  return { text: `cycle2 noop${cause}` }
}

async function _handleMemCycle3(args, config, signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  const confirmed = args?.confirm === 'APPLY CYCLE3'
  const requestedMode = typeof args?.cycle3Mode === 'string' ? args.cycle3Mode : null
  const applyMode = confirmed
    ? 'confirmed'
    : (requestedMode === 'proposal' || requestedMode === 'dry-run' || requestedMode === 'dryrun')
      ? 'proposal'
      : 'conservative'
  const result = await runCycle3(db, config || {}, DATA_DIR, { signal, apply: confirmed ? true : undefined, applyMode })
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  const parts = ['reviewed', 'kept', 'updated', 'merged', 'deleted']
    .map(k => `${k}=${result?.[k] || 0}`)
  if (result?.proposed) {
    parts.push(`proposal_update=${result.proposed.updated || 0}`)
    parts.push(`proposal_merge=${result.proposed.merged || 0}`)
    parts.push(`proposal_delete=${result.proposed.deleted || 0}`)
  }
  if (result?.held) {
    parts.push(`held_update=${result.held.updated || 0}`)
    parts.push(`held_merge=${result.held.merged || 0}`)
    parts.push(`held_delete=${result.held.deleted || 0}`)
  }
  parts.push(`mode=${result?.applyMode || applyMode}`)
  parts.push(`applied=${result?.applied === true ? 'true' : 'false'}`)
  if (result?.skippedInFlight) parts.push('inFlight=true')
  const errPart = result?.error ? ` error=${result.error}` : ''
  return { text: `cycle3 ${parts.join(' ')}${errPart}` }
}

async function _handleMemFlush(args, config, signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  const r1 = await _awaitCycle1Run(config?.cycle1 || {}, { signal })
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  const r2 = await runCycle2(db, config?.cycle2 || {}, { signal }, DATA_DIR)
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  await _finalizeCycle2Run(r2)
  return { text: `flush: cycle1 chunks=${r1.chunks} processed=${r1.processed}, cycle2 ${JSON.stringify(r2)}` }
}

async function _handleMemStatus(args, config) {
  const stats = await entryStats()
  const last = await getCycleLastRun()
  let dims = 0
  let dimsErr = null
  try {
    const raw = await getMetaValue(db, 'embedding.current_dims', null)
    if (raw != null) dims = Number(JSON.parse(raw))
    if (!Number.isFinite(dims)) dims = 0
  } catch (e) {
    // Surface the error in the status line instead of masquerading a meta
    // read failure as dims=0 (which is indistinguishable from a fresh,
    // pre-bootstrap DB). Keep status callable so other lines still render.
    dims = 0
    dimsErr = e?.message || String(e)
  }
  const bootstrapComplete = await isBootstrapComplete(db)
  const lastCycle1Ago = last.cycle1 ? `${Math.round((Date.now() - last.cycle1) / 60000)}m ago` : 'never'
  const lastCycle2Ago = last.cycle2 ? `${Math.round((Date.now() - last.cycle2) / 60000)}m ago` : 'never'
  const activeTargetCap = Number.isFinite(Number(config?.cycle2?.active_target_cap))
    ? Number(config?.cycle2?.active_target_cap)
    : CYCLE2_ACTIVE_TARGET_CAP
  const mvState = stats.mv_hot_active_populated === null
    ? 'missing'
    : stats.mv_hot_active_populated ? 'populated' : 'unpopulated'
  const lines = [
    `entries: total=${stats.total} roots=${stats.roots} cycle1_raw=${stats.unchunked_leaves} (unchunked leaves) cycle2_pending=${stats.cycle2_pending_roots} (awaiting cycle2 review)`,
    `status: ${stats.byStatus.map(r => `${r.status ?? '?'}:${r.c}`).join(', ') || 'empty'}`,
    `categories(active): ${stats.byCategory.map(r => `${r.category ?? 'NULL'}:${r.c}`).join(', ') || 'empty'} active_target_cap=${activeTargetCap}`,
    `core_memory: user=${stats.core_entries} embed_null=${stats.core_embed_null} active_core=${stats.active_core_summaries} active_missing_core=${stats.active_core_summary_missing}`,
    `embedding_index: ready dims=${dims}${dimsErr ? ` (meta_read_error: ${dimsErr})` : ''}`,
    `recall_index: mv_hot_active=${mvState}`,
    `bootstrap: ${bootstrapComplete ? 'complete' : 'incomplete'}`,
    `last_cycle1: ${lastCycle1Ago}`,
    `last_cycle2: ${lastCycle2Ago}`,
    ...(last.cycle2_last_error ? [`last_cycle2_error: ${last.cycle2_last_error}`] : []),
  ]
  return { text: lines.join('\n') }
}

async function _handleMemRebuild(args, config, signal) {
  if (args.confirm !== 'REBUILD MEMORY') {
    return { text: 'rebuild requires confirm: "REBUILD MEMORY" (truncates classification columns and re-runs cycles)', isError: true }
  }
  // Drain any pre-reset cycle1 BEFORE the destructive truncation so the
  // post-reset run is not started concurrently against the same DB.
  // _awaitCycle1Run() may release the outer handle on a caller deadline while
  // the inner runCycle1 promise still owns the DB writes. Drain both layers,
  // then loop once more if one layer exposed another promise while awaiting.
  const drainedCycle1Promises = new Set()
  for (;;) {
    const pendingCycle1Promises = [_cycle1InFlight, getInFlightCycle1(db)]
      .filter(p => p && !drainedCycle1Promises.has(p))
    if (pendingCycle1Promises.length === 0) break
    for (const pendingCycle1 of pendingCycle1Promises) {
      drainedCycle1Promises.add(pendingCycle1)
      try { await pendingCycle1 } catch {}
    }
  }
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  // Cleanup must run BEFORE demotion: the original order demoted normal
  // roots (chunk_root = id) to is_root = 0 first, then ran the cleanup
  // WHERE is_root = 1 — which missed exactly those demoted rows, leaving
  // stale element/category/summary/score/embedding/summary_hash on rows that
  // had just become raw leaves. Reorder so all roots get their classification
  // columns cleared while is_root = 1 still selects them, then demote.
  // Wrap the whole destructive sequence in one transaction so a mid-step
  // failure rolls back rather than leaving a mixed state.
  await db.transaction(async (tx) => {
    await tx.query(`
      UPDATE entries
      SET element = NULL, category = NULL, summary = NULL,
          status = 'pending', score = NULL, last_seen_at = NULL,
          embedding = NULL, summary_hash = NULL,
          core_summary = NULL, reviewed_at = NULL, promoted_at = NULL,
          error_count = 0
      WHERE is_root = 1
    `)
    await tx.query(`UPDATE entries SET chunk_root = NULL, is_root = 0 WHERE chunk_root = id`)
    await tx.query(`UPDATE entries SET chunk_root = NULL WHERE is_root = 0`)
    await tx.query(`
      UPDATE entries
      SET status = NULL,
          element = NULL, category = NULL, summary = NULL,
          score = NULL, last_seen_at = NULL,
          embedding = NULL, summary_hash = NULL,
          core_summary = NULL, reviewed_at = NULL, promoted_at = NULL,
          error_count = 0
      WHERE is_root = 0
    `)
  })
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  // Force a fresh post-reset cycle1: _cycle1InFlight is guaranteed null
  // here (we drained above and have not awaited any cycle1-starting call
  // since), so calling _startCycle1Run directly skips the coalesce branch
  // inside _awaitCycle1Run and guarantees the newly demoted rows are read.
  const r1 = await _startCycle1Run(config?.cycle1 || {}, { signal })
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  const r2 = await runCycle2(db, config?.cycle2 || {}, { signal }, DATA_DIR)
  await _finalizeCycle2Run(r2)
  return { text: `rebuild: cycle1 chunks=${r1.chunks} processed=${r1.processed}, cycle2 ${JSON.stringify(r2)}` }
}

async function _handleMemPrune(args, _config) {
  if (args.confirm !== 'PRUNE OLD ENTRIES') {
    return { text: 'prune requires confirm: "PRUNE OLD ENTRIES" (permanently deletes unclassified entries older than maxDays)', isError: true }
  }
  const days = Math.max(1, Number(args.maxDays ?? 30))
  const result = await pruneOldEntries(db, days)
  return { text: `prune: deleted ${result.deleted} unclassified entries older than ${days} days` }
}

async function _handleMemBackfill(args, config, signal) {
  // Whole-action mutex (transport-agnostic). _cycle1InFlight only protects
  // cycle1; ingest workers + cycle2 can still overlap if a second backfill
  // kicks in (timeout-retry, parallel callers, /api/tool vs /mcp vs
  // /admin/backfill). Sentinel is set synchronously before any await so a
  // burst of concurrent calls cannot all pass the check.
  if (_backfillInFlight) {
    return { text: 'backfill already in progress', isError: true }
  }
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  const window = args.window != null ? String(args.window) : '7d'
  const scope = args.scope != null ? String(args.scope) : 'all'
  const limit = args.limit != null ? Math.max(1, Number(args.limit)) : null
  // Capture the cycle2 envelope so we can route through _finalizeCycle2Run
  // (which records cycle2_last_error and clears scheduler delay only on
  // ok:true) rather than stamping cycle2 unconditionally afterward.
  let _capturedCycle2
  const promise = runFullBackfill(db, {
    window,
    scope,
    limit,
    config,
    dataDir: DATA_DIR,
    ingestTranscriptFile,
    cwdFromTranscriptPath,
    // Re-check the IPC cancel signal at every cycle1/cycle2 iteration the
    // backfill driver dispatches. handleMemoryAction only checks once
    // before dispatch; without per-iteration checkpoints a long-running
    // backfill keeps spinning through ingest + cycle1 + cycle2 batches
    // after the proxy has already responded "cancelled" to the caller.
    runCycle1: (dbArg, cycle1Config = {}, options = {}, _dir) => {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      return _awaitCycle1Run(cycle1Config, { ...options, signal })
    },
    runCycle2: async (dbArg, c2Config, c2Options, c2DataDir) => {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      const r2 = await runCycle2(dbArg, c2Config, { ...c2Options, signal }, c2DataDir)
      _capturedCycle2 = r2
      return r2
    },
  })
  _backfillInFlight = promise
  let result
  try {
    result = await promise
  } finally {
    if (_backfillInFlight === promise) _backfillInFlight = null
  }
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  if (_capturedCycle2) {
    await _finalizeCycle2Run(_capturedCycle2)
  }
  return {
    text: `backfill: window=${result.window} scope=${result.scope} files=${result.files} ingested=${result.ingested} cycle1_iters=${result.cycle1_iters} promoted=${result.promoted} unclassified=${result.unclassified}`,
  }
}

async function handleMemoryAction(args, signal) {
  // Cooperative abort check: surfaces caller-cancel (IPC cancel handler)
  // before any long DB work begins on the worker side.
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  const action = String(args.action ?? '')
  const config = readMainConfig()

  if (action === 'status') {
    return _handleMemStatus(args, config)
  }

  if (action === 'cycle1') {
    return _handleMemCycle1(args, config, signal)
  }

  if (action === 'cycle2' || action === 'sleep') {
    return _handleMemCycle2(args, config, signal)
  }

  if (action === 'cycle3') {
    return _handleMemCycle3(args, config, signal)
  }

  // Direct semantic-search surface for callers that want raw ranked rows
  // without going through the Lead-side recall synthesizer. The
  // handleSearch executor is exposed through the public `memory` tool action
  // `search` so callers can hit the hybrid CTE directly.
  if (action === 'search') {
    return handleSearch(args, signal)
  }

  if (action === 'flush') {
    return _handleMemFlush(args, config, signal)
  }

  if (action === 'rebuild') {
    return _handleMemRebuild(args, config, signal)
  }

  if (action === 'prune') {
    return _handleMemPrune(args, config)
  }

  if (action === 'backfill') {
    return _handleMemBackfill(args, config, signal)
  }

  if (action === 'ingest_session') {
    return ingestSessionMessages(args)
  }

  if (action === 'dump_session_roots') {
    return dumpSessionRootChunks(args)
  }

  if (action === 'manage') {
    const op = String(args.op ?? '').trim().toLowerCase()
    if (!['add', 'edit', 'delete'].includes(op)) {
      return { text: 'manage requires op: "add" | "edit" | "delete"', isError: true }
    }
    const VALID_CAT = new Set(['rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue'])
    const VALID_STATUS = new Set(['pending', 'active', 'archived'])

    if (op === 'add') {
      const element = String(args.element ?? '').trim()
      const summary = String(args.summary ?? args.element ?? '').trim()
      const category = String(args.category ?? 'fact').trim().toLowerCase()
      if (!element || !summary) {
        return { text: 'manage add requires element and summary', isError: true }
      }
      if (!VALID_CAT.has(category)) {
        return { text: `manage add: invalid category "${category}". Valid: ${[...VALID_CAT].join(', ')}`, isError: true }
      }
      const nowMs = Date.now()
      const sourceRef = `manual:${nowMs}-${process.pid}`
      const manageProjectId = resolveProjectScope(typeof args.cwd === 'string' && args.cwd ? args.cwd : null)
      try {
        let newId
        await db.transaction(async (tx) => {
          const result = await tx.query(`
            INSERT INTO entries(ts, role, content, source_ref, session_id, project_id)
            VALUES ($1, 'system', $2, $3, NULL, $4)
            RETURNING id
          `, [nowMs, element + ' — ' + summary, sourceRef, manageProjectId])
          newId = Number(result.rows[0].id)
          const score = computeEntryScore(category, nowMs, nowMs)
          await tx.query(`
            UPDATE entries
            SET chunk_root = $1, is_root = 1, element = $2, category = $3, summary = $4,
                status = 'active', score = $5, last_seen_at = $6
            WHERE id = $7
          `, [newId, element, category, summary, score, nowMs, newId])
        })
        await syncRootEmbedding(db, newId)
        return { text: `added (id=${newId}): [${category}] ${element} — ${summary.slice(0, 200)}` }
      } catch (e) {
        return { text: `manage add failed: ${e.message}`, isError: true }
      }
    }

    if (op === 'edit') {
      const id = Number(args.id)
      if (!Number.isFinite(id) || id <= 0) {
        return { text: 'manage edit requires numeric id', isError: true }
      }
      const existing = (await db.query(
        `SELECT id, element, summary, category, status, ts, is_root FROM entries WHERE id = $1`,
        [id]
      )).rows[0]
      if (!existing) return { text: `manage edit: no entry with id=${id}`, isError: true }
      if (existing.is_root !== 1) return { text: `manage edit: id=${id} is not a root`, isError: true }

      const trimOrNull = v => {
        if (v == null) return null
        const s = String(v).trim()
        return s === '' ? null : s
      }
      const newElement = trimOrNull(args.element)
      const newSummary = trimOrNull(args.summary)
      const newCategory = trimOrNull(args.category)?.toLowerCase() ?? null
      const newStatus = trimOrNull(args.status)?.toLowerCase() ?? null

      if (!newElement && !newSummary && !newCategory && !newStatus) {
        return { text: 'manage edit requires at least one field: element, summary, category, status', isError: true }
      }
      if (newCategory && !VALID_CAT.has(newCategory)) {
        return { text: `manage edit: invalid category "${newCategory}". Valid: ${[...VALID_CAT].join(', ')}`, isError: true }
      }
      if (newStatus && !VALID_STATUS.has(newStatus)) {
        return { text: `manage edit: invalid status "${newStatus}". Valid: ${[...VALID_STATUS].join(', ')}`, isError: true }
      }

      const finalElement = newElement ?? existing.element
      const finalSummary = newSummary ?? existing.summary
      const finalCategory = newCategory ?? existing.category
      const finalStatus = newStatus ?? existing.status
      const nowMs = Date.now()
      const score = computeEntryScore(finalCategory, nowMs, nowMs)
      const textChanged = newElement != null || newSummary != null
      // Guard null element/summary: a category/status-only edit on a root
      // whose element or summary is NULL would otherwise persist literal
      // 'null — null' content and explode on finalSummary.slice() below.
      // Use empty-string sentinels for the content composition + render so
      // the row stays consistent with what's actually stored.
      const elementStr = finalElement == null ? '' : String(finalElement)
      const summaryStr = finalSummary == null ? '' : String(finalSummary)
      const composedContent = elementStr || summaryStr
        ? `${elementStr}${summaryStr ? ' — ' + summaryStr : ''}`
        : ''

      try {
        await db.query(`
          UPDATE entries
          SET element = $1, summary = $2, category = $3, status = $4, score = $5,
              last_seen_at = $6, content = $7
          WHERE id = $8
        `, [finalElement, finalSummary, finalCategory, finalStatus, score,
            nowMs, composedContent, id])
      } catch (e) {
        return { text: `manage edit failed: ${e.message}`, isError: true }
      }
      if (textChanged) {
        try { await syncRootEmbedding(db, id) } catch (e) {
          __mixdogMemoryLog(`[memory.manage] embedding resync failed (id=${id}): ${e.message}\n`)
        }
      }
      return { text: `edited (id=${id}): [${finalCategory}/${finalStatus}] ${elementStr}${summaryStr ? ' — ' + summaryStr.slice(0, 200) : ''}` }
    }

    if (op === 'delete') {
      const id = Number(args.id)
      if (!Number.isFinite(id) || id <= 0) {
        return { text: 'manage delete requires numeric id', isError: true }
      }
      const info = (await db.query(
        `SELECT id, category, element, is_root FROM entries WHERE id = $1`,
        [id]
      )).rows[0]
      if (!info) return { text: `manage delete: no entry with id=${id}`, isError: true }
      try {
        const result = info.is_root === 1
          ? await db.query(`DELETE FROM entries WHERE id = $1 OR chunk_root = $2`, [id, id])
          : await db.query(`DELETE FROM entries WHERE id = $1`, [id])
        return { text: `deleted (id=${id}, rows=${Number(result.rowCount ?? result.affectedRows ?? 0)}): [${info.category ?? '-'}] ${info.element ?? ''}` }
      } catch (e) {
        return { text: `manage delete failed: ${e.message}`, isError: true }
      }
    }

    return { text: `manage: unhandled op "${op}"`, isError: true }
  }

  if (action === 'core') {
    const op = String(args.op ?? '').trim().toLowerCase()
    if (!['add', 'edit', 'delete', 'list'].includes(op)) {
      return { text: 'core requires op: "add" | "edit" | "delete" | "list"', isError: true }
    }
    const dataDir = (typeof DATA_DIR === 'string' ? DATA_DIR : resolvePluginData())
    if (!dataDir) return { text: 'core: memory data dir is not initialized', isError: true }
    // Local trim helper — the manage-block trimOrNull at :1807 is scoped to
    // that branch and unreachable from here.
    // Normalize project_id: 'common' (case-insensitive) or null → null (COMMON pool); non-empty string → slug.
    const hasProjectIdKey = Object.prototype.hasOwnProperty.call(args, 'project_id')
    const projectId = (() => {
      if (!hasProjectIdKey || args.project_id == null) return null
      const s = String(args.project_id).trim()
      if (s === '' || s.toLowerCase() === 'common') return null
      if (s === '*') return '*'
      return s
    })()
    try {
      if (projectId === '*' && op !== 'list') {
        return { text: `core ${op}: project_id "*" only valid for op="list"`, isError: true }
      }
      if (op === 'list') {
        if (projectId !== '*') {
          const entries = await listCore(dataDir, projectId)
          if (entries.length === 0) return { text: 'core: empty' }
          return { text: entries.map(e => `id=${e.id} [${e.category}] ${e.element} — ${String(e.summary || '').slice(0, 200)}`).join('\n') }
        }
        // Cross-pool listing — group by project_id, COMMON first
        const entries = await listCore(dataDir, '*')
        if (entries.length === 0) return { text: 'core: empty' }
        const groups = new Map()
        for (const e of entries) {
          const key = e.project_id ?? null
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(e)
        }
        const lines = []
        for (const [key, rows] of groups) {
          lines.push(`${key === null ? 'COMMON' : key}:`)
          for (const e of rows) {
            lines.push(`  id=${e.id} [${e.category}] ${e.element} — ${String(e.summary || '').slice(0, 200)}`)
          }
        }
        return { text: lines.join('\n') }
      }
      if (op === 'add') {
        if (!hasProjectIdKey) {
          return { text: 'core add: project_id required — pass "common" for COMMON pool, or project slug like "owner/repo" for scoped pool', isError: true }
        }
        const entry = await addCore(dataDir, args, projectId)
        return { text: `core added (id=${entry.id}): [${entry.category}] ${entry.element} — ${entry.summary.slice(0, 200)}` }
      }
      if (op === 'edit') {
        const entry = await editCore(dataDir, args.id, args)
        return { text: `core edited (id=${entry.id}): [${entry.category}] ${entry.element} — ${entry.summary.slice(0, 200)}` }
      }
      if (op === 'delete') {
        const removed = await deleteCore(dataDir, args.id)
        return { text: `core deleted (id=${removed.id}): [${removed.category}] ${removed.element}` }
      }
    } catch (e) {
      return { text: `core ${op} failed: ${e.message}`, isError: true }
    }
    return { text: `core: unhandled op "${op}"`, isError: true }
  }

  if (action === 'purge') {
    if (args.confirm !== 'DELETE ALL MEMORY') {
      return { text: 'purge requires confirm: "DELETE ALL MEMORY"', isError: true }
    }
    const preCount = (await db.query(`SELECT COUNT(*) c FROM entries`)).rows[0].c
    const coreCount = (await db.query(`SELECT COUNT(*) c FROM core_entries`)).rows[0].c
    try {
      await db.query(`DELETE FROM entries`)
    } catch (e) {
      return { text: `purge failed: ${e.message}`, isError: true }
    }
    return { text: `purged generated memory entries (count=${preCount}); user core preserved (core_entries=${coreCount})` }
  }

  if (action === 'retro_eval_active') {
    if (args.confirm !== 'REEVAL ACTIVE') {
      return { text: 'retro_eval_active requires confirm: "REEVAL ACTIVE" (heavy LLM batch op — reviews all active roots through the unified gate)', isError: true }
    }
    const RETRO_BATCH = 50
    const cycle2Config = config?.cycle2 || {}
    const allActive = (await db.query(
      `SELECT id, element, category, summary, score, last_seen_at, project_id, status
       FROM entries WHERE is_root = 1 AND status = 'active'
       ORDER BY reviewed_at ASC, id ASC`
    )).rows
    const total = allActive.length
    let archived = 0, kept = 0, updated = 0, merged = 0, errors = 0
    const nowMs = Date.now()
    for (let offset = 0; offset < total; offset += RETRO_BATCH) {
      const batch = allActive.slice(offset, offset + RETRO_BATCH)
      const batchIds = batch.map(r => Number(r.id))
      const activeContext = (await db.query(
        `SELECT id, element, category, summary, score, last_seen_at, project_id, status
         FROM entries WHERE is_root = 1 AND status = 'active'
         ORDER BY score DESC, last_seen_at DESC, id ASC LIMIT 200`
      )).rows
      let gateResult
      try {
        gateResult = await runUnifiedGate(db, batch, activeContext, cycle2Config, { activeCap: 200 })
      } catch (err) {
        __mixdogMemoryLog(`[retro_eval_active] runUnifiedGate failed (offset=${offset}): ${err.message}\n`)
        errors += batch.length
        continue
      }
      if (gateResult?.parseOk === false || gateResult?.actions === null) {
        errors += batch.length
        continue
      }
      const actions = gateResult?.actions ?? []
      // Separate explicit `core` summary lines from primary verbs so an
      // update/merge/active also refreshes the injected core_summary — mirrors
      // the cycle2 apply path (memory-cycle2.mjs). Without this, retro could
      // rewrite a root's summary while leaving its core_summary stale.
      const coreSummaryById = new Map()
      const primaryActions = []
      for (const a of actions) {
        if (a?.action === 'core') {
          const cid = Number(a.entry_id)
          const core = String(a.core_summary ?? '').replace(/\s+/g, ' ').trim().slice(0, CORE_SUMMARY_MAX)
          if (Number.isFinite(cid) && core) coreSummaryById.set(cid, core)
        } else {
          primaryActions.push(a)
        }
      }
      const allowed = new Set(batchIds)
      const rejected = gateResult?.rejected ?? new Set()
      // Partial-apply contract: rows the gate never returned a verdict for
      // (missingIds) must NOT be marked reviewed — they are left for a later
      // run. Exclude both rejected and missing ids from the reviewed set.
      const missing = new Set((gateResult?.missingIds ?? []).map(Number))
      const successIds = new Set(batchIds.filter(id => !rejected.has(id) && !missing.has(id)))
      for (const id of successIds) {
        try { await db.query(`UPDATE entries SET reviewed_at = $1 WHERE id = $2`, [nowMs, id]) } catch {}
      }
      const setCoreSummary = async (entryId, core) => {
        if (!core) return
        try { await db.query(`UPDATE entries SET core_summary = $1 WHERE id = $2 AND is_root = 1`, [core, Number(entryId)]) }
        catch (err) { __mixdogMemoryLog(`[retro_eval_active] core_summary update failed (id=${entryId}): ${err.message}\n`) }
      }
      if (!primaryActions.length) { kept += batch.filter(r => successIds.has(Number(r.id))).length; continue }
      const acted = new Set()
      for (const act of primaryActions) {
        try {
          const eid = Number(act?.entry_id)
          if (!Number.isFinite(eid) || !allowed.has(eid)) continue
          acted.add(eid)
          if (act.action === 'archived') {
            if (await applySimpleStatus(db, eid, 'archived')) archived += 1
          } else if (act.action === 'active') {
            // active → active is a keep verdict from the gate.
            kept += 1
            await setCoreSummary(eid, coreSummaryById.get(eid))
          } else if (act.action === 'update') {
            if (await applyUpdate(db, eid, act.element, act.summary)) updated += 1
            await setCoreSummary(eid, coreSummaryById.get(eid))
          } else if (act.action === 'merge') {
            const targetId = Number(act?.target_id)
            const sourceIds = Array.isArray(act?.source_ids) ? act.source_ids : []
            if (!Number.isFinite(targetId) || !allowed.has(targetId)) {
              __mixdogMemoryLog(`[retro_eval_active] merge target outside batch (id=${targetId})\n`)
              acted.delete(eid)
              continue
            }
            const filteredSources = sourceIds.filter(s => allowed.has(Number(s)))
            if (filteredSources.length !== sourceIds.length) {
              __mixdogMemoryLog(
                `[retro_eval_active] merge sources filtered: ${JSON.stringify(sourceIds)} -> ${JSON.stringify(filteredSources)}\n`,
              )
            }
            acted.add(targetId)
            filteredSources.forEach(s => acted.add(Number(s)))
            const moved = await applyMerge(db, targetId, filteredSources)
            if (moved > 0) {
              merged += moved
              if (typeof act.element === 'string' || typeof act.summary === 'string') {
                try {
                  if (await applyUpdate(db, targetId, act.element, act.summary)) updated += 1
                } catch (err) {
                  __mixdogMemoryLog(`[retro_eval_active] merge target update failed (target=${targetId}): ${err.message}\n`)
                }
              }
              await setCoreSummary(targetId, coreSummaryById.get(targetId) || coreSummaryById.get(eid))
            }
          }
        } catch (err) {
          __mixdogMemoryLog(`[retro_eval_active] action error (id=${act?.entry_id}): ${err.message}\n`)
          errors += 1
        }
      }
      // Entries in successIds but not acted-upon (omit / no-op) are kept.
      kept += batch.filter(r => successIds.has(Number(r.id)) && !acted.has(Number(r.id))).length
    }
    return { text: `retro_eval_active: total=${total} archived=${archived} kept=${kept} updated=${updated} merged=${merged} errors=${errors}` }
  }

  return { text: `unknown memory action: ${action}`, isError: true }
}

async function handleToolCall(name, args, signal) {
  try {
    if (name === 'search_memories') {
      const result = await handleSearch(args || {}, signal)
      return { ...result, content: [{ type: 'text', text: result.text }], isError: result.isError || false }
    }
    if (name === 'recall') {
      // recall is aiWrapped in the unified build; in standalone mode map it to
      // search_memories so the advertised tool name actually works. Forward
      // every advertised arg so id/limit/offset/sort/includeArchived/
      // includeMembers/includeRaw reach handleSearch instead of being dropped.
      const a = args || {}
      const hasQuery = Array.isArray(a.query)
        ? a.query.some((value) => String(value || '').trim())
        : String(a.query ?? '').trim() !== ''
      const recallIds = hasQuery
        ? []
        : (Array.isArray(a.id) ? a.id : [a.id])
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value > 0)
      const searchArgs = {
        ...(a.query !== undefined ? { query: a.query } : {}),
        ...(recallIds.length > 0 ? { ids: recallIds } : {}),
        ...(a.period ? { period: a.period } : {}),
        ...(a.limit !== undefined ? { limit: a.limit } : {}),
        ...(a.offset !== undefined ? { offset: a.offset } : {}),
        ...(a.sort !== undefined ? { sort: a.sort } : {}),
        ...(a.category !== undefined ? { category: a.category } : {}),
        ...(a.includeArchived !== undefined ? { includeArchived: a.includeArchived } : {}),
        ...(a.includeMembers !== undefined ? { includeMembers: a.includeMembers } : {}),
        ...(a.includeRaw !== undefined ? { includeRaw: a.includeRaw } : {}),
        ...(a.cwd ? { cwd: a.cwd } : {}),
        ...(a.projectScope ? { projectScope: a.projectScope } : {}),
        ...(a.sessionId ? { sessionId: a.sessionId } : {}),
        ...(a.session_id ? { session_id: a.session_id } : {}),
        ...(a.currentSession !== undefined ? { currentSession: a.currentSession } : {}),
      }
      const result = await handleSearch(searchArgs, signal)
      return { ...result, content: [{ type: 'text', text: result.text }], isError: result.isError || false }
    }
    if (name === 'memory') {
      const result = await handleMemoryAction(args || {}, signal)
      return { ...result, content: [{ type: 'text', text: result.text }], isError: result.isError || false }
    }
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${name} failed: ${msg}` }], isError: true }
  }
}

const mcp = new Server(
  { name: 'mixdog-memory', version: PLUGIN_VERSION },
  { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS_TEXT },
)
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))
mcp.setRequestHandler(CallToolRequestSchema, (req) => handleToolCall(req.params.name, req.params.arguments ?? {}))

function createHttpMcpServer() {
  const s = new Server(
    { name: 'mixdog-memory', version: PLUGIN_VERSION },
    { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS_TEXT },
  )
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))
  s.setRequestHandler(CallToolRequestSchema, (req) => handleToolCall(req.params.name, req.params.arguments ?? {}))
  return s
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) { resolve({}); return }
      try { resolve(JSON.parse(raw)) }
      catch (error) {
        const e = new Error(`invalid JSON body: ${error.message}`)
        e.statusCode = 400
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendError(res, msg, status = 500) {
  sendJson(res, { error: msg }, status)
}

async function awaitRuntimeReadyForHttp(res) {
  if (_initialized) return true
  if (!_initPromise) {
    sendJson(res, { error: 'memory runtime is starting' }, 503)
    return false
  }
  try {
    await _initPromise
    return true
  } catch (e) {
    sendJson(res, { error: `memory runtime failed: ${e?.message || e}` }, 503)
    return false
  }
}

// Origin/Referer guard for /admin/* mutation routes. Memory-service binds
// 127.0.0.1, but browser DNS-rebinding or a stray cross-origin fetch could
// still reach destructive endpoints (purge, backfill, entry mutations).
// Server-to-server callers (setup-server, hooks) issue raw http.request
// without a browser Origin/Referer, so absent headers pass; any non-loopback
// Origin/Referer is rejected. Mirrors setup-server.mjs isAllowedOrigin.
function isLocalOrigin(req) {
  const LOOP = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i
  const origin = req.headers.origin || ''
  const referer = req.headers.referer || ''
  if (origin && !LOOP.test(origin)) return false
  if (referer && !LOOP.test(referer)) return false
  return true
}

function normalizeCoreProjectId(value, { allowStar = false } = {}) {
  if (value == null) return null
  const s = String(value).trim()
  if (!s || s.toLowerCase() === 'common') return null
  if (allowStar && s === '*') return '*'
  return s
}

async function buildSessionCoreMemoryPayload(cwd) {
  const projectId = resolveProjectScope(typeof cwd === 'string' && cwd ? cwd : null)
  const generatedScopeClause = projectId !== null
    ? `project_id IS NULL OR project_id = $1`
    : `project_id IS NULL`
  const dbRows = (await db.query(`
    SELECT core_summary
    FROM entries
    WHERE is_root = 1
      AND status = 'active'
      AND core_summary IS NOT NULL
      AND (${generatedScopeClause})
    ORDER BY score DESC, last_seen_at DESC
  `, projectId !== null ? [projectId] : [])).rows
  const commonRows = (await db.query(
    `SELECT summary FROM core_entries WHERE project_id IS NULL ORDER BY id ASC`
  )).rows
  const scopedRows = projectId !== null
    ? (await db.query(
        `SELECT summary FROM core_entries WHERE project_id = $1 ORDER BY id ASC`,
        [projectId]
      )).rows
    : []
  return {
    projectId,
    dbLines: dbRows.map(r => String(r.core_summary || '').trim()).filter(Boolean),
    userLines: [
      ...commonRows.map(r => String(r.summary || '').trim()).filter(Boolean),
      ...scopedRows.map(r => String(r.summary || '').trim()).filter(Boolean),
    ],
  }
}

// Whole-action backfill mutex. memory-cycle1's _cycle1InFlight only protects
// cycle1; ingest workers (memory-ops-policy.mjs) and cycle2 can still overlap
// if a second backfill kicks in (e.g. setup-server timeout + retry). Track the
// in-flight promise here and reject overlaps with 409.
let _backfillInFlight = null

// Owner-side /api/tool in-flight controllers keyed by caller-supplied
// X-Mixdog-Call-Id. /api/cancel aborts the matching AbortSignal so the
// upstream handleToolCall actually stops when the fork-proxy parent cancels.
const _ownerInFlightHttpCalls = new Map()

const httpServer = http.createServer(async (req, res) => {
  touchDaemonIdleTimer(`${req.method || 'HTTP'} ${req.url || '/'}`)
  if (req.method === 'POST' && req.url === '/session-reset') {
    _bootTimestamp = Date.now()
    sendJson(res, { ok: true, bootTimestamp: _bootTimestamp })
    return
  }
  if (req.method === 'POST' && req.url === '/rebind') {
    _bootTimestamp = Date.now()
    sendJson(res, { ok: true })
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    if (!_initialized) {
      sendJson(res, { status: 'starting' }, 503)
      return
    }
    try {
      const stats = await entryStats()
      sendJson(res, {
        status: 'ok',
        worker_pid: process.pid,
        server_pid: Number(process.env.MIXDOG_SERVER_PID) || null,
        owner_lead_pid: Number(process.env.MIXDOG_OWNER_LEAD_PID) || null,
        code_fingerprint: BOOT_PROMOTION_CODE_FINGERPRINT,
        bootstrap: await isBootstrapComplete(db),
        entries: stats.total,
        roots: stats.roots,
        active_roots: stats.active_roots,
        archived_roots: stats.archived_roots,
        unchunked_leaves: stats.unchunked_leaves,
        cycle2_pending_roots: stats.cycle2_pending_roots,
        core_entries: stats.core_entries,
        core_embed_null: stats.core_embed_null,
        active_core_summaries: stats.active_core_summaries,
        active_core_summary_missing: stats.active_core_summary_missing,
        mv_hot_active_populated: stats.mv_hot_active_populated,
      })
    } catch (e) { sendError(res, e.message) }
    return
  }

  if (!await awaitRuntimeReadyForHttp(res)) return

  if (req.method === 'GET' && req.url === '/admin/entries/active') {
    try {
      const { rows } = await db.query(`
        SELECT id, element, category, summary, score, last_seen_at
        FROM entries
        WHERE is_root = 1 AND status = 'active'
        ORDER BY score DESC
      `)
      sendJson(res, { ok: true, items: rows })
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 500) }
    return
  }

  if (req.method === 'GET' && req.url === '/admin/core/entries') {
    try {
      const rows = await listCore(DATA_DIR, '*')
      sendJson(res, { ok: true, items: rows })
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 500) }
    return
  }

  if (req.method === 'POST' && req.url === '/admin/core/entries') {
    if (!isLocalOrigin(req)) {
      sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
      return
    }
    try {
      const body = await readBody(req)
      const projectId = normalizeCoreProjectId(body.project_id)
      const entry = await addCore(DATA_DIR, body, projectId)
      sendJson(res, { ok: true, item: entry })
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 500) }
    return
  }

  if (req.method === 'POST' && req.url === '/admin/core/entries/delete') {
    if (!isLocalOrigin(req)) {
      sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
      return
    }
    try {
      const body = await readBody(req)
      const removed = await deleteCore(DATA_DIR, body.id)
      sendJson(res, { ok: true, item: removed })
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 500) }
    return
  }

  if (req.method === 'POST' && req.url === '/admin/entries/status') {
    if (!isLocalOrigin(req)) {
      sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
      return
    }
    try {
      const body = await readBody(req)
      const id = Number(body.id)
      const status = String(body.status ?? '').trim().toLowerCase()
      const VALID = ['pending', 'active', 'archived']
      if (!Number.isInteger(id) || id <= 0 || !VALID.includes(status)) {
        sendJson(res, { ok: false, error: 'valid id and status required' }, 400)
        return
      }
      const result = await db.query(
        `UPDATE entries SET status = $1 WHERE id = $2 AND is_root = 1`,
        [status, id]
      )
      sendJson(res, { ok: true, changes: Number(result.rowCount ?? result.affectedRows ?? 0) })
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 500) }
    return
  }

  if (req.method === 'POST' && req.url === '/admin/entries/add') {
    if (!isLocalOrigin(req)) {
      sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
      return
    }
    try {
      const body = await readBody(req)
      const result = await handleMemoryAction({
        action: 'manage',
        op: 'add',
        element: body.element,
        summary: body.summary,
        category: body.category,
        cwd: body.cwd,
      })
      if (result.isError) {
        sendJson(res, { ok: false, error: result.text }, 400)
        return
      }
      const idMatch = String(result.text || '').match(/id=(\d+)/)
      const newId = idMatch ? Number(idMatch[1]) : null
      sendJson(res, { ok: true, id: newId, text: result.text })
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 500) }
    return
  }

  if (req.method === 'POST' && req.url === '/admin/backfill') {
    if (!isLocalOrigin(req)) {
      sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
      return
    }
    let body
    try { body = await readBody(req) }
    catch (e) { sendJson(res, { ok: false, error: e.message }, Number(e?.statusCode) || 500); return }
    try {
      const result = await handleMemoryAction({
        action: 'backfill',
        window: body.window,
        scope: body.scope,
        limit: body.limit,
      })
      if (result.isError) {
        // 'backfill already in progress' → 409, other failures → 500
        const status = result.text === 'backfill already in progress' ? 409 : 500
        sendJson(res, { ok: false, error: result.text }, status)
        return
      }
      sendJson(res, { ok: true, text: result.text })
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, 500)
    }
    return
  }

  if (req.method === 'POST' && req.url === '/admin/purge') {
    if (!isLocalOrigin(req)) {
      sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
      return
    }
    try {
      const body = await readBody(req)
      if (body?.confirm !== 'DELETE ALL MEMORY') {
        sendJson(res, { ok: false, error: 'confirm must be exactly "DELETE ALL MEMORY"' }, 400)
        return
      }
      const { rows: countRows } = await db.query(`SELECT COUNT(*) AS c FROM entries`)
      const preCount = Number(countRows[0].c)
      const { rows: coreCountRows } = await db.query(`SELECT COUNT(*) AS c FROM core_entries`)
      const coreCount = Number(coreCountRows[0].c)
      await db.transaction(async (tx) => {
        await tx.query(`DELETE FROM entries`)
      })
      sendJson(res, { ok: true, deleted: preCount, core_preserved: coreCount })
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 500) }
    return
  }

  if (req.method === 'POST' && req.url === '/admin/trace-record') {
    if (!isLocalOrigin(req)) {
      sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
      return
    }
    let body
    try { body = await readBody(req) }
    catch (e) { sendJson(res, { ok: false, error: e.message }, 400); return }
    if (!Array.isArray(body?.events)) {
      sendJson(res, { ok: false, error: 'body.events must be an array' }, 400)
      return
    }
    if (body.events.length > 500) {
      sendJson(res, { ok: false, error: 'too many events (max 500)' }, 413)
      return
    }
    if (!_traceDb) {
      try {
        _traceDb = await openTraceDatabase(DATA_DIR)
        registerTraceExitDrain(_traceDb)
      } catch (e) {
        sendJson(res, { ok: false, error: `trace DB unavailable: ${e.message}` }, 503)
        return
      }
    }
    try {
      // Enqueue for async batched flush (100ms / 500-row window).
      enqueueTraceEvents(_traceDb, body.events)
      // Use `queued` — events are async; `inserted` would imply durability.
      sendJson(res, { ok: true, queued: body.events.length })
      // Fire-and-forget into focused agent analytic tables.
      insertAgentCalls(_traceDb, body.events).catch(e =>
        __mixdogMemoryLog(`[trace] insertAgentCalls error: ${e?.message}\n`)
      )
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, 500)
    }
    return
  }

  if (req.method === 'POST' && req.url === '/session-start/core-memory') {
    try {
      const body = await readBody(req)
      const { projectId, dbLines, userLines } = await buildSessionCoreMemoryPayload(body.cwd)
      sendJson(res, { ok: true, projectId, dbLines, userLines })
    } catch (e) { sendError(res, e.message) }
    return
  }

  if (req.method === 'POST' && req.url === '/admin/shutdown') {
    if (!isLocalOrigin(req)) {
      sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
      return
    }
    sendJson(res, { shutting_down: true }, 202)
    setImmediate(() => {
      const watchdog = setTimeout(() => {
        __mixdogMemoryLog('[shutdown] watchdog fired — forcing exit after 8s\n')
        process.exit(1)
      }, 8000)
      watchdog.unref?.()
      stop()
        .then(() => { clearTimeout(watchdog); process.exit(0) })
        .catch(e => {
          __mixdogMemoryLog(`[shutdown] error ${e.message}\n`)
          clearTimeout(watchdog)
          process.exit(1)
        })
    })
    return
  }

  // DEV-ONLY cycle1 chunking bench. Gated by env MIXDOG_DEV_BENCH=1 so
   // production is untouched (route returns 404 when unset). Mirrors cycle1's
   // exact fetch query + per-session windowing, then runs each window through
   // buildCycle1ChunkPrompt + callAgentDispatch + parseCycle1LineFormat. STRICT
   // read-only — no UPDATE, no transaction, no commit.
  if (req.method === 'POST' && req.url === '/dev/cycle1-bench') {
    // Gate: env MIXDOG_DEV_BENCH=1 OR a runtime flag file, so it can be
    // toggled without restarting the host agent (env only reaches the worker
    // on a full CC restart, not via dev-sync full-restart).
    const _devBenchOn = process.env.MIXDOG_DEV_BENCH === '1'
      || (DATA_DIR && fs.existsSync(path.join(DATA_DIR, '.dev-bench-enabled')))
    if (!_devBenchOn) {
      sendJson(res, { error: 'not found' }, 404)
      return
    }
    if (!isLocalOrigin(req)) {
      sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
      return
    }
    try {
      const body = await readBody(req)
      const sets = Math.max(1, Number(body?.sets ?? 5))
      const repeat = Math.max(1, Number(body?.repeat ?? 1))
      // Optional variant matrix. Each variant: {name, rules}. rules=null → default prompt.
      const rawVariants = Array.isArray(body?.variants) ? body.variants : null
      const variants = rawVariants && rawVariants.length > 0
        ? rawVariants.map((v, i) => ({
            name: typeof v?.name === 'string' && v.name ? v.name : `variant-${i + 1}`,
            rules: Array.isArray(v?.rules) ? v.rules : null,
          }))
        : null

      // Lazy-load LLM + chunking helpers so production boot pays nothing.
      // Use the same in-process agent dispatch adapter as real cycle1 — the legacy
      // agent-ipc callAgentDispatch() path is dead in the detached standalone
      // memory daemon (no connected IPC), so the dev bench must mirror prod.
      const [{ buildCycle1ChunkPrompt, parseCycle1LineFormat }, { resolveMaintenancePreset }] = await Promise.all([
        import('./lib/memory-cycle1.mjs'),
        import('../shared/llm/index.mjs'),
      ])
      const benchCallLlm = getCycle1CallLlm()

      const CYCLE1_MIN_BATCH = 3
      const CYCLE1_SESSION_CAP = 10
      const BATCH_SIZE = 100
      const TIMEOUT_MS = 180_000
      const fetchLimit = CYCLE1_SESSION_CAP * BATCH_SIZE

      const fetchResult = await db.query(
        `SELECT id, ts, role, content, session_id, source_ref, project_id
         FROM entries
         WHERE chunk_root IS NULL AND session_id IS NOT NULL
         ORDER BY ts DESC, id DESC
         LIMIT $1`,
        [fetchLimit],
      )
      const rowsDesc = fetchResult.rows

      if (rowsDesc.length < CYCLE1_MIN_BATCH) {
        sendJson(res, {
          ok: true,
          sets, repeat,
          windowsAvailable: 0,
          note: `not enough pending rows (need >= ${CYCLE1_MIN_BATCH}, got ${rowsDesc.length})`,
          results: [],
        })
        return
      }

      // Partition by session_id — same as memory-cycle1.mjs _runCycle1Impl L207-233.
      const sessionMap = new Map()
      for (const row of rowsDesc.slice().reverse()) {
        const sid = row.session_id
        if (!sessionMap.has(sid)) sessionMap.set(sid, [])
        sessionMap.get(sid).push(row)
      }
      const windows = []
      for (const [sid, sessionRows] of sessionMap) {
        if (sessionRows.length < CYCLE1_MIN_BATCH) continue
        const windowCount = Math.max(1, Math.ceil(sessionRows.length / BATCH_SIZE))
        const baseSize = Math.floor(sessionRows.length / windowCount)
        const remainder = sessionRows.length % windowCount
        let _offset = 0
        for (let i = 0; i < windowCount; i++) {
          const size = baseSize + (i < remainder ? 1 : 0)
          windows.push({ sid, rows: sessionRows.slice(_offset, _offset + size) })
          _offset += size
        }
      }
      const chosen = windows.slice(0, sets)

      const preset = resolveMaintenancePreset('memory')

      function summariseChunks(chunks, totalEntries) {
        const usedIdx = new Set()
        for (const c of chunks) for (const i of (c._idxList || [])) usedIdx.add(i)
        const omitted = []
        for (let i = 1; i <= totalEntries; i++) if (!usedIdx.has(i)) omitted.push(i)
        return { covered: usedIdx.size, omitted }
      }

      // When variants are absent, fall back to a single implicit baseline so the
      // pre-variant call shape (single rows × repeat) keeps producing the same
      // {runs:[…]} payload the trigger already knows how to print.
      const variantList = variants ?? [{ name: 'baseline', rules: null }]

      async function runOnce(rows, customRules) {
        const userMessage = buildCycle1ChunkPrompt(rows, customRules)
        const t0 = Date.now()
        let raw, error
        try {
          raw = await benchCallLlm({
            preset,
            timeout: TIMEOUT_MS,
          }, userMessage)
        } catch (e) {
          error = e?.message ?? String(e)
        }
        const llmMs = Date.now() - t0
        if (error) return { ok: false, llmMs, error }
        const parsed = parseCycle1LineFormat(raw)
        const chunks = Array.isArray(parsed?.chunks) ? parsed.chunks : []
        const { covered, omitted } = summariseChunks(chunks, rows.length)
        const ratio = chunks.length > 0
          ? parseFloat((rows.length / chunks.length).toFixed(2))
          : null
        return {
          ok: true,
          llmMs,
          entries: rows.length,
          chunks: chunks.length,
          ratio,
          covered,
          omitted,
          chunkList: chunks.map(c => ({
            idx: c._idxList,
            element: c.element,
            category: c.category,
            summary: c.summary,
          })),
        }
      }

      const results = []
      for (let s = 0; s < chosen.length; s++) {
        const { sid, rows } = chosen[s]
        const sidShort = String(sid).slice(0, 8)
        if (variants) {
          // Variant mode: same rows, one run per variant per repeat.
          const variantResults = []
          for (const v of variantList) {
            const runs = []
            for (let r = 0; r < repeat; r++) {
              const run = await runOnce(rows, v.rules)
              runs.push({ repIdx: r + 1, ...run })
            }
            variantResults.push({ name: v.name, runs })
          }
          results.push({
            setIdx: s + 1,
            sessionIdShort: sidShort,
            entries: rows.length,
            variants: variantResults,
          })
        } else {
          // Legacy single-baseline payload shape.
          const runs = []
          for (let r = 0; r < repeat; r++) {
            const run = await runOnce(rows, null)
            runs.push({ repIdx: r + 1, ...run })
          }
          results.push({
            setIdx: s + 1,
            sessionIdShort: sidShort,
            entries: rows.length,
            runs,
          })
        }
      }
      sendJson(res, {
        ok: true,
        sets, repeat,
        windowsAvailable: windows.length,
        variants: variants ? variantList.map(v => v.name) : null,
        results,
      })
    } catch (e) {
      sendError(res, e?.message || String(e))
    }
    return
  }

  if (req.method === 'POST' && req.url === '/session-start/recap') {
    try {
      const body = await readBody(req)
      const projectId = resolveProjectScope(typeof body.cwd === 'string' && body.cwd ? body.cwd : null)
      const rows = projectId !== null
        ? (await db.query(`
            SELECT id, ts, summary FROM entries
            WHERE is_root = 1 AND (project_id IS NULL OR project_id = $1)
            ORDER BY ts DESC, id DESC LIMIT 20
          `, [projectId])).rows
        : (await db.query(`
            SELECT id, ts, summary FROM entries
            WHERE is_root = 1
            ORDER BY ts DESC, id DESC LIMIT 20
          `)).rows
      sendJson(res, { ok: true, projectId, rows })
    } catch (e) { sendError(res, e.message) }
    return
  }

  if (req.method === 'POST' && req.url === '/api/tool') {
    if (!isLocalOrigin(req)) {
      sendJson(res, { content: [{ type: 'text', text: 'forbidden: cross-origin' }], isError: true }, 403)
      return
    }
    // Owner-side cancel plumbing: the fork-proxy worker forwards parent
    // 'cancel' IPC by issuing POST /api/cancel with the same callId. Track
    // each in-flight /api/tool by its caller-supplied X-Mixdog-Call-Id so
    // the cancel endpoint can abort the AbortSignal threaded into
    // handleToolCall. Without this the proxy-side fetch aborts but the
    // owner keeps running the upstream tool to completion.
    const callId = String(req.headers['x-mixdog-call-id'] || '').trim() || null
    const ac = new AbortController()
    // Abort only on a genuine mid-flight client disconnect. The req 'close'
    // event fires on every normal request once the request body is consumed
    // (before handleToolCall resolves), so gating on it would mark normal
    // completions as aborted. Use the response side instead: when the
    // socket closes, res.writableFinished is true iff the response was
    // fully written — a real client disconnect closes the socket before
    // the response finishes, leaving writableFinished===false.
    res.on('close', () => {
      if (res.writableFinished) return
      try { ac.abort() } catch {}
    })
    if (callId) _ownerInFlightHttpCalls.set(callId, ac)
    try {
      const body = await readBody(req)
      const result = await handleToolCall(body.name, body.arguments ?? {}, ac.signal)
      sendJson(res, result)
    } catch (e) {
      sendJson(res, { content: [{ type: 'text', text: `api/tool error: ${e.message}` }], isError: true }, Number(e?.statusCode) || 500)
    } finally {
      if (callId) _ownerInFlightHttpCalls.delete(callId)
    }
    return
  }

  if (req.method === 'POST' && req.url === '/api/cancel') {
    if (!isLocalOrigin(req)) {
      sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
      return
    }
    try {
      const body = await readBody(req)
      const id = String(body.callId || '').trim()
      if (!id) { sendJson(res, { ok: false, error: 'callId required' }, 400); return }
      const ac = _ownerInFlightHttpCalls.get(id)
      if (ac) {
        try { ac.abort() } catch {}
        _ownerInFlightHttpCalls.delete(id)
        sendJson(res, { ok: true, cancelled: true })
      } else {
        sendJson(res, { ok: true, cancelled: false })
      }
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, Number(e?.statusCode) || 500)
    }
    return
  }

  if (req.url === '/mcp') {
    if (!isLocalOrigin(req)) {
      sendJson(res, { error: 'forbidden: cross-origin' }, 403)
      return
    }
    try {
      if (req.method === 'POST') {
        const httpMcp = createHttpMcpServer()
        const httpTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        })
        res.on('close', () => {
          httpTransport.close()
          void httpMcp.close()
        })
        await httpMcp.connect(httpTransport)
        const body = await readBody(req)
        await httpTransport.handleRequest(req, res, body)
      } else {
        sendJson(res, { error: 'Method not allowed' }, 405)
      }
    } catch (e) {
      __mixdogMemoryLog(`[memory-service] /mcp error: ${e.stack || e.message}\n`)
      if (!res.headersSent) sendError(res, e.message, Number(e?.statusCode) || 500)
    }
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, { error: 'Method not allowed' }, 405)
    return
  }

  // Tail block handles /entry and /ingest-transcript — both mutate the DB,
  // so apply the same cross-origin guard as /admin/* routes.
  if (!isLocalOrigin(req)) {
    sendError(res, 'forbidden: cross-origin', 403)
    return
  }

  let body
  try { body = await readBody(req) }
  catch (e) { sendError(res, e.message, Number(e?.statusCode) || 500); return }

  try {
    if (req.url === '/entry') {
      const role = String(body.role ?? 'user')
      const content = String(body.content ?? '')
      const sourceRef = String(body.sourceRef ?? `manual:${Date.now()}-${process.pid}`)
      const sessionId = body.sessionId ?? null
      const tsMs = parseTsToMs(body.ts ?? Date.now())
      if (!content) { sendJson(res, { error: 'content required' }, 400); return }
      // Run the same scrubber used by ingestTranscriptFile so noise markers
      // like "[Request interrupted by user]" and whitespace-only payloads
      // are rejected before they reach the entries table. Match the
      // existing 400 / { error } convention for invalid payloads.
      const cleaned = cleanMemoryText(content)
      if (!cleaned || !cleaned.trim()) {
        sendJson(res, { error: 'empty after clean' }, 400)
        return
      }
      const entryProjectId = resolveProjectScope(typeof body.cwd === 'string' && body.cwd ? body.cwd : null)
      try {
        const result = await db.query(`
          INSERT INTO entries(ts, role, content, source_ref, session_id, project_id)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT DO NOTHING
          RETURNING id
        `, [tsMs, role, cleaned, sourceRef, sessionId, entryProjectId])
        const insertedId = result.rows[0]?.id ?? null
        sendJson(res, { ok: true, id: insertedId !== null ? Number(insertedId) : null, changes: Number(result.rowCount ?? result.affectedRows ?? 0) })
      } catch (e) {
        sendJson(res, { error: e.message }, 500)
      }
      return
    }

    if (req.url === '/ingest-transcript') {
      const filePath = body.filePath
      if (!filePath) { sendJson(res, { error: 'filePath required' }, 400); return }
      try {
        const n = await ingestTranscriptFile(filePath, { cwd: body.cwd })
        sendJson(res, { ok: true, ingested: n })
      } catch (e) {
        sendJson(res, { error: e.message }, 500)
      }
      return
    }

    if (req.url === '/transcript/ingest-sync') {
      const filePath = body.path
      if (!filePath || typeof filePath !== 'string') {
        sendJson(res, { error: 'path required' }, 400)
        return
      }
      try {
        let stat
        try { stat = await fs.promises.stat(filePath) } catch {
          sendJson(res, { ok: true, complete: true, fileSize: 0, offsetBytes: 0 })
          return
        }
        const fileSize = stat.size
        await ingestTranscriptFile(filePath, { cwd: body.cwd })
        const off = _transcriptOffsets.get(filePath)
        const offsetBytes = off && Number.isFinite(off.bytes) ? off.bytes : 0
        const complete = offsetBytes >= fileSize
        sendJson(res, { ok: true, offsetBytes, fileSize, complete })
      } catch (e) {
        sendJson(res, { error: e.message }, 500)
      }
      return
    }

    sendJson(res, { error: 'Not found' }, 404)
  } catch (e) {
    __mixdogMemoryLog(`[memory-service] ${req.url} error: ${e.stack || e.message}\n`)
    sendError(res, e.message)
  }
})

export { TOOL_DEFS, handleToolCall, buildSessionCoreMemoryPayload }
export { MEMORY_INSTRUCTIONS_TEXT as instructions }
export { acquireLock, releaseLock }
export { cwdFromTranscriptPath }
export async function init() {
  if (_initialized) return
  __mixdogMemoryLog(`[boot-time] tag=memory-init-start tMs=${Date.now()}\n`)
  if (process.env.MIXDOG_WORKER_MODE === '1' && process.send) {
    // Single-worker daemon: acquire the owner lock (which reclaims a crashed
    // predecessor's stale, dead-PID lock). If a LIVE peer still holds it — an
    // anomaly, since server-main forks exactly one memory worker — exit so
    // server-main respawns us instead of running a second owner.
    if (!tryAcquireMemoryOwnerLock()) {
      __mixdogMemoryLog('[memory-service] live peer holds owner lock — exiting for respawn\n')
      process.exit(0)
    }
    process.on('exit', releaseMemoryOwnerLock)
  }
  const runtimeReady = _beginRuntimeInit()
  let boundPort = null
  if (!memorySecondaryMode()) {
    boundPort = await _startHttpServer()
    await runtimeReady
    advertiseMemoryPort(boundPort)
  } else {
    await runtimeReady
  }
  if (process.env.MIXDOG_WORKER_MODE === '1' && process.send) {
    __mixdogMemoryLog(`[boot-time] tag=memory-ready tMs=${Date.now()}\n`)
    process.send({ type: 'ready', port: boundPort })
  }
  __mixdogMemoryLog(`[memory-service] init() complete (entries unified mode, version=${PLUGIN_VERSION})\n`)
  touchDaemonIdleTimer('init')
}

export async function stop() {
  if (_stopPromise) return _stopPromise
  _stopPromise = (async () => {
    _stopCycles()
    if (_periodicAdvertiseTimer) {
      try { clearInterval(_periodicAdvertiseTimer) } catch {}
      _periodicAdvertiseTimer = null
    }
    _periodicAdvertiseInstalled = false
    _currentAdvertisedPort = null
    _pendingEmbeddingWarmup = null
    if (_idleShutdownTimer) {
      try { clearTimeout(_idleShutdownTimer) } catch {}
      _idleShutdownTimer = null
    }
    await stopLlmWorker()
    resetHttpListenErrorHandler()
    if (_httpBoundPort != null || _httpReadyPromise) {
      await new Promise(resolve => {
        try {
          httpServer.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }
    _httpReadyPromise = null
    _httpBoundPort = null
    activePort = BASE_PORT
    if (_traceDb) {
      try { await closeTraceDatabase(DATA_DIR) } catch {}
      _traceDb = null
    }
    await closeDatabase(DATA_DIR)
    // Stop the PG postmaster after the connection pools have been drained.
    // closeDatabase() only ends the client pool; without this the child
    // postmaster keeps running after the memory service exits.
    if (!memorySecondaryMode()) {
      try {
        const { stopPgForShutdown } = await import('./lib/pg/supervisor.mjs')
        await stopPgForShutdown()
      } catch {}
    } else {
      __mixdogMemoryLog('[memory-service] secondary mode; leaving shared PG running\n')
    }
    db = null
    mainConfig = null
    _initialized = false
    _initPromise = null
    _bootTimestamp = null
    _transcriptOffsets = new Map()
    _cycle1InFlight = null
    _cycle2InFlight = false
    _cycle3InFlight = false
    _checkCyclesInFlight = false
    releaseLock()
  })().finally(() => {
    _stopPromise = null
  })
  return _stopPromise
}

let activePort = BASE_PORT
let _httpReadyPromise = null
let _httpBoundPort = null
let _httpListenErrorHandler = null

function resetHttpListenErrorHandler() {
  if (!_httpListenErrorHandler) return
  try { httpServer.off('error', _httpListenErrorHandler) } catch {}
  _httpListenErrorHandler = null
}

function _startHttpServer() {
  if (_httpBoundPort != null) return Promise.resolve(_httpBoundPort)
  if (_httpReadyPromise) return _httpReadyPromise
  _httpReadyPromise = new Promise((resolve, reject) => {
    function tryListen() {
      httpServer.listen(activePort, '127.0.0.1', () => {
        // Use actual bound port (important when activePort=0, OS assigns a free port).
        const boundPort = httpServer.address().port
        _httpBoundPort = boundPort
        __mixdogMemoryLog(`[memory-service] HTTP listening on 127.0.0.1:${boundPort}\n`)
        resolve(boundPort)
      })
    }
    _httpListenErrorHandler = (err) => {
      if (_httpBoundPort != null) {
        __mixdogMemoryLog(`[memory-service] HTTP error: ${err?.message || err}\n`)
        return
      }
      if (err.code === 'EADDRINUSE' && activePort < MAX_PORT) {
        activePort++
        tryListen()
      } else if (err.code === 'EADDRINUSE') {
        // All fixed ports exhausted; let OS pick a free port.
        activePort = 0
        tryListen()
      } else {
        __mixdogMemoryLog(`[memory-service] HTTP fatal: ${err.message}\n`)
        resetHttpListenErrorHandler()
        reject(err)
      }
    }
    httpServer.on('error', _httpListenErrorHandler)
    tryListen()
  })
  return _httpReadyPromise
}

if (process.env.MIXDOG_WORKER_MODE === '1' && process.send) {
  // SIGTERM/SIGINT handler for worker mode: call stop() (fsyncs,
  // removes port file) then exit(0). Prevents taskkill /F from bypassing
  // graceful shutdown and leaving pgdata in an inconsistent checkpoint state.
  let _stopInFlight = false
  const _workerSignalHandler = (sig) => {
    if (_stopInFlight) {
      __mixdogMemoryLog(`[memory-worker] ${sig} — stop already in flight, ignoring\n`)
      return
    }
    _stopInFlight = true
    __mixdogMemoryLog(`[memory-worker] received ${sig} — calling stop() for clean shutdown\n`)
    const _exitTimer = setTimeout(() => {
      __mixdogMemoryLog(`[memory-worker] stop() timed out after 6000ms — forcing exit(2)\n`)
      process.exit(2)
    }, 6000)
    stop().then(() => {
      clearTimeout(_exitTimer)
      __mixdogMemoryLog(`[memory-worker] stop() complete — exiting cleanly\n`)
      process.exit(0)
    }).catch((e) => {
      clearTimeout(_exitTimer)
      __mixdogMemoryLog(`[memory-worker] stop() error on ${sig}: ${e && (e.message || e)}\n`)
      process.exit(1)
    })
  }
  process.on('SIGTERM', () => _workerSignalHandler('SIGTERM'))
  process.on('SIGINT',  () => _workerSignalHandler('SIGINT'))

  // callId → AbortController for in-flight IPC calls (cancel handler uses this).
  const _inFlightCalls = new Map()

  process.on('message', async (msg) => {
    // Handle parent-initiated graceful shutdown IPC message.
    if (msg.type === 'shutdown') {
      __mixdogMemoryLog('[memory-worker] received IPC shutdown — calling stop()\n')
      _workerSignalHandler('IPC:shutdown')
      return
    }
    if (msg.type === 'cancel' && msg.callId) {
      const entry = _inFlightCalls.get(msg.callId)
      if (entry) {
        // Mark cancelled so the in-flight call's result/error branch below
        // does not double-respond after the AbortController fires.
        entry.cancelled = true
        entry.ac.abort()
        _inFlightCalls.delete(msg.callId)
        process.send({ type: 'result', callId: msg.callId, error: 'cancelled' })
      }
      return
    }
    if (msg.type !== 'call' || !msg.callId) return
    const entry = { ac: new AbortController(), cancelled: false }
    _inFlightCalls.set(msg.callId, entry)
    try {
      let result
      try {
        result = await handleToolCall(msg.name, msg.args || {}, entry.ac.signal)
      } finally {
        _inFlightCalls.delete(msg.callId)
      }
      if (!entry.cancelled) process.send({ type: 'result', callId: msg.callId, result })
    } catch (e) {
      if (!entry.cancelled) process.send({ type: 'result', callId: msg.callId, error: e.message })
    }
  })
  init().catch(e => {
    let detail
    try {
      const parts = []
      if (e?.name) parts.push(`name=${e.name}`)
      if (e?.code) parts.push(`code=${e.code}`)
      if (e?.errno) parts.push(`errno=${e.errno}`)
      if (e?.syscall) parts.push(`syscall=${e.syscall}`)
      if (e?.path) parts.push(`path=${e.path}`)
      if (e?.message) parts.push(`message=${e.message}`)
      let stringified = null
      try { stringified = JSON.stringify(e, Object.getOwnPropertyNames(e || {})) } catch {}
      if (stringified && stringified !== '{}' && stringified !== '"{}"') parts.push(`json=${stringified}`)
      if (e?.stack) parts.push(`\nstack=\n${e.stack}`)
      if (parts.length === 0) parts.push(`raw=${typeof e}:${String(e)}`)
      detail = parts.join(' | ')
    } catch (logErr) {
      detail = `(error formatting failed: ${logErr?.message}) raw=${String(e)}`
    }
    __mixdogMemoryLog(`[memory-worker] init failed: ${detail}\n`)
    // Signal degraded state to parent before exiting so it records the failure
    // rather than treating this as a normal pre-ready crash.
    try { process.send({ type: 'ready', degraded: true, error: detail.slice(0, 800) }) } catch {}
    process.exit(1)
  })
}

// Standalone MCP launcher path. When this module is the entry script AND no
// MIXDOG_WORKER_MODE flag is set, we own stdio and bring up the full MCP
// server with acquireLock + StdioServerTransport. Server-main spawnWorker
// also forks this file with MIXDOG_WORKER_MODE='1'; that path uses the IPC
// handler block above and acquireLock/init() as the single memory owner.
if (IS_MEMORY_ENTRY && process.env.MIXDOG_WORKER_MODE !== '1') {
  ;(async () => {
    acquireLock()
    process.on('exit', releaseLock)
    process.on('SIGINT', () => { stop().finally(() => process.exit(0)) })
    process.on('SIGTERM', () => { stop().finally(() => process.exit(0)) })
    await init()
    const transport = new StdioServerTransport()
    await mcp.connect(transport)
    await new Promise((resolve) => { mcp.onclose = resolve })
    await stop()
  })().catch((err) => {
    __mixdogMemoryLog(`[memory-service] startup failed: ${err.stack || err.message}\n`)
    process.exit(1)
  })
}
