/**
 * Gemini image adapter (API key lane).
 *
 * Calls the Generative Language `generateContent` route and pulls the first
 * inline image part out of the candidate. Explicit output modalities prevent
 * image-capable models from ending with text only. Never silently discard a
 * requested output setting or retry a paid request.
 */
import { resolveGeminiKey } from '../auth.mjs';
import { decodeBase64Media } from '../download.mjs';
import { mediaError } from '../lanes.mjs';
import { upstreamError } from '../upstream-error.mjs';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 180_000;

export function geminiImageRequestBody(prompt, options = {}, references = []) {
  const body = {
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    contents: [{
      role: 'user',
      parts: [
        ...references.map((ref) => ({
          inlineData: { mimeType: ref.mime || 'image/png', data: ref.base64 },
        })),
        { text: prompt },
      ],
    }],
  };
  const aspect = String(options?.aspectRatio || 'auto');
  if (aspect !== 'auto') {
    body.generationConfig.imageConfig = { aspectRatio: aspect };
  }
  return body;
}

async function post(model, key, body, signal, fetchFn) {
  return await fetchFn(`${BASE_URL}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)].filter(Boolean)),
  });
}

export async function generateImage({ model, prompt, options = {}, references = [], signal }, {
  fetchFn = fetch, resolveKey = resolveGeminiKey,
} = {}) {
  const key = resolveKey();
  const res = await post(model, key, geminiImageRequestBody(prompt, options, references), signal, fetchFn);
  if (!res.ok) throw upstreamError('Gemini image', res.status, await res.text().catch(() => ''));
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const image = parts.find((part) => part?.inlineData?.data);
  if (!image) {
    const refusal = parts.find((part) => typeof part?.text === 'string')?.text || '';
    throw mediaError(
      `Gemini returned no image data${refusal ? `: ${refusal.slice(0, 200)}` : ''}`,
      'MEDIA_EMPTY_RESULT',
      502,
    );
  }
  return {
    bytes: decodeBase64Media(image.inlineData.data, 'Gemini image'),
    mime: image.inlineData.mimeType || 'image/png',
    revisedPrompt: null,
  };
}
