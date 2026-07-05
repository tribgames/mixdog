// Native (provider-hosted) web-search runtime, extracted from
// mixdog-session-runtime.mjs. Dependency-injected factory pattern: closes over
// route/searchRoute/config/reg/session accessors supplied by the facade.
import { clean } from './session-text.mjs';

export function createNativeSearch({
  getRoute,
  getSearchRoute,
  setSearchRoute,
  getConfig,
  getSession,
  getReg,
  ensureFullConfig,
  ensureProvidersReady,
  ensureProviderEnabled,
  normalizeSearchProviderId,
  normalizeSearchRouteConfig,
  isDefaultSearchRouteConfig,
  isSearchCapableProvider,
  searchCapableFor,
}) {
  function normalizeSearchAllowedDomain(site) {
    const raw = clean(site);
    if (!raw) return '';
    try {
      return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
    } catch {
      return raw.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    }
  }

  function nativeSearchUserLocation(locale) {
    if (!locale || typeof locale !== 'object' || Array.isArray(locale)) return null;
    const location = { type: 'approximate' };
    for (const key of ['country', 'region', 'city', 'timezone']) {
      const value = clean(locale[key]);
      if (value) location[key] = value;
    }
    return Object.keys(location).length > 1 ? location : null;
  }

  function nativeSearchTool(args = {}, toolType = 'web_search', providerId = '') {
    const providerName = normalizeSearchProviderId(providerId);
    const domain = normalizeSearchAllowedDomain(args.site);
    const type = clean(toolType) || 'web_search';
    const location = nativeSearchUserLocation(args.locale);
    if (providerName === 'gemini') {
      return { type: type || 'google_search' };
    }
    if (providerName === 'anthropic' || providerName === 'anthropic-oauth') {
      const tool = {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: Math.max(1, Math.min(10, Number(args.maxResults) || 5)),
      };
      if (domain) tool.allowed_domains = [domain];
      if (location) tool.user_location = location;
      return tool;
    }
    if (providerName === 'grok-oauth' || providerName === 'xai') {
      const tool = { type };
      if (domain) tool.filters = { allowed_domains: [domain] };
      return tool;
    }
    const tool = {
      type,
    };
    if (type === 'web_search') {
      tool.search_context_size = clean(args.contextSize) || 'low';
      if (domain) tool.filters = { allowed_domains: [domain] };
      if (location) tool.user_location = location;
    }
    return tool;
  }

  function nativeSearchToolTypes(routeLike = {}) {
    const envToolType = clean(process.env.MIXDOG_NATIVE_SEARCH_TOOL_TYPE);
    if (envToolType) return [envToolType];
    const configured = clean(routeLike.toolType);
    if (configured) return [configured];
    const providerName = normalizeSearchProviderId(routeLike.provider);
    if (providerName === 'gemini') return ['google_search'];
    if (providerName === 'anthropic' || providerName === 'anthropic-oauth') return ['web_search'];
    if (providerName === 'grok-oauth' || providerName === 'xai') return ['web_search'];
    return ['web_search', 'web_search_preview'];
  }

  function currentMainSearchModelMeta() {
    const route = getRoute();
    if (!route?.provider || !route?.model) return null;
    return { ...route, id: route.model, display: route.model, name: route.model };
  }

  function nativeSearchRoutes() {
    const route = getRoute();
    const cfg = ensureFullConfig();
    const searchRoute = normalizeSearchRouteConfig(cfg.searchRoute) || normalizeSearchRouteConfig(getSearchRoute());
    setSearchRoute(searchRoute);
    if (!searchRoute) return [];
    if (isDefaultSearchRouteConfig(searchRoute)) {
      const mainModel = currentMainSearchModelMeta();
      if (!mainModel || !searchCapableFor(route.provider, mainModel)) return [];
      return [{
        key: `default\n${route.provider}\n${route.model}`,
        provider: normalizeSearchProviderId(route.provider),
        model: route.model,
        source: 'default-search-route',
        effort: route.effectiveEffort || route.effort || null,
        fast: route.fast === true,
        toolType: searchRoute.toolType || null,
      }];
    }
    const providerName = normalizeSearchProviderId(searchRoute.provider);
    if (!isSearchCapableProvider(providerName)) return [];
    return [{
      key: `${providerName}\n${searchRoute.model}`,
      provider: providerName,
      model: searchRoute.model,
      source: 'search-route',
      effort: searchRoute.effort || null,
      fast: searchRoute.fast === true,
      toolType: searchRoute.toolType || null,
    }];
  }

  function nativeSearchMessages(searchArgs = {}) {
    const prompt = searchArgs.prompt || '';
    return [
      {
        role: 'system',
        content: [
          'You are Mixdog native web search.',
          'Use the hosted web_search tool for current or external facts.',
          'Answer concisely, cite source URLs, and do not request local tools or file edits.',
        ].join('\n'),
      },
      { role: 'user', content: prompt },
    ];
  }

  function flattenNativeSearchSources(result = {}) {
    const out = [];
    const add = (source, fallbackTitle = '') => {
      if (!source || typeof source !== 'object') return;
      const url = clean(source.url || source.uri || source.href || source.source_url);
      if (!url) return;
      out.push({
        title: clean(source.title || source.query || source.name || fallbackTitle || url),
        url,
        snippet: clean(source.snippet || source.text || source.description),
        source: source.source || 'native-web-search',
        provider: source.provider || 'native-web-search',
      });
    };
    for (const citation of Array.isArray(result.citations) ? result.citations : []) add(citation);
    for (const call of Array.isArray(result.webSearchCalls) ? result.webSearchCalls : []) {
      const action = call?.action || {};
      for (const source of Array.isArray(action.sources) ? action.sources : []) add(source, action.query || '');
      if (action.url) add({ url: action.url, title: action.query || '' });
      for (const url of Array.isArray(action.urls) ? action.urls : []) add({ url, title: action.query || '' });
    }
    const seen = new Set();
    return out.filter((item) => {
      const key = item.url || `${item.title}\n${item.snippet}`;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function runNativeWebSearch(searchArgs = {}, { signal } = {}) {
    const route = getRoute();
    const session = getSession();
    const reg = getReg();
    const candidates = nativeSearchRoutes();
    if (!candidates.length) {
      if (isDefaultSearchRouteConfig(getSearchRoute())) {
        throw new Error(`default search route requires the current main model to support native web search (${route?.provider || 'unknown'}/${route?.model || 'unknown'})`);
      }
      throw new Error('search route is not configured; open /search to choose a search provider/model');
    }
    const errors = [];
    for (const candidate of candidates) {
      for (const toolType of nativeSearchToolTypes(candidate)) {
        try {
          // Read config lazily: nativeSearchRoutes() above may have run
          // ensureFullConfig() and replaced the facade config with the
          // secret-bearing one — an early snapshot would miss those secrets.
          await ensureProvidersReady(ensureProviderEnabled(getConfig(), candidate.provider));
          const providerImpl = reg.getProvider(candidate.provider);
          if (!providerImpl || typeof providerImpl.send !== 'function') {
            throw new Error(`provider "${candidate.provider}" is not ready`);
          }
          const model = candidate.model;
          const searchTool = nativeSearchTool(searchArgs, toolType, candidate.provider);
          const startedAt = Date.now();
          const result = await providerImpl.send(
            nativeSearchMessages(searchArgs),
            model,
            undefined,
            {
              signal,
              role: 'web-search',
              sessionId: `${session?.id || 'search'}:native-search:${Date.now().toString(36)}`,
              sourceType: 'native-search',
              sourceName: 'search',
              nativeTools: [searchTool],
              nativeInclude: candidate.provider === 'openai' || candidate.provider === 'openai-oauth'
                ? ['web_search_call.action.sources']
                : [],
              toolChoice: candidate.provider === 'gemini' ? 'auto' : 'required',
              ...(candidate.effort ? { effort: candidate.effort } : {}),
              fast: candidate.fast === true,
              onStageChange: () => {},
              onStreamDelta: () => {},
            },
          );
          const sources = flattenNativeSearchSources(result);
          return {
            content: String(result?.content || '').trim(),
            provider: candidate.provider,
            model: result?.model || candidate.model || null,
            usage: result?.usage || null,
            citations: sources,
            webSearchCalls: result?.webSearchCalls || [],
            durationMs: Date.now() - startedAt,
          };
        } catch (err) {
          errors.push(`${candidate.provider}${candidate.model ? `/${candidate.model}` : ''}/${toolType}: ${err?.message || String(err)}`);
        }
      }
    }
    throw new Error(`native web search failed: ${errors.join(' | ')}`);
  }

  return {
    normalizeSearchAllowedDomain,
    nativeSearchUserLocation,
    nativeSearchTool,
    nativeSearchToolTypes,
    currentMainSearchModelMeta,
    nativeSearchRoutes,
    nativeSearchMessages,
    flattenNativeSearchSources,
    runNativeWebSearch,
  };
}
