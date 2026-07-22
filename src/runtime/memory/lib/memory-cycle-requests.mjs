import { __mixdogMemoryLog } from './memory-log.mjs';

const VALID_CYCLES = new Set(['cycle1', 'cycle2', 'cycle3'])
const KEY_PREFIX = 'cycle_request.'
const _retryTimersByDb = new WeakMap()

function normalizeSignaturePart(value, depth = 0) {
  if (depth > 4) return '[depth]'
  if (value == null) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(v => normalizeSignaturePart(v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (key === 'signal' || key === 'coalescedRetry') continue
      const v = value[key]
      if (typeof v === 'function' || typeof v === 'undefined') continue
      out[key] = normalizeSignaturePart(v, depth + 1)
    }
    return out
  }
  return String(value)
}

function shortHash(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(36)
}

export function makeCycleRequestSignature(...parts) {
  const text = JSON.stringify(parts.map(p => normalizeSignaturePart(p)))
  return shortHash(text)
}

function cycleRequestKey(kind, signature = 'default') {
  const normalized = String(kind || '').trim().toLowerCase()
  if (!VALID_CYCLES.has(normalized)) throw new Error(`invalid cycle request kind: ${kind}`)
  const sig = String(signature || 'default').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120)
  return `${KEY_PREFIX}${normalized}.${sig}`
}

function cycleScheduleKey(kind, signature = 'default') {
  const normalized = String(kind || '').trim().toLowerCase()
  if (!VALID_CYCLES.has(normalized)) throw new Error(`invalid cycle schedule kind: ${kind}`)
  const sig = String(signature || 'default').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120)
  return `cycle_schedule.${normalized}.${sig}`
}

export async function claimScheduledCycle(db, kind, intervalMs, signature = 'default', options = {}) {
  const key = cycleScheduleKey(kind, signature)
  const now = Number.isFinite(Number(options?.now)) ? Number(options.now) : Date.now()
  const spacingMsRaw = Number.isFinite(Number(options?.spacingMs)) ? Number(options.spacingMs) : Number(intervalMs)
  const spacingMs = Math.max(1000, Number.isFinite(spacingMsRaw) && spacingMsRaw > 0 ? spacingMsRaw : 60_000)
  const nextAllowedAt = now + spacingMs
  try {
    const result = await db.query(
      `INSERT INTO meta(key, value)
       VALUES ($1, jsonb_build_object(
         'last_attempt_at', $2::bigint,
         'next_allowed_at', $3::bigint,
         'claimed_count', 1,
         'last_reason', $4::text
       ))
       ON CONFLICT(key) DO UPDATE SET value = jsonb_build_object(
         'last_attempt_at', $2::bigint,
         'next_allowed_at', $3::bigint,
         'claimed_count',
           CASE WHEN jsonb_typeof(meta.value->'claimed_count') = 'number'
             THEN (meta.value->>'claimed_count')::integer + 1
             ELSE 1
           END,
         'last_reason', $4::text,
         'last_skipped_at', meta.value->'last_skipped_at'
       )
       WHERE CASE WHEN jsonb_typeof(meta.value->'next_allowed_at') = 'number'
         THEN (meta.value->>'next_allowed_at')::bigint
         ELSE 0
       END <= $2::bigint
       RETURNING value`,
      [key, now, nextAllowedAt, String(options?.reason || 'scheduled').slice(0, 80)],
    )
    return { claimed: result.rows.length > 0, nextAllowedAt }
  } catch (err) {
    __mixdogMemoryLog(`[${kind}] scheduled claim failed: ${err.message}\n`)
    return { claimed: false, error: err.message, nextAllowedAt: 0 }
  }
}

export async function claimAndMarkScheduledCycle(db, kind, intervalMs, signature = 'default', options = {}) {
  const scheduleKey = cycleScheduleKey(kind, signature)
  const requestKey = cycleRequestKey(kind, signature)
  const now = Number.isFinite(Number(options?.now)) ? Number(options.now) : Date.now()
  const spacingMsRaw = Number.isFinite(Number(options?.spacingMs)) ? Number(options.spacingMs) : Number(intervalMs)
  const spacingMs = Math.max(1000, Number.isFinite(spacingMsRaw) && spacingMsRaw > 0 ? spacingMsRaw : 60_000)
  const nextAllowedAt = now + spacingMs
  const safeReason = String(options?.reason || 'scheduled').slice(0, 80)
  try {
    return await db.transaction(async (tx) => {
      const claimed = await tx.query(
        `INSERT INTO meta(key, value)
         VALUES ($1, jsonb_build_object(
           'last_attempt_at', $2::bigint,
           'next_allowed_at', $3::bigint,
           'claimed_count', 1,
           'last_reason', $4::text
         ))
         ON CONFLICT(key) DO UPDATE SET value = jsonb_build_object(
           'last_attempt_at', $2::bigint,
           'next_allowed_at', $3::bigint,
           'claimed_count',
             CASE WHEN jsonb_typeof(meta.value->'claimed_count') = 'number'
               THEN (meta.value->>'claimed_count')::integer + 1
               ELSE 1
             END,
           'last_reason', $4::text,
           'last_skipped_at', meta.value->'last_skipped_at'
         )
         WHERE CASE WHEN jsonb_typeof(meta.value->'next_allowed_at') = 'number'
           THEN (meta.value->>'next_allowed_at')::bigint
           ELSE 0
         END <= $2::bigint
         RETURNING value`,
        [scheduleKey, now, nextAllowedAt, safeReason],
      )
      if (claimed.rows.length === 0) return { claimed: false, nextAllowedAt }
      await tx.query(
        `INSERT INTO meta(key, value)
         VALUES ($1, jsonb_build_object(
           'count', 1,
           'first_requested_at', $2::bigint,
           'last_requested_at', $2::bigint,
           'last_reason', $3::text
         ))
         ON CONFLICT(key) DO UPDATE SET value = jsonb_build_object(
           'count',
             CASE WHEN jsonb_typeof(meta.value->'count') = 'number'
               THEN (meta.value->>'count')::integer + 1
               ELSE 1
             END,
           'first_requested_at', COALESCE(meta.value->'first_requested_at', to_jsonb($2::bigint)),
           'last_requested_at', to_jsonb($2::bigint),
           'last_reason', to_jsonb($3::text),
           'last_drained_at', meta.value->'last_drained_at',
           'last_drained_count', meta.value->'last_drained_count'
         )`,
        [requestKey, now, safeReason],
      )
      return { claimed: true, nextAllowedAt }
    })
  } catch (err) {
    __mixdogMemoryLog(`[${kind}] scheduled claim+mark failed: ${err.message}\n`)
    return { claimed: false, error: err.message, nextAllowedAt: 0 }
  }
}

