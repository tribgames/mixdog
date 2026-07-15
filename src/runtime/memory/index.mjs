#!/usr/bin/env bun
const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

process.removeAllListeners('warning')
process.on('warning', () => {})

import http from 'node:http'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

import { readPluginVersion, readPromotionCodeFingerprint } from './lib/promotion-fingerprint.mjs'
const PLUGIN_VERSION = readPluginVersion(PLUGIN_ROOT)
const BOOT_PROMOTION_CODE_FINGERPRINT = readPromotionCodeFingerprint(PLUGIN_ROOT)

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

// Static import (not the dynamic one in stop()) so the sync stop is available
// inside a process 'exit' hook, where dynamic import() cannot run.
import { stopPgForShutdownSync } from './lib/pg/supervisor.mjs'

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
  sessionMessageContentForIngest,
  shouldExcludeIngestMessage,
} from './lib/session-ingest.mjs'
import { configureEmbedding, embedText, embedTexts, getEmbeddingDims, getEmbeddingDtype, getEmbeddingModelId, getKnownDimsForCurrentModel, isEmbeddingModelReady, primeEmbeddingDims, warmupEmbeddingProvider } from './lib/embedding-provider.mjs'
import { startLlmWorker, stopLlmWorker } from './lib/llm-worker-host.mjs'
import { runCycle1, runCycle2, runCycle3, runUnifiedGate, parseInterval, syncRootEmbedding, flushRawEmbeddings, applySimpleStatus, applyUpdate, applyMerge, CYCLE2_ACTIVE_TARGET_CAP } from './lib/memory-cycle.mjs'
import { loadConfig as loadAgentConfig } from '../agent/orchestrator/config.mjs'
import { initProviders } from '../agent/orchestrator/providers/registry.mjs'
import { makeAgentDispatch } from '../agent/orchestrator/agent-runtime/agent-dispatch.mjs'
import { getInFlightCycle1 } from './lib/memory-cycle1.mjs'
import { claimAndMarkScheduledCycle, resolveCoalesceMaxRetries, scheduleCoalescedCycleRetry } from './lib/memory-cycle-requests.mjs'
import { searchRelevantHybrid } from './lib/memory-recall-store.mjs'
import { fetchEntriesByIdsScoped } from './lib/memory-recall-id-patch.mjs'
import { retrieveEntries } from './lib/memory-retrievers.mjs'
import { pruneOldEntries } from './lib/memory-maintenance-store.mjs'
import { computeEntryScore } from './lib/memory-score.mjs'
import { runFullBackfill } from './lib/memory-ops-policy.mjs'
import { listCore, addCore, editCore, deleteCore, compactCoreIds, listCoreCandidates, promoteCoreCandidate, dismissCoreCandidate, CORE_SUMMARY_MAX } from './lib/core-memory-store.mjs'
import { resolveProjectId, resolveProjectScope } from './lib/project-id-resolver.mjs'
import { openTraceDatabase, closeTraceDatabase, insertTraceEvents, enqueueTraceEvents, insertAgentCalls, registerTraceExitDrain } from './lib/trace-store.mjs'
import { updateJsonAtomicSync, writeJsonAtomicSync } from '../shared/atomic-file.mjs'
import { resolvePluginData, mixdogHome } from '../shared/plugin-paths.mjs'
import { parsePeriod, formatTs, coreRecallTerms, normalizeRecallProjectScope, sessionRecallTerms, interleaveRawRows, renderEntryLines, renderSessionGroupedLines } from './lib/recall-format.mjs'
import { readBody, sendJson, sendError, isLocalOrigin, normalizeCoreProjectId } from './lib/http-wire.mjs'
import { scheduledCycle1Signature, scheduledCycle2Signature, scheduledCycle3Signature } from './lib/cycle-signatures.mjs'
import { createTranscriptIngest } from './lib/transcript-ingest.mjs'
import { createEmbeddingWarmup } from './lib/embedding-warmup.mjs'
import { init as initKoMorph } from './lib/ko-morph.mjs'
import { createCycleLlmAdapters } from './lib/cycle-llm-adapters.mjs'
import { createCycleScheduler } from './lib/cycle-scheduler.mjs'
import { createQueryHandlers } from './lib/query-handlers.mjs'
import { createSessionIngestRuntime } from './lib/session-ingest-runtime.mjs'
import { createMemoryActionHandlers } from './lib/memory-action-handlers.mjs'
import { createHttpRouter } from './lib/http-router.mjs'
import {
  readMainConfig,
  readRecapEnabled,
  embeddingWarmupEnabled,
  envFlagEnabled,
  memorySecondaryMode,
  embeddingWarmupCanStart,
  memoryLlmWorkerEnabled,
  memoryCyclesEnabled,
  secondaryPgAdvertised as _secondaryPgAdvertised,
  assertSecondaryPgAttachable as _assertSecondaryPgAttachable,
} from './lib/memory-config-flags.mjs'
const IS_MEMORY_ENTRY = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
const USE_ARG_DATA_DIR = IS_MEMORY_ENTRY || process.env.MIXDOG_WORKER_MODE === '1'
const DATA_DIR = process.env.MIXDOG_DATA_DIR || (USE_ARG_DATA_DIR ? process.argv[2] : '') || resolvePluginData()
if (!DATA_DIR) {
  __mixdogMemoryLog('[memory-service] memory data dir not set and no explicit data dir provided\n')
  process.exit(1)
}
__mixdogMemoryLog(`[memory-service] DATA_DIR=${DATA_DIR}\n`)
const MEMORY_PROFILE_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_MEMORY_PROFILE || process.env.MIXDOG_BOOT_PROFILE || ''))
const MEMORY_PROFILE_START = performance.now()
function memoryProfile(event, fields = {}) {
  if (!MEMORY_PROFILE_ENABLED) return
  const parts = [`[memory-profile] +${(performance.now() - MEMORY_PROFILE_START).toFixed(1)}ms`, event]
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue
    parts.push(`${key}=${String(value).replace(/\s+/g, '_')}`)
  }
  __mixdogMemoryLog(`${parts.join(' ')}\n`)
}

