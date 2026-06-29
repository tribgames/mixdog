const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

import { parentPort } from 'worker_threads'
import { createRequire } from 'module'
import { join } from 'path'
import { mkdirSync } from 'fs'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolvePluginData } from '../../shared/plugin-paths.mjs'
import {
  getConfiguredEmbeddingModelId,
  getDefaultEmbeddingDevice,
  getDefaultEmbeddingDtype,
  getEmbeddingModelLoadOptions,
  normalizeEmbeddingDtype,
} from './embedding-model-config.mjs'

const MODEL_ID = getConfiguredEmbeddingModelId()
const DEFAULT_DEVICE = getDefaultEmbeddingDevice(MODEL_ID)
const DEFAULT_DTYPE = getDefaultEmbeddingDtype(MODEL_ID)
const MODEL_LOAD_OPTIONS = getEmbeddingModelLoadOptions(MODEL_ID)
const INTRA_OP_THREADS = 1
const INTER_OP_THREADS = 1
// Session-create graph optimization. ORT defaults to 'all' (full node fusion),
// which is the bulk of the cold-load CPU spike. 'basic' trims that fusion work
// — the load gets noticeably cheaper on CPU at a negligible inference cost for
// short-text embeddings.
const GRAPH_OPT_LEVEL = 'basic'
const execFileAsync = promisify(execFile)
// Cores the worker is pinned to *during* the cold model load, to cap the
// CPU/heat (fan) of DirectML graph compilation + weight dequant — work the ORT
// thread settings cannot bound (the GPU driver compiles on its own threads).
// Full affinity is restored the instant the load resolves, so steady-state
// inference is unaffected. Lower = quieter fan, slower load.
// MIXDOG_EMBED_LOAD_CORES overrides (default 1 = single core).
const _envLoadCores = Number(process.env.MIXDOG_EMBED_LOAD_CORES)
const LOAD_AFFINITY_CORES = Number.isInteger(_envLoadCores) && _envLoadCores >= 1 ? _envLoadCores : 1
const MODEL_CACHE_DIR = join(resolvePluginData(), 'memory-models')
// Idle dispose was previously 15 min. Production profiling showed the model
// re-load cost (~3 s DirectML cold start) repeating ~880×/4 h because cycle1
// gaps exceed 15 min in normal use. Default to keep-alive (0) so the model
// stays resident for the lifetime of the worker. Set MIXDOG_EMBED_IDLE_TIMEOUT_MS
// to a positive value (in ms) to restore the prior dispose behaviour when GPU
// VRAM pressure is a concern.
const _envIdleMs = Number(process.env.MIXDOG_EMBED_IDLE_TIMEOUT_MS)
const IDLE_TIMEOUT_MS = Number.isFinite(_envIdleMs) && _envIdleMs >= 0 ? _envIdleMs : 0

let extractorPromise = null
let configuredDtype = DEFAULT_DTYPE
let _device = 'cpu'
let _idleTimer = null
let _embedInFlight = false
const _msgQueue = []
let ortPatched = false
// Actions that must hold the in-flight guard for their entire async duration.
// Inference actions hold it so concurrent embeds serialize; configure/dispose
// hold it so a new embed arriving mid-await cannot race extractorPromise
// reset / ext.dispose() while the prior extractor is still being torn down.
const GUARDED_ACTIONS = new Set(['embed', 'embed-batch', 'warmup', 'configure', 'dispose'])

function resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer)
  if (IDLE_TIMEOUT_MS <= 0) return
  _idleTimer = setTimeout(() => {
    if (extractorPromise) {
      extractorPromise.then(ext => { try { ext.dispose() } catch {} }).catch(() => {})
      extractorPromise = null
      const prevDevice = _device
      _device = 'cpu'
      __mixdogMemoryLog('[embed-worker] idle timeout — model disposed\n')
      parentPort.postMessage({ type: 'idle-dispose', device: prevDevice, dtype: configuredDtype })
    }
    _idleTimer = null
  }, IDLE_TIMEOUT_MS)
}

