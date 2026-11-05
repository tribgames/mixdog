// Recorder-process-only determinism for retry behaviour. No product code is
// touched and no wall-clock value is recorded:
//  - Math.random is replaced by a seeded PRNG (mulberry32, seed = FNV-1a/32 of
//    the scenario id); every sample is logged with the product call site, so a
//    Rust gate can replay the same samples against the same policy;
//  - globalThis.setTimeout is wrapped; every call made from product code is
//    logged with its scheduled delay, the number of requests/connections the
//    hub had received so far (`afterRequests`, so the sleep preceded attempt
//    `afterRequests + 1`) and the product call chain. Timers are NOT rescheduled
//    or shortened: the product runs with its real delays.
// Timers created inside Node internals (undici, ws, AbortSignal.timeout) have no
// product frame and are not part of the retry policy; they are not recorded.
import nodeCrypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const RETRY_SLEEP_FUNCTIONS = new Set(['sleepWithAbort', '_defaultAbortSleep', '_defaultSleep']);
const FRAME = /^\s*at (?:(.+?) \()?(file:\/\/\/[^()]+?|[A-Za-z]:[\\/][^()]+?):\d+:\d+\)?$/;

export const fnv1a32 = (text) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};

const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Sites run concurrently, so the global call order is not stable; each site's own
// sequence is. Group by site and number within the site.
const bySite = (samples) => {
  const count = {};
  return samples
    .map(({ n: _n, ...s }) => ({ ...s, n: (count[s.site] = (count[s.site] ?? 0) + 1) }))
    .sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : a.n - b.n));
};

