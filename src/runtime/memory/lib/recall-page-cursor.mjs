import { createHash } from 'node:crypto'

const PREFIX = 'r1.'

function contextKey(context) {
  return createHash('sha256')
    .update(JSON.stringify(context ?? {}))
    .digest('base64url')
    .slice(0, 16)
}

export function encodeRecallPageCursor({ lastTs, sessionId, context }) {
  const ts = Number(lastTs)
  const sid = String(sessionId || '').trim()
  if (!Number.isFinite(ts) || !sid) return null
  const payload = JSON.stringify({ v: 1, t: ts, s: sid, k: contextKey(context) })
  return PREFIX + Buffer.from(payload, 'utf8').toString('base64url')
}

export function decodeRecallPageCursor(value, context) {
  const token = String(value || '').trim()
  if (!token.startsWith(PREFIX)) throw new Error('invalid recall cursor')
  let payload
  try {
    payload = JSON.parse(Buffer.from(token.slice(PREFIX.length), 'base64url').toString('utf8'))
  } catch {
    throw new Error('invalid recall cursor')
  }
  const ts = Number(payload?.t)
  const sid = String(payload?.s || '').trim()
  if (payload?.v !== 1 || !Number.isFinite(ts) || !sid || payload?.k !== contextKey(context)) {
    throw new Error('recall cursor does not match this query/scope')
  }
  return { lastTs: ts, sessionId: sid }
}
