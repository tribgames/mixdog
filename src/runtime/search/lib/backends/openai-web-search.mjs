export const OPENAI_SEARCH_SYSTEM_INSTRUCTIONS = 'You can use the web_search server tool to look up live information. Reply concisely with the answer and citations.'

export function buildOpenAIWebSearchTool({ site, type = 'web', locale, contextSize = 'low' } = {}) {
  const tool = {
    type: 'web_search',
    external_web_access: true,
    search_context_size: contextSize || 'low',
  }
  if (site) tool.filters = { allowed_domains: [site] }
  if (locale?.country || locale?.city || locale?.region || locale?.timezone) {
    tool.user_location = {
      type: 'approximate',
      ...(locale.country ? { country: locale.country } : {}),
      ...(locale.city ? { city: locale.city } : {}),
      ...(locale.region ? { region: locale.region } : {}),
      ...(locale.timezone ? { timezone: locale.timezone } : {}),
    }
  }
  if (type === 'images') tool.search_content_types = ['text', 'image']
  return tool
}

export function buildOpenAISearchPrompt(query, maxResults = 5) {
  return [
    String(query),
    '',
    `Return a concise answer and cite at most ${maxResults} source URLs.`,
    'Put source URLs as plain full URLs if annotations are not available.',
  ].join('\n')
}

export function citationsFromText(text, maxResults = 5, source = 'openai-oauth') {
  const urls = String(text || '').match(/https?:\/\/[^\s<>()\[\]{}"`']+/g) || []
  const seen = new Set()
  const citations = []
  for (const raw of urls) {
    let parsed
    try {
      parsed = new URL(raw.replace(/[.,;:!?]+$/g, ''))
    } catch {
      continue
    }
    const url = parsed.toString()
    if (seen.has(url)) continue
    seen.add(url)
    citations.push({ title: parsed.hostname, url, snippet: '', source })
    if (citations.length >= maxResults) break
  }
  return citations
}

export function citationsFromWebSearchCalls(calls, maxResults = 5, source = 'openai-oauth') {
  const seen = new Set()
  const citations = []
  for (const call of Array.isArray(calls) ? calls : []) {
    const action = call?.action || {}
    const entries = [
      ...(action.url ? [action.url] : []),
      ...(Array.isArray(action.urls) ? action.urls : []),
    ]
    for (const raw of entries) {
      let parsed
      try {
        parsed = new URL(String(raw))
      } catch {
        continue
      }
      const url = parsed.toString()
      if (seen.has(url)) continue
      seen.add(url)
      citations.push({ title: parsed.hostname, url, snippet: '', source })
      if (citations.length >= maxResults) return citations
    }
  }
  return citations
}
