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

export function validateRouteChainProviders(routes) {
  const providers = new Set();
  for (const route of routes) {
    const provider = canonicalRouteProvider(route.provider);
    if (!provider || !String(route.model || '').trim()) throw new Error('route requires provider and model');
    if (providers.has(provider)) throw new Error(`duplicate route provider "${provider}"`);
    if (providers.size && provider === 'default') throw new Error('follow Main is only allowed as the primary route');
    providers.add(provider);
  }
}

export function normalizeRouteChain(route, normalizeLeaf, fallback = {}) {
  const raw = routeChain({ ...fallback, ...route });
  const primary = normalizeLeaf(route, fallback);
  if (!primary) return null;
  const routes = raw.map((entry, index) => {
    const normalized = index === 0 ? primary : normalizeLeaf(entry, {});
    if (!normalized) throw new Error('fallback route requires provider and model');
    return { ...normalized, provider: canonicalRouteProvider(normalized.provider) };
  });
  validateRouteChainProviders(routes);
  const [first, ...rest] = routes;
  return rest.length ? { ...first, fallbacks: rest } : first;
}
