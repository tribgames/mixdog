async function fetchJson(url, apiKey) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })

  if (!response.ok) {
    // Drain/cancel the body before throwing so the underlying socket isn't
    // held open until GC.
    try { await response.body?.cancel() } catch {}
    throw new Error(`Usage request failed: ${response.status}`)
  }

  return response.json()
}

async function fetchFirecrawlUsage(apiKey) {
  if (!apiKey) return null
  const payload = await fetchJson('https://api.firecrawl.dev/v2/team/credit-usage', apiKey)
  const data = payload?.data
  if (!data) return null

  return {
    remaining: typeof data.remainingCredits === 'number' ? data.remainingCredits : null,
    limit:
      typeof data.planCredits === 'number' && data.planCredits > 0
        ? data.planCredits
        : null,
    resetAt: data.billingPeriodEnd || null,
  }
}

async function fetchTavilyUsage(apiKey) {
  if (!apiKey) return null
  const payload = await fetchJson('https://api.tavily.com/usage', apiKey)
  const key = payload?.key
  if (!key) return null

  const usage = typeof key.usage === 'number' ? key.usage : null
  const limit =
    typeof key.limit === 'number' && key.limit > 0
      ? key.limit
      : null

  return {
    remaining: usage !== null && limit !== null ? Math.max(limit - usage, 0) : null,
    limit,
    resetAt: null,
  }
}

export async function fetchProviderUsageSnapshot(provider, env = process.env) {
  switch (provider) {
    case 'firecrawl':
      return fetchFirecrawlUsage(env.FIRECRAWL_API_KEY)
    case 'tavily':
      return fetchTavilyUsage(env.TAVILY_API_KEY)
    default:
      // No telemetry endpoint just means "no usage patch to apply" — it does
      // NOT mean the provider is unavailable. Returning {available:false}
      // here would spread over the {available:true} baseline in
      // writeStartupSnapshot and mark a configured provider as down.
      return null
  }
}
