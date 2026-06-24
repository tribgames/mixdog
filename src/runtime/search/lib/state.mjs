import { USAGE_PATH, readJson, writeJson } from './config.mjs'

const FLUSH_DELAY_MS = 5000

let usageDirty = false
let usageFlushTimer = null
let activeUsageState = null
let lastUsageFlushWarnAt = 0

function now() {
  return new Date().toISOString()
}

function defaultState() {
  return {
    providers: {},
    routingCache: {
      rawBySite: {},
      scrapeByHost: {},
    },
  }
}

// 5s debounce — every search/crawl/batch path mutates usage at least once
// (lastUsedAt/percentUsed/cooldownUntil). Without coalescing, callers that
// don't explicitly flush would either spam fsync per call or lose the dirty
// state on crash. process.on('exit') still fires for graceful shutdown.
function scheduleUsageFlush(state) {
  usageDirty = true
  activeUsageState = state
  if (usageFlushTimer) return
  usageFlushTimer = setTimeout(() => {
    usageFlushTimer = null
    flushUsageState()
  }, FLUSH_DELAY_MS)
  if (usageFlushTimer.unref) usageFlushTimer.unref()
}

function flushUsageState() {
  if (usageFlushTimer) {
    clearTimeout(usageFlushTimer)
    usageFlushTimer = null
  }
  if (usageDirty && activeUsageState) {
    try {
      writeJson(USAGE_PATH, activeUsageState)
      usageDirty = false
    } catch (err) {
      // Usage state is best-effort telemetry. A Windows AV/indexer can
      // hold the destination open. Keep the dirty state and retry quietly.
      const nowMs = Date.now()
      if (nowMs - lastUsageFlushWarnAt > 60000) {
        lastUsageFlushWarnAt = nowMs
        process.stderr.write(`[search-state] flushUsageState delayed: ${err?.code || err?.message || err}\n`)
      }
      if (!usageFlushTimer) {
        usageFlushTimer = setTimeout(() => {
          usageFlushTimer = null
          flushUsageState()
        }, FLUSH_DELAY_MS * 2)
        if (usageFlushTimer.unref) usageFlushTimer.unref()
      }
    }
  }
}

process.on('exit', flushUsageState)

export { flushUsageState }

let _instance = null

export function loadUsageState() {
  if (_instance) return _instance
  const raw = readJson(USAGE_PATH, null)
  const def = defaultState()
  const state = raw && typeof raw === 'object' ? {
    ...def,
    ...raw,
    providers: { ...(raw.providers || {}) },
    routingCache: {
      rawBySite: { ...(def.routingCache.rawBySite), ...(raw.routingCache?.rawBySite || {}) },
      scrapeByHost: { ...(def.routingCache.scrapeByHost), ...(raw.routingCache?.scrapeByHost || {}) },
    },
  } : def
  _instance = state
  activeUsageState = state
  return state
}

export function saveUsageState(state) {
  scheduleUsageFlush(state)
}

export function updateProviderState(state, provider, patch) {
  let normalizedPatch = { ...patch }
  const remaining =
    typeof normalizedPatch.remaining === 'number' ? normalizedPatch.remaining : null
  const limit = typeof normalizedPatch.limit === 'number' ? normalizedPatch.limit : null

  if (
    limit &&
    limit > 0 &&
    remaining !== null &&
    typeof normalizedPatch.percentUsed !== 'number'
  ) {
    normalizedPatch.percentUsed = Number((((limit - remaining) / limit) * 100).toFixed(2))
  }

  state.providers[provider] = {
    ...(state.providers[provider] || {}),
    ...normalizedPatch,
    updatedAt: normalizedPatch.updatedAt || now(),
  }
  scheduleUsageFlush(state)
}

export function noteProviderSuccess(state, provider, extra = {}) {
  updateProviderState(state, provider, {
    ...extra,
    error: null,
    lastUsedAt: now(),
    lastSuccessAt: now(),
    cooldownUntil: null,
  })
}

export const PROVIDER_ERROR_KIND = {
  AUTH: 'auth',
  QUOTA: 'quota',
  PAYMENT: 'payment',
  RATE_LIMIT: 'rate_limit',
  SERVER: 'server',
  NETWORK: 'network',
  UNKNOWN: 'unknown',
}

export function classifyProviderError(error) {
  let status = error?.status
  if (status == null && error?.message) {
    const m = String(error.message).match(/\bHTTP\s+(\d{3})\b/)
    if (m) status = Number(m[1])
  }
  const name = error?.name
  if (status === 429) return PROVIDER_ERROR_KIND.RATE_LIMIT
  if (status === 400 || status === 401 || status === 403) return PROVIDER_ERROR_KIND.AUTH
  if (status === 402) return PROVIDER_ERROR_KIND.PAYMENT
  if (status >= 500 && status < 600) return PROVIDER_ERROR_KIND.SERVER
  if (!status && (name === 'AbortError' || name === 'TimeoutError')) return PROVIDER_ERROR_KIND.NETWORK
  if (!status) return PROVIDER_ERROR_KIND.NETWORK
  return PROVIDER_ERROR_KIND.UNKNOWN
}

/** Structured HTTP error for search backends (enables cooldown via classifyProviderError). */
export function providerHttpError(provider, status, detail = '') {
  const code = Number(status)
  const snippet = detail ? `: ${String(detail).slice(0, 200)}` : ''
  const err = new Error(`[search:${provider}] HTTP ${code}${snippet}`)
  err.status = code
  err.provider = provider
  return err
}

const PROVIDER_DISABLE_TTL_MS = {
  auth: 24 * 3600 * 1000,
  quota: 24 * 3600 * 1000,
  payment: 24 * 3600 * 1000,
  rate_limit: 24 * 3600 * 1000,
  server: 0,
  network: 0,
  unknown: 0,
}

export function noteProviderFailure(state, provider, errorMessage, errorKind) {
  const payload = {
    error: errorMessage,
    lastUsedAt: now(),
    lastFailureAt: now(),
  }
  const ttl = PROVIDER_DISABLE_TTL_MS[errorKind] ?? 0
  if (ttl > 0) {
    payload.cooldownUntil = new Date(Date.now() + ttl).toISOString()
  }
  updateProviderState(state, provider, payload)
}

// Selection is config-driven (no preference cache, no historical ranking).
// We only honor active cooldownUntil set by noteProviderFailure so callers
// don't spin on a known-rate-limited extractor within the same window.
export function rankScrapeExtractors(_host, state, defaults) {
  const nowTime = Date.now()
  const active = []
  const cooling = []
  for (const extractor of defaults) {
    const info = state?.providers?.[extractor]
    const until = info?.cooldownUntil ? new Date(info.cooldownUntil).getTime() : 0
    if (Number.isFinite(until) && until > nowTime) cooling.push(extractor)
    else active.push(extractor)
  }
  return active.length > 0 ? [...active, ...cooling] : cooling
}
