/**
 * Normalized Image API adapter for the `openrouter` and `nano-gpt` lanes.
 *
 * Both gateways document the same contract: POST {base}/images with `model`,
 * `prompt`, the model's advertised enum parameters and `input_references`
 * (image_url parts; data URLs accepted), answering `data[].b64_json` (NanoGPT
 * may answer a signed `url` instead) plus `usage`.
 *   https://openrouter.ai/docs/guides/overview/multimodal/image-generation
 *   https://docs.nano-gpt.com/api-reference/image-generation
 */
import { resolveImageApiAuth } from '../auth.mjs';
import { timeoutSignal } from '../bounded-signal.mjs';
import { decodeBase64Media, downloadPublicMedia } from '../download.mjs';
import { mediaError } from '../lanes.mjs';
import { imageApiUsage, withReportedUsage } from '../media-usage.mjs';
import { upstreamError } from '../upstream-error.mjs';

const IMAGE_TIMEOUT_MS = 180_000;
const LABELS = Object.freeze({ openrouter: 'OpenRouter image', 'nano-gpt': 'NanoGPT image' });
// Request field per Studio option; values come from the model's own enums.
const PARAMS = Object.freeze({
  aspectRatio: 'aspect_ratio',
  resolution: 'resolution',
  quality: 'quality',
  background: 'background',
});

function referenceUrl(reference) {
  const data = String(reference?.base64 || '');
  return data.startsWith('data:') ? data : `data:${reference?.mime || 'image/png'};base64,${data}`;
}

/** The stored format comes from the bytes, not a label: only rasters the store keeps. */
function rasterMime(bytes) {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return '';
}

export async function generateImage({ lane, model, prompt, options = {}, references = [], signal }) {
  const label = LABELS[lane] || 'Image API';
  const { baseURL, token } = resolveImageApiAuth(lane);
  const body = { model, prompt, n: 1 };
  for (const [option, param] of Object.entries(PARAMS)) {
    const value = String(options?.[option] || '').trim();
    if (value) body[param] = value;
  }
  if (references.length) {
    body.input_references = references.map((reference) => ({
      type: 'image_url',
      image_url: { url: referenceUrl(reference) },
    }));
  }
  let res;
  try {
    res = await fetch(`${baseURL}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: timeoutSignal(signal, IMAGE_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') throw mediaError(`${label} timed out`, 'MEDIA_TIMEOUT', 504);
    throw error;
  }
  if (!res.ok) throw upstreamError(label, res.status, (await res.text().catch(() => '')).slice(0, 400));
  const data = await res.json().catch(() => null);
  const usage = imageApiUsage(data);
  const entry = Array.isArray(data?.data) ? data.data[0] : null;
  let bytes;
  try {
    if (entry?.b64_json) bytes = decodeBase64Media(entry.b64_json, label);
    else if (entry?.url) bytes = await downloadPublicMedia(entry.url, { signal, label });
    else throw mediaError(`${label} returned no image data`, 'MEDIA_EMPTY_RESULT', 502);
  } catch (error) {
    throw withReportedUsage(error, usage);
  }
  const mime = rasterMime(bytes);
  if (!mime) {
    throw withReportedUsage(
      mediaError(`${label} returned an unsupported image format`, 'MEDIA_UPSTREAM_FAILED', 502),
      usage
    );
  }
  return { bytes, mime, revisedPrompt: entry.revised_prompt || null, usage };
}
