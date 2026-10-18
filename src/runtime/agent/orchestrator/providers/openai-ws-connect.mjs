/**
 * openai-ws-connect.mjs — how a Responses WebSocket reaches the server.
 *
 * Every pool handshake is a brand-new TCP+TLS connection (the upgrade detaches
 * it from any HTTP keep-alive pool), so a burst of agents starting together
 * pays one DNS resolution and one full TLS handshake per socket. This module
 * removes the repeated work and the long stall:
 *
 *   - lookup: one resolution per host, shared by concurrent handshakes and
 *     reused for a short TTL (libuv's small thread pool otherwise queues one
 *     getaddrinfo per socket behind unrelated file I/O);
 *   - TLS resumption: the latest session ticket per host rides the next
 *     connect, so later sockets skip the full key exchange;
 *   - hedged open: an upgrade that has not opened within the hedge window
 *     gets a parallel replacement attempt instead of waiting out the whole
 *     acquire timeout. The first leg to open wins; the rest are cancelled.
 *     Server decisions (any HTTP status on the upgrade, e.g. 429/401) end
 *     the race at once so backoff stays driven by real server signals.
 */
import { lookup as dnsLookup } from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { resolveTimeoutMs } from '../stall-policy.mjs';

const DNS_TTL_MS = resolveTimeoutMs('MIXDOG_PROVIDER_WS_DNS_TTL_MS', 30_000, { minMs: 1_000, maxMs: 300_000 });
// Observed production upgrades: p95 ≈ 0.55s, max ≈ 3.4s over 6k handshakes,
// so a leg still unopened after 3s is almost certainly stuck.
const WS_HEDGE_MS = resolveTimeoutMs('MIXDOG_PROVIDER_WS_HEDGE_MS', 3_000, { minMs: 500, maxMs: 60_000 });

const _dnsCache = new Map();

function _lookupKey(hostname, options) {
  return `${hostname}\0${options?.family || 0}\0${options?.hints || 0}`;
}

function _answer(addresses, options, callback) {
  if (options?.all) {
    callback(null, addresses);
    return;
  }
  const first = addresses[0];
  callback(null, first.address, first.family);
}

/** dns.lookup-compatible resolver with in-flight coalescing and a short TTL. */
export function cachedLookup(hostname, options, callback) {
  const opts = typeof options === 'function' ? {} : typeof options === 'number' ? { family: options } : options || {};
  const cb = typeof options === 'function' ? options : callback;
  const key = _lookupKey(hostname, opts);
  const cached = _dnsCache.get(key);
  if (cached?.addresses && cached.expiresAt > Date.now()) {
    _answer(cached.addresses, opts, cb);
    return;
  }
  if (cached?.waiters) {
    cached.waiters.push({ opts, cb });
    return;
  }
  const record = { waiters: [{ opts, cb }] };
  _dnsCache.set(key, record);
  dnsLookup(hostname, { family: opts.family || 0, hints: opts.hints || 0, all: true }, (err, addresses) => {
    const waiters = record.waiters;
    if (err || !addresses?.length) {
      if (_dnsCache.get(key) === record) _dnsCache.delete(key);
      const failure = err || Object.assign(new Error(`lookup ${hostname} returned no address`), { code: 'ENOTFOUND' });
      for (const waiter of waiters) waiter.cb(failure);
      return;
    }
    _dnsCache.set(key, { addresses, expiresAt: Date.now() + DNS_TTL_MS });
    for (const waiter of waiters) _answer(addresses, waiter.opts, waiter.cb);
  });
}

const _tlsSessions = new Map();

/**
 * `ws` createConnection: the shared lookup for every socket, plus TLS
 * resumption for secure ones. Mirrors ws's own servername defaulting.
 */
export function createWsConnection(options) {
  if (options.protocol === 'ws:' || options.protocol === 'http:') {
    return net.connect({ ...options, path: options.socketPath, lookup: cachedLookup });
  }
  const sessionKey = `${options.host}:${options.port}`;
  const servername =
    options.servername || options.servername === '' ? options.servername : net.isIP(options.host) ? '' : options.host;
  const socket = tls.connect({
    ...options,
    path: undefined,
    servername,
    lookup: cachedLookup,
    session: _tlsSessions.get(sessionKey),
  });
  socket.on('session', (session) => _tlsSessions.set(sessionKey, session));
  return socket;
}

/** Test-only reset of the resolver and TLS session caches. */
export function _clearConnectCachesForTest() {
  _dnsCache.clear();
  _tlsSessions.clear();
}

function _abortReason(signal, fallback) {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

/**
 * Race handshake legs until one opens. `openLeg({ externalSignal })` opens one
 * socket and resolves `{ socket }`. A new leg starts every `hedgeMs` while
 * none has opened and the acquire deadline leaves room; a leg's transport
 * failure only ends the race when nothing else is still connecting.
 */
export function openHedged({ openLeg, externalSignal, hedgeMs = WS_HEDGE_MS, deadlineMs, deadlineError }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const legs = new Set();
    let settled = false;
    let hedgeTimer = null;
    let deadlineTimer = null;
    let lastError = null;

    const cleanup = () => {
      if (hedgeTimer) clearTimeout(hedgeTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      externalSignal?.removeEventListener?.('abort', onExternalAbort);
    };
    const cancelLegs = (reason) => {
      for (const leg of legs) leg.abort(reason);
      legs.clear();
    };
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      (ok ? resolve : reject)(value);
    };
    const fail = (err) => {
      cancelLegs(err);
      finish(false, err);
    };
    function onExternalAbort() {
      fail(_abortReason(externalSignal, 'OpenAI WS handshake aborted'));
    }

    const scheduleHedge = () => {
      if (settled || !(hedgeMs > 0)) return;
      if (Date.now() - startedAt + hedgeMs >= deadlineMs) return;
      hedgeTimer = setTimeout(() => {
        hedgeTimer = null;
        startLeg();
      }, hedgeMs);
      hedgeTimer.unref?.();
    };

    function startLeg() {
      if (settled) return;
      const controller = new AbortController();
      legs.add(controller);
      Promise.resolve()
        .then(() => openLeg({ externalSignal: controller.signal }))
        .then(
          (opened) => {
            legs.delete(controller);
            if (settled) {
              try {
                opened?.socket?.terminate?.();
              } catch {}
              return;
            }
            cancelLegs(new Error('OpenAI WS handshake superseded by a faster attempt'));
            finish(true, opened);
          },
          (err) => {
            legs.delete(controller);
            if (settled || controller.signal.aborted) return;
            lastError = err;
            // An HTTP status is the server's decision for this request
            // (rate limit, auth, upgrade refusal): surface it unchanged.
            if (err?.httpStatus != null || legs.size === 0) fail(err);
          }
        );
      if (hedgeTimer) clearTimeout(hedgeTimer);
      scheduleHedge();
    }

    if (externalSignal?.aborted) {
      onExternalAbort();
      return;
    }
    externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
    deadlineTimer = setTimeout(() => fail(lastError?.httpStatus != null ? lastError : deadlineError()), deadlineMs);
    deadlineTimer.unref?.();
    startLeg();
  });
}
