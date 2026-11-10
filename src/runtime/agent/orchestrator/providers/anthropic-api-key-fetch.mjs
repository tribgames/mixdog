// Custom `fetch` for the Anthropic SDK client (API-key path): gzips
// /v1/messages bodies on the libuv threadpool, but ONLY when the effective
// request origin is exactly https://api.anthropic.com. The decision is made on
// the final request URL, so a custom baseURL, ANTHROPIC_BASE_URL, proxy or
// gateway never gets a compressed body. Policy shared with the OAuth path.
import { sendGzipCompressed } from './lib/request-compression.mjs';

const OFFICIAL_ORIGIN = 'https://api.anthropic.com';

function officialMessagesUrl(input) {
  try {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    return url.origin === OFFICIAL_ORIGIN && url.pathname === '/v1/messages';
  } catch {
    return false;
  }
}

function bodyBytes(body) {
  if (typeof body === 'string') return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return null;
}

export function createAnthropicApiKeyFetch({ baseFetch = (...args) => globalThis.fetch(...args), compress } = {}) {
  return async (input, init) => {
    const raw = init?.method?.toUpperCase() === 'POST' && officialMessagesUrl(input) ? bodyBytes(init.body) : null;
    if (!raw) return baseFetch(input, init);
    return sendGzipCompressed({
      raw,
      headers: init.headers,
      compress,
      send: (body, headers) => baseFetch(input, { ...init, headers, body: body === raw ? init.body : body }),
    });
  };
}
