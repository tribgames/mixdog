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

// Pinned model release. The WASM package version (kiwi-nlp in package.json) and
// this model version are independent; base model is format-stable across the
// 0.2x line. Bump deliberately, never floating.
// Model version MUST match the kiwi-nlp WASM version — a mismatched model
// aborts the WASM at build() with an opaque numeric error. Pinned pair:
// kiwi-nlp@0.21.0 (package.json) + model v0.21.0 KnLM. Deliberately NOT
// 0.23.0: its base model ships CoNg (72MB, ~940MB RSS after build) vs
// KnLM's 35MB download / ~560MB build peak, and recall stemming gains
// nothing from the CoNg accuracy delta.
export const KIWI_MODEL_VERSION = 'v0.21.0'
const KIWI_MODEL_ASSET = `kiwi_model_${KIWI_MODEL_VERSION}_base.tgz`
const KIWI_MODEL_URL = `https://github.com/bab2min/Kiwi/releases/download/${KIWI_MODEL_VERSION}/${KIWI_MODEL_ASSET}`

// Model files KiwiBuilder.build({ modelFiles }) needs from the extracted
// archive (v0.21.0 base layout: KnLM = sj.knlm + sj.morph).
const REQUIRED_MODEL_FILES = [
  'combiningRule.txt', 'default.dict', 'extract.mdl', 'sj.knlm', 'sj.morph',
]
// Optional files loaded when present (loadMultiDict / loadTypoDict defaults).
const OPTIONAL_MODEL_FILES = ['multi.dict', 'skipbigram.mdl', 'typo.dict']

// Content-morpheme POS tags whose stems are worth indexing against search_tsv.
// NNG/NNP nouns, VV/VA predicate stems, XR root, SL foreign(latin) — matches
// the brief. Endings/particles/josa are intentionally dropped.
const CONTENT_TAGS = new Set(['NNG', 'NNP', 'VV', 'VA', 'XR', 'SL'])

let _state = 'idle' // idle | loading | ready | failed
let _initPromise = null
let _kiwi = null
let _log = () => {}
let _initMs = 0

export function isReady() { return _state === 'ready' && _kiwi != null }
export function state() { return _state }
export function initLatencyMs() { return _initMs }

function modelDir(dataDir) {
  return path.join(dataDir, 'kiwi-model', KIWI_MODEL_VERSION)
}

function hasAllRequired(dir) {
  try {
    return REQUIRED_MODEL_FILES.every(f => fs.existsSync(path.join(dir, f)))
  } catch { return false }
}

// Minimal POSIX/ustar tar reader over an already-gunzipped buffer. Avoids a
// node-tar dependency for a one-shot boot extraction. Handles regular files
// (typeflag '0'/'\0') and the GNU/pax long-name records well enough for the
// flat Kiwi model archive (all entries live under a single top-level dir).
function extractTar(buf, destDir) {
  let offset = 0
  const written = []
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    // Two consecutive zero blocks mark end of archive.
    if (header.every(b => b === 0)) break
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeStr, 8) || 0
    const typeflag = String.fromCharCode(header[156]) || '0'
    // ustar prefix (name continuation) at 345..500.
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    if (prefix) name = `${prefix}/${name}`
    offset += 512
    const body = buf.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '') continue
    // Flatten: take basename only; the archive nests files under one dir.
    const base = name.split('/').filter(Boolean).pop()
    if (!base) continue
    fs.writeFileSync(path.join(destDir, base), body)
    written.push(base)
  }
  return written
}

async function downloadAndExtractModel(dataDir) {
  const dir = modelDir(dataDir)
  if (hasAllRequired(dir)) return dir
  fs.mkdirSync(dir, { recursive: true })
  _log(`[memory-service] kiwi model missing — downloading ${KIWI_MODEL_ASSET} (~35MB) once\n`)
  const res = await fetch(KIWI_MODEL_URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`kiwi model download HTTP ${res.status}`)
  const gz = Buffer.from(await res.arrayBuffer())
  const tar = zlib.gunzipSync(gz)
  extractTar(tar, dir)
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
  if (_state === 'ready') return true
  if (_initPromise) return _initPromise
  _log = typeof log === 'function' ? log : (() => {})
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
  _state = 'idle'
  _initPromise = null
  _kiwi = null
  _initMs = 0
}
