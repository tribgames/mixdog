import { mediaError } from './lanes.mjs';
import { readResponseBuffer } from '../shared/bounded-download.mjs';
import { assertPublicUrl, pinnedFetch } from '../search/lib/ssrf-guard.mjs';

export const MAX_GENERATED_MEDIA_BYTES = 256 * 1024 * 1024;
export const MAX_GENERATED_MEDIA_BASE64_CHARS =
  Math.ceil(MAX_GENERATED_MEDIA_BYTES / 3) * 4 + 4;

export function decodeBase64Media(value, label = 'generated media') {
  if (typeof value !== 'string' || !value
    || value.length > MAX_GENERATED_MEDIA_BASE64_CHARS) {
    throw mediaError(`${label} exceeds the media size limit`, 'MEDIA_RESULT_TOO_LARGE', 502);
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_GENERATED_MEDIA_BYTES) {
    throw mediaError(`${label} exceeds the media size limit`, 'MEDIA_RESULT_TOO_LARGE', 502);
  }
  return bytes;
}

function redirectTarget(response, currentUrl) {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get('location');
  return location ? new URL(location, currentUrl).toString() : null;
}

export async function downloadPublicMedia(
  input,
  {
    signal,
    label = 'generated media',
    maxBytes = MAX_GENERATED_MEDIA_BYTES,
    fetchImpl = pinnedFetch,
  } = {},
) {
  let url = String(input || '');
  for (let hops = 0; hops <= 5; hops++) {
    assertPublicUrl(url);
    const response = await fetchImpl(url, { signal, redirect: 'manual' });
    const redirect = redirectTarget(response, url);
    if (redirect) {
      url = redirect;
      continue;
    }
    if (!response.ok) {
      throw mediaError(
        `${label} download failed (${response.status})`,
        'MEDIA_UPSTREAM_FAILED',
        response.status,
      );
    }
    return readResponseBuffer(response, { maxBytes, label });
  }
  throw mediaError(`${label} download redirected too many times`, 'MEDIA_UPSTREAM_FAILED', 502);
}

export function geminiMediaDownloadUrl(input) {
  let url;
  try {
    url = new URL(String(input || ''));
  } catch {
    throw mediaError('Veo returned an invalid video URI', 'MEDIA_UPSTREAM_FAILED', 502);
  }
  if (url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== 'generativelanguage.googleapis.com'
    || url.username
    || url.password) {
    throw mediaError('Veo returned an untrusted video URI', 'MEDIA_UPSTREAM_FAILED', 502);
  }
  url.searchParams.set('alt', 'media');
  return url.toString();
}

export async function downloadGeminiMedia(
  input,
  {
    key,
    signal,
    label = 'Veo video',
    maxBytes = MAX_GENERATED_MEDIA_BYTES,
    fetchImpl = pinnedFetch,
  } = {},
) {
  const url = geminiMediaDownloadUrl(input);
  assertPublicUrl(url);
  const response = await fetchImpl(url, {
    headers: { 'x-goog-api-key': key },
    signal,
    redirect: 'manual',
  });
  if (redirectTarget(response, url)) {
    throw mediaError(`${label} download redirect was rejected`, 'MEDIA_UPSTREAM_FAILED', 502);
  }
  if (!response.ok) {
    throw mediaError(
      `${label} download failed (${response.status})`,
      'MEDIA_UPSTREAM_FAILED',
      response.status,
    );
  }
  return readResponseBuffer(response, { maxBytes, label });
}
