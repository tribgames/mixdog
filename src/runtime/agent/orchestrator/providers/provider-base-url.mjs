// Keep saved custom endpoints and OpenAI-compatible clients under the same
// transport policy: credentials may travel over HTTP only on loopback.
export function assertSafeBaseURL(rawURL, providerName) {
  let parsed;
  try {
    parsed = new URL(String(rawURL));
  } catch {
    throw new Error(`[provider:${providerName}] invalid baseURL`);
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'https:' && scheme !== 'http:') {
    throw new Error(`[provider:${providerName}] baseURL scheme not allowed: ${parsed.protocol} (only http/https)`);
  }
  if (scheme === 'http:') {
    const host = parsed.hostname.toLowerCase();
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (!isLocal) {
      throw new Error(
        `[provider:${providerName}] baseURL must use https for non-localhost host (got ${parsed.protocol}//${parsed.hostname})`
      );
    }
  }
  return rawURL;
}
