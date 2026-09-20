// Native (provider-hosted) web-search runtime.
// Dependency-injected factory pattern: closes over
// route/webSearchRoute/config/reg/session accessors supplied by the facade.
//
//   native-web-search/tool-shape.mjs — provider tool shape, prompt, source flattening
//   native-web-search/routes.mjs     — which provider/model answers the search
import {
  flattenNativeWebSearchSources,
  nativeWebSearchMessages,
  nativeWebSearchTool,
  nativeWebSearchToolTypes,
  nativeWebSearchUserLocation,
  normalizeWebSearchAllowedDomain,
} from './native-web-search/tool-shape.mjs';
import { createWebSearchRouteCandidates } from './native-web-search/routes.mjs';

export function createNativeWebSearch(deps) {
  const {
    getRoute,
    getWebSearchRoute,
    getConfig,
    getSession,
    getReg,
    ensureProvidersReady,
    ensureProviderEnabled,
    normalizeWebSearchProviderId,
    isDefaultWebSearchRouteConfig,
  } = deps;
  const routes = createWebSearchRouteCandidates(deps);

  const toolFor = (args, toolType, providerId) =>
    nativeWebSearchTool(args, toolType, normalizeWebSearchProviderId(providerId));
  const toolTypesFor = (routeLike = {}) =>
    nativeWebSearchToolTypes(routeLike, normalizeWebSearchProviderId(routeLike.provider));

  function noCandidateError() {
    const route = getRoute();
    if (isDefaultWebSearchRouteConfig(getWebSearchRoute())) {
      return new Error(
        `default web search route requires the current main model to support native web search (${route?.provider || 'unknown'}/${route?.model || 'unknown'})`
      );
    }
    const configured = getWebSearchRoute();
    return new Error(
      `web search route "${configured?.provider || 'unknown'}/${configured?.model || 'unknown'}" cannot run native web search; open /websearch to choose another provider/model`
    );
  }

  /** One provider send with the hosted tool; throws when the provider cannot serve it. */
  async function sendCandidate(candidate, toolType, webSearchArgs, signal) {
    // Read config lazily: nativeWebSearchRoutes() may have run
    // ensureFullConfig() and replaced the facade config with the
    // secret-bearing one — an early snapshot would miss those secrets.
    await ensureProvidersReady(ensureProviderEnabled(getConfig(), candidate.provider));
    const providerImpl = getReg().getProvider(candidate.provider);
    if (!providerImpl || typeof providerImpl.send !== 'function') {
      throw new Error(`provider "${candidate.provider}" is not ready`);
    }
    const startedAt = Date.now();
    const result = await providerImpl.send(nativeWebSearchMessages(webSearchArgs), candidate.model, undefined, {
      signal,
      role: 'web-search',
      sessionId: `${getSession()?.id || 'web_search'}:native-web-search:${Date.now().toString(36)}`,
      sourceType: 'native-web-search',
      sourceName: 'web_search',
      nativeTools: [toolFor(webSearchArgs, toolType, candidate.provider)],
      nativeInclude:
        candidate.provider === 'openai' || candidate.provider === 'openai-oauth'
          ? ['web_search_call.action.sources']
          : [],
      toolChoice: candidate.provider === 'gemini' ? 'auto' : 'required',
      ...(candidate.effort ? { effort: candidate.effort } : {}),
      fast: candidate.fast === true,
      modelParameters: candidate.modelParameters || {},
      onStageChange: () => {},
      onStreamDelta: () => {},
    });
    return {
      content: String(result?.content || '').trim(),
      provider: candidate.provider,
      model: result?.model || candidate.model || null,
      usage: result?.usage || null,
      citations: flattenNativeWebSearchSources(result),
      webSearchCalls: result?.webSearchCalls || [],
      durationMs: Date.now() - startedAt,
    };
  }

  async function runNativeWebSearch(webSearchArgs = {}, { signal } = {}) {
    const candidates = await routes.nativeWebSearchRoutes();
    if (!candidates.length) throw noCandidateError();
    const errors = [];
    for (const candidate of candidates) {
      for (const toolType of toolTypesFor(candidate)) {
        try {
          return await sendCandidate(candidate, toolType, webSearchArgs, signal);
        } catch (err) {
          errors.push(
            `${candidate.provider}${candidate.model ? `/${candidate.model}` : ''}/${toolType}: ${err?.message || String(err)}`
          );
        }
      }
    }
    throw new Error(`native web search failed: ${errors.join(' | ')}`);
  }

  return {
    normalizeWebSearchAllowedDomain,
    nativeWebSearchUserLocation,
    nativeWebSearchTool: toolFor,
    nativeWebSearchToolTypes: toolTypesFor,
    ...routes,
    nativeWebSearchMessages,
    flattenNativeWebSearchSources,
    runNativeWebSearch,
  };
}