export function installDeterminism(hub, tree) {
  const productPrefix = `${pathToFileURL(tree).href.toLowerCase()}/src/`;
  const realRandom = Math.random;
  const realSetTimeout = globalThis.setTimeout;
  let state = null;

  const productFrames = () => {
    const prior = Error.stackTraceLimit;
    Error.stackTraceLimit = 40;
    const stack = new Error().stack ?? '';
    Error.stackTraceLimit = prior;
    const frames = [];
    for (const line of stack.split('\n').slice(1)) {
      const m = FRAME.exec(line);
      if (!m) continue;
      const url = m[2].startsWith('file:') ? m[2] : pathToFileURL(m[2]).href;
      if (!url.toLowerCase().startsWith(productPrefix) || url.includes('/node_modules/')) continue;
      frames.push({ fn: (m[1] ?? '<anonymous>').replace(/^(async |new )/, ''), file: decodeURIComponent(url.slice(productPrefix.length - 4)) });
    }
    return frames;
  };

  Math.random = () => {
    if (!state) return realRandom();
    const value = state.rng();
    const [top] = productFrames();
    state.samples.push({ n: state.samples.length + 1, value, site: top ? `${top.file}#${top.fn}` : '<non-product>' });
    return value;
  };

  // crypto randomness (request/session ids the adapters mint): a second seeded
  // stream, used only for calls with a product frame on the stack, so Node/undici/ws
  // internals (handshake nonces, ...) neither consume it nor change its order.
  const realCrypto = {
    randomUUID: nodeCrypto.randomUUID,
    randomBytes: nodeCrypto.randomBytes,
    randomInt: nodeCrypto.randomInt,
    webRandomUUID: globalThis.crypto?.randomUUID,
    webGetRandomValues: globalThis.crypto?.getRandomValues,
  };
  const cryptoBytes = (kind, size) => {
    const [top] = productFrames();
    if (!state || !top) return null;
    const out = Buffer.alloc(size);
    // One stream per product call site: concurrent async sites (temp-file names vs
    // request ids) interleave differently run to run, so a shared stream would not repeat.
    const site = `${top.file}#${top.fn}`;
    const rng = (state.cryptoRngs[site] ??= mulberry32(state.seed ^ fnv1a32(site) ^ 0x9e3779b9));
    for (let i = 0; i < size; i += 1) out[i] = Math.floor(rng() * 256);
    state.crypto.push({ n: state.crypto.length + 1, kind, bytes: size, hex: out.toString('hex'), site: `${top.file}#${top.fn}` });
    return out;
  };
  const uuidFrom = (b) => {
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const uuidPatch = (real) => function randomUUID(...a) {
    const b = cryptoBytes('randomUUID', 16);
    return b ? uuidFrom(b) : real.apply(this, a);
  };
  nodeCrypto.randomUUID = uuidPatch(realCrypto.randomUUID);
  nodeCrypto.randomBytes = function randomBytes(size, cb) {
    const b = typeof size === 'number' ? cryptoBytes('randomBytes', size) : null;
    if (!b) return realCrypto.randomBytes.call(this, size, cb);
    if (typeof cb === 'function') { process.nextTick(cb, null, b); return undefined; }
    return b;
  };
  nodeCrypto.randomInt = function randomInt(...a) {
    const cb = typeof a.at(-1) === 'function' ? a.pop() : null;
    const [min, max] = a.length === 1 ? [0, a[0]] : a;
    const b = cryptoBytes('randomInt', 4);
    if (!b) return realCrypto.randomInt.call(this, ...a, ...(cb ? [cb] : []));
    const v = min + (b.readUInt32BE(0) % (max - min));
    if (cb) { process.nextTick(cb, null, v); return undefined; }
    return v;
  };
  const fillTyped = (real) => function getRandomValues(arr) {
    const b = arr && arr.byteLength ? cryptoBytes('getRandomValues', arr.byteLength) : null;
    if (!b) return real.call(this, arr);
    new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).set(b);
    return arr;
  };
  if (globalThis.crypto) {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, writable: true, value: uuidPatch(realCrypto.webRandomUUID) });
    Object.defineProperty(globalThis.crypto, 'getRandomValues', { configurable: true, writable: true, value: fillTyped(realCrypto.webGetRandomValues) });
  }
  syncBuiltinESMExports();

  globalThis.setTimeout = function patchedSetTimeout(callback, delay, ...rest) {
    if (state) {
      const frames = productFrames();
      if (frames.length) {
        state.timers.push({
          kind: frames.some((f) => RETRY_SLEEP_FUNCTIONS.has(f.fn)) ? 'retry-sleep' : 'timer',
          delayMs: Number(delay) || 0,
          afterRequests: hub.records.length,
          site: `${frames[0].file}#${frames[0].fn}`,
          chain: frames.slice(0, 4).map((f) => `${f.file}#${f.fn}`),
        });
      }
    }
    return realSetTimeout.call(this, callback, delay, ...rest);
  };

  hub.beginScenario = (id) => {
    const seed = fnv1a32(id);
    state = { id, seed, rng: mulberry32(seed), cryptoRngs: {}, samples: [], crypto: [], timers: [] };
  };
  hub.endScenario = () => {
    const done = state;
    state = null;
    if (!done) return null;
    // Retry sleeps are exact facts: the delay the policy computed from the seeded
    // samples, and the attempt it preceded. Watchdog/deadline timers are NOT
    // recorded with delays: their re-arm count follows how the response is
    // chunked on the socket and their delay is derived from Date.now() (299999
    // vs 300000), so neither is reproducible. Only their product call sites are
    // listed, so a missed sleep site shows up in review.
    const retrySleeps = done.timers
      .filter((t) => t.kind === 'retry-sleep')
      .map((t, i) => ({ seq: i + 1, delayMs: t.delayMs, precedesAttempt: t.afterRequests + 1, site: t.site, chain: t.chain }));
    const otherSites = [...new Set(done.timers.filter((t) => t.kind !== 'retry-sleep' && !t.site.includes('agent-trace-io.mjs')).map((t) => t.site))].sort();
    return {
      rng: { algorithm: 'mulberry32', seedDerivation: 'fnv1a32(scenarioId)', scenarioId: done.id, seed: done.seed, samples: done.samples },
      cryptoRandom: { algorithm: 'mulberry32 bytes', seedDerivation: 'one stream per product call site: fnv1a32(scenarioId) ^ fnv1a32(site) ^ 0x9e3779b9', note: 'only calls with a product frame on the stack; temp-file/lock names from shared/file-lock.mjs and shared/atomic-file.mjs are omitted (background cache writers, a race with the scenario window)', samples: bySite(done.crypto.filter((c) => !/shared\/(file-lock|atomic-file)\.mjs#/.test(c.site))) },
      retrySleeps,
      otherProductTimerSites: otherSites,
      notRecorded: 'the local agent-trace flush timers (fire-and-forget; their presence in a scenario window is a race), '
        + 'delays of watchdog/deadline timers, timers created by Node internals (undici, ws, AbortSignal.timeout), and any wall-clock value',
    };
  };
  hub.restoreDeterminism = () => {
    Math.random = realRandom;
    globalThis.setTimeout = realSetTimeout;
    Object.assign(nodeCrypto, { randomUUID: realCrypto.randomUUID, randomBytes: realCrypto.randomBytes, randomInt: realCrypto.randomInt });
    if (globalThis.crypto) {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, writable: true, value: realCrypto.webRandomUUID });
      Object.defineProperty(globalThis.crypto, 'getRandomValues', { configurable: true, writable: true, value: realCrypto.webGetRandomValues });
    }
    syncBuiltinESMExports();
  };
}
