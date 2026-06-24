export const PROVIDER_OVERRIDE_ENUM = [
  'anthropic-oauth',
  'openai-oauth',
  'openai-api',
  'gemini-api',
  'xai-api',
  'grok-oauth',
  'tavily',
  'firecrawl',
  'exa',
]

export const RAW_PROVIDER_CAPABILITIES = {
  firecrawl: {
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: true,
    },
  },
  tavily: {
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: true,
    },
  },
  'xai-api': {
    usageSupport: {
      available: true,
      timestamps: true,
      cost: true,
      quota: false,
    },
  },
}

export function getProvidersWithApiKeys(env = process.env) {
  const providers = []
  if (env.FIRECRAWL_API_KEY) providers.push('firecrawl')
  if (env.TAVILY_API_KEY) providers.push('tavily')
  if (env.EXA_API_KEY) providers.push('exa')
  if (env.XAI_API_KEY || env.GROK_API_KEY) providers.push('xai-api')
  return providers
}
