/**
 * The browser identity every page of the partition presents: the agent
 * string and language list the partition sends, and the client-hint
 * metadata that makes `navigator.userAgentData` and the hint headers name
 * the same Chrome. The engine's platform facts are read once, from a page,
 * before any override applies; they belong to the process, not to a page.
 */
import { type BrowserUserAgentBase, browserUserAgentMetadata } from './user-agent';

let partitionUserAgent = '';
let partitionLanguages: string | undefined;
let engineBase: BrowserUserAgentBase | undefined;

export function rememberBrowserIdentity(identity: { userAgent: string; acceptLanguages?: string }): void {
  partitionUserAgent = identity.userAgent;
  partitionLanguages = identity.acceptLanguages;
}

/** Whether the engine's platform facts are still to be read. */
export function browserIdentityNeedsEngineFacts(): boolean {
  return !engineBase;
}

/** The facts as a page of this engine reports them, unchanged. */
export function rememberEngineFacts(value: unknown): void {
  const facts = value as Partial<BrowserUserAgentBase> | null;
  // A page already under an override without metadata reports empty facts.
  if (!facts || typeof facts.platformVersion !== 'string' || typeof facts.platform !== 'string' || !facts.platform) {
    return;
  }
  engineBase = {
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
      .getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'wow64', 'formFactors'])
      .then(({ brands, fullVersionList, uaFullVersion, ...facts }) => facts)
  : null`;

/** `Network.setUserAgentOverride` parameters for an agent string. The
 *  partition's own string carries Chrome's client-hint metadata and the
 *  partition's languages; any other (one an emulation chose) goes as given,
 *  with the languages it names. An override without metadata empties the
 *  page's brand list, so until the engine's facts are known the partition's
 *  own string clears the override instead (the engine's identity stands). */
export function browserUserAgentOverride(userAgent: string, acceptLanguage?: string): Record<string, unknown> {
  const own = Boolean(partitionUserAgent) && userAgent === partitionUserAgent;
  if (own && !engineBase && !acceptLanguage) return { userAgent: '' };
  const languages = acceptLanguage || (own ? partitionLanguages : undefined);
  return {
    userAgent,
    ...(languages ? { acceptLanguage: languages } : {}),
    ...(own && engineBase ? { userAgentMetadata: browserUserAgentMetadata(engineBase, process.versions.chrome) } : {}),
  };
}
