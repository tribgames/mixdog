// Citations (deduped by URL) and web_search_call items, from output_text
// annotations and web search actions.
export function createCitations() {
  const citations = [];
  const citationKeys = new Set();
  const webSearchCalls = [];
  const webSearchCallKeys = new Set();

  function pushCitation(raw, fallbackTitle = '') {
    const url = raw?.url || raw?.uri || raw?.href || '';
    if (!url || citationKeys.has(url)) return;
    citationKeys.add(url);
    citations.push({
      title: raw?.title || fallbackTitle || '',
      url,
      snippet: raw?.snippet || raw?.text || raw?.description || '',
      source: 'openai-oauth',
    });
  }

  function pushOutputTextAnnotations(contentPart) {
    const annotations = Array.isArray(contentPart?.annotations) ? contentPart.annotations : [];
    for (const annotation of annotations) pushCitation(annotation);
  }

  function webSearchKey(item) {
    if (item.id) return item.id;
    try {
      return JSON.stringify(item.action || item);
    } catch {
      return `${webSearchCalls.length}`;
    }
  }

  function pushWebSearchCall(item) {
    if (item?.type !== 'web_search_call') return;
    const key = webSearchKey(item);
    if (webSearchCallKeys.has(key)) return;
    webSearchCallKeys.add(key);
    webSearchCalls.push({
      id: item.id || '',
      status: item.status || '',
      action: item.action || null,
    });
    const action = item.action || {};
    if (action.url) pushCitation({ url: action.url, title: action.query || '' });
    if (Array.isArray(action.urls)) {
      for (const url of action.urls) pushCitation({ url, title: action.query || '' });
    }
  }

  return { citations, webSearchCalls, pushCitation, pushOutputTextAnnotations, pushWebSearchCall };
}
