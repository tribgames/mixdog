/** The default agent string carries the app and the framework that embeds
 *  Chromium. Sites read that as an unsupported or automated browser and answer
 *  with a login wall or a "browser not supported" page, so pages see the Chrome
 *  build that is actually rendering them, in the reduced form Chrome itself
 *  sends (major version only). Emulation still overrides it. The string is the
 *  same in every context of the partition (pages, workers, other processes)
 *  and the brands stay the engine's own: a site compares them, and Cloudflare
 *  Turnstile fails verification (error 600010) when they disagree. */
export function browserPartitionUserAgent(defaultAgent: string): string {
  return defaultAgent
    .replace(/\s*\b(?:mixdog[\w-]*|Electron)\/\S+/gi, '')
    .replace(/\bChrome\/(\d+)[\d.]*/, 'Chrome/$1.0.0.0')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
