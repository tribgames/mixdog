// HTTP wire helpers extracted from index.mjs. All pure request/response
// utilities with no module state — no db, _traceDb, or timer dependencies.
// index.mjs imports these; behavior and signatures are unchanged.

export function readBody(req) {
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

export function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function sendError(res, msg, status = 500) {
  sendJson(res, { error: msg }, status)
}

// Origin/Referer guard for /admin/* mutation routes. Memory-service binds
// 127.0.0.1, but browser DNS-rebinding or a stray cross-origin fetch could
// still reach destructive endpoints (purge, backfill, entry mutations).
// Server-to-server callers (setup-server, hooks) issue raw http.request
// without a browser Origin/Referer, so absent headers pass; any non-loopback
// Origin/Referer is rejected. Mirrors setup-server.mjs isAllowedOrigin.
export function isLocalOrigin(req) {
  const LOOP = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i
  const origin = req.headers.origin || ''
  const referer = req.headers.referer || ''
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
