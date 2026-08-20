// Korean morphological analysis for the recall FTS query path.
//
// Wraps kiwi-nlp (WASM). The npm package ships ONLY the WASM binary + JS glue,
// NOT the language model — so the model archive is downloaded ONCE at boot from
// the bab2min/Kiwi GitHub Release and cached under a gitignored data dir
// (precedent: the embedding ONNX model is runtime-downloaded/cached the same
// way). No per-query network. If download or WASM init fails, analyze() returns
// null and the caller (buildFtsQuery) falls back to its prior websearch path.
//
// Lifecycle:
//   init(dataDir)  — lazy, async, idempotent, safe to call fire-and-forget at
//                    boot. Downloads+extracts model on first run, then builds
//                    the Kiwi instance. Never throws (logs once, stays null).
//   ready()        — true once the Kiwi instance is built.
//   analyze(text)  — sync; returns TokenInfo[] or null when not ready.
//   stems(text)    — sync; content-morpheme stems (NNG/NNP/VV/VA/XR/SL) or null.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { readResponseBuffer } from '../../shared/bounded-download.mjs'

// Pinned model release. The WASM package version (kiwi-nlp in package.json) and
// this model version are independent; base model is format-stable across the
// 0.2x line. Bump deliberately, never floating.
// Model version MUST match the kiwi-nlp WASM version — a mismatched model
// aborts the WASM at build() with an opaque numeric error. Pinned pair:
// kiwi-nlp@0.21.0 (package.json) + model v0.21.0 KnLM. Deliberately NOT
// 0.23.0: its base model ships CoNg (72MB, ~940MB RSS after build) vs
// KnLM's 35MB download / ~560MB build peak, and recall stemming gains
// nothing from the CoNg accuracy delta.
const KIWI_MODEL_VERSION = 'v0.21.0'
const KIWI_MODEL_ASSET = `kiwi_model_${KIWI_MODEL_VERSION}_base.tgz`
const KIWI_MODEL_URL = `https://github.com/bab2min/Kiwi/releases/download/${KIWI_MODEL_VERSION}/${KIWI_MODEL_ASSET}`
const KIWI_MODEL_ARCHIVE_BYTES = 35_791_770
const KIWI_MODEL_ARCHIVE_SHA256 = '87c7ed775a84bf05399a66e60ca01b83b18d78ab9a4145c37efc84115577c51d'
const KIWI_MODEL_TAR_MAX_BYTES = 64 * 1024 * 1024

// Model files KiwiBuilder.build({ modelFiles }) needs from the extracted
// archive (v0.21.0 base layout: KnLM = sj.knlm + sj.morph).
const REQUIRED_MODEL_FILES = [
  'combiningRule.txt', 'default.dict', 'extract.mdl', 'sj.knlm', 'sj.morph',
]
// Optional files loaded when present (loadMultiDict / loadTypoDict defaults).
const OPTIONAL_MODEL_FILES = ['multi.dict', 'skipbigram.mdl', 'typo.dict']
const ALLOWED_MODEL_FILES = new Set([...REQUIRED_MODEL_FILES, ...OPTIONAL_MODEL_FILES])

// Content-morpheme POS tags whose stems are worth indexing against search_tsv.
// NNG/NNP nouns, VV/VA predicate stems, XR root, SL foreign(latin) — matches
// the brief. Endings/particles/josa are intentionally dropped.
const CONTENT_TAGS = new Set(['NNG', 'NNP', 'VV', 'VA', 'XR', 'SL'])

let _state = 'idle' // idle | loading | ready | failed
let _initPromise = null
let _kiwi = null
let _log = () => {}
let _initMs = 0
let _idleTimer = null
// Idle window before the analyzer is released. A cold rebuild costs ~1.5-1.8s
// and BLOCKS the recall path (buildFtsQuery awaits it for Hangul queries), so a
// 60s window expired between ordinary conversational turns and made nearly
// every interactive recall pay that rebuild. 5 minutes keeps the analyzer alive
// across a normal back-and-forth while still reclaiming its ~560MB once the
// session genuinely goes quiet. MIXDOG_KO_MORPH_IDLE_TIMEOUT_MS overrides;
// 0 disables the release entirely.
const _envIdleMs = Number(process.env.MIXDOG_KO_MORPH_IDLE_TIMEOUT_MS)
const IDLE_TIMEOUT_MS = Number.isFinite(_envIdleMs) && _envIdleMs >= 0
  ? _envIdleMs
  : 300_000

