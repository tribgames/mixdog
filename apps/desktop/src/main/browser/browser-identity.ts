/**
 * The browser identity of the partition: the agent string and language list
 * the session itself sends (the app's `userAgentFallback` gives every other
 * context of the process the same string), so a page needs no per-page
 * override of them. Only an emulation override of the partition's own string
 * (a locale) restates the engine's own client hints, which are read once,
 * from a page, while none of its overrides applies; they belong to the
 * process, not to a page.
 */
import { type BrowserBrandVersion, type BrowserUserAgentBase, browserUserAgentMetadata } from './user-agent';

let partitionUserAgent = '';
let engineBase: BrowserUserAgentBase | undefined;

export function rememberBrowserIdentity(identity: { userAgent: string }): void {
  partitionUserAgent = identity.userAgent;
}

/** Whether the engine's client hints are still to be read. */
export function browserIdentityNeedsEngineFacts(): boolean {
  return !engineBase;
}

function brandList(value: unknown): BrowserBrandVersion[] {
  return Array.isArray(value)
    ? value.map((entry) => ({ brand: String(entry?.brand ?? ''), version: String(entry?.version ?? '') }))
    : [];
}

/** The facts as a page of this engine reports them, unchanged. */
export function rememberEngineFacts(value: unknown): void {
  const facts = value as (Partial<BrowserUserAgentBase> & { brands?: unknown; fullVersionList?: unknown }) | null;
  // A page already under an override without metadata reports empty facts.
  if (!facts || typeof facts.platformVersion !== 'string' || typeof facts.platform !== 'string' || !facts.platform) {
    return;
  }
  const brands = brandList(facts.brands);
  if (brands.length === 0) return;
  engineBase = {
    brands,
    fullVersionList: brandList(facts.fullVersionList),
    platform: facts.platform,
    platformVersion: facts.platformVersion,
    architecture: String(facts.architecture ?? ''),
    model: String(facts.model ?? ''),
    mobile: facts.mobile === true,
    ...(typeof facts.bitness === 'string' ? { bitness: facts.bitness } : {}),
    ...(typeof facts.wow64 === 'boolean' ? { wow64: facts.wow64 } : {}),
    ...(Array.isArray(facts.formFactors) ? { formFactors: facts.formFactors.map(String) } : {}),
  };
}

/** The expression that reads those facts in a page (null where the page
 *  cannot: an insecure one has no `navigator.userAgentData`). */
export const ENGINE_FACTS_EXPRESSION = `navigator.userAgentData
  ? navigator.userAgentData
      .getHighEntropyValues([
        'architecture',
        'bitness',
        'model',
        'platformVersion',
        'wow64',
        'formFactors',
        'fullVersionList',
      ])
      .then(({ uaFullVersion, ...facts }) => facts)
  : null`;

/** `Network.setUserAgentOverride` parameters for an agent string. The
 *  partition's own string is what the session already sends, so without a
 *  language it clears the override (brands stay the engine's own); with one
 *  it restates the engine's client hints, since an override without metadata
 *  empties the page's brand list. Any other string (one an emulation chose)
 *  goes as given, with the languages it names. */
export function browserUserAgentOverride(userAgent: string, acceptLanguage?: string): Record<string, unknown> {
  const own = Boolean(partitionUserAgent) && userAgent === partitionUserAgent;
  if (own && !acceptLanguage) return { userAgent: '' };
  return {
    userAgent,
    ...(acceptLanguage ? { acceptLanguage } : {}),
    ...(own && engineBase ? { userAgentMetadata: browserUserAgentMetadata(engineBase, process.versions.chrome) } : {}),
  };
}
