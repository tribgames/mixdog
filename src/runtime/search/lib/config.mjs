import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { resolvePluginData } from '../../shared/plugin-paths.mjs'
import { renameWithRetrySync, writeJsonAtomicSync } from '../../shared/atomic-file.mjs'
import { readSection, updateSection, stripGeneratedMarker, CONFIG_PATH as MIXDOG_CONFIG_PATH, getSearchApiKey } from '../../shared/config.mjs'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
// src/search/lib/config.mjs → plugin root is three levels up (src/search/lib → src/search → src → plugin root).
export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(currentDir, '..', '..', '..')

// Unified mode: search shares the plugin data dir with the rest of mixdog.
const SHARED_DATA_DIR = resolvePluginData()
if (!SHARED_DATA_DIR) throw new Error('[search-config] resolvePluginData() returned falsy — plugin data dir not configured')
export const DATA_DIR = SHARED_DATA_DIR
export const USAGE_PATH = path.join(DATA_DIR, 'usage.local.json')
export const CACHE_PATH = path.join(DATA_DIR, 'cache.local.json')

// Per-provider default models. Single source of truth for any site that
// needs a fallback when the user config lacks an explicit override.
export const DEFAULT_MODELS = {
  openai: 'gpt-5.5',
  gemini: 'gemini-3-flash-preview',
  xai:    'grok-4.3',
}

export const DEFAULT_CONFIG = {
  // Single active search backend. Switching here changes which backend the
  // `search` MCP tool calls — does not require credentials for the unused
  // backends. No priority chain / fallback — the selected provider is the
  // only one tried; on failure the call throws.
  provider: 'anthropic-oauth',
  // Per-provider model override (only used by providers that take a model arg).
  // Anthropic OAuth is haiku-fixed (third-party policy + practical quota).
  models: {},
  rawSearch: {
    maxResults: 10,
    credentials: {
      firecrawl: {
        apiKey: '',
      },
      tavily: {
        apiKey: '',
      },
      exa: {
        apiKey: '',
      },
    },
  },
  requestTimeoutMs: 120000,
  crawl: {
    maxPages: 10,
    maxDepth: 2,
    sameDomainOnly: true,
  },
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

export function ensureDataDir() {
  ensureDir(DATA_DIR)
}

export function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    try {
      return JSON.parse(raw)
    } catch (parseErr) {
      try { renameWithRetrySync(filePath, filePath + '.corrupt.' + Date.now()) } catch {}
      process.stderr.write(`[search-config] corrupt JSON backed up: ${filePath}\n`)
      throw parseErr
    }
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    throw err
  }
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  writeJsonAtomicSync(filePath, value, { lock: true, fsyncDir: true })
}

function hasKeys(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
}

export function saveConfig(config) {
  updateSection('search', () => stripGeneratedMarker(config) || {})
}

function finiteInt(value, { min, max, def }) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return def
  const i = Math.trunc(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

function strictBool(value, def) {
  if (value === true) return true
  if (value === false) return false
  return def
}

export function loadConfig() {
  ensureDataDir()
  let config = readSection('search')
  if (!hasKeys(config)) {
    saveConfig(DEFAULT_CONFIG)
    config = DEFAULT_CONFIG
    process.stderr.write(
      `mixdog-search: default config created in ${MIXDOG_CONFIG_PATH} (section: search)\n` +
      '  use /setup to change provider priority and crawl defaults.\n',
    )
  }
  const merged = {
    ...DEFAULT_CONFIG,
    ...config,
    rawSearch: {
      ...DEFAULT_CONFIG.rawSearch,
      ...(config?.rawSearch || {}),
      credentials: {
        ...DEFAULT_CONFIG.rawSearch.credentials,
        ...(config?.rawSearch?.credentials || {}),
      },
    },
    crawl: {
      ...DEFAULT_CONFIG.crawl,
      ...(config?.crawl || {}),
    },
  }
  merged.requestTimeoutMs = finiteInt(merged.requestTimeoutMs, {
    min: 1000,
    max: 300000,
    def: DEFAULT_CONFIG.requestTimeoutMs,
  })
  merged.crawl.maxPages = finiteInt(merged.crawl.maxPages, {
    min: 1,
    max: 200,
    def: DEFAULT_CONFIG.crawl.maxPages,
  })
  merged.crawl.maxDepth = finiteInt(merged.crawl.maxDepth, {
    min: 0,
    max: 5,
    def: DEFAULT_CONFIG.crawl.maxDepth,
  })
  merged.crawl.sameDomainOnly = strictBool(merged.crawl.sameDomainOnly, true)
  return merged
}

export function getRawSearchMaxResults(config) {
  return config.rawSearch?.maxResults || DEFAULT_CONFIG.rawSearch.maxResults
}

export function getRawProviderApiKey(_config, provider) {
  return getSearchApiKey(provider)
}

export function getRawProviderCredentialSource(config, provider, env = process.env) {
  if (getRawProviderApiKey(config, provider)) {
    return 'config'
  }

  const envKeyByProvider = {
    firecrawl: 'FIRECRAWL_API_KEY',
    tavily: 'TAVILY_API_KEY',
    'xai-api': ['XAI_API_KEY', 'GROK_API_KEY'],
  }

  const envKey = envKeyByProvider[provider]
  if (envKey) {
    const keys = Array.isArray(envKey) ? envKey : [envKey]
    if (keys.some(k => env?.[k])) {
      return 'env'
    }
  }

  return null
}

export function getRequestTimeoutMs(config) {
  return config.requestTimeoutMs || DEFAULT_CONFIG.requestTimeoutMs
}

export function getFirecrawlApiKey(config) {
  return getRawProviderApiKey(config, 'firecrawl') || ''
}