export async function markCycleRequest(db, kind, reason = 'coalesced', signature = 'default') {
  const key = cycleRequestKey(kind, signature)
  const now = Date.now()
  const safeReason = String(reason || 'coalesced').slice(0, 80)
  try {
    await db.query(
      `INSERT INTO meta(key, value)
       VALUES ($1, jsonb_build_object(
         'count', 1,
         'first_requested_at', $2::bigint,
         'last_requested_at', $2::bigint,
         'last_reason', $3::text
       ))
       ON CONFLICT(key) DO UPDATE SET value = jsonb_build_object(
         'count',
           CASE WHEN jsonb_typeof(meta.value->'count') = 'number'
             THEN (meta.value->>'count')::integer + 1
             ELSE 1
           END,
         'first_requested_at', COALESCE(meta.value->'first_requested_at', to_jsonb($2::bigint)),
         'last_requested_at', to_jsonb($2::bigint),
         'last_reason', to_jsonb($3::text),
         'last_drained_at', meta.value->'last_drained_at',
         'last_drained_count', meta.value->'last_drained_count'
       )`,
      [key, now, safeReason],
    )
    return true
  } catch (err) {
    __mixdogMemoryLog(`[${kind}] coalesced request mark failed: ${err.message}\n`)
    return false
  }
}

export async function consumeCycleRequests(db, kind, signature = 'default') {
  const key = cycleRequestKey(kind, signature)
  return await db.transaction(async (tx) => {
    const selected = await tx.query(`SELECT value FROM meta WHERE key = $1 FOR UPDATE`, [key])
    if (selected.rows.length === 0) return 0
    const value = selected.rows[0]?.value ?? {}
    const count = Number(value?.count ?? 0)
    if (!Number.isFinite(count) || count <= 0) return 0
    await tx.query(
      `UPDATE meta
       SET value = jsonb_set(
         jsonb_set(
           jsonb_set(COALESCE(value, '{}'::jsonb), '{count}', '0'::jsonb, true),
           '{last_drained_at}', to_jsonb($2::bigint), true
         ),
         '{last_drained_count}', to_jsonb($3::integer), true
       )
       WHERE key = $1`,
      [key, Date.now(), Math.min(count, 2147483647)],
    )
    return count
  })
}

export function resolveCoalesceMaxDrains(config, fallback = 1) {
  const direct = Number(config?.coalesce_max_drains)
  const nested = Number(config?.coalesce?.max_drains)
  const env = Number(process.env.MIXDOG_MEMORY_CYCLE_COALESCE_MAX_DRAINS)
  const value = Number.isFinite(direct) ? direct
    : Number.isFinite(nested) ? nested
      : Number.isFinite(env) ? env
        : fallback
  return Math.max(0, Math.min(10, Math.floor(value)))
}

export function resolveCoalesceRetryDelayMs(config, fallback = 1000) {
  const direct = Number(config?.coalesce_retry_delay_ms)
  const nested = Number(config?.coalesce?.retry_delay_ms)
  const env = Number(process.env.MIXDOG_MEMORY_CYCLE_COALESCE_RETRY_MS)
  const value = Number.isFinite(direct) ? direct
    : Number.isFinite(nested) ? nested
      : Number.isFinite(env) ? env
        : fallback
  return Math.max(50, Math.min(60_000, Math.floor(value)))
}

export function resolveCoalesceMaxRetries(config, fallback = 3) {
  const direct = Number(config?.coalesce_max_retries)
  const nested = Number(config?.coalesce?.max_retries)
  const env = Number(process.env.MIXDOG_MEMORY_CYCLE_COALESCE_MAX_RETRIES)
  const value = Number.isFinite(direct) ? direct
    : Number.isFinite(nested) ? nested
      : Number.isFinite(env) ? env
        : fallback
  return Math.max(0, Math.min(10, Math.floor(value)))
}

export function scheduleCoalescedCycleRetry(db, kind, runner, config = {}, signature = 'default') {
  const key = cycleRequestKey(kind, signature)
  if (!db || typeof runner !== 'function') return false
  let byKind = _retryTimersByDb.get(db)
  if (!byKind) {
    byKind = new Map()
    _retryTimersByDb.set(db, byKind)
  }
  if (byKind.has(key)) return false
  const delayMs = resolveCoalesceRetryDelayMs(config)
  const timer = setTimeout(async () => {
    byKind.delete(key)
    try {
      await runner()
    } catch (err) {
      __mixdogMemoryLog(`[${kind}] coalesced retry failed: ${err?.message || err}\n`)
    }
  }, delayMs)
  if (typeof timer.unref === 'function') timer.unref()
  byKind.set(key, timer)
  return true
}