export function isReady() { return _state === 'ready' && _kiwi != null }
export function state() { return _state }
function initLatencyMs() { return _initMs }

function releaseLoaded(reason = '') {
  if (_idleTimer) clearTimeout(_idleTimer)
  _idleTimer = null
  const current = _kiwi
  _kiwi = null
  _state = 'idle'
  _initPromise = null
  _initMs = 0
  try { current?.dispose?.() } catch {}
  if (current && reason) _log(`[memory-service] kiwi morph ${reason} — analyzer released\n`)
}

function touchIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer)
  if (IDLE_TIMEOUT_MS <= 0) return
  _idleTimer = setTimeout(() => releaseLoaded('idle timeout'), IDLE_TIMEOUT_MS)
  _idleTimer.unref?.()
}

function modelDir(dataDir) {
  return path.join(dataDir, 'kiwi-model', KIWI_MODEL_VERSION)
}

function hasAllRequired(dir) {
  try {
    return REQUIRED_MODEL_FILES.every(f => fs.existsSync(path.join(dir, f)))
  } catch { return false }
}

// Minimal POSIX/ustar tar reader over an already-gunzipped buffer. The pinned
// model has one `base/` directory and a fixed file set; reject links, devices,
// duplicate names, truncation, and unexpected files before writing anything.
export function _extractTar(buf, destDir) {
  let offset = 0
  let ended = false
  const entries = []
  const seen = new Set()
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    // Two consecutive zero blocks mark end of archive.
    if (header.every(b => b === 0)) {
      ended = true
      break
    }
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    if (sizeStr && !/^[0-7]+$/.test(sizeStr)) throw new Error(`kiwi model tar has invalid size: ${name}`)
    const size = sizeStr ? parseInt(sizeStr, 8) : 0
    const typeflag = String.fromCharCode(header[156]) || '0'
    // ustar prefix (name continuation) at 345..500.
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    if (prefix) name = `${prefix}/${name}`
    offset += 512
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > buf.length) {
      throw new Error(`kiwi model tar entry is truncated: ${name}`)
    }
    const body = buf.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    if (offset > buf.length) throw new Error(`kiwi model tar padding is truncated: ${name}`)
    if (typeflag === '5') {
      if (name !== 'base/' && name !== 'base') throw new Error(`kiwi model tar has unexpected directory: ${name}`)
      continue
    }
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '') {
      throw new Error(`kiwi model tar has unsupported entry type: ${name}`)
    }
    if (name.includes('\\')) throw new Error(`kiwi model tar has unsafe entry path: ${name}`)
    const parts = name.split('/').filter(Boolean)
    const base = parts[1]
    if (parts.length !== 2 || parts[0] !== 'base' || !ALLOWED_MODEL_FILES.has(base)) {
      throw new Error(`kiwi model tar has unexpected file: ${name}`)
    }
    if (seen.has(base)) throw new Error(`kiwi model tar has duplicate file: ${base}`)
    seen.add(base)
    entries.push({ base, body })
  }
  if (!ended) throw new Error('kiwi model tar is missing its end marker')
  for (const required of REQUIRED_MODEL_FILES) {
    if (!seen.has(required)) throw new Error(`kiwi model tar is missing required file: ${required}`)
  }
  for (const { base, body } of entries) fs.writeFileSync(path.join(destDir, base), body)
  return entries.map(({ base }) => base)
}

export function _verifyKiwiModelArchive(gz, {
  expectedBytes = KIWI_MODEL_ARCHIVE_BYTES,
  expectedSha256 = KIWI_MODEL_ARCHIVE_SHA256,
  maxTarBytes = KIWI_MODEL_TAR_MAX_BYTES,
} = {}) {
  if (gz.byteLength !== expectedBytes) {
    throw new Error(`kiwi model archive size mismatch: expected ${expectedBytes}, got ${gz.byteLength}`)
  }
  const actualSha256 = createHash('sha256').update(gz).digest('hex')
  if (actualSha256 !== expectedSha256) throw new Error('kiwi model archive sha256 mismatch')
  try {
    return zlib.gunzipSync(gz, { maxOutputLength: maxTarBytes })
  } catch (error) {
    throw new Error('kiwi model archive decompression failed or exceeds its limit', { cause: error })
  }
}

