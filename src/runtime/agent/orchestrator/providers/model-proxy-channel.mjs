// Model proxy channel: the daemon half of "model calls via the client PC".
//
// In remote mode (MIXDOG_MODEL_PROXY=client) the daemon never holds model
// credentials. A provider send becomes a request here; the desktop client on
// the user's PC runs it with its own provider registry and streams back.
//
// Wire (all over the authenticated session connection):
//   daemon -> PC   desktop-event `model-proxy-request`: the FULL current state,
//                  { requests: [{ id, provider, method, model }], cancelled: [id] }.
//                  Desktop events are latest-wins per name under backpressure,
//                  so a snapshot (never a delta) is the only safe shape.
//   PC -> daemon   desktop operations
//                  modelProxyClaim(id)                      -> { payload } | null
//                  modelProxyEvent(id, eventsJson)          -> { results, cancelled }
//                  modelProxyResolve(id, ok, valueJson, errorJson) -> boolean
//                  modelProxyHeartbeat(ids)                 -> { cancelled: [id] }
// Payloads, events and results travel as JSON text so the generic wire
// sanitizer (depth cap, Error flattening) never reshapes a model request.
//
// Deliberately dependency-free: the desktop service bundle imports this file
// too, and both copies share one channel through a global symbol.
import { randomUUID } from 'node:crypto';

export const MODEL_PROXY_REQUEST_EVENT = 'model-proxy-request';
export const MODEL_PROXY_OPERATIONS = Object.freeze({
  claim: 'modelProxyClaim',
  event: 'modelProxyEvent',
  resolve: 'modelProxyResolve',
  heartbeat: 'modelProxyHeartbeat',
});
/** Calls the PC executes. `providerConfig` is registry-wide (no provider). */
export const MODEL_PROXY_METHODS = Object.freeze([
  'send',
  'listModels',
  'refreshModels',
  'isAvailable',
  'resolveWireRoute',
  'providerConfig',
  'oauthUsage',
]);
/** PC heartbeat cadence while it runs calls; well inside the lease. */
export const MODEL_PROXY_HEARTBEAT_MS = 5_000;

/** Daemon-side liveness lease of a claimed call; the PC gives up on the same clock. */
export const MODEL_PROXY_LEASE_MS = 20_000;
const CLAIM_TIMEOUT_MS = 10_000;
const LEASE_MS = MODEL_PROXY_LEASE_MS;
const SWEEP_MS = 2_000;
const WIRE_MAX_DEPTH = 64;
const BYTES_TAG = '__mixdogWireBytes';
const ERROR_TAG = '__mixdogWireError';
const OPERATION_NAMES = new Set(Object.values(MODEL_PROXY_OPERATIONS));

export class ModelProxyUnavailableError extends Error {
  constructor(detail) {
    super(`model proxy unavailable: ${detail}`);
    this.name = 'ModelProxyUnavailableError';
    this.code = 'MODEL_PROXY_UNAVAILABLE';
  }
}

// ── Wire codec ──────────────────────────────────────────────────────────────

function errorToWireRecord(error, depth, seen) {
  const record = { name: String(error?.name || 'Error'), message: String(error?.message || ''), props: {} };
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === 'name' || key === 'message' || key === 'stack') continue;
    let value;
    try {
      value = error[key];
    } catch {
      continue;
    }
    const wire = wireValue(value, depth + 1, seen);
    if (wire !== undefined) record.props[key] = wire;
  }
  return record;
}

