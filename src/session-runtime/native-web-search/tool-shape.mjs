/**
 * tool-shape.mjs — provider-specific shape of the hosted web-search tool,
 * the prompt that drives it and the flattening of its cited sources.
 */
import { clean } from '../session-text.mjs';

export function normalizeWebSearchAllowedDomain(site) {
  const raw = clean(site);
  if (!raw) return '';
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .toLowerCase();
  }
}

export function nativeWebSearchUserLocation(locale) {
  if (!locale || typeof locale !== 'object' || Array.isArray(locale)) return null;
  const location = { type: 'approximate' };
  for (const key of ['country', 'region', 'city', 'timezone']) {
    const value = clean(locale[key]);
    if (value) location[key] = value;
  }
  return Object.keys(location).length > 1 ? location : null;
}

export function nativeWebSearchTool(args = {}, toolType = 'web_search', providerName = '') {
  const domain = normalizeWebSearchAllowedDomain(args.site);
  const type = clean(toolType) || 'web_search';
  const location = nativeWebSearchUserLocation(args.locale);
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
  const tool = { type };
  if (type === 'web_search') {
    tool.search_context_size = clean(args.contextSize) || 'low';
    if (domain) tool.filters = { allowed_domains: [domain] };
    if (location) tool.user_location = location;
  }
  return tool;
}

export function nativeWebSearchToolTypes(routeLike = {}, providerName = '') {
  const envToolType = clean(process.env.MIXDOG_NATIVE_WEB_SEARCH_TOOL_TYPE);
  if (envToolType) return [envToolType];
  const configured = clean(routeLike.toolType);
  if (configured) return [configured];
  if (providerName === 'gemini') return ['google_search'];
  if (providerName === 'anthropic' || providerName === 'anthropic-oauth') return ['web_search'];
  if (providerName === 'grok-oauth' || providerName === 'xai') return ['web_search'];
  return ['web_search', 'web_search_preview'];
}

export function nativeWebSearchMessages(webSearchArgs = {}) {
  const prompt = webSearchArgs.prompt || '';
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

export function flattenNativeWebSearchSources(result = {}) {
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