async function downloadAndExtractModel(dataDir) {
  const dir = modelDir(dataDir)
  if (hasAllRequired(dir)) return dir
  fs.mkdirSync(dir, { recursive: true })
  _log(`[memory-service] kiwi model missing — downloading ${KIWI_MODEL_ASSET} (~35MB) once\n`)
  const res = await fetch(KIWI_MODEL_URL, {
    redirect: 'follow',
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) throw new Error(`kiwi model download HTTP ${res.status}`)
  const gz = await readResponseBuffer(res, {
    maxBytes: KIWI_MODEL_ARCHIVE_BYTES,
    label: 'kiwi model download',
  })
  const tar = _verifyKiwiModelArchive(gz)
  _extractTar(tar, dir)
  if (!hasAllRequired(dir)) {
    throw new Error(`kiwi model extract incomplete under ${dir}`)
  }
  return dir
}

function readModelFiles(dir) {
  const modelFiles = {}
  for (const f of REQUIRED_MODEL_FILES) {
    modelFiles[f] = new Uint8Array(fs.readFileSync(path.join(dir, f)))
  }
  for (const f of OPTIONAL_MODEL_FILES) {
    const p = path.join(dir, f)
    if (fs.existsSync(p)) modelFiles[f] = new Uint8Array(fs.readFileSync(p))
  }
  return modelFiles
}

// Lazy, idempotent, never-throwing init. Fire-and-forget at boot.
export async function init(dataDir, log = () => {}) {
  _log = typeof log === 'function' ? log : (() => {})
  if (_state === 'ready') {
    touchIdleTimer()
    return true
  }
  if (_initPromise) return _initPromise
  _state = 'loading'
  const t0 = Date.now()
  _log(`[memory-service] kiwi morph init start (model ${KIWI_MODEL_VERSION})\n`)
  _initPromise = (async () => {
    // Resolve the WASM path from the installed package without hard-importing
    // (keeps the whole feature optional if kiwi-nlp isn't installed).
    // NOTE: must go through module resolution (import.meta.resolve) — a bare
    // `new URL(spec, import.meta.url)` resolves relative to THIS file's
    // directory, not node_modules.
    const { KiwiBuilder } = await import('kiwi-nlp')
    const wasmUrl = import.meta.resolve('kiwi-nlp/dist/kiwi-wasm.wasm')
    const wasmPath = wasmUrl.startsWith('file:')
      ? (await import('node:url')).fileURLToPath(wasmUrl)
      : wasmUrl
    const dir = await downloadAndExtractModel(dataDir)
    const modelFiles = readModelFiles(dir)
    const builder = await KiwiBuilder.create(wasmPath)
    // modelType 'knlm' = fast KnLM (sj.knlm); loadMultiDict/loadTypoDict only
    // engage if the optional files were present.
    _kiwi = await builder.build({ modelFiles, modelType: 'knlm' })
    _state = 'ready'
    _initMs = Date.now() - t0
    _log(`[memory-service] kiwi morph ready in ${_initMs}ms (model ${KIWI_MODEL_VERSION}, rss≈${Math.round(process.memoryUsage().rss / 1e6)}MB)\n`)
    touchIdleTimer()
    return true
  })().catch(err => {
    _state = 'failed'
    _kiwi = null
    _log(`[memory-service] kiwi morph init failed — recall stays lexical: ${err?.message || err}\n`)
    return false
  })
  return _initPromise
}

// Sync morphological analysis. Returns TokenInfo[] or null when not ready.
export function analyze(text) {
  if (!isReady()) return null
  const s = String(text ?? '')
  if (!s) return null
  try {
    const r = _kiwi.analyze(s)
    touchIdleTimer()
    return Array.isArray(r?.tokens) ? r.tokens : null
  } catch {
    return null
  }
}

// Content-morpheme stem forms for a Korean phrase. null when not ready.
// Example: an inflected Korean noun/verb phrase is reduced to content stems.
export function stems(text) {
  const tokens = analyze(text)
  if (!tokens) return null
  const out = []
  for (const t of tokens) {
    if (!t || !CONTENT_TAGS.has(t.tag)) continue
    const form = String(t.str || '').trim()
    if (form.length >= 1) out.push(form)
  }
  return out
}

export function reset() {
  releaseLoaded()
}