// Set this process's CPU affinity to `mask` (bitmask of allowed logical
// processors). Windows-only and best-effort: there is no Node API, so go
// through PowerShell; a process may set its own affinity without elevation.
// Returns true on success; non-win32 or failure returns false (caller then
// skips the matching restore).
async function setSelfAffinity(mask) {
  if (process.platform !== 'win32') return false
  try {
    await execFileAsync('powershell', ['-NoProfile', '-Command',
      `(Get-Process -Id ${process.pid}).ProcessorAffinity = ${mask}`], { timeout: 8000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

function patchOrtThreads() {
  if (ortPatched) return
  try {
    const require = createRequire(import.meta.url)
    let ort = null
    try {
      const transformersEntry = require.resolve('@huggingface/transformers')
      const transformersRequire = createRequire(transformersEntry)
      ort = transformersRequire('onnxruntime-node')
    } catch {
      ort = require('onnxruntime-node')
    }
    if (!ort?.InferenceSession?.create) {
      __mixdogMemoryLog('[embed-worker] ORT patch skipped: InferenceSession.create not found\n')
      return
    }
    const origCreate = ort.InferenceSession.create.bind(ort.InferenceSession)
    ort.InferenceSession.create = async function (pathOrBuffer, options = {}) {
      if (!options.intraOpNumThreads) options.intraOpNumThreads = INTRA_OP_THREADS
      if (!options.interOpNumThreads) options.interOpNumThreads = INTER_OP_THREADS
      if (!options.graphOptimizationLevel) options.graphOptimizationLevel = GRAPH_OPT_LEVEL
      if (options.logSeverityLevel === undefined) options.logSeverityLevel = 4
      return origCreate(pathOrBuffer, options)
    }
    ortPatched = true
    __mixdogMemoryLog(`[embed-worker] ORT patched OK: intra=${INTRA_OP_THREADS} inter=${INTER_OP_THREADS} graphOpt=${GRAPH_OPT_LEVEL}\n`)
  } catch (err) {
    __mixdogMemoryLog(`[embed-worker] ORT patch failed: ${err?.message || err}\n`)
  }
}

async function loadExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      parentPort.postMessage({ type: 'profile', record: { phase: 'baseline', model: MODEL_ID, device: _device, dtype: configuredDtype, note: 'pre-load' } })
      patchOrtThreads()
      const { pipeline, env } = await import('@huggingface/transformers')
      try { env.backends.onnx.logLevel = 'fatal' } catch {}
      env.allowLocalModels = false
      try { mkdirSync(MODEL_CACHE_DIR, { recursive: true }) } catch {}
      env.cacheDir = MODEL_CACHE_DIR
      try { env.backends.onnx.wasm.numThreads = INTRA_OP_THREADS } catch {}
      const opts = {}
      Object.assign(opts, MODEL_LOAD_OPTIONS)
      if (configuredDtype) {
        opts.dtype = configuredDtype
      }
      const startMs = Date.now()
      let extractor
      const requestedDevice = String(process.env.MIXDOG_MEMORY_EMBED_DEVICE || DEFAULT_DEVICE).trim().toLowerCase()
      const preferGpu = requestedDevice === 'dml'
        || requestedDevice === 'gpu'
        || (requestedDevice === 'auto' && process.platform === 'win32')
      // Cap CPU affinity for the heavy session-create so DirectML graph
      // compilation cannot saturate every core (the fan lever). The process
      // starts at full affinity, so the full mask is the correct restore
      // baseline; restored in the finally below.
      const _totalCores = os.cpus().length
      const _fullAffinity = (2 ** _totalCores) - 1
      const _loadAffinity = (2 ** Math.min(LOAD_AFFINITY_CORES, _totalCores)) - 1
      const affinityCapped = await setSelfAffinity(_loadAffinity)
      // Yield the cold-load CPU spike to foreground work: drop process priority
      // for the heavy session-create, then restore it the instant the load
      // resolves. setPriority is advisory (may EPERM on locked-down hosts), so
      // guard it; the finally restore is the invariant — priority never stays
      // depressed past the load.
      let priorityLowered = false
      try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); priorityLowered = true } catch {}
      try {
        if (preferGpu) {
          extractor = await pipeline('feature-extraction', MODEL_ID, { ...opts, device: 'dml' })
          _device = 'dml'
        } else {
          extractor = await pipeline('feature-extraction', MODEL_ID, { ...opts, device: 'cpu' })
          _device = 'cpu'
        }
      } finally {
        if (priorityLowered) {
          // Restore is the invariant: never leave the worker pinned at
          // BELOW_NORMAL. Retry once, then surface loudly if it still fails
          // rather than silently swallowing a stuck-low state.
          try {
            os.setPriority(0, os.constants.priority.PRIORITY_NORMAL)
          } catch {
            try {
              os.setPriority(0, os.constants.priority.PRIORITY_NORMAL)
            } catch (e) {
              __mixdogMemoryLog(`[embed-worker] WARN: process priority stuck below normal (restore failed: ${e?.message || e})\n`)
            }
          }
        }
        if (affinityCapped) {
          // Restore is the invariant: never leave the worker pinned to a core
          // subset. setSelfAffinity never throws; retry once, then warn loudly.
          let restored = await setSelfAffinity(_fullAffinity)
          if (!restored) restored = await setSelfAffinity(_fullAffinity)
          if (!restored) __mixdogMemoryLog(`[embed-worker] WARN: CPU affinity stuck on ${LOAD_AFFINITY_CORES} core(s); restore to all cores failed\n`)
        }
      }
      const loadMs = Date.now() - startMs
      __mixdogMemoryLog(`[embed-worker] loaded ${MODEL_ID} dtype=${configuredDtype} device=${_device} threads=${INTRA_OP_THREADS} in ${loadMs}ms\n`)
      parentPort.postMessage({ type: 'profile', record: { phase: 'load', model: MODEL_ID, device: _device, dtype: configuredDtype, wallMs: loadMs } })
      return extractor
    })()
  }
  return extractorPromise
}

