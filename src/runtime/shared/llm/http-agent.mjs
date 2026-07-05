/**
 * Shared HTTP connection pool for outbound LLM provider API calls.
 *
 * The provider modules (anthropic-oauth, openai-oauth, grok-oauth, gemini)
 * call the global `fetch()` with no dispatcher, so they ride Node's default
 * undici agent. That agent keeps connections alive only briefly, so after an
 * idle gap the first request to a provider pays a fresh TLS handshake — a
 * 100-300ms first-byte penalty observed on cold calls.
 *
 * This module exports ONE lazily-created singleton undici `Agent` with a long
 * keep-alive window and a sane connection cap, passed as the `dispatcher`
 * option on those providers' `fetch()` calls so warm sockets survive idle
 * gaps. `preconnect(origin)` opens a socket ahead of the first real request
 * (best-effort, errors swallowed) and is called once at provider construction.
 *
 * Scope note: this is deliberately NOT used by src/search/lib/web-tools.mjs,
 * whose per-request Agent pins a pre-validated DNS address for SSRF safety and
 * must own its own short-lived pool. LLM API origins are fixed, trusted hosts,
 * so a shared long-lived pool is appropriate here.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let _undici = null
function undici() {
  if (!_undici) _undici = require('undici')
  return _undici
}

let _agent = null
let _globalInstalled = false

function envInt(name, fallback) {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback
}

/**
 * Detect whether outbound HTTP is meant to flow through a proxy or any custom
 * global dispatcher. When so, pinning our own bare keep-alive `Agent` as the
 * per-request `dispatcher` would silently bypass `setGlobalDispatcher(...)` and
 * env-proxy wiring — so callers must fall back to the global dispatcher.
 *
 * What is preserved (we step aside): explicit proxy env vars, undici's built-in
 * `ProxyAgent`, and ANY non-default global dispatcher — i.e. any installed
 * global whose constructor name is not `Agent` (undici's default global is a
 * plain `Agent`). Our own singleton is never installed via
 * `setGlobalDispatcher`, so this never self-detects.
 *
 * Accepted gap: a custom dispatcher deliberately constructed AS a plain undici
 * `Agent` and set as the global is indistinguishable from the default here, so
 * we'd keep using our shared pool. That's tolerable — such a dispatcher is
 * itself a direct-connection pool (no proxy hop), so the bypass risk is minimal.
 */
function proxyConfigured() {
  const env = process.env
  if (env.HTTP_PROXY || env.HTTPS_PROXY || env.http_proxy || env.https_proxy) return true
  if (env.NODE_USE_ENV_PROXY) return true
  try {
    const g = undici().getGlobalDispatcher?.()
    // Any non-default global dispatcher (constructor name other than the plain
    // `Agent` undici installs by default) is treated as custom — ProxyAgent,
    // EnvHttpProxyAgent, MockAgent, or a user subclass — and we step aside.
    if (g && g.constructor && g.constructor.name !== 'Agent') return true
  } catch { /* getGlobalDispatcher unavailable — treat as no proxy */ }
  return false
}

/**
 * The shared singleton dispatcher for LLM API requests. Created on first use.
 *
 * keepAliveTimeout (~60s) keeps a socket warm across the typical idle gap
 * between agent turns; connections caps concurrent sockets per origin so a
 * burst of parallel calls can't open an unbounded number of handshakes.
 *
 * Returns `undefined` when a proxy / any custom (non-default) global dispatcher
 * is configured, so `fetch({ dispatcher: undefined })` falls back to that
 * global dispatcher instead of bypassing it. `dispatcher: undefined` is a
 * harmless fetch option, so call sites need no change.
 */
export function getLlmDispatcher() {
  if (proxyConfigured()) return undefined
  if (!_agent) {
    _agent = new (undici().Agent)({
      keepAliveTimeout: envInt('MIXDOG_LLM_KEEPALIVE_MS', 60_000),
      keepAliveMaxTimeout: envInt('MIXDOG_LLM_KEEPALIVE_MAX_MS', 90_000),
      connections: envInt('MIXDOG_LLM_CONNECTIONS', 16),
    })
  }
  // mixdog standalone: separate undici instance from Node's fetch undici, so
  // a per-request dispatcher throws UND_ERR_INVALID_ARG. Install globally once
  // and omit the per-request dispatcher. See port-plan D7.
  if (!_globalInstalled) {
    try { undici().setGlobalDispatcher(_agent); _globalInstalled = true } catch { /* fall back */ }
  }
  return _globalInstalled ? undefined : _agent
}

// Origins warmed (or warming) recently, with the timestamp of the last warm.
// A time-based gate (instead of a permanent Set) lets us RE-warm a socket once
// the kept-alive window has lapsed: a one-shot warm at provider construction
// went cold after keepAliveTimeout (~60s idle between turns), so the first
// request after a pause paid the full TLS handshake again. Re-warming just
// before a turn keeps the hot-path send on a live socket.
const _preconnectedAt = new Map()
// Re-warm cadence: slightly below the keep-alive window so a socket is renewed
// before it can lapse. Capped so an explicit short keepAlive still re-warms.
function _preconnectTtlMs() {
  const keepAlive = envInt('MIXDOG_LLM_KEEPALIVE_MS', 60_000)
  return Math.max(5_000, keepAlive - 10_000)
}

/**
 * Best-effort warm a kept-alive socket to `origin` so the first real request
 * skips the TLS handshake. Fire-and-forget: never throws, never returns a
 * pending promise the caller must await.
 *
 * @param {string} origin e.g. 'https://api.anthropic.com'
 */
export function preconnect(origin) {
  try {
    // With a proxy / custom global dispatcher in play we deliberately don't own
    // the connection pool, so there's no warm socket to seed — no-op.
    if (proxyConfigured()) return
    if (!origin || typeof origin !== 'string') return
    let url
    try { url = new URL(origin) } catch { return }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return
    const key = url.origin
    const now = Date.now()
    const last = _preconnectedAt.get(key) || 0
    if (now - last < _preconnectTtlMs()) return
    _preconnectedAt.set(key, now)
    // A throwaway HEAD lands a pooled socket without fetching a body. Any
    // failure (offline, DNS, 4xx/5xx) is irrelevant — the handshake is the
    // point, and the real request will surface genuine errors.
    undici().request(key, {
      method: 'HEAD',
      dispatcher: getLlmDispatcher(),
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) => res.body?.dump?.())
      .catch(() => {
        // Warm failed — clear the timestamp so the next call can retry instead
        // of waiting out the full TTL on a connection that never landed.
        _preconnectedAt.delete(key)
      })
  } catch { /* never let warmup break construction */ }
}
