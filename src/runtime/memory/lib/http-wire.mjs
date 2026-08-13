// HTTP wire helpers extracted from index.mjs. All pure request/response
// utilities with no module state — no db, _traceDb, or timer dependencies.
// index.mjs imports these; behavior and signatures are unchanged.

export const MAX_HTTP_BODY_BYTES = 1024 * 1024

// /api/tool carries whole-session transcripts (ingest_session hydration for
// recall-fasttrack compaction). A near-window transcript projects to several
// MB of JSON, and rejecting it with 413 silently disabled auto-compaction:
// the loop fail-safe kept full history, so long sessions never shrank and
// every turn resent the entire context. The service binds loopback-only and
// the payload is bounded by the model context window, so a generous fixed
// cap is safe. All other routes keep the 1 MB default.
export const TOOL_HTTP_BODY_MAX_BYTES = 64 * 1024 * 1024

export function readBody(req, { maxBytes = MAX_HTTP_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const limit = Math.max(1, Number(maxBytes) || MAX_HTTP_BODY_BYTES)
    const contentLength = Number(req.headers?.['content-length'] || 0)
    let chunks = []
    let total = 0
    let settled = false
    const rejectTooLarge = () => {
      if (settled) return
      settled = true
      chunks = []
      const error = new Error(`request body exceeds the ${limit} byte limit`)
      error.statusCode = 413
      reject(error)
    }
    if (Number.isFinite(contentLength) && contentLength > limit) {
      req.resume?.()
      rejectTooLarge()
      return
    }
    req.on('data', c => {
      if (settled) return
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c)
      total += chunk.length
      if (total > limit) {
        rejectTooLarge()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) { resolve({}); return }
      try { resolve(JSON.parse(raw)) }
      catch (error) {
        const e = new Error(`invalid JSON body: ${error.message}`)
        e.statusCode = 400
        reject(e)
      }
    })
    req.on('error', error => {
      if (settled) return
      settled = true
      chunks = []
      reject(error)
    })
  })
}

export function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

export function sendError(res, msg, status = 500) {
  sendJson(res, { error: msg }, status)
}

// Host + Origin/Referer guard for the entire memory HTTP surface.
// Memory-service binds 127.0.0.1, but browser DNS rebinding can preserve an
// attacker-controlled Host while routing the request to loopback.
// Server-to-server callers (setup-server, hooks) issue raw http.request
// without a browser Origin/Referer, but still send a loopback Host.
export function isLocalOrigin(req) {
  const LOOP = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i
  const LOOP_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i
  const host = String(req.headers.host || '').trim()
  const origin = req.headers.origin || ''
  const referer = req.headers.referer || ''
  if (!LOOP_HOST.test(host)) return false
  if (origin && !LOOP.test(origin)) return false
  if (referer && !LOOP.test(referer)) return false
  return true
}

export function normalizeCoreProjectId(value, { allowStar = false } = {}) {
  if (value == null) return null
  const s = String(value).trim()
  if (!s || s.toLowerCase() === 'common') return null
  if (allowStar && s === '*') return '*'
  return s
}
