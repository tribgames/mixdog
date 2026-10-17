/** The default agent string carries the app and the framework that embeds
 *  Chromium. Sites read that as an unsupported or automated browser and answer
 *  with a login wall or a "browser not supported" page, so pages see the Chrome
 *  build that is actually rendering them, in the reduced form Chrome itself
 *  sends (major version only). Emulation still overrides it. */
export function browserPartitionUserAgent(defaultAgent: string): string {
  return defaultAgent
    .replace(/\s*\b(?:mixdog[\w-]*|Electron)\/\S+/gi, '')
    .replace(/\bChrome\/(\d+)[\d.]*/, 'Chrome/$1.0.0.0')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface BrowserBrandVersion {
  brand: string;
  version: string;
}

/** The brand list Chrome itself reports for an engine version: its own brand,
 *  Chromium, and the "GREASE" brand, ordered and spelled by the same seed
 *  (the major version) Chrome uses, so the list matches what a Chrome of this
 *  version sends. `full` gives the full-version-list form. The version is the
 *  engine's own: claiming a newer one would contradict every feature probe. */
export function browserBrandList(fullVersion: string, full = false): BrowserBrandVersion[] {
  const major = Number.parseInt(fullVersion, 10) || 0;
  const separators = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const greaseVersion = ['8', '99', '24'][major % 3];
  const grease = {
    brand: `Not${separators[major % 11]}A${separators[(major + 1) % 11]}Brand`,
    version: full ? `${greaseVersion}.0.0.0` : greaseVersion,
  };
  const version = full ? fullVersion : String(major);
  const chromium = { brand: 'Chromium', version };
  const chrome = { brand: 'Google Chrome', version };
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  const order = orders[major % 6];
  const list: BrowserBrandVersion[] = [];
  list[order[0]] = grease;
  list[order[1]] = chromium;
  list[order[2]] = chrome;
  return list;
}

/** A brand list in the structured-header form of `Sec-CH-UA`. */
export function browserBrandHeader(brands: BrowserBrandVersion[]): string {
  return brands.map(({ brand, version }) => `${JSON.stringify(brand)};v=${JSON.stringify(version)}`).join(', ');
}

/** The request headers that name brands, rewritten to the brand list above.
 *  Requests no page session overrides (a service worker's, for one) still
 *  carry the engine's own Chromium-only list; this keeps them consistent with
 *  what the page's `navigator.userAgentData` says. Headers a page did not ask
 *  for are never added. */
export function browserBrandRequestHeaders(
  headers: Record<string, string>,
  fullVersion: string
): Record<string, string> {
  const rewritten = { ...headers };
  for (const name of Object.keys(rewritten)) {
    const lower = name.toLowerCase();
    if (lower === 'sec-ch-ua') rewritten[name] = browserBrandHeader(browserBrandList(fullVersion));
    else if (lower === 'sec-ch-ua-full-version-list') {
      rewritten[name] = browserBrandHeader(browserBrandList(fullVersion, true));
    }
  }
  return rewritten;
}

/** The engine's own client-hint values, read once from a page of this
 *  partition before any override applies. */
export interface BrowserUserAgentBase {
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness?: string;
  wow64?: boolean;
  formFactors?: string[];
}

/** `Network.setUserAgentOverride` metadata: the engine's own platform facts
 *  with Chrome's brand lists, so `navigator.userAgentData` and the hint
 *  headers agree with each other and with the agent string. */
export function browserUserAgentMetadata(base: BrowserUserAgentBase, fullVersion: string): Record<string, unknown> {
  return {
    brands: browserBrandList(fullVersion),
    fullVersionList: browserBrandList(fullVersion, true),
    fullVersion,
    platform: base.platform,
    platformVersion: base.platformVersion,
    architecture: base.architecture,
    model: base.model,
    mobile: base.mobile,
    ...(base.bitness !== undefined ? { bitness: base.bitness } : {}),
    ...(base.wow64 !== undefined ? { wow64: base.wow64 } : {}),
    ...(base.formFactors ? { formFactors: base.formFactors } : {}),
  };
}

/** Chrome's default Accept-Language for a system language list: each regional
 *  tag followed by its base language, as Chrome seeds a new profile
 *  ("ko-KR,ko,en-US,en"). */
export function browserAcceptLanguages(preferred: string[]): string {
  const languages: string[] = [];
  for (const tag of preferred) {
    const trimmed = String(tag || '').trim();
    if (!trimmed) continue;
    if (!languages.includes(trimmed)) languages.push(trimmed);
    const base = trimmed.split('-')[0];
    if (base && !languages.includes(base)) languages.push(base);
  }
  return languages.join(',');
}
