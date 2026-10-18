// Provider registries are process-global. Share raw catalog rows across
// sessions, while each session owns its saved-settings projection.
//
// One slow or offline provider must not hold, or force a reload of, everyone
// else's rows. Each provider's model list runs through catalog-deadline.mjs:
// bounded per provider (a timed-out list becomes an error entry and is
// aborted where listModels honors `{ signal }`), and single-flight per
// provider until the underlying work settles. When some but not all providers
// answer, the answered entries are kept for the catalog state, and each
// failed entry carries a process-wide `retryAt`: non-forced reads by any
// session reuse the partial answer and ask a missing provider again only once
// its backoff passed. Forced reads ask every provider. A load where every
// provider failed is never kept, so it stays immediately retryable. A
// provider whose previous list ignored its deadline and is still running is
// not asked at all (catalog-deadline.mjs): it gets a timed-out entry at
// once, with the same backoff, until that list settles.
//
// The catalog state is the registry revision plus a local epoch that
// invalidateSharedProviderCatalog() bumps on auth/account changes, so rows
// listed under the previous account are never served again.
import {
  boundedProviderCatalogOp,
  bumpProviderCatalogGeneration,
  PROVIDER_CATALOG_TIMEOUT_MS,
} from '../runtime/agent/orchestrator/providers/catalog-deadline.mjs';

export { PROVIDER_CATALOG_TIMEOUT_MS };

/** Backoff before a provider missing from a partial catalog is asked again. */
export const PROVIDER_CATALOG_RETRY_MS = 30_000;

let catalogEpoch = 0;
let sharedCatalogKey = null;
let sharedCatalogEntries = null;
let sharedPartialKey = null;
let sharedPartialEntries = null;
let sharedCatalogPromise = null;
let sharedCatalogPromiseKey = null;
let sharedCatalogPromiseForced = false;

export function catalogRevision(registry) {
  const value = Number(registry?.providerCatalogRevision?.());
  return Number.isFinite(value) ? value : 0;
}

const catalogKey = (registry) => `${catalogRevision(registry)}:${catalogEpoch}`;

/** Drops every shared entry (complete or partial) and opens a new epoch: the
 *  next read asks every provider again. Called on auth/account changes. */
export function invalidateSharedProviderCatalog() {
  catalogEpoch += 1;
  // Pending refreshes and lists of the previous account, of either kind, must
  // not block or fail the new account's work.
  bumpProviderCatalogGeneration();
  sharedCatalogKey = null;
  sharedCatalogEntries = null;
  sharedPartialKey = null;
  sharedPartialEntries = null;
}

const answered = (entry) => !Object.hasOwn(entry, 'error');

async function providerEntry(name, provider, timeoutMs, epoch) {
  if (typeof provider?.listModels !== 'function') return { name, models: [], ms: 0 };
  const startedAt = performance.now();
  const outcome = await boundedProviderCatalogOp({
    name,
    provider,
    kind: 'list',
    run: (signal) => provider.listModels({ signal }),
    timeoutMs,
    epoch,
  });
  const ms = performance.now() - startedAt;
  if (outcome.error) {
    return { name, models: [], error: outcome.error, ms, retryAt: Date.now() + PROVIDER_CATALOG_RETRY_MS };
  }
  return { name, models: Array.isArray(outcome.value) ? outcome.value : [], ms };
}

export async function sharedProviderCatalog(registry, { force = false, timeoutMs = PROVIDER_CATALOG_TIMEOUT_MS } = {}) {
  const key = catalogKey(registry);
  if (!force && sharedCatalogKey === key && Array.isArray(sharedCatalogEntries)) {
    return sharedCatalogEntries;
  }
  if (sharedCatalogPromise && sharedCatalogPromiseKey === key && (sharedCatalogPromiseForced || !force)) {
    return await sharedCatalogPromise;
  }
  const kept = new Map();
  if (!force && sharedPartialKey === key) {
    const now = Date.now();
    for (const entry of sharedPartialEntries) {
      if (answered(entry) || now < entry.retryAt) kept.set(entry.name, entry);
    }
  }
  const providers = [...registry.getAllProviders()];
  // Every missing provider is still inside its backoff: the partial answer is
  // the answer, without asking anyone.
  if (providers.length > 0 && providers.every(([name]) => kept.has(name))) {
    return providers.map(([name]) => kept.get(name));
  }
  // A pending list from an older catalog state (revision or account epoch) is
  // not joined: its answer may describe the previous catalog.
  const epoch = key;
  sharedCatalogPromiseKey = key;
  sharedCatalogPromiseForced = force;
  const request = Promise.all(
    providers.map(([name, provider]) => kept.get(name) || providerEntry(name, provider, timeoutMs, epoch))
  )
    .then((entries) => {
      if (sharedCatalogPromise === request && catalogKey(registry) === key) {
        const complete = entries.every(answered);
        const partial = !complete && entries.some(answered);
        sharedCatalogKey = complete ? key : null;
        sharedCatalogEntries = complete ? entries : null;
        sharedPartialKey = partial ? key : null;
        sharedPartialEntries = partial ? entries : null;
      }
      return entries;
    })
    .finally(() => {
      if (sharedCatalogPromise === request) {
        sharedCatalogPromise = null;
        sharedCatalogPromiseKey = null;
        sharedCatalogPromiseForced = false;
      }
    });
  sharedCatalogPromise = request;
  return await request;
}
