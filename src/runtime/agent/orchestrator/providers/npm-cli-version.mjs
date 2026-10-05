// Live "latest published CLI version" lookup from the npm registry, shared by
// providers that must present a current CLI client version to a version gate.
// Sync accessor never blocks (kicks a background refresh); warm() is the
// awaitable cold-start path. Failures resolve to null so callers fall back to
// their floor. MIXDOG_DISABLE_LIVE_CLI_VERSIONS=1 turns the lookup off.
//
// A source given a `persistKey` also remembers its last live answer on disk,
// so a new process (or an offline one) starts from the newest version this
// machine has seen rather than from a floor that only moves with a release.

import { readLastKnownVersion, rememberLastKnownVersion } from './client-version-store.mjs';

const SEMVER = /^\d+\.\d+\.\d+$/;
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const FAILURE_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 4_000;

export function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** Highest valid x.y.z among the candidates (invalid/empty ignored). */
export function maxSemver(...candidates) {
  let best = null;
  for (const c of candidates) {
    const v = String(c ?? '').trim();
    if (SEMVER.test(v) && (!best || compareSemver(v, best) > 0)) best = v;
  }
  return best;
}

export function createNpmVersionSource(pkg, options) {
  return createRemoteVersionSource(
    `https://registry.npmjs.org/${pkg}/latest`,
    async (res) => {
      const v = String((await res.json())?.version || '').trim();
      return SEMVER.test(v) ? v : null;
    },
    options
  );
}

/**
 * Generic source: GET `url`, `parse(res)` returns the version string or null
 * (unrecognised format). Same TTL/in-flight/timeout/disable rules as npm.
 */
export function createRemoteVersionSource(
  url,
  parse,
  { ttlMs = DEFAULT_TTL_MS, timeoutMs = TIMEOUT_MS, persistKey = null } = {}
) {
  let value = null;
  let expiresAt = 0;
  let inFlight = null;
  let lastKnownLoaded = false;

  // Stale on purpose: it answers until the refresh lands, never instead of it.
  function loadLastKnown() {
    if (lastKnownLoaded) return;
    lastKnownLoaded = true;
    if (!value) value = readLastKnownVersion(persistKey);
  }

  async function refresh() {
    let next = null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) next = (await parse(res)) || null;
    } catch {
      /* offline or slow — keep previous/floor */
    }
    if (next) {
      value = next;
      rememberLastKnownVersion(persistKey, next);
    }
    expiresAt = Date.now() + (next ? ttlMs : FAILURE_TTL_MS);
    return value;
  }

  function ensureRefresh() {
    if (process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS === '1') return Promise.resolve(value);
    if (!inFlight) {
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  const fresh = () => Date.now() < expiresAt;

  return {
    /** Cached live version or null; refreshes in the background when stale. */
    sync() {
      loadLastKnown();
      if (!fresh()) ensureRefresh();
      return value;
    },
    /** Awaitable, never rejects; bounded by the fetch timeout. */
    warm() {
      loadLastKnown();
      return fresh() ? Promise.resolve(value) : ensureRefresh();
    },
  };
}