function wireValue(value, depth, seen) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'bigint') return Number(value);
  if (type !== 'object') return undefined;
  if (depth >= WIRE_MAX_DEPTH || seen.has(value)) return undefined;
  if (value instanceof Uint8Array) {
    return { [BYTES_TAG]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  }
  if (value instanceof Date) return value.toISOString();
  seen.add(value);
  try {
    if (value instanceof Error) return { [ERROR_TAG]: errorToWireRecord(value, depth, seen) };
    if (Array.isArray(value)) return value.map((entry) => wireValue(entry, depth + 1, seen) ?? null);
    if (value instanceof Set) {
      return [...value].map((entry) => wireValue(entry, depth + 1, seen)).filter((entry) => entry !== undefined);
    }
    const out = {};
    const entries =
      value instanceof Map ? [...value].map(([key, entry]) => [String(key), entry]) : Object.entries(value);
    for (const [key, entry] of entries) {
      const wire = wireValue(entry, depth + 1, seen);
      if (wire !== undefined) out[key] = wire;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** JSON-safe projection: bytes and errors are tagged, cycles and functions dropped. */
export function modelProxyWireValue(value) {
  return wireValue(value, 0, new WeakSet());
}

export function encodeModelProxyWire(value) {
  return JSON.stringify(modelProxyWireValue(value) ?? null);
}

/** Rebuild an Error with every own property it carried (status, code, partials...). */
export function modelProxyErrorFromWire(record) {
  const error = new Error(String(record?.message || 'model proxy call failed'));
  if (record?.name) error.name = String(record.name);
  for (const [key, value] of Object.entries(record?.props || {})) {
    try {
      error[key] = value;
    } catch {
      /* read-only on Error: keep the rest */
    }
  }
  return error;
}

export function modelProxyErrorToWire(error) {
  return error instanceof Error
    ? errorToWireRecord(error, 0, new WeakSet())
    : { name: 'Error', message: String(error ?? 'model proxy call failed'), props: {} };
}

export function decodeModelProxyWire(text) {
  if (typeof text !== 'string' || !text) return null;
  return JSON.parse(text, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    if (typeof value[BYTES_TAG] === 'string' && Object.keys(value).length === 1) {
      return Buffer.from(value[BYTES_TAG], 'base64');
    }
    if (value[ERROR_TAG] && typeof value[ERROR_TAG] === 'object' && Object.keys(value).length === 1) {
      return modelProxyErrorFromWire(value[ERROR_TAG]);
    }
    return value;
  });
}

// ── Send options ────────────────────────────────────────────────────────────

/**
 * Split provider send options into wire data and callbacks. The abort signal
 * stays on the daemon (cancellation travels as a channel cancel), `_`-prefixed
 * keys are process-local seams (admission metrics, stall budgets, test hooks),
 * and only `on*` functions are callbacks the PC may invoke back.
 */
export function splitModelProxySendOptions(opts) {
  const options = {};
  const callbacks = {};
  for (const [key, value] of Object.entries(opts || {})) {
    if (key === 'signal' || key.startsWith('_')) continue;
    if (typeof value === 'function') {
      if (/^on[A-Z]/.test(key)) callbacks[key] = value;
      continue;
    }
    options[key] = value;
  }
  return { options, callbacks };
}

const SECRET_KEY =
  /api[-_]?key|secret|password|passwd|authorization|cookie|bearer|credential|^headers$|(?:^|[-_])token$|^(?:access|refresh|id)[-_]?token$|^tokens$/i;

/** Provider config without any credential-bearing field, at any depth. */
export function stripModelProxySecrets(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > WIRE_MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((entry) => stripModelProxySecrets(entry, depth + 1));
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = stripModelProxySecrets(entry, depth + 1);
  }
  return out;
}

// ── Channel ─────────────────────────────────────────────────────────────────

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(String(signal?.reason || 'model call aborted'));
  error.name = 'AbortError';
  return error;
}

export class ModelProxyChannel {
  #publisher = null;
  #entries = new Map();
  #sweepTimer = null;
  #now;
  #claimTimeoutMs;
  #leaseMs;
  #sweepMs;

  constructor({ now = Date.now, claimTimeoutMs = CLAIM_TIMEOUT_MS, leaseMs = LEASE_MS, sweepMs = SWEEP_MS } = {}) {
    this.#now = now;
    this.#claimTimeoutMs = claimTimeoutMs;
    this.#leaseMs = leaseMs;
    this.#sweepMs = sweepMs;
  }

  #clientPresent = true;
  #generation = 0;
  #connectionWaiters = new Set();

  /** True while a desktop client service can receive model-proxy requests. */
  get connected() {
    return this.#publisher !== null && this.#clientPresent;
  }

  /** Bumps whenever the client behind the channel may have changed: an answer
   *  learned under one generation (the PC's provider config) must not be
   *  served to the next client, which may be another PC. */
  get generation() {
    return this.#generation;
  }