import {
  parsePositivePid,
  isPidAliveLocal,
  tryAcquireMemoryOwnerLock as _tryAcquireMemoryOwnerLock,
  releaseMemoryOwnerLock as _releaseMemoryOwnerLock,
  killPreviousServer as _killPreviousServer,
  acquireLock as _acquireLock,
  releaseLock as _releaseLock,
} from './lib/memory-process-lock.mjs'

import {
  readServiceAdvert as _readServiceAdvert,
  writeServiceAdvert as _writeServiceAdvert,
} from '../shared/service-discovery.mjs'

const RUNTIME_ROOT = process.env.MIXDOG_RUNTIME_ROOT
  ? path.resolve(process.env.MIXDOG_RUNTIME_ROOT)
  : path.join(os.tmpdir(), 'mixdog')

let _periodicAdvertiseInstalled = false
let _periodicAdvertiseTimer = null
// Single module-level advertise retry chain. A newer advertiseMemoryPort call
// cancels the older chain so a delayed retry never replays a stale boundPort.
let _advertiseRetryTimer = null
let _advertiseGeneration = 0
// Track the most recently advertised port so the periodic tick re-reads it
// every interval. Without this the setInterval closure binds the FIRST port
// (the upstream we proxied to) and keeps re-advertising the dead upstream
// port after fork-proxy promotion swaps in our own locally-bound port.
let _currentAdvertisedPort = null

const MEMORY_SERVER_PID = parsePositivePid(process.env.MIXDOG_SERVER_PID) ?? process.pid
const _isPidAliveLocal = isPidAliveLocal
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

// ── Connected-client tracking + prompt shutdown ───────────────────────────
// The daemon is shared by multiple proxy clients (TUI host + channels worker,
// potentially several sessions). Each client registers/deregisters over HTTP
// (see /client/register, /client/deregister in lib/http-router.mjs). When the
// last client goes away we arm a short grace timer (default 10s) so a quick
// reconnect keeps the daemon warm, but an actually-closed CLI reaps the daemon
// in seconds instead of waiting out the 10-minute idle TTL (kept as backstop).
const MEMORY_CLIENT_GRACE_MS = Math.max(0, Number(process.env.MIXDOG_MEMORY_CLIENT_GRACE_MS) || 10_000)
const _connectedClients = new Map() // clientPid -> lastSeenMs
let _everHadClient = false
let _clientGraceTimer = null
let _clientSweepTimer = null

function _clientShutdownEnabled() {
  return MEMORY_DAEMON_MODE && MEMORY_CLIENT_GRACE_MS > 0
}

function pruneDeadClients() {
  for (const pid of [..._connectedClients.keys()]) {
    if (!_isPidAliveLocal(pid)) _connectedClients.delete(pid)
  }
}

function cancelClientGrace() {
  if (_clientGraceTimer) {
    try { clearTimeout(_clientGraceTimer) } catch {}
    _clientGraceTimer = null
  }
}

