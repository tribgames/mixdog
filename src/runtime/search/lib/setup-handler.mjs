import { loadConfig, saveConfig } from './config.mjs'
import { getSearchApiKey, saveSecret, SECRET_ACCOUNTS } from '../../shared/config.mjs'
import { DEFAULT_MODELS } from './config.mjs'
import { PROVIDER_OVERRIDE_ENUM } from './providers.mjs'

const PROVIDER_CHOICES = PROVIDER_OVERRIDE_ENUM

const SEARCH_KEY_PROVIDERS = ['firecrawl', 'tavily', 'exa']

function mask(key) {
  if (!key) return '  not set'
  return '  ****' + key.slice(-4)
}

function icon(key) {
  return key ? '●' : '○'
}

function statusBlock(config) {
  const activeProvider = config.provider || 'anthropic-oauth'
  const models = config.models || {}

  const lines = [
    '',
    '  ╭───────────────────────────────────────╮',
    '  │  mixdog-search config                   │',
    '  ╰───────────────────────────────────────╯',
    '',
    '  Active Backend',
    '  ────────────────────────────────────────',
    `    provider     ${activeProvider}`,
  ]
  if (activeProvider === 'openai-oauth' || activeProvider === 'openai-api') {
    lines.push(`    openai model ${models.openai || 'gpt-5.5'}`)
  } else if (activeProvider === 'gemini-api') {
    lines.push(`    gemini model ${models.gemini || DEFAULT_MODELS.gemini}`)
  } else if (activeProvider === 'xai-api') {
    lines.push(`    xai model    ${models.xai || 'grok-4.3'}`)
  } else if (activeProvider === 'anthropic-oauth') {
    lines.push(`    model        claude-haiku-4-5 (fixed)`)
  }

  lines.push('')
  lines.push('  Search-Specific Keys')
  lines.push('  ────────────────────────────────────────')
  for (const p of SEARCH_KEY_PROVIDERS) {
    const key = getSearchApiKey(p)
    lines.push(`    ${icon(key)} ${p.padEnd(12)}${mask(key)}`)
  }
  lines.push('')
  lines.push('  Options')
  lines.push('  ────────────────────────────────────────')
  lines.push(`    max results ${config.rawSearch?.maxResults || 10}`)
  lines.push(`    crawl       ${config.crawl?.maxPages || 10} pages / depth ${config.crawl?.maxDepth || 1}`)
  lines.push('')
  return lines.join('\n')
}

function sectionHeader(config) {
  const activeProvider = config.provider || 'anthropic-oauth'
  const total = SEARCH_KEY_PROVIDERS.filter(p => !!getSearchApiKey(p)).length
  return [
    '  ╭───────────────────────────────────────╮',
    '  │  mixdog-search setup                    │',
    '  ╰───────────────────────────────────────╯',
    '',
    `    active provider: ${activeProvider}`,
    `    ${total > 0 ? '●' : '○'} ${total} search-specific key(s) configured`,
    '',
  ].join('\n')
}

function keysHeader(title, entries) {
  const lines = [
    '  ╭───────────────────────────────────────╮',
    `  │  ${title.padEnd(37)}│`,
    '  ╰───────────────────────────────────────╯',
    '',
    '    empty = keep current / "clear" = remove',
    '',
  ]
  for (const [name, key] of entries) {
    lines.push(`    ${icon(key)} ${name.padEnd(12)}${mask(key)}`)
  }
  return lines.join('\n')
}

function applyKeys(config, data) {
  for (const [provider, value] of Object.entries(data)) {
    if (value == null) continue
    const trimmed = String(value).trim()
    if (!trimmed) continue
    const isClear = trimmed.toLowerCase() === 'clear'
    if (isClear) {
      saveSecret(SECRET_ACCOUNTS.searchApiKey(provider), '')
    } else {
      // Validate: API keys must be non-empty printable ASCII, no whitespace
      if (!/^[\x21-\x7E]+$/.test(trimmed)) {
        throw new Error(`[setup] invalid API key for ${provider}: must be printable ASCII with no whitespace`)
      }
      saveSecret(SECRET_ACCOUNTS.searchApiKey(provider), trimmed)
    }
    // Remove plaintext copy from config object before save
    if (config.rawSearch?.credentials?.[provider]?.apiKey != null) {
      delete config.rawSearch.credentials[provider].apiKey
    }
  }
}

function save(config) {
  saveConfig(config)
}

