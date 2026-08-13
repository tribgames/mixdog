/**
 * Gemini image adapter (API key lane).
 *
 * Calls the Generative Language `generateContent` route and pulls the first
 * inline image part out of the candidate. Aspect ratio rides in `imageConfig`,
 * which older image models reject — a 400 there retries once without it so a
 * control the model does not know never fails the whole generation.
 */
import { resolveGeminiKey } from '../auth.mjs';
import { decodeBase64Media } from '../download.mjs';
import { mediaError } from '../lanes.mjs';
import { upstreamError } from '../upstream-error.mjs';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 180_000;

function requestBody(prompt, options, withImageConfig, references = []) {
  const body = {
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
  if (withImageConfig && aspect !== 'auto') {
    body.generationConfig = { imageConfig: { aspectRatio: aspect } };
  }
  return body;
}

async function post(model, key, body, signal) {
  return await fetch(`${BASE_URL}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)].filter(Boolean)),
  });
}

export async function generateImage({ model, prompt, options = {}, references = [], signal }) {
  const key = resolveGeminiKey();
  const wantsImageConfig = String(options.aspectRatio || 'auto') !== 'auto';
  let res = await post(model, key, requestBody(prompt, options, wantsImageConfig, references), signal);
  if (!res.ok && res.status === 400 && wantsImageConfig) {
    res = await post(model, key, requestBody(prompt, options, false, references), signal);
  }
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