function armClientGrace(reason = 'last client gone') {
  if (!_clientShutdownEnabled() || _clientGraceTimer) return
  _clientGraceTimer = setTimeout(() => {
    _clientGraceTimer = null
    pruneDeadClients()
    if (_connectedClients.size > 0) return
    __mixdogMemoryLog(`[memory-service] daemon client grace elapsed (${reason}); shutting down\n`)
    stop()
      .then(() => process.exit(0))
      .catch((e) => {
        __mixdogMemoryLog(`[memory-service] daemon client-grace shutdown failed: ${e?.message || e}\n`)
        process.exit(1)
      })
  }, MEMORY_CLIENT_GRACE_MS)
  _clientGraceTimer.unref?.()
}

function startClientSweep() {
  if (_clientSweepTimer || !_clientShutdownEnabled()) return
  // Reap clients that died without deregistering so a crashed CLI still frees
  // the daemon in grace-scale time rather than waiting for the idle TTL.
  const interval = Math.max(1000, Math.min(MEMORY_CLIENT_GRACE_MS, 5000))
  _clientSweepTimer = setInterval(() => {
    pruneDeadClients()
    if (_everHadClient && _connectedClients.size === 0) armClientGrace('all clients gone (sweep)')
  }, interval)
  _clientSweepTimer.unref?.()
}

function registerClient(clientPid) {
  const pid = parsePositivePid(clientPid)
  if (!pid) return true
  // Reject registration once shutdown has begun. stop() sets _stopPromise
  // synchronously (before its first await) and, in daemon mode, always ends
  // in process.exit — so a daemon that is draining will never revive. Signal
  // the proxy (via a distinct 503) to respawn a fresh daemon instead of
  // binding to this dying one, which would fail the subsequent /api/tool.
  if (_stopPromise) return false
  _connectedClients.set(pid, Date.now())
  _everHadClient = true
  cancelClientGrace()
  startClientSweep()
  return true
}

function deregisterClient(clientPid) {
  const pid = parsePositivePid(clientPid)
  if (pid) _connectedClients.delete(pid)
  pruneDeadClients()
  if (_everHadClient && _connectedClients.size === 0) armClientGrace('last client deregistered')
}

