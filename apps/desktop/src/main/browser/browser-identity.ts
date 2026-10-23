/**
 * The browser identity of the partition: the agent string and language list
 * the session itself sends (the app's `userAgentFallback` gives every other
 * context of the process the same string), so a page needs no per-page
 * override of them. An emulation override of the partition's own string (a
 * locale) sends an empty string, so the engine's own client hints (brands,
 * platform) stay as they are.
 */
let partitionUserAgent = '';

export function rememberBrowserIdentity(identity: { userAgent: string }): void {
  partitionUserAgent = identity.userAgent;
}

/** `Network.setUserAgentOverride` parameters for an agent string. The
 *  partition's own string is what the session already sends, so it is never
 *  restated: an empty `userAgent` leaves the session's string and the
 *  engine's own client hints (brands, platform) untouched, and with a
 *  language the override changes only that (confirmed in a real Electron
 *  run). Restating the string without metadata would empty the page's brand
 *  list. Any other string (one an emulation chose) goes as given, with the
 *  languages it names. */
export function browserUserAgentOverride(userAgent: string, acceptLanguage?: string): Record<string, unknown> {
  const own = Boolean(partitionUserAgent) && userAgent === partitionUserAgent;
  if (own) return { userAgent: '', ...(acceptLanguage ? { acceptLanguage } : {}) };
  return { userAgent, ...(acceptLanguage ? { acceptLanguage } : {}) };
}
