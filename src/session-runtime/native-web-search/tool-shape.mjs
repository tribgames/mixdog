/**
 * tool-shape.mjs — provider-specific shape of the hosted web-search tool,
 * the prompt that drives it and the flattening of its cited sources.
 */
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';

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

// A site filter may name several domains the way a search box takes them
// ("a.com OR b.com", "a.com, b.com", "site:a.com site:b.com"); each becomes its
// own allowed domain instead of one invalid combined entry.
export function normalizeWebSearchAllowedDomains(site) {
  const domains = clean(site)
    .split(/[\s,|]+/)
    .filter((part) => part && part.toUpperCase() !== 'OR')
    .map((part) => normalizeWebSearchAllowedDomain(part.replace(/^site:/i, '')))
    .filter(Boolean);
  return [...new Set(domains)];
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

// `family` is the provider's hosted web-search family (webSearchProviderFamily).
export function nativeWebSearchTool(args = {}, toolType = 'web_search', family = '') {
  const domains = normalizeWebSearchAllowedDomains(args.site);
  const type = clean(toolType) || 'web_search';
  const location = nativeWebSearchUserLocation(args.locale);
  if (family === 'gemini') {
    return { type };
  }
  if (family === 'anthropic') {
    const tool = {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: Math.max(1, Math.min(10, Number(args.maxResults) || 5)),
    };
    if (domains.length) tool.allowed_domains = domains;
    if (location) tool.user_location = location;
    return tool;
  }
  if (family === 'xai') {
    const tool = { type };
    if (domains.length) tool.filters = { allowed_domains: domains };
    return tool;
  }
  const tool = { type };
  if (type === 'web_search') {
    tool.search_context_size = clean(args.contextSize) || 'low';
    if (domains.length) tool.filters = { allowed_domains: domains };
    if (location) tool.user_location = location;
  }
  return tool;
}

export function nativeWebSearchToolTypes(routeLike = {}, family = '') {
  const envToolType = clean(process.env.MIXDOG_NATIVE_WEB_SEARCH_TOOL_TYPE);
  if (envToolType) return [envToolType];
  const configured = clean(routeLike.toolType);
  if (configured) return [configured];
  if (family === 'gemini') return ['google_search'];
  if (family === 'anthropic' || family === 'xai') return ['web_search'];
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
