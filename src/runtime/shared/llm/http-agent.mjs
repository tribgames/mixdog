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
 * Scope note: this is deliberately NOT used by src/runtime/web-search/lib/web-tools.mjs,
 * whose per-request Agent pins a pre-validated DNS address for SSRF safety and
 * must own its own short-lived pool. LLM API origins are fixed, trusted hosts,
 * so a shared long-lived pool is appropriate here.
 */

import { createRequire } from 'node:module';
import { BlockList, isIP } from 'node:net';

const require = createRequire(import.meta.url);
let _undici = null;
function undici() {
  if (!_undici) _undici = require('undici');
  return _undici;
}

let _agent = null;
let _globalInstalled = false;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
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
  const env = process.env;
  if (PROXY_VARS.some((name) => env[name])) return true;
  if (env.NODE_USE_ENV_PROXY) return true;
  try {
    const g = undici().getGlobalDispatcher?.();
    // Any non-default global dispatcher (constructor name other than the plain
    // `Agent` undici installs by default) is treated as custom — ProxyAgent,
    // EnvHttpProxyAgent, MockAgent, or a user subclass — and we step aside.
    if (g?.constructor && g.constructor.name !== 'Agent') return true;
  } catch {
    /* getGlobalDispatcher unavailable — treat as no proxy */
  }
  return false;
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
// Loopback, private (RFC 1918) and link-local IPv4.
const LOCAL_V4_RANGES = [
  ['127.0.0.0', '127.255.255.255'],
  ['10.0.0.0', '10.255.255.255'],
  ['172.16.0.0', '172.31.255.255'],
  ['192.168.0.0', '192.168.255.255'],
  ['169.254.0.0', '169.254.255.255'],
];
// Loopback, unique-local and link-local IPv6.
const LOCAL_V6_SUBNETS = [
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
];

/**
 * NO_PROXY for processes that follow the proxy variables natively (children,
 * Node's http module). NO_PROXY matching is by name, suffix or exact address;
 * fetch has no address ranges at all and Node's http module takes `a-b`
 * ranges, so this list is a fallback: in-process, isLocalHost decides.
 */
export const LOCAL_NO_PROXY = [
  'localhost',
  '127.0.0.1',
  '::1',
  '.local',
  ...LOCAL_V4_RANGES.map(([start, end]) => `${start}-${end}`),
].join(',');

let _localAddresses = null;
function localAddresses() {
  if (!_localAddresses) {
    _localAddresses = new BlockList();
    for (const [start, end] of LOCAL_V4_RANGES) _localAddresses.addRange(start, end, 'ipv4');
    for (const [network, prefix] of LOCAL_V6_SUBNETS) _localAddresses.addSubnet(network, prefix, 'ipv6');
  }
  return _localAddresses;
}

function normalizeHost(hostname) {
  return String(hostname)
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
    .toLowerCase();
}

/**
 * A host that never goes through the proxy: a loopback, private or
 * link-local address, a dotless name (`localhost`, a LAN machine) or a
 * `.local` / `.localhost` name — local providers and LAN services.
 */
export function isLocalHost(hostname) {
  const host = normalizeHost(hostname);
  const family = isIP(host);
  if (family) return localAddresses().check(host, family === 4 ? 'ipv4' : 'ipv6');
  return !host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost');
}

/**
 * `env` plus what Node needs to honour its proxy variables: NODE_USE_ENV_PROXY
 * (Node ignores HTTPS_PROXY without it) and a local NO_PROXY. Unchanged when
 * no proxy variable is set or the user set NODE_USE_ENV_PROXY / NO_PROXY.
 */
export function withEnvProxy(env) {
  if (env.NODE_USE_ENV_PROXY !== undefined || !PROXY_VARS.some((name) => env[name])) return env;
  const noProxy = env.NO_PROXY || env.no_proxy ? {} : { NO_PROXY: LOCAL_NO_PROXY };
  return { ...env, NODE_USE_ENV_PROXY: '1', ...noProxy };
}

