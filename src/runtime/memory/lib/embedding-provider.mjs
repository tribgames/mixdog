const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

/**
 * embedding-provider.mjs — Embedding provider with worker_threads isolation.
 */

import { Worker } from 'worker_threads'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { writeProfilePoint } from './model-profile.mjs'
import {
  getConfiguredEmbeddingModelId,
  getDefaultEmbeddingDtype,
  getKnownEmbeddingDims,
  normalizeEmbeddingDtype,
} from './embedding-model-config.mjs'

const MODEL_ID = getConfiguredEmbeddingModelId()

// Static dims registry — bypasses first-boot measurement for registered models.
// Validated against measured dims inside warmupEmbeddingProvider; mismatch throws.
const KNOWN_MODEL_DIMS = { [MODEL_ID]: getKnownEmbeddingDims(MODEL_ID) }

let worker = null
let _restartCount = 0
let _lastRestartMs = 0
const MAX_RESTART_BACKOFF_MS = 30_000
let cachedDims = null
let _modelReady = false
let _device = 'cpu'
let _configuredDtype = getDefaultEmbeddingDtype(MODEL_ID)
let _warmupPromise = null
let _embedCallCount = 0
let _msgId = 0
const _pending = new Map()
const EMBED_STEADY_SAMPLE_EVERY = 20
const queryEmbeddingCache = new Map()
const QUERY_EMBEDDING_CACHE_LIMIT = 1000

const WORKER_PATH = join(fileURLToPath(import.meta.url), '..', 'embedding-worker.mjs')

function cacheEmbedding(key, vector) {
  if (queryEmbeddingCache.has(key)) queryEmbeddingCache.delete(key)
  queryEmbeddingCache.set(key, vector)
  if (queryEmbeddingCache.size > QUERY_EMBEDDING_CACHE_LIMIT) {
    const oldestKey = queryEmbeddingCache.keys().next().value
    if (oldestKey) queryEmbeddingCache.delete(oldestKey)
  }
}

function getCachedEmbedding(key) {
  if (!queryEmbeddingCache.has(key)) return null
  const value = queryEmbeddingCache.get(key)
  queryEmbeddingCache.delete(key)
  queryEmbeddingCache.set(key, value)
  return value
}

function ensureWorker() {
  if (worker) return worker
  const now = Date.now()
  if (_restartCount > 0) {
    const backoffMs = Math.min(1000 * Math.pow(2, _restartCount - 1), MAX_RESTART_BACKOFF_MS)
    const elapsed = now - _lastRestartMs
    if (elapsed < backoffMs) {
      throw new Error(`embed worker in restart backoff (${Math.ceil((backoffMs - elapsed) / 1000)}s remaining)`)
    }
  }
  _lastRestartMs = now
  const execArgv = process.execArgv.filter((arg) => !String(arg).startsWith('--input-type'))
  worker = new Worker(WORKER_PATH, { env: { ...process.env }, execArgv })
  worker.on('message', (msg) => {
    if (msg.type === 'profile') {
      writeProfilePoint(msg.record)
      return
    }
    if (msg.type === 'idle-dispose') {
      cachedDims = null
      _modelReady = false
      _device = 'cpu'
      __mixdogMemoryLog('[embed] idle timeout — model disposed\n')
      writeProfilePoint({ phase: 'post-idle', model: MODEL_ID, device: msg.device, dtype: msg.dtype, note: 'idle dispose' })
      return
    }
    const pending = _pending.get(msg.id)
    if (!pending) return
    _pending.delete(msg.id)
    if (msg.type === 'error') {
      pending.reject(new Error(msg.message))
    } else {
      pending.resolve(msg)
    }
  })
  worker.on('error', (err) => {
    __mixdogMemoryLog(`[embed] worker error: ${err?.message || err}\n`)
    for (const [, p] of _pending) p.reject(err)
    _pending.clear()
    worker = null
    _modelReady = false
    _restartCount++
  })
  worker.on('exit', (code) => {
    if (code !== 0) {
      __mixdogMemoryLog(`[embed] worker exited with code ${code}\n`)
      for (const [, p] of _pending) p.reject(new Error(`Worker exited with code ${code}`))
      _pending.clear()
      _restartCount++
    } else {
      _restartCount = 0
    }
    worker = null
    _modelReady = false
  })
  return worker
}

const EMBED_WORKER_TIMEOUT_MS = 60_000

