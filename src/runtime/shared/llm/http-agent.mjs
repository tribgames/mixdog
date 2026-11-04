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
import { runInRootAsyncContext } from '../root-async-context.mjs';
import { currentProxySetting, decideProxyRoute } from './proxy-policy.mjs';

const require = createRequire(import.meta.url);
let _undici = null;
function undici() {
  if (!_undici) _undici = require('undici');
  return _undici;
}

let _agent = null;
/** The proxy-policy router (createProxyDispatcher), installed as the global dispatcher. */
let _router = null;
/** The OS route (system-proxy.mjs systemProxyRoute) registered by adoptPrivateProxy; null without one. */
let _systemRoute = null;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/**
 * Whether the global dispatcher is somebody else's: undici's ProxyAgent,
 * EnvHttpProxyAgent, a MockAgent or a user subclass — any global whose
 * constructor name is not the plain `Agent` undici installs by default — other
 * than our own router. We step aside for it instead of installing the router
 * over it.
 *
 * Accepted gap: a custom dispatcher deliberately constructed AS a plain undici
 * `Agent` and set as the global is indistinguishable from the default here.
 */
function foreignDispatcher() {
  const g = undici().getGlobalDispatcher();
  return g !== _router && !!g?.constructor && g.constructor.name !== 'Agent';
}

/**
 * Make the proxy-policy router the global dispatcher, so that every fetch of
 * this process follows the network proxy setting (proxy-policy.mjs). With
 * `replaceForeign` it also replaces another global dispatcher (what adopting
 * the environment or the OS proxy always did). Returns whether the router is
 * installed.
 */
function installPolicyRouter(replaceForeign) {
  if (_router && undici().getGlobalDispatcher() === _router) return true;
  if (!replaceForeign && foreignDispatcher()) return false;
  _router = createProxyDispatcher();
  undici().setGlobalDispatcher(_router);
  return true;
}

/**
 * The route for `target` (an http(s) or ws(s) URL) under the network proxy
 * setting: `{ proxy, via }` (see decideProxyRoute), or a promise of one while
 * the OS route is looked up. Throws for a manual proxy without an address.
 * Raw-socket paths (WebSocket, HTTP/2) ask this too, to tunnel like fetch does.
 */
export function routeForUrl(target, setting = currentProxySetting()) {
  return decideProxyRoute(target, { setting, env: process.env, system: _systemRoute, isLocalHost });
}