async function processMessage(msg) {
  const { id, action } = msg
  try {
    switch (action) {
      case 'embed-batch': {
        if (_embedInFlight) {
          _msgQueue.push(msg)
          return
        }
        _embedInFlight = true
        resetIdleTimer()
        const extractor = await loadExtractor()
        const texts = Array.isArray(msg.texts) ? msg.texts : []
        if (texts.length === 0) {
          parentPort.postMessage({ id, type: 'result', vectors: [], dims: 0, wallMs: 0, device: _device, dtype: configuredDtype })
          break
        }
        const t0 = Date.now()
        const output = await extractor(texts, { pooling: 'mean', normalize: true })
        const wallMs = Date.now() - t0
        if (!output.data?.length) throw new Error(`embed-batch output missing data (model=${MODEL_ID})`)
        const total = output.data.length
        if (total % texts.length !== 0) throw new Error(`embed-batch data length ${total} not divisible by texts ${texts.length}`)
        const dims = total / texts.length
        const vectors = new Array(texts.length)
        for (let i = 0; i < texts.length; i++) vectors[i] = Array.from(output.data.subarray(i * dims, (i + 1) * dims))
        parentPort.postMessage({ id, type: 'result', vectors, dims, wallMs, device: _device, dtype: configuredDtype })
        break
        // _embedInFlight cleared in drainQueue / catch
      }
      case 'embed': {
        if (_embedInFlight) {
          // Re-queue behind current — serialize all embed calls
          _msgQueue.push(msg)
          return
        }
        _embedInFlight = true
        resetIdleTimer()
        const extractor = await loadExtractor()
        const t0 = Date.now()
        const output = await extractor(msg.text, { pooling: 'mean', normalize: true })
        const wallMs = Date.now() - t0
        if (!output.data?.length) throw new Error(`embed output missing data (model=${MODEL_ID})`)
        const dims = output.data.length
        const vector = Array.from(output.data)
        parentPort.postMessage({ id, type: 'result', vector, dims, wallMs, device: _device, dtype: configuredDtype })
        break
        // _embedInFlight cleared in finally below
      }
      case 'warmup': {
        if (_embedInFlight) {
          _msgQueue.push(msg)
          return
        }
        _embedInFlight = true
        resetIdleTimer()
        const extractor = await loadExtractor()
        const t0 = Date.now()
        const warmupOutput = await extractor('warmup', { pooling: 'mean', normalize: true })
        const wallMs = Date.now() - t0
        if (!warmupOutput.data?.length) throw new Error(`warmup output missing data (model=${MODEL_ID})`)
        const measuredDims = warmupOutput.data.length
        parentPort.postMessage({ id, type: 'result', dims: measuredDims, wallMs, device: _device, dtype: configuredDtype })
        parentPort.postMessage({ type: 'profile', record: { phase: 'warmup', model: MODEL_ID, device: _device, dtype: configuredDtype, wallMs } })
        resetIdleTimer()
        break
      }
      case 'configure': {
        if (_embedInFlight) {
          _msgQueue.push(msg)
          return
        }
        _embedInFlight = true
        if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null }
        if (msg.dtype != null) {
          configuredDtype = normalizeEmbeddingDtype(MODEL_ID, msg.dtype)
        }
        if (extractorPromise) {
          try {
            const ext = await extractorPromise
            try { ext.dispose() } catch {}
          } catch {}
          extractorPromise = null
          _device = 'cpu'
        }
        parentPort.postMessage({ id, type: 'result' })
        break
      }
      case 'dispose': {
        if (_embedInFlight) {
          _msgQueue.push(msg)
          return
        }
        _embedInFlight = true
        if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null }
        const prevDevice = _device
        if (extractorPromise) {
          try {
            const ext = await extractorPromise
            try { ext.dispose() } catch {}
          } catch {}
          extractorPromise = null
          _device = 'cpu'
        }
        parentPort.postMessage({ id, type: 'result', prevDevice, dtype: configuredDtype })
        break
      }
    }
  } catch (err) {
    parentPort.postMessage({ id, type: 'error', message: err?.message || String(err) })
    if (GUARDED_ACTIONS.has(action)) _embedInFlight = false
  }
}

async function drainQueue() {
  while (_msgQueue.length > 0) {
    const next = _msgQueue.shift()
    _embedInFlight = false
    await processMessage(next)
  }
  _embedInFlight = false
}

parentPort.on('message', async (msg) => {
  // All guarded actions (embed/embed-batch/warmup/configure/dispose) wait
  // behind any in-flight guarded action. Without queueing configure/dispose
  // here, a new embed arriving mid-dispose would bypass the queue and race
  // extractorPromise reset / ext.dispose() against the prior tear-down.
  if (_embedInFlight) {
    _msgQueue.push(msg)
    return
  }
  await processMessage(msg)
  if (GUARDED_ACTIONS.has(msg.action)) await drainQueue()
})
