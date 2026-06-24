const SEARCH_TYPES = Object.freeze(['web', 'news', 'images'])
const SEARCH_CONTEXT_SIZES = Object.freeze(['low', 'medium', 'high'])

function normalizeLocale(value) {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) {
    const locale = {
      country: value.country ? String(value.country).trim().toUpperCase() : undefined,
      language: value.language ? String(value.language).trim().toLowerCase() : undefined,
      region: value.region ? String(value.region).trim() : undefined,
      city: value.city ? String(value.city).trim() : undefined,
      timezone: value.timezone ? String(value.timezone).trim() : undefined,
      explicit: true,
    }
    return Object.fromEntries(Object.entries(locale).filter(([, v]) => v !== undefined && v !== ''))
  }
  const raw = String(value || '').trim().replace(/_/g, '-')
  if (!raw) return null
  const parts = raw.split('-').filter(Boolean)
  if (parts.length >= 2) {
    return { language: parts[0].toLowerCase(), country: parts[1].toUpperCase(), explicit: true }
  }
  const single = parts[0] || raw
  if (/^[A-Z]{2}$/.test(single)) return { country: single, explicit: true }
  if (/^[a-z]{2}$/.test(single)) return { language: single, explicit: true }
  return { country: single.toUpperCase(), explicit: true }
}

function clampMaxResults(value, fallback = 5, max = 20) {
  const n = Number(value)
  const base = Number.isFinite(n) ? Math.floor(n) : Number(fallback)
  const safe = Number.isFinite(base) && base > 0 ? base : 5
  return Math.max(1, Math.min(max, safe))
}

function normalizeContextSize(value, fallback = 'low') {
  const raw = String(value || '').trim().toLowerCase()
  if (SEARCH_CONTEXT_SIZES.includes(raw)) return raw
  const fb = String(fallback || '').trim().toLowerCase()
  return SEARCH_CONTEXT_SIZES.includes(fb) ? fb : 'low'
}

function normalizeSite(site) {
  const raw = String(site || '').trim()
  if (!raw) return ''
  const withoutPrefix = raw.replace(/^site:/i, '').trim()
  try {
    const parsed = new URL(withoutPrefix.includes('://') ? withoutPrefix : `https://${withoutPrefix}`)
    return parsed.hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return withoutPrefix
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/.*$/, '')
      .trim()
      .toLowerCase()
  }
}

export function normalizeSearchIntent(raw = {}, { caps = {}, defaultMaxResults = 5 } = {}) {
  const rawQuery = String(raw.query ?? raw.keywords ?? '').trim()
  if (!rawQuery) throw new Error('query is required')

  const supportedTypes = Array.isArray(caps.searchTypes) && caps.searchTypes.length
    ? caps.searchTypes
    : ['web']
  const requestedType = SEARCH_TYPES.includes(String(raw.type || '').trim())
    ? String(raw.type).trim()
    : 'web'
  const type = supportedTypes.includes(requestedType) ? requestedType : 'web'
  const site = normalizeSite(raw.site)
  const queryWithSite = site && !/\bsite:/i.test(rawQuery)
    ? `${rawQuery} site:${site}`
    : rawQuery
  const warnings = []
  if (requestedType !== type) {
    warnings.push(`search type "${requestedType}" is not supported by this provider; used "${type}"`)
  }
  const locale = normalizeLocale(raw.locale)
  if (locale && caps.localeMode === 'none') {
    warnings.push('locale is not supported by this provider; ignored')
  }

  return {
    query: rawQuery,
    queryWithSite,
    rawQuery,
    site,
    type,
    requestedType,
    maxResults: clampMaxResults(raw.maxResults, defaultMaxResults),
    contextSize: normalizeContextSize(raw.contextSize ?? raw.searchContextSize, raw.defaultContextSize || 'low'),
    locale,
    warnings,
  }
}

export function tavilyCountryName(country) {
  const code = String(country || 'US').toUpperCase()
  const names = {
    CN: 'china',
    JP: 'japan',
    KR: 'south korea',
    RU: 'russia',
    SA: 'saudi arabia',
    US: 'united states',
  }
  return names[code] || 'united states'
}
