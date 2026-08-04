// Per-service, SINGLE-WRITER port-advert files under RUNTIME_ROOT/discovery/.
//
// Motivation: service port discovery (memory_port, pg_port, ...) used to ride
// inside the shared active-instance.json, whose write path takes a .lock. With
// multiple terminals heartbeating and slow Windows renames, that lock could be
// held long enough to starve a port advertise for an hour+. Splitting each
// service's advert into its own file, written by its single owner via a plain
// atomic rename (NO .lock), removes the shared-lock contention entirely.
//
// Each advert is stamped with the owner pid and updatedAt. Readers prefer the
// discovery file (validating the owner pid is still alive) and callers may fall
// back to the legacy active-instance fields for cross-version compat.
import { readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeJsonAtomicSync } from './atomic-file.mjs'

function discoveryRoot() {
  const root = process.env.MIXDOG_RUNTIME_ROOT
    ? resolve(process.env.MIXDOG_RUNTIME_ROOT)
    : join(tmpdir(), 'mixdog')
  return join(root, 'discovery')
}

export function discoveryPath(service) {
  return join(discoveryRoot(), `${service}.json`)
}

function parsePid(value) {
  const pid = Number(value)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

export function isPidAlive(value) {
  const pid = parsePid(value)
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: process exists but we lack permission → alive. ESRCH → dead.
    return e?.code === 'EPERM'
  }
}

// Per-process "unreachable port" distrust set: service → { port, updatedAt,
// pid, ts } a consumer WITHOUT its own health probe proved dead this process
// (connect-failure). pid-liveness alone cannot catch a recycled owner pid: the
// advert's pid can be alive as an UNRELATED process while its advertised port
// is dead, so a pid-validated advert would keep routing consumers to a corpse
// port and suppress the legacy fallback. Consumers call markServiceUnreachable()
// on a CONNECTION-level failure (see isConnRefuseError); readLiveServiceAdvert
// then skips THAT port so the caller falls back to legacy/buffer.
//
// The entry records the advert IDENTITY at mark time (updatedAt + pid). A
// daemon restarted on the SAME port re-stamps updatedAt / gets a new pid, so
// readLiveServiceAdvert detects the change and clears the distrust — the old
// port-only key otherwise stayed distrusted for the whole process lifetime. A
// short TTL is a second self-heal so any residual false positive expires.
const _DISTRUST_TTL_MS = 30_000
const _unreachablePorts = new Map()

// Connection-level failure classifier for distrust decisions: only "nothing is
// listening / socket died on connect" justifies distrusting an advert port.
// Timeouts (slow-but-alive daemon) and HTTP/handshake status errors must NOT —
// they would false-distrust a healthy service.
const _CONN_REFUSE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH',
])
export function isConnRefuseError(err) {
  if (!err) return false
  const code = String(err.code || err.cause?.code || '')
  if (_CONN_REFUSE_CODES.has(code)) return true
  const msg = String(err.message || err.cause?.message || '')
  return /socket hang up|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/i.test(msg)
}

export function markServiceUnreachable(service, port) {
  const p = Number(port)
  if (!Number.isInteger(p) || p <= 0) return
  // Snapshot the CURRENT advert identity so a later restart on the same port is
  // detected (newer updatedAt / different pid) and the distrust auto-clears.
  const raw = readServiceAdvert(service)
  const same = raw && Number(raw.port) === p
  _unreachablePorts.set(service, {
    port: p,
    updatedAt: same ? (Number(raw.updatedAt) || 0) : 0,
    pid: same && raw.pid != null ? Number(raw.pid) : null,
    ts: Date.now(),
  })
}

// Raw read of a service advert (no validation). Returns the parsed object or
// null when absent/unreadable/partial (mid-rename).
export function readServiceAdvert(service) {
  try {
    const raw = JSON.parse(readFileSync(discoveryPath(service), 'utf8'))
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

// Validated read: returns the advert only when it carries a live port whose
// owner pid (field `pid`) is still alive. A dead owner → null (stale advert).
export function readLiveServiceAdvert(service, { requirePid = true } = {}) {
  const raw = readServiceAdvert(service)
  if (!raw) return null
  const port = Number(raw.port)
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null
  // A port a consumer already proved unreachable this process is treated as an
  // invalid advert (recycled-pid corpse guard) → fall back to legacy/buffer.
  // Self-heal: a restart on the same port re-stamps updatedAt / changes pid,
  // and a stale entry ages out — either clears the distrust and re-trusts.
  const distrust = _unreachablePorts.get(service)
  if (distrust && distrust.port === port) {
    const curUpdatedAt = Number(raw.updatedAt) || 0
    const curPid = raw.pid != null ? Number(raw.pid) : null
    const restarted = curUpdatedAt > distrust.updatedAt || curPid !== distrust.pid
    const expired = Date.now() - distrust.ts > _DISTRUST_TTL_MS
    if (restarted || expired) _unreachablePorts.delete(service)
    else return null
  }
  if (raw.pid != null) {
    if (!isPidAlive(raw.pid)) return null
  } else if (requirePid) {
    return null
  }
  return raw
}

// Convenience: live port only (or null).
export function readServicePort(service, opts) {
  const raw = readLiveServiceAdvert(service, opts)
  return raw ? Number(raw.port) : null
}

// Single-writer full-replace advert. Plain atomic rename, NO .lock. Always
// stamps updatedAt; callers pass port/pid + any extra metadata fields.
export function writeServiceAdvert(service, fields = {}) {
  const file = discoveryPath(service)
  writeJsonAtomicSync(
    file,
    { ...fields, updatedAt: Date.now() },
    { compact: true, fsyncDir: true, renameFallback: 'truncate' },
  )
  return file
}

// Single-writer merge patch: read current advert, apply fields (null/undefined
// value ⇒ delete key), re-stamp updatedAt. When the merged result no longer
// advertises a port, the file is removed (clean shutdown). Read-modify-write is
// race-free enough for a genuine single owner (only the service's supervisor
// writes its own file).
function patchServiceAdvert(service, fields = {}) {
  const cur = readServiceAdvert(service) ?? {}
  const merged = { ...cur }
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) delete merged[k]
    else merged[k] = v
  }
  const port = Number(merged.port)
  if (!Number.isInteger(port) || port <= 0) {
    // No live port left → drop the advert entirely rather than leaving a husk.
    try { unlinkSync(discoveryPath(service)) } catch {}
    return null
  }
  return writeServiceAdvert(service, merged)
}