function advertiseMemoryPort(boundPort, attempt = 0) {
  if (!Number.isFinite(boundPort) || boundPort <= 0) return
  // A fresh top-level advertise (attempt 0) supersedes any pending retry chain:
  // last write wins, so a delayed retry never clobbers a newer boundPort.
  if (attempt === 0) {
    _currentAdvertisedPort = boundPort
    _advertiseGeneration++
    if (_advertiseRetryTimer) { try { clearTimeout(_advertiseRetryTimer) } catch {} ; _advertiseRetryTimer = null }
  }
  const generation = _advertiseGeneration
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
  try {
    // Single-writer discovery file (discovery/memory.json), plain atomic rename
    // with NO .lock: memory_port discovery can never be starved by the shared
    // active-instance.json lock. Conflict guard preserved: a live OTHER memory
    // owner advertising a different port is not clobbered.
    const cur = _readServiceAdvert('memory')
    const curMemPort = Number(cur?.port)
    const curMemPid = parsePositivePid(cur?.pid)
    const portConflict = Number.isFinite(curMemPort) && curMemPort > 0 && curMemPort !== boundPort
    const otherOwnerAlive =
      curMemPid != null &&
      curMemPid !== MEMORY_SERVER_PID &&
      _isPidAliveLocal(curMemPid)
    if (portConflict && otherOwnerAlive) {
      __mixdogMemoryLog(`[memory-service] skip memory_port advertise port=${boundPort} curMemPort=${curMemPort} curMemPid=${curMemPid} memoryServerPid=${MEMORY_SERVER_PID}\n`)
      if (generation === _advertiseGeneration) _advertiseRetryTimer = null
      return
    }
    _writeServiceAdvert('memory', {
      port: boundPort,
      ...(MEMORY_SERVER_PID ? { pid: MEMORY_SERVER_PID } : {}),
    })
    if (generation === _advertiseGeneration) _advertiseRetryTimer = null
  } catch (e) {
    // Boot path must not serially block on the default 8s lock wait: use a short
    // lock timeout and treat lock contention/timeout as transient so pg_port /
    // memory_port still eventually publish via unref'd, backed-off bg retries.
    const transient =
      e?.code === 'EPERM' || e?.code === 'EBUSY' || e?.code === 'EACCES' ||
      e?.code === 'ELOCKTIMEOUT' || e?.code === 'ELOCKCONTENDED'
    if (transient && attempt < 5 && generation === _advertiseGeneration) {
      const delay = Math.min(2000, 50 * 2 ** attempt)
      // Fire-time generation re-check: even if clearTimeout was missed, a
      // retry from a superseded chain must never republish an old boundPort.
      _advertiseRetryTimer = setTimeout(() => {
        if (generation !== _advertiseGeneration) return
        advertiseMemoryPort(boundPort, attempt + 1)
      }, delay)
      _advertiseRetryTimer.unref?.()
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

function tryAcquireMemoryOwnerLock() {
  return _tryAcquireMemoryOwnerLock(OWNER_LOCK_FILE, __mixdogMemoryLog)
}

function releaseMemoryOwnerLock() {
  return _releaseMemoryOwnerLock(OWNER_LOCK_FILE)
}

const BASE_PORT = 3350
const MAX_PORT = 3357

let _traceDb = null

const MEMORY_INSTRUCTIONS_TEXT = ''

function killPreviousServer(pid) {
  return _killPreviousServer(pid, __mixdogMemoryLog)
}

function acquireLock() {
  return _acquireLock(LOCK_FILE, __mixdogMemoryLog)
}

function releaseLock() {
  return _releaseLock(LOCK_FILE)
}

let db = null
let mainConfig = null
// NOTE: cycle tick timers + the cycle1 outer-coalesce in-flight tracker now
// live inside the cycle scheduler factory (lib/cycle-scheduler.mjs). The
// AUTHORITATIVE cycle1 guard is still memory-cycle.mjs:runCycle1; the
// scheduler's outer layer coalesces simultaneous awaitCycle1Run callers.
let _initialized = false
let _initPromise = null
let _stopPromise = null
let _bootTimestamp = null
// Boot-edge background warmup. ONNX session creation on the embedding worker
// thread is CPU-heavy, so it must not overlap the worker's own init (DB open,
// schema, cycle wiring). Previously this was gated behind a fixed setTimeout —
// a wall-clock guess at "boot settled". Now the warmup is queued during
// _initStore and fired at the _initRuntime completion edge (see _initRuntime),
// so it starts the instant boot's CPU-heavy work is done — no magic-number
// delay. MIXDOG_EMBED_WARMUP=0 disables it (model loads lazily on first use).

const TRANSCRIPT_OFFSETS_KEY = 'state.transcript_offsets'
const CYCLE_LAST_RUN_KEY = 'state.cycle_last_run'
// Per-session durable high-water for untimestamped-repeat ordinals (one small
// hash→next-ordinal map per session, only for identities that reached a
// duplicate). Stored in the `meta` kv (entries schema untouched).
const SESSION_INGEST_ORDINALS_KEY_PREFIX = 'state.session_ingest_ordinals.'

// Transcript ingest cluster (extracted to lib/transcript-ingest.mjs). Live
// db/config coupling is injected so index.mjs keeps lifecycle ownership.
const _transcriptIngest = createTranscriptIngest({
  getDb: () => db,
  loadMeta: () => getMetaValue(db, TRANSCRIPT_OFFSETS_KEY, '{}'),
  persistMeta: (json) => setMetaValue(db, TRANSCRIPT_OFFSETS_KEY, json),
  projectsRoot: () => path.join(mixdogHome(), 'projects'),
  resolveProjectId,
  firstTextContent,
  cleanMemoryText,
  log: __mixdogMemoryLog,
})
const {
  loadTranscriptOffsets,
  ingestTranscriptFile,
  cwdFromTranscriptPath,
  parseTsToMs,
} = _transcriptIngest

// Session ingest runtime (extracted to lib/session-ingest-runtime.mjs). Owns
// the per-session chains, identity cache, and post-ingest raw-embedding flush
// chain; live db + parseTsToMs are injected so the facade keeps db ownership.
const _sessionIngest = createSessionIngestRuntime({
  getDb: () => db,
  log: __mixdogMemoryLog,
  parseTsToMs,
  loadOrdinalHighWater: async (sessionId) => {
    const raw = await getMetaValue(db, `${SESSION_INGEST_ORDINALS_KEY_PREFIX}${sessionId}`, 'null')
    try { return JSON.parse(raw) } catch { return null }
  },
  saveOrdinalHighWater: (sessionId, obj) =>
    setMetaValue(db, `${SESSION_INGEST_ORDINALS_KEY_PREFIX}${sessionId}`, JSON.stringify(obj)),
})
const { ingestSessionMessages } = _sessionIngest

// Boot-edge embedding warmup queue (extracted to lib/embedding-warmup.mjs).
const _embeddingWarmup = createEmbeddingWarmup({
  canStart: embeddingWarmupCanStart,
  warmup: warmupEmbeddingProvider,
  getDims: getEmbeddingDims,
  persistMeta: (metaPath, value) => writeJsonAtomicSync(metaPath, value, { lock: true }),
  log: __mixdogMemoryLog,
})

// DATA_DIR-bound wrappers over the extracted pure flag helpers (see
// ./lib/memory-config-flags.mjs). The pg-attach check needs DATA_DIR, which is
// module-local here.
function secondaryPgAdvertised() {
  return _secondaryPgAdvertised(DATA_DIR)
}

function assertSecondaryPgAttachable() {
  return _assertSecondaryPgAttachable(DATA_DIR)
}

async function _initStore() {
  const initStoreStartedAt = performance.now()
  memoryProfile('init-store:start')
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
    // Start embedding + kiwi warmup NOW so they run on their worker threads
    // during the PG ensure I/O-wait window below: openDatabase spawns/awaits
    // Postgres (I/O-bound, not CPU), so overlapping warmup there is safe and
    // lands a cold boot's first recall dense instead of lexical-fallback.
    // Both are fire-and-forget; the boot-complete fireDeferred/initKoMorph edge
    // stays an idempotent no-op fallback. schedule() respects canStart
    // (secondary/env-disabled skip → fireDeferred no-op); kiwi skips secondary.
    _embeddingWarmup.schedule(EMBEDDING_META_PATH, metaKey)
    memoryProfile('embedding:warmup:fire')
    _embeddingWarmup.fireDeferred()
    if (!memorySecondaryMode()) {
      memoryProfile('ko-morph:warmup:fire')
      initKoMorph(DATA_DIR, __mixdogMemoryLog).catch(() => {})
    }
    const openStartedAt = performance.now()
    db = await openDatabase(DATA_DIR, dimsResolved)
    memoryProfile('open-db:done', { ms: (performance.now() - openStartedAt).toFixed(1), dims: dimsResolved })
  } else {
    if (!embeddingWarmupCanStart()) {
      throw new Error('memory-service: embedding dims unavailable while warmup is disabled')
    }
    // Cold path: meta missed AND model not registered. Sequential.
    const warmupStartedAt = performance.now()
    memoryProfile('embedding:cold-warmup:start')
    await warmupEmbeddingProvider()
    memoryProfile('embedding:cold-warmup:done', { ms: (performance.now() - warmupStartedAt).toFixed(1) })
    dimsResolved = Number(getEmbeddingDims())
    assertSecondaryPgAttachable()
    // Embedding is already warm (awaited above); still fire kiwi during the PG
    // ensure I/O-wait so the first recall's FTS path is morph-aware too.
    if (!memorySecondaryMode()) {
      memoryProfile('ko-morph:warmup:fire')
      initKoMorph(DATA_DIR, __mixdogMemoryLog).catch(() => {})
    }
    const openStartedAt = performance.now()
    db = await openDatabase(DATA_DIR, dimsResolved)
    memoryProfile('open-db:done', { ms: (performance.now() - openStartedAt).toFixed(1), dims: dimsResolved })
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
  // Registry must be available whenever cycles COULD run in this process, not
  // just when they are currently enabled: recap can be toggled on at runtime
  // (memoryCyclesEnabled() now includes the recap flag), so gate registry init
  // on the cycle-capable conditions (not secondary, env not hard-disabled) OR
  // the llm worker gate — never on the runtime recap flag itself, or enabling
  // recap later would hit an empty registry and fail with "Provider not found".
  const cyclesCapable = !memorySecondaryMode() && !envFlagEnabled('MIXDOG_MEMORY_DISABLE_CYCLES')
  if (cyclesCapable || memoryLlmWorkerEnabled()) {
    try {
      const agentCfg = loadAgentConfig()
      const providersStartedAt = performance.now()
      await initProviders(agentCfg.providers || {})
      memoryProfile('providers:init:done', { ms: (performance.now() - providersStartedAt).toFixed(1) })
    } catch (e) {
      process.stderr.write(`[memory-service] initProviders failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
  _bootTimestamp = Date.now()
  const offsetsStartedAt = performance.now()
  await loadTranscriptOffsets()
  memoryProfile('transcript-offsets:loaded', { ms: (performance.now() - offsetsStartedAt).toFixed(1) })
  memoryProfile('init-store:done', { ms: (performance.now() - initStoreStartedAt).toFixed(1) })
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


// ── Cycle scheduling cluster (extracted to lib/cycle-scheduler.mjs) ────────
// The mutually-referential cycle machinery (health ledger, cycle1 outer
// coalesce layer, scheduled enqueue/retry paths, checkCycles, tick loop) lives
// in the factory below. index.mjs keeps lifecycle ownership by injecting live
// getters (getDb/getConfig/setConfig) plus runners and LLM adapters.
const CYCLE_STATE_FILE = path.join(DATA_DIR, 'memory-cycle-state.json')

const _cycleLlmAdapters = createCycleLlmAdapters({ makeAgentDispatch })
const { getCycle1CallLlm, getCycle2CallLlm, getCycle3CallLlm } = _cycleLlmAdapters

const _cycleScheduler = createCycleScheduler({
  getDb: () => db,
  getConfig: () => mainConfig,
  setConfig: (cfg) => { mainConfig = cfg },
  dataDir: DATA_DIR,
  log: __mixdogMemoryLog,
  getCycleLastRun,
  setCycleLastRun,
  readMainConfig,
  memoryCyclesEnabled,
  getCycle1CallLlm,
  getCycle2CallLlm,
  getCycle3CallLlm,
  runCycle1,
  runCycle2,
  runCycle3,
  parseInterval,
  flushRawEmbeddings,
  getInFlightCycle1,
  claimAndMarkScheduledCycle,
  resolveCoalesceMaxRetries,
  scheduleCoalescedCycleRetry,
  scheduledCycle1Signature,
  scheduledCycle2Signature,
  scheduledCycle3Signature,
  cycleStateFile: CYCLE_STATE_FILE,
})
// Cycle1 run primitives + cycle2 finalize used by MCP action handlers below.
const _startCycle1Run = _cycleScheduler.startCycle1Run
const _awaitCycle1Run = _cycleScheduler.awaitCycle1Run
const _finalizeCycle2Run = _cycleScheduler.finalizeCycle2Run
const _finalizeCycle3Run = _cycleScheduler.finalizeCycle3Run

// Transcript watcher lifecycle stays in the facade (owns _transcriptIngest);
// the cycle tick loop start/stop is delegated to the scheduler.
let _transcriptWatcher = null
function _startCycles() {
  _cycleScheduler.startCycles()
}

function _stopCycles() {
  _cycleScheduler.stopCycles()
  if (_transcriptWatcher) { try { _transcriptWatcher.stop() } catch {} _transcriptWatcher = null }
}

async function _initRuntime() {
  if (_initialized) return
  const runtimeStartedAt = performance.now()
  memoryProfile('runtime-init:start')
  await _initStore()
  memoryProfile('runtime-init:init-store-ready', { ms: (performance.now() - runtimeStartedAt).toFixed(1) })
  // Restore the core_entries.id == 1..N invariant once per boot: SERIAL only
  // increments, so deleted rows leave permanent gaps. Fast no-op when already
  // contiguous (or empty). Runs only here — never in cycle2/addCore/deleteCore.
  const compactStartedAt = performance.now()
  await compactCoreIds(DATA_DIR)
  memoryProfile('core-ids:compact:done', { ms: (performance.now() - compactStartedAt).toFixed(1) })
  // Memory module is always-on: the transcript watcher/ingest runs
  // unconditionally except in secondary mode (secondary attaches to a primary's
  // PG and must not double-ingest). The recap toggle only gates whether the
  // background cycles actually schedule work — but we still start the tick loop
  // so recap can be toggled ON at runtime (checkCycles polls recap each tick and
  // no-ops while recap is off). The env hard-override / secondary mode skip the
  // tick loop entirely.
  if (!memorySecondaryMode()) {
    _transcriptWatcher = _transcriptIngest.initTranscriptWatcher()
  } else {
    __mixdogMemoryLog('[memory-service] secondary mode; skipping transcript watcher\n')
  }
  if (!memorySecondaryMode() && !envFlagEnabled('MIXDOG_MEMORY_DISABLE_CYCLES')) {
    const cyclesStartedAt = performance.now()
    _startCycles()
    memoryProfile('cycles:start:done', { ms: (performance.now() - cyclesStartedAt).toFixed(1) })
  } else {
    __mixdogMemoryLog('[memory-service] background cycle tick loop not started (secondary/env-disabled)\n')
  }
  _initialized = true
  // Boot complete — continue straight into the deferred embedding warmup.
  // Fire-and-forget on the embedding worker thread; never awaited so it does
  // not delay init() returning or the memory-ready signal.
  memoryProfile('embedding:warmup:fire')
  _embeddingWarmup.fireDeferred()
  // Boot-edge Korean morph warmup. Same fire-and-forget style: lazy async init
  // downloads+caches the Kiwi model once under DATA_DIR/kiwi-model/<version>,
  // then builds the WASM analyzer. On any failure ko-morph stays null and
  // buildFtsQuery keeps the websearch_to_tsquery fallback (never throws here).
  // Skipped in secondary mode (query path lives on the primary).
  if (!memorySecondaryMode()) {
    memoryProfile('ko-morph:warmup:fire')
    initKoMorph(DATA_DIR, __mixdogMemoryLog).catch(() => {})
  }
  memoryProfile('runtime-init:done', { ms: (performance.now() - runtimeStartedAt).toFixed(1) })
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

const __queryHandlers = createQueryHandlers({
  getDb: () => db,
  log: __mixdogMemoryLog,
  resolveProjectScope,
  embeddingWarmupCanStart,
  getBootTimestamp: () => _bootTimestamp,
  getTraceDb: () => _traceDb,
})
const {
  readRawRowsInWindow,
  recallSessionRows,
  recallCoreRows,
  handleSearch,
  dumpSessionRootChunks,
  entryStats,
} = __queryHandlers

// ── Memory action + tool-call handlers (extracted to
// lib/memory-action-handlers.mjs). The facade keeps db/scheduler ownership and
// injects live getters plus the query/ingest/cycle primitives.
const _actionHandlers = createMemoryActionHandlers({
  getDb: () => db,
  dataDir: DATA_DIR,
  log: __mixdogMemoryLog,
  readMainConfig,
  getCycleLastRun,
  ingestSessionMessages,
  entryStats,
  handleSearch,
  dumpSessionRootChunks,
  awaitCycle1Run: _awaitCycle1Run,
  startCycle1Run: _startCycle1Run,
  finalizeCycle2Run: _finalizeCycle2Run,
  finalizeCycle3Run: _finalizeCycle3Run,
  getSchedulerCycle1InFlight: () => _cycleScheduler.getCycle1InFlight(),
  getCycle2CallLlm,
  getCycle3CallLlm,
  ingestTranscriptFile,
  cwdFromTranscriptPath,
})
const { handleMemoryAction, handleToolCall } = _actionHandlers

const mcp = new Server(
  { name: 'mixdog-memory', version: PLUGIN_VERSION },
  { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS_TEXT },
)
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))
mcp.setRequestHandler(CallToolRequestSchema, (req) => handleToolCall(req.params.name, req.params.arguments ?? {}))

// ── HTTP request router (extracted to lib/http-router.mjs). The facade owns
// the http.Server + listen/stop lifecycle; the router builds the request
// handler and buildSessionCoreMemoryPayload from injected live state.
const _httpRouter = createHttpRouter({
  getDb: () => db,
  dataDir: DATA_DIR,
  log: __mixdogMemoryLog,
  pluginVersion: PLUGIN_VERSION,
  bootPromotionCodeFingerprint: BOOT_PROMOTION_CODE_FINGERPRINT,
  touchDaemonIdleTimer,
  entryStats,
  cycleScheduler: _cycleScheduler,
  getInitialized: () => _initialized,
  getInitPromise: () => _initPromise,
  setBootTimestamp: (v) => { _bootTimestamp = v },
  handleMemoryAction,
  handleToolCall,
  stop,
  registerClient,
  deregisterClient,
  getDraining: () => _stopPromise != null,
  getTraceDb: () => _traceDb,
  setTraceDb: (v) => { _traceDb = v },
  ingestTranscriptFile,
  getTranscriptOffset: (fp) => _transcriptIngest.getOffset(fp),
  parseTsToMs,
})
const buildSessionCoreMemoryPayload = _httpRouter.buildSessionCoreMemoryPayload
const httpServer = http.createServer(_httpRouter.requestHandler)

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
    advertiseMemoryPort(boundPort)
    try {
      await runtimeReady
    } catch (e) {
      // Runtime init failed AFTER we advertised the HTTP port. Leaving the
      // listener up would answer discovery with a live 503, which
      // memory-client treats as a delivered (non-buffered) write — silently
      // dropping entries that would otherwise be buffered when no port is
      // advertised. stop() withdraws the advert (clears _currentAdvertisedPort
      // + cancels the periodic re-advertise) and closes the HTTP server, so
      // clients see conn-refused and buffer/respawn instead.
      try { await stop() } catch {}
      throw e
    }
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
    if (_advertiseRetryTimer) {
      try { clearTimeout(_advertiseRetryTimer) } catch {}
      _advertiseRetryTimer = null
    }
    _advertiseGeneration++
    _periodicAdvertiseInstalled = false
    _currentAdvertisedPort = null
    _embeddingWarmup.reset()
    if (_idleShutdownTimer) {
      try { clearTimeout(_idleShutdownTimer) } catch {}
      _idleShutdownTimer = null
    }
    cancelClientGrace()
    if (_clientSweepTimer) {
      try { clearInterval(_clientSweepTimer) } catch {}
      _clientSweepTimer = null
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
        // Conservative check: only skip stopPgForShutdown when the owner
        // record is unambiguously (a) a memory-runtime-daemon owner record
        // (kind check — guards against a stale/foreign pid reusing this pid
        // number for an unrelated process) and (b) that pid is alive AND not
        // this process. Any read/parse failure or ambiguous state falls back
        // to stopping PG (previous unconditional behavior) rather than
        // risking an orphaned PG postmaster.
        const anotherOwnerAlive = await (async () => {
          try {
            const { readSingletonOwner } = await import('../shared/singleton-owner.mjs')
            const ownerPath = path.join(DATA_DIR, 'memory-runtime-owner.json')
            const { owner, alive } = readSingletonOwner(ownerPath)
            if (!alive) return false
            if (owner?.kind !== 'memory-runtime-daemon') return false
            const ownerPid = Number(owner?.pid)
            if (!Number.isInteger(ownerPid) || ownerPid === process.pid) return false
            // Best-effort process-name check (mirrors supervisor.mjs's
            // isPostgresPid pattern) — confirms the pid is actually a node
            // process before trusting it as a live sibling memory owner.
            // Falls back to true (trust the owner file) when the platform
            // check is unavailable or inconclusive.
            try {
              if (process.platform === 'win32') {
                const { execFileSync } = await import('node:child_process')
                const out = execFileSync('tasklist', ['/FI', `PID eq ${ownerPid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
                if (!String(out || '').toLowerCase().includes('node')) return false
              } else if (process.platform === 'linux') {
                const comm = fs.readFileSync(`/proc/${ownerPid}/comm`, 'utf8').trim()
                if (!comm.includes('node')) return false
              }
            } catch { /* inconclusive — trust the owner file (already alive+kind-matched) */ }
            return true
          } catch { return false }
        })()
        if (anotherOwnerAlive) {
          __mixdogMemoryLog('[memory-service] shutdown: another live memory owner holds memory-runtime-owner.json — leaving PG running\n')
        } else {
          const { stopPgForShutdown } = await import('./lib/pg/supervisor.mjs')
          await stopPgForShutdown()
        }
      } catch {}
    } else {
      __mixdogMemoryLog('[memory-service] secondary mode; leaving shared PG running\n')
    }
    db = null
    mainConfig = null
    _initialized = false
    _initPromise = null
    _bootTimestamp = null
    _transcriptIngest.resetOffsets()
    _cycleScheduler.resetInFlight()
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
  let _syncPgStopRequested = false
  const _workerSignalHandler = (sig) => {
    if (_stopInFlight) {
      __mixdogMemoryLog(`[memory-worker] ${sig} — stop already in flight, ignoring\n`)
      return
    }
    _stopInFlight = true
    _syncPgStopRequested = true
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

  // Windows-safe last resort: SIGTERM may TerminateProcess before the async
  // stop() path runs, orphaning PG mid-write. Best-effort sync pg_ctl stop on
  // exit (no-op after a completed graceful stop). Skip in secondary mode — we
  // do not own the shared PG there.
  if (!memorySecondaryMode()) process.on('exit', () => {
    // Do not stop shared PG on an unexpected Memory crash. The singleton proxy
    // will respawn a daemon that can attach to the still-healthy cluster. The
    // sync stop is only a last resort after an explicit shutdown signal began.
    if (_syncPgStopRequested) {
      try { stopPgForShutdownSync() } catch {}
    }
  })

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
    let syncPgStopRequested = false
    if (!memorySecondaryMode()) process.on('exit', () => {
      if (syncPgStopRequested) {
        try { stopPgForShutdownSync() } catch {}
      }
    })
    const stopFromSignal = () => {
      syncPgStopRequested = true
      stop().finally(() => process.exit(0))
    }
    process.on('SIGINT', stopFromSignal)
    process.on('SIGTERM', stopFromSignal)
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