function sendToWorker(action, extra = {}, timeoutMs = EMBED_WORKER_TIMEOUT_MS) {
  const w = ensureWorker()
  const id = ++_msgId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(id)
      __mixdogMemoryLog(`[embed] worker ${action} timed out — terminating worker\n`)
      if (worker) {
        const stuck = worker
        worker = null
        _restartCount++
        stuck.terminate().catch(() => {})
      }
      reject(new Error(`embed worker ${action} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    _pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    try {
      w.postMessage({ id, action, ...extra })
    } catch (postErr) {
      clearTimeout(timer)
      _pending.delete(id)
      reject(postErr)
    }
  })
}

export function configureEmbedding(config = {}) {
  cachedDims = null
  _modelReady = false
  _device = 'cpu'
  _configuredDtype = normalizeEmbeddingDtype(MODEL_ID, config.dtype ?? process.env.MIXDOG_EMBED_DTYPE)
  queryEmbeddingCache.clear()
  if (worker) {
    sendToWorker('configure', { dtype: _configuredDtype }).catch((err) => {
      // Silent .catch hid worker reconfigure failures (dtype mismatch,
      // worker crash, IPC closed). At least one log line so cycle1 /
      // cycle2 root-cause investigation can see the upstream failure
      // instead of just the downstream `db write failed`.
      __mixdogMemoryLog(`[embed] worker configure failed: ${err?.message || err}\n`)
    })
  }
}

export function primeEmbeddingDims(dims) {
  const n = Number(dims)
  if (Number.isFinite(n) && n > 0) cachedDims = n
}

export function getEmbeddingModelId() {
  return MODEL_ID
}

export function getEmbeddingDtype() {
  return _configuredDtype
}

export function getKnownDimsForCurrentModel() {
  return KNOWN_MODEL_DIMS[MODEL_ID] ?? null
}

export function isEmbeddingModelReady() {
  return _modelReady && Boolean(cachedDims)
}

export function getEmbeddingDims() {
  if (!cachedDims) throw new Error('embedding dims not yet measured — warmup required')
  return cachedDims
}

async function runEmbeddingWarmup() {
  if (_modelReady && cachedDims) return true
  const result = await sendToWorker('warmup')
  if (!result.dims) throw new Error('warmup returned no dims — model output missing')
  const known = KNOWN_MODEL_DIMS[MODEL_ID]
  if (known != null && known !== result.dims) {
    throw new Error(
      `embedding dims invariant violation: model=${MODEL_ID} expected=${known} measured=${result.dims}`,
    )
  }
  cachedDims = result.dims
  _modelReady = true
  _device = result.device || 'cpu'
  return true
}

export function warmupEmbeddingProvider() {
  if (_modelReady && cachedDims) return Promise.resolve(true)
  if (!_warmupPromise) {
    _warmupPromise = runEmbeddingWarmup().finally(() => {
      _warmupPromise = null
    })
  }
  return _warmupPromise
}

export async function embedText(text) {
  const clean = String(text ?? '').trim()
  if (!clean) return []
  const cacheKey = `${MODEL_ID}\n${clean}`
  const cached = getCachedEmbedding(cacheKey)
  if (cached) return [...cached]

  const result = await sendToWorker('embed', { text: clean })
  if (!result.dims) throw new Error(`embed result missing dims (model=${MODEL_ID})`)
  const resultDims = result.dims
  if (cachedDims && resultDims !== cachedDims) {
    throw new Error(`embed vector dims mismatch: expected ${cachedDims}, got ${resultDims}`)
  }
  cachedDims = resultDims
  _modelReady = true
  _device = result.device || 'cpu'
  const vector = result.vector
  if (!Array.isArray(vector) || vector.length !== cachedDims) {
    throw new Error(`embed vector length mismatch: expected ${cachedDims}, got ${vector?.length}`)
  }
  cacheEmbedding(cacheKey, vector)
  _embedCallCount++
  if (_embedCallCount % EMBED_STEADY_SAMPLE_EVERY === 0) {
    writeProfilePoint({
      phase: 'steady',
      model: MODEL_ID,
      device: _device,
      dtype: result.dtype,
      wallMs: result.wallMs,
      note: `sample@${_embedCallCount}`,
    })
  }
  return vector
}

/**
 * Batch variant of embedText. Pre-warms the per-query cache so subsequent
 * single-text calls hit instantly. Invariant-preserving: each cached entry
 * follows the same MODEL_ID-keyed format as embedText, so cache hits look
 * identical regardless of whether the vector was originally produced via
 * single or batch path. Worker still serializes the single ONNX run, but
 * one batched run replaces N sequential runs.
 */
export async function embedTexts(texts) {
  if (!Array.isArray(texts)) throw new Error('embedTexts requires an array')
  const cleaned = texts.map(t => String(t ?? '').trim())
  const missing = []
  for (const t of cleaned) {
    if (!t) continue
    const key = `${MODEL_ID}\n${t}`
    if (!queryEmbeddingCache.has(key)) missing.push(t)
  }
  if (missing.length === 0) return cleaned.map(t => {
    if (!t) return []
    return [...queryEmbeddingCache.get(`${MODEL_ID}\n${t}`)]
  })
  const result = await sendToWorker('embed-batch', { texts: missing })
  if (!result.dims) throw new Error(`embed-batch result missing dims (model=${MODEL_ID})`)
  const resultDims = result.dims
  if (cachedDims && resultDims !== cachedDims) {
    throw new Error(`embed-batch vector dims mismatch: expected ${cachedDims}, got ${resultDims}`)
  }
  cachedDims = resultDims
  _modelReady = true
  _device = result.device || _device
  if (!Array.isArray(result.vectors) || result.vectors.length !== missing.length) {
    throw new Error(`embed-batch vectors count mismatch: expected ${missing.length}, got ${result.vectors?.length}`)
  }
  for (let i = 0; i < missing.length; i++) {
    const vec = result.vectors[i]
    if (!Array.isArray(vec) || vec.length !== cachedDims) {
      throw new Error(`embed-batch vector length mismatch at idx ${i}: expected ${cachedDims}, got ${vec?.length}`)
    }
    cacheEmbedding(`${MODEL_ID}\n${missing[i]}`, vec)
  }
  _embedCallCount += missing.length
  return cleaned.map(t => {
    if (!t) return []
    const cached = queryEmbeddingCache.get(`${MODEL_ID}\n${t}`)
    return cached ? [...cached] : []
  })
}
