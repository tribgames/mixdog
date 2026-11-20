const PROVIDER_ALIASES = Object.freeze({
  'openai-api': 'openai',
  'xai-api': 'xai',
  'gemini-api': 'gemini',
  'anthropic-api': 'anthropic',
});

export function canonicalRouteProvider(value) {
  const id = String(value || '').trim();
  return PROVIDER_ALIASES[id] || id;
}

export function routeChain(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) return [];
  const { fallbacks = [], ...primary } = route;
  if (!Array.isArray(fallbacks)) throw new Error('route.fallbacks must be an array');
  for (const entry of fallbacks) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.hasOwn(entry, 'fallbacks')) {
      throw new Error('fallback routes must be leaf route objects');
    }
  }
  return [primary, ...fallbacks];
}

/** The fallbacks a chain runs: those on a provider not already used by the
 *  primary or an earlier fallback. The stored list is never changed; a fallback
 *  on the main model's own provider (left there by a later main-model change)
 *  is simply inactive. */
export function executionFallbacks(route) {
  const [primary, ...fallbacks] = routeChain(route);
  if (!primary) return [];
  const seen = new Set([routeIdentity(primary)]);
  return fallbacks.filter((entry) => {
    const identity = routeIdentity(entry);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/** A route's identity: canonical provider plus model. */
export function routeIdentity(route) {
  return `${canonicalRouteProvider(route.provider)}\n${String(route.model || '').trim()}`;
}

/** `allowDuplicates` accepts a stored chain whose fallbacks repeat a provider and model
 *  (see executionFallbacks); an explicit save validates without it. */
export function validateRouteChainProviders(routes, { allowDuplicates = false } = {}) {
  const seen = new Set();
  for (const route of routes) {
    const provider = canonicalRouteProvider(route.provider);
    const model = String(route.model || '').trim();
    if (!provider || !model) throw new Error('route requires provider and model');
    const identity = routeIdentity(route);
    if (!allowDuplicates && seen.has(identity)) throw new Error(`duplicate route "${provider}/${model}"`);
    if (seen.size && provider === 'default') throw new Error('follow Main is only allowed as the primary route');
    seen.add(identity);
  }
}

export function normalizeRouteChain(route, normalizeLeaf, fallback = {}, { strict = true } = {}) {
  const raw = routeChain({ ...fallback, ...route });
  const primary = normalizeLeaf(route, fallback);
  if (!primary) return null;
  const routes = raw.map((entry, index) => {
    const normalized = index === 0 ? primary : normalizeLeaf(entry, {});
    if (!normalized) throw new Error('fallback route requires provider and model');
    return { ...normalized, provider: canonicalRouteProvider(normalized.provider) };
  });
  validateRouteChainProviders(routes, { allowDuplicates: !strict });
  const [first, ...rest] = routes;
  return rest.length ? { ...first, fallbacks: rest } : first;
}
