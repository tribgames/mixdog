/** Sites treat the app and Electron tokens as an unsupported or automated browser. The brands stay the engine's own: Cloudflare Turnstile fails verification (error 600010) when they disagree with the user agent. */
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