/** The OS proxy route of `origin` whatever the setting says (to describe what `off` ignores); `{ proxy: null }` without one. */
export function osProxyRoute(origin) {
  return _systemRoute ? _systemRoute(origin) : { proxy: null };
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

export function normalizeHost(hostname) {
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
 * The global dispatcher: each origin goes where the network proxy setting
 * sends it (routeForUrl) — the shared LLM pool when direct, a ProxyAgent leg
 * of the chosen proxy otherwise. The setting is asked per request, so a change
 * applies to the next connection. `direct` and `proxied` replace the legs
 * (tests); a `direct` dispatcher instance stands for the pool.
 */
export function createProxyDispatcher({ direct = null, proxied = null } = {}) {
  return createRoutedProxyDispatcher({
    route: routeForUrl,
    direct: direct ? () => direct : llmAgent,
    proxied: proxied ?? ((uri) => new (undici().ProxyAgent)({ ...llmAgentOptions(), uri })),
    // Local hosts are the policy's call (a manual proxy has no hardcoded bypass).
    bypassLocal: false,
  });
}

let _envProxyAdopted = false;

/**
 * Install the proxy-policy router as this process's global dispatcher and,
 * when the environment holds proxy variables, mark the env so that every child
 * this process spawns honours them too. Returns whether the env was marked:
 * false without a proxy variable, when the user set NODE_USE_ENV_PROXY to
 * anything but 1, or once adopted.
 */
export function adoptEnvProxy(env = process.env) {
  installPolicyRouter(true);
  const next = withEnvProxy(env);
  if (_envProxyAdopted || next.NODE_USE_ENV_PROXY !== '1' || !PROXY_VARS.some((name) => next[name])) return false;
  env.NODE_USE_ENV_PROXY = '1';
  if (next.NO_PROXY !== undefined) env.NO_PROXY = next.NO_PROXY;
  _envProxyAdopted = true;
  return true;
}

/** A request the router could not hand to a leg fails through its handler. */
function failDispatch(handler, error) {
  if (typeof handler.onResponseError === 'function') handler.onResponseError(null, error);
  else handler.onError?.(error);
}

const RESPONSE_CALLBACKS = [
  'onRequestUpgrade',
  'onResponseStart',
  'onResponseData',
  'onResponseEnd',
  'onResponseError',
];

/**
 * Start a request whose leg is not known yet: its handler gets a controller at
 * once, so an abort while the route is looked up settles it right away instead
 * of when the lookup answers. Returns the handler to give the leg (which binds
 * the controller to the real request), or null once aborted. Legacy handlers
 * (no onRequestStart) start with the leg as before.
 */
function startDeferred(handler) {
  if (typeof handler.onRequestStart !== 'function') return () => handler;
  let inner = null;
  let reason = null;
  const controller = {
    get aborted() {
      return inner ? inner.aborted : reason !== null;
    },
    get paused() {
      return inner?.paused ?? false;
    },
    get reason() {
      return inner ? inner.reason : reason;
    },
    get rawHeaders() {
      return inner?.rawHeaders;
    },
    get rawTrailers() {
      return inner?.rawTrailers;
    },
    abort(cause) {
      if (inner) return inner.abort(cause);
      if (reason !== null) return;
      reason = cause ?? new (undici().errors.RequestAbortedError)();
      handler.onResponseError?.(controller, reason);
    },
    pause() {
      inner?.pause();
    },
    resume() {
      inner?.resume();
    },
  };
  handler.onRequestStart(controller, {});
  const forwarded = {
    onRequestStart(real) {
      inner = real;
    },
  };
  for (const name of RESPONSE_CALLBACKS) {
    if (typeof handler[name] === 'function') forwarded[name] = (...args) => handler[name](...args);
  }
  return () => (reason === null ? forwarded : null);
}

/**
 * A dispatcher that routes each origin on its own: local and LAN hosts connect
 * directly without asking (unless `bypassLocal` is false: then `route` decides
 * for them too), every other origin by `route(origin)` — `{ proxy }` (a proxy
 * URL, or null for direct), or a promise of one, which the request waits for.
 * A `route` that throws or rejects fails the request: it never goes direct. A
 * request aborted meanwhile settles at once and is never sent.
 * `direct()` gives the direct leg (read per request: the pool can be replaced),
 * `proxied(uri)` builds the leg of one proxy, kept for reuse.
 */
export function createRoutedProxyDispatcher({
  route,
  direct = null,
  proxied = (uri) => new (undici().ProxyAgent)({ uri }),
  bypassLocal = true,
}) {
  const { Agent, Dispatcher } = undici();
  let ownDirect = null;
  const directLeg = direct ?? (() => (ownDirect ??= new Agent()));
  class SystemProxyRouter extends Dispatcher {
    #proxied = new Map();

    #leg(decision) {
      const uri = decision?.proxy;
      if (!uri) return directLeg();
      let leg = this.#proxied.get(uri);
      if (!leg) {
        leg = proxied(uri);
        this.#proxied.set(uri, leg);
      }
      return leg;
    }

    dispatch(opts, handler) {
      const url = new URL(opts.origin);
      let decided = null;
      if (!bypassLocal || !isLocalHost(url.hostname)) {
        try {
          decided = route(url.origin);
        } catch (error) {
          decided = Promise.reject(error);
        }
      }
      if (typeof decided?.then !== 'function') return this.#leg(decided).dispatch(opts, handler);
      const started = startDeferred(handler);
      decided.then(
        (decision) => {
          const legHandler = started();
          if (!legHandler) return;
          try {
            this.#leg(decision).dispatch(opts, legHandler);
          } catch (error) {
            failDispatch(legHandler, error);
          }
        },
        (error) => {
          const legHandler = started();
          if (legHandler) failDispatch(legHandler, error);
        }
      );
      return true;
    }

    async close() {
      await Promise.all([directLeg().close(), ...[...this.#proxied.values()].map((leg) => leg.close())]);
    }

    async destroy(error) {
      await Promise.all([directLeg().destroy(error), ...[...this.#proxied.values()].map((leg) => leg.destroy(error))]);
    }
  }
  return new SystemProxyRouter();
}

/**
 * Let the network proxy policy follow a proxy decision that came from the OS
 * rather than from the user's environment (system-proxy.mjs): `route` as in
 * createRoutedProxyDispatcher, asked in `system` mode for hosts the user's
 * variables do not cover. It lives in the dispatcher only: no proxy variable
 * is written, so shells, tools and other CLIs this process spawns see none.
 * Returns false when `route` is already the one registered.
 */
export function adoptPrivateProxy(route) {
  if (_systemRoute === route) return false;
  _systemRoute = route;
  installPolicyRouter(true);
  return true;
}

function llmAgentOptions() {
  return {
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
  };
}

/** The shared LLM pool, created again once closed or destroyed. */
function llmAgent() {
  if (_agent?.destroyed || _agent?.closed) {
    _agent = null;
  }
  _agent ??= new (undici().Agent)({ ...llmAgentOptions(), connect: rootContextConnector() });
  return _agent;
}

// A kept-alive socket serves later requests of any session: connect it in the
// root context so it never retains the request that opened it. buildConnector
// with no options matches the connector undici builds for an Agent without
// TLS/connect options.
function rootContextConnector() {
  const connect = undici().buildConnector({});
  return (options, callback) => runInRootAsyncContext(() => connect(options, callback));
}

/**
 * The shared singleton dispatcher for LLM API requests. Created on first use.
 *
 * keepAliveTimeout (~60s) keeps a socket warm across the typical idle gap
 * between agent turns; sockets per origin are unbounded unless
 * MIXDOG_LLM_CONNECTIONS sets a cap.
 *
 * Always returns `undefined`: it installs the proxy-policy router as the
 * global dispatcher (unless a custom, non-default global dispatcher is already
 * there, which is left alone), so `fetch({ dispatcher: undefined })` rides it.
 * mixdog standalone has a separate undici instance from Node's fetch undici,
 * so a per-request dispatcher would throw UND_ERR_INVALID_ARG anyway. The pool
 * is the router's direct leg. See port-plan D7.
 */
export function getLlmDispatcher() {
  installPolicyRouter(false);
  return undefined;
}

/**
 * Replace the direct pool before retiring its old generation. SDK clients
 * use global fetch without calling getLlmDispatcher() on every attempt.
 * Graceful close drains unrelated in-flight requests instead of aborting
 * every provider because one origin failed. No-op under a custom dispatcher.
 */
export function recycleLlmDispatcher() {
  if (foreignDispatcher()) return false;
  const old = _agent;
  if (!old) return false;
  _agent = null;
  _preconnectedAt.clear();
  // The router asks for the pool per request, so the next one gets a new pool.
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
    // Under a custom global dispatcher we deliberately don't own the
    // connection pool, so there's no warm socket to seed — no-op.
    if (foreignDispatcher()) return;
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