/**
 * The global dispatcher under a proxy: local and LAN hosts (isLocalHost, which
 * includes every dotless name) connect directly, every other host follows the
 * proxy variables and NO_PROXY. `bypass` ({ hosts, suffixes }: exact hosts and
 * `*.suffix` domains) adds hosts that also connect directly. `direct` and
 * `proxied` replace the two inner dispatchers (tests, and the private proxy of
 * adoptPrivateProxy).
 */
export function createProxyDispatcher({ direct = null, proxied = null, bypass = null } = {}) {
  const { Agent, Dispatcher, EnvHttpProxyAgent } = undici();
  const bypassHosts = new Set(bypass?.hosts ?? []);
  const bypassSuffixes = bypass?.suffixes ?? [];
  const bypassed = (host) => bypassHosts.has(host) || bypassSuffixes.some((suffix) => host.endsWith(`.${suffix}`));
  class LocalBypassProxyAgent extends Dispatcher {
    #direct = direct ?? new Agent();
    #proxied = proxied ?? new EnvHttpProxyAgent();

    dispatch(opts, handler) {
      const { hostname } = new URL(opts.origin);
      const target = isLocalHost(hostname) || bypassed(normalizeHost(hostname)) ? this.#direct : this.#proxied;
      return target.dispatch(opts, handler);
    }

    async close() {
      await Promise.all([this.#direct.close(), this.#proxied.close()]);
    }

    async destroy(error) {
      await Promise.all([this.#direct.destroy(error), this.#proxied.destroy(error)]);
    }
  }
  return new LocalBypassProxyAgent();
}

let _envProxyAdopted = false;

/**
 * Honour proxy variables in this already-running process (createProxyDispatcher
 * as the global dispatcher) and, through the inherited env, in every child it
 * spawns. No-op without a proxy variable, when the user set NODE_USE_ENV_PROXY
 * to anything but 1, or once adopted.
 */
export function adoptEnvProxy(env = process.env) {
  const next = withEnvProxy(env);
  if (_envProxyAdopted || next.NODE_USE_ENV_PROXY !== '1' || !PROXY_VARS.some((name) => next[name])) return false;
  env.NODE_USE_ENV_PROXY = '1';
  if (next.NO_PROXY !== undefined) env.NO_PROXY = next.NO_PROXY;
  undici().setGlobalDispatcher(createProxyDispatcher());
  _envProxyAdopted = true;
  return true;
}

/**
 * Route this process's fetch through a proxy that came from the OS rather than
 * from the user's environment (system-proxy.mjs). It lives in the dispatcher
 * only: no proxy variable is written, so shells, tools and other CLIs this
 * process spawns see none. `proxy` is `{ https, http? }` (a missing scheme goes
 * direct), `bypass` as in createProxyDispatcher. No-op once a proxy is adopted.
 */
export function adoptPrivateProxy({ https, http = '' }, bypass = null) {
  if (_envProxyAdopted) return false;
  const proxied = new (undici().EnvHttpProxyAgent)({ httpProxy: http, httpsProxy: https, noProxy: '' });
  undici().setGlobalDispatcher(createProxyDispatcher({ proxied, bypass }));
  _envProxyAdopted = true;
  return true;
}

/**
 * The shared singleton dispatcher for LLM API requests. Created on first use.
 *
 * keepAliveTimeout (~60s) keeps a socket warm across the typical idle gap
 * between agent turns; sockets per origin are unbounded unless
 * MIXDOG_LLM_CONNECTIONS sets a cap.
 *
 * Returns `undefined` when a proxy / any custom (non-default) global dispatcher
 * is configured, so `fetch({ dispatcher: undefined })` falls back to that
 * global dispatcher instead of bypassing it. `dispatcher: undefined` is a
 * harmless fetch option, so call sites need no change.
 */
export function getLlmDispatcher() {
  if (proxyConfigured()) return undefined;
  if (_agent?.destroyed || _agent?.closed) {
    _agent = null;
    _globalInstalled = false;
  }
  if (!_agent) {
    _agent = new (undici().Agent)({
      keepAliveTimeout: envInt('MIXDOG_LLM_KEEPALIVE_MS', 60_000),
      keepAliveMaxTimeout: envInt('MIXDOG_LLM_KEEPALIVE_MAX_MS', 90_000),
      // No per-origin socket cap by default: each streaming (SSE) response
      // holds its HTTP/1.1 socket for the whole generation, so a cap of N
      // queued the (N+1)th concurrent agent until another finished. Rate
      // limiting is the server's call (429 → admission cooldown).
      connections: envInt('MIXDOG_LLM_CONNECTIONS', null),
      // undici defaults both of these to 300s, which beheaded the Anthropic
      // NON-STREAMING stall fallback (2026-08-03 regex-chess probe:
      // UND_ERR_HEADERS_TIMEOUT at exactly 300s) — a non-streaming completion
      // sends NO response headers until generation finishes, so a long silent
      // generation legitimately exceeds 300s of header wait. Raise both to
      // 600s: first-byte/idle protection is owned by the app-level watchdogs
      // (provider first-byte + semantic idle + agent stall abort), which all
      // fire below this transport ceiling; this layer is only the last-resort
      // dead-socket bound.
      headersTimeout: envInt('MIXDOG_LLM_HEADERS_TIMEOUT_MS', 600_000),
      bodyTimeout: envInt('MIXDOG_LLM_BODY_TIMEOUT_MS', 600_000),
    });
  }
  // mixdog standalone: separate undici instance from Node's fetch undici, so
  // a per-request dispatcher throws UND_ERR_INVALID_ARG. Install globally once
  // and omit the per-request dispatcher. See port-plan D7.
  if (!_globalInstalled) {
    try {
      undici().setGlobalDispatcher(_agent);
      _globalInstalled = true;
    } catch {
      /* fall back */
    }
  }
  return _globalInstalled ? undefined : _agent;
}

/**
 * Replace the global pool before retiring its old generation. SDK clients
 * use global fetch without calling getLlmDispatcher() on every attempt.
 * Graceful close drains unrelated in-flight requests instead of aborting
 * every provider because one origin failed. No-op under a proxy.
 */
export function recycleLlmDispatcher() {
  if (proxyConfigured()) return false;
  const old = _agent;
  if (!old) return false;
  _agent = null;
  _globalInstalled = false;
  _preconnectedAt.clear();
  getLlmDispatcher();
  if (undici().getGlobalDispatcher() !== _agent) {
    const unused = _agent;
    _agent = old;
    _globalInstalled = false;
    try {
      unused?.close()?.catch?.(() => {});
    } catch {}
    return false;
  }
  try {
    old.close().catch(() => {});
  } catch {
    /* never let recycle throw into a retry path */
  }
  return true;
}

// Origins warmed (or warming) recently, with the timestamp of the last warm.
// A time-based gate (instead of a permanent Set) lets us RE-warm a socket once
// the kept-alive window has lapsed: a one-shot warm at provider construction
// went cold after keepAliveTimeout (~60s idle between turns), so the first
// request after a pause paid the full TLS handshake again. Re-warming just
// before a turn keeps the hot-path send on a live socket.
const _preconnectedAt = new Map();
// Re-warm cadence: slightly below the keep-alive window so a socket is renewed
// before it can lapse. Capped so an explicit short keepAlive still re-warms.
function _preconnectTtlMs() {
  const keepAlive = envInt('MIXDOG_LLM_KEEPALIVE_MS', 60_000);
  return Math.max(5_000, keepAlive - 10_000);
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
    if (proxyConfigured()) return;
    if (!origin || typeof origin !== 'string') return;
    let url;
    try {
      url = new URL(origin);
    } catch {
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    const key = url.origin;
    const now = Date.now();
    const last = _preconnectedAt.get(key) || 0;
    if (now - last < _preconnectTtlMs()) return;
    _preconnectedAt.set(key, now);
    // A throwaway HEAD lands a pooled socket without fetching a body. Any
    // failure (offline, DNS, 4xx/5xx) is irrelevant — the handshake is the
    // point, and the real request will surface genuine errors.
    undici()
      .request(key, {
        method: 'HEAD',
        dispatcher: getLlmDispatcher(),
        signal: AbortSignal.timeout(10_000),
      })
      .then((res) => res.body?.dump?.())
      .catch(() => {
        // Warm failed — clear the timestamp so the next call can retry instead
        // of waiting out the full TTL on a connection that never landed.
        _preconnectedAt.delete(key);
      });
  } catch {
    /* never let warmup break construction */
  }
}