export async function handleSetup(server) {
  const config = loadConfig()

  const step1 = await server.elicitInput({
    message: sectionHeader(config),
    requestedSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          title: 'Section',
          enum: ['provider', 'search-keys', 'options', 'status'],
        },
      },
      required: ['section'],
    },
  })

  if (step1.action !== 'accept') {
    return { content: [{ type: 'text', text: statusBlock(config) }] }
  }

  const section = step1.content.section

  if (section === 'status') {
    return { content: [{ type: 'text', text: statusBlock(config) }] }
  }

  if (section === 'provider') {
    const result = await server.elicitInput({
      message: [
        '  ╭───────────────────────────────────────╮',
        '  │  Active Search Provider               │',
        '  ╰───────────────────────────────────────╯',
        '',
        `    current: ${config.provider || 'anthropic-oauth'}`,
        '',
        '    OAuth backends reuse the matching agent.providers',
        '    OAuth tokens; search-specific backends (firecrawl,',
        '    tavily, exa) use the keys set in `search-keys`.',
        '',
      ].join('\n'),
      requestedSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            title: 'Search Provider',
            enum: PROVIDER_CHOICES,
          },
          openaiModel: {
            type: 'string',
            title: 'OpenAI model preset (used when provider=openai-oauth/openai-api)',
            enum: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-4o', 'gpt-4.1'],
          },
          geminiModel: {
            type: 'string',
            title: 'Gemini model preset (used when provider=gemini-api)',
            enum: ['gemini-3-flash-preview', 'gemini-3.1-flash', 'gemini-3-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
          },
          xaiModel: {
            type: 'string',
            title: 'xAI model preset (used when provider=xai-api)',
            enum: ['grok-4.3', 'grok-4.20-fast', 'grok-composer-2.5-fast'],
          },
        },
      },
    })
    if (result.action === 'accept' && result.content) {
      const d = result.content
      if (typeof d.provider === 'string' && PROVIDER_CHOICES.includes(d.provider)) {
        config.provider = d.provider
      }
      if (!config.models) config.models = {}
      if (typeof d.openaiModel === 'string' && d.openaiModel.trim()) config.models.openai = d.openaiModel.trim()
      if (typeof d.geminiModel === 'string' && d.geminiModel.trim()) config.models.gemini = d.geminiModel.trim()
      if (typeof d.xaiModel === 'string' && d.xaiModel.trim()) config.models.xai = d.xaiModel.trim()
      save(config)
      return { content: [{ type: 'text', text: '  ✓ Provider saved.\n' + statusBlock(loadConfig()) }] }
    }
    return { content: [{ type: 'text', text: '  ⏎ Cancelled.' }] }
  }

  if (section === 'search-keys') {
    const result = await server.elicitInput({
      message: keysHeader('Search-Specific Keys', [
        ['firecrawl', getSearchApiKey('firecrawl')],
        ['tavily', getSearchApiKey('tavily')],
        ['exa', getSearchApiKey('exa')],
      ]),
      requestedSchema: {
        type: 'object',
        properties: {
          firecrawl: { type: 'string', title: 'Firecrawl' },
          tavily: { type: 'string', title: 'Tavily' },
          exa: { type: 'string', title: 'Exa' },
        },
      },
    })

    if (result.action === 'accept' && result.content) {
      try {
        applyKeys(config, result.content)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `  ✗ Search keys not saved: ${message}` }] }
      }
      save(config)
      return { content: [{ type: 'text', text: '  ✓ Search keys saved.\n' + statusBlock(loadConfig()) }] }
    }
    return { content: [{ type: 'text', text: '  ⏎ Cancelled.' }] }
  }

  if (section === 'options') {
    const result = await server.elicitInput({
      message: [
        '  ╭───────────────────────────────────────╮',
        '  │  Search Options                       │',
        '  ╰───────────────────────────────────────╯',
        '',
        `    max results  ${config.rawSearch?.maxResults || 10}`,
        `    crawl pages  ${config.crawl?.maxPages || 10}`,
        `    crawl depth  ${config.crawl?.maxDepth || 1}`,
        `    same domain  ${config.crawl?.sameDomainOnly ?? true}`,
      ].join('\n'),
      requestedSchema: {
        type: 'object',
        properties: {
          maxResults: { type: 'integer', title: 'Max search results' },
          crawlMaxPages: { type: 'integer', title: 'Crawl max pages' },
          crawlMaxDepth: { type: 'integer', title: 'Crawl max depth' },
          sameDomainOnly: { type: 'boolean', title: 'Same domain only' },
        },
      },
    })

    if (result.action === 'accept' && result.content) {
      const d = result.content
      if (d.maxResults != null) { if (!config.rawSearch) config.rawSearch = {}; config.rawSearch.maxResults = d.maxResults }
      if (d.crawlMaxPages != null) { if (!config.crawl) config.crawl = {}; config.crawl.maxPages = d.crawlMaxPages }
      if (d.crawlMaxDepth != null) { if (!config.crawl) config.crawl = {}; config.crawl.maxDepth = d.crawlMaxDepth }
      if (d.sameDomainOnly != null) { if (!config.crawl) config.crawl = {}; config.crawl.sameDomainOnly = d.sameDomainOnly }
      save(config)
      return { content: [{ type: 'text', text: '  ✓ Options saved.\n' + statusBlock(loadConfig()) }] }
    }
    return { content: [{ type: 'text', text: '  ⏎ Cancelled.' }] }
  }
}
