/** The default agent string carries the app and the framework that embeds
 *  Chromium, while the client hints the browser partition sends name Chromium
 *  alone. Sites read that mismatch as an unsupported or automated browser and
 *  answer with a login wall or a "browser not supported" page, so pages see the
 *  Chrome build that is actually rendering them. Emulation still overrides it. */
export function browserPartitionUserAgent(defaultAgent: string): string {
  return defaultAgent
    .replace(/\s*\b(?:mixdog-desktop|Electron)\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