  /** Resolves true once a client is connected, false after `timeoutMs`. */
  whenConnected(timeoutMs) {
    if (this.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = (connected) => {
        clearTimeout(timer);
        this.#connectionWaiters.delete(waiter);
        resolve(connected);
      };
      const timer = setTimeout(() => waiter(false), Math.max(0, Number(timeoutMs) || 0));
      timer.unref?.();
      this.#connectionWaiters.add(waiter);
    });
  }

  #stateListeners = new Set();

  /** `listener()` runs after every presence/generation change (the model
   *  proxy bridge pushes it to its clients). Returns the unsubscribe. */
  onStateChange(listener) {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  #connectionChanged() {
    this.#generation += 1;
    for (const listener of [...this.#stateListeners]) {
      try {
        listener();
      } catch {
        /* a listener never breaks the transport that reported the change */
      }
    }
    if (!this.connected) return;
    for (const waiter of [...this.#connectionWaiters]) waiter(true);
  }

  /**
   * Transport hook: the session connection knows when the last desktop client
   * is gone. Absent, every outstanding call fails and new ones fail fast;
   * without this hook an absent client is detected by the claim timeout.
   */
  setClientPresent(present) {
    const next = present !== false;
    const changed = next !== this.#clientPresent;
    this.#clientPresent = next;
    if (!this.#clientPresent) this.disconnect('the desktop client disconnected');
    if (changed) this.#connectionChanged();
  }

  /**
   * Register the desktop-event publisher of the connected client service. The
   * returned detach fails every outstanding call: a client that went away can
   * never answer them.
   */
  attachPublisher(publish) {
    this.#publisher = publish;
    this.#connectionChanged();
    if (this.#entries.size) this.#publish();
    return () => {
      if (this.#publisher !== publish) return;
      this.#publisher = null;
      this.disconnect('the desktop client disconnected');
      this.#connectionChanged();
    };
  }

  /** Fail every outstanding call now (client gone). Never falls back. */
  disconnect(reason = 'the desktop client disconnected') {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    this.#stopSweep();
    for (const entry of entries) this.#settle(entry, false, new ModelProxyUnavailableError(reason));
  }

  /**
   * One call executed by the PC. `callbacks` are invoked, in order, for every
   * event the PC streams back; the promise settles with the PC's final result.
   */
  request(call, { signal = null, callbacks = {} } = {}) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!this.connected) {
      return Promise.reject(new ModelProxyUnavailableError('no desktop client is connected to run model calls'));
    }
    let payload;
    try {
      payload = encodeModelProxyWire({ ...call, callbacks: Object.keys(callbacks) });
    } catch (error) {
      return Promise.reject(error);
    }
    const now = this.#now();
    return new Promise((resolve, reject) => {
      const entry = {
        id: `mp_${randomUUID().replaceAll('-', '')}`,
        state: 'pending',
        provider: String(call?.provider || ''),
        method: String(call?.method || ''),
        model: typeof call?.model === 'string' ? call.model : null,
        payload,
        callbacks,
        resolve,
        reject,
        signal,
        onAbort: null,
        settled: false,
        claimDeadline: now + this.#claimTimeoutMs,
        lastSeenAt: now,
        cancelledAt: 0,
      };
      if (signal) {
        entry.onAbort = () => this.#cancel(entry, abortReason(signal));
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.#entries.set(entry.id, entry);
      this.#ensureSweep();
      this.#publish();
    });
  }

  handlesOperation(name) {
    return OPERATION_NAMES.has(String(name || ''));
  }

  /** Desktop-operation entry point for the PC's answers. */
  handleOperation(name, args = []) {
    const list = Array.isArray(args) ? args : [];
    switch (name) {
      case MODEL_PROXY_OPERATIONS.claim:
        return this.claim(list[0]);
      case MODEL_PROXY_OPERATIONS.event:
        return this.event(list[0], list[1]);
      case MODEL_PROXY_OPERATIONS.resolve:
        return this.resolve(list[0], list[1] === true, list[2], list[3]);
      case MODEL_PROXY_OPERATIONS.heartbeat:
        return this.heartbeat(list[0]);
      default:
        throw new TypeError(`unknown model proxy operation: ${name}`);
    }
  }

  claim(id) {
    const entry = this.#entries.get(String(id || ''));
    if (entry?.state !== 'pending') return null;
    entry.state = 'claimed';
    entry.lastSeenAt = this.#now();
    const payload = entry.payload;
    entry.payload = null;
    this.#publish();
    return { payload };
  }

  async event(id, eventsText) {
    const entry = this.#entries.get(String(id || ''));
    if (!entry || entry.state === 'pending') return { cancelled: true, results: '[]' };
    entry.lastSeenAt = this.#now();
    if (entry.state === 'cancelled') return { cancelled: true, results: '[]' };
    const events = decodeModelProxyWire(eventsText);
    const results = [];
    for (const event of Array.isArray(events) ? events : []) {
      const callback = entry.state === 'claimed' ? entry.callbacks[String(event?.name || '')] : null;
      if (typeof callback !== 'function') {
        results.push({ ok: true, value: null });
        continue;
      }
      try {
        const value = await callback(...(Array.isArray(event.args) ? event.args : []));
        results.push({ ok: true, value: modelProxyWireValue(value) ?? null });
      } catch (error) {
        results.push({ ok: false, error: modelProxyErrorToWire(error) });
      }
    }
    entry.lastSeenAt = this.#now();
    return { cancelled: entry.state !== 'claimed', results: encodeModelProxyWire(results) };
  }

  resolve(id, ok, valueText, errorText) {
    const entry = this.#entries.get(String(id || ''));
    if (!entry || entry.state === 'pending') return false;
    this.#entries.delete(entry.id);
    if (entry.state === 'cancelled') {
      this.#publish();
      return true;
    }
    if (ok) {
      let value;
      try {
        value = decodeModelProxyWire(valueText);
      } catch (error) {
        this.#settle(entry, false, error);
        return true;
      }
      this.#settle(entry, true, value);
    } else {
      let error;
      try {
        error = modelProxyErrorFromWire(decodeModelProxyWire(errorText));
      } catch {
        error = new Error('model proxy call failed on the desktop client');
      }
      this.#settle(entry, false, error);
    }
    return true;
  }

  /** PC liveness for its running calls; answers which of them to stop. */
  heartbeat(ids) {
    const now = this.#now();
    const cancelled = [];
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = String(raw || '');
      const entry = this.#entries.get(id);
      if (entry?.state !== 'claimed') {
        cancelled.push(id);
        continue;
      }
      entry.lastSeenAt = now;
    }
    return { cancelled };
  }

  snapshot() {
    const requests = [];
    const cancelled = [];
    for (const entry of this.#entries.values()) {
      if (entry.state === 'pending') {
        requests.push({ id: entry.id, provider: entry.provider, method: entry.method, model: entry.model });
      } else if (entry.state === 'cancelled') cancelled.push(entry.id);
    }
    return { requests, cancelled };
  }

  #publish() {
    try {
      this.#publisher?.(this.snapshot());
    } catch {
      /* the sweep fails unclaimed calls if the client never hears of them */
    }
  }

  #settle(entry, ok, value) {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.onAbort) {
      try {
        entry.signal.removeEventListener('abort', entry.onAbort);
      } catch {
        /* best effort: the call is settled whether or not the signal drops the listener */
      }
    }
    entry.callbacks = {};
    if (ok) entry.resolve(value);
    else entry.reject(value);
  }

  #cancel(entry, reason) {
    if (entry.settled) return;
    this.#settle(entry, false, reason);
    if (entry.state === 'pending') this.#entries.delete(entry.id);
    else {
      entry.state = 'cancelled';
      entry.cancelledAt = this.#now();
    }
    this.#publish();
  }

  #ensureSweep() {
    if (this.#sweepTimer) return;
    this.#sweepTimer = setInterval(() => this.sweep(), this.#sweepMs);
    this.#sweepTimer.unref?.();
  }

  #stopSweep() {
    if (!this.#sweepTimer) return;
    clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
  }

  /** Expire unclaimed calls, silent clients and acknowledged-never cancels. */
  sweep() {
    const now = this.#now();
    let changed = false;
    for (const entry of [...this.#entries.values()]) {
      if (entry.state === 'pending' && now >= entry.claimDeadline) {
        this.#entries.delete(entry.id);
        this.#settle(entry, false, new ModelProxyUnavailableError('the desktop client did not pick up the model call'));
        changed = true;
      } else if (entry.state === 'claimed' && now - entry.lastSeenAt > this.#leaseMs) {
        this.#entries.delete(entry.id);
        this.#settle(entry, false, new ModelProxyUnavailableError('the desktop client stopped responding'));
        changed = true;
      } else if (entry.state === 'cancelled' && now - entry.cancelledAt > this.#leaseMs) {
        this.#entries.delete(entry.id);
        changed = true;
      }
    }
    if (changed) this.#publish();
    if (!this.#entries.size) this.#stopSweep();
  }
}

const CHANNEL_KEY = Symbol.for('mixdog.modelProxyChannel.v1');

/** The process-wide channel shared by the provider registry and the desktop service. */
export function getModelProxyChannel() {
  globalThis[CHANNEL_KEY] ??= new ModelProxyChannel();
  return globalThis[CHANNEL_KEY];
}

/**
 * Make `channel` the process-wide channel (a headless child talks through the
 * daemon's model proxy bridge instead). The returned restore puts the previous
 * channel back once, unless another install replaced this one since.
 */
export function installModelProxyChannel(channel) {
  const hadPrevious = Object.hasOwn(globalThis, CHANNEL_KEY);
  const previous = globalThis[CHANNEL_KEY];
  globalThis[CHANNEL_KEY] = channel;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (globalThis[CHANNEL_KEY] !== channel) return;
    if (hadPrevious) globalThis[CHANNEL_KEY] = previous;
    else delete globalThis[CHANNEL_KEY];
  };
}
