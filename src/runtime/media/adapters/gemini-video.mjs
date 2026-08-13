/**
 * Gemini video adapter (API key lane).
 *
 * Two different upstream shapes live behind one lane:
 *   - Omni Flash answers on the Interactions API in a single call, with the
 *     mp4 inline as base64 on a `model_output` step.
 *   - Veo 3.1 is a long-running predict: submit, poll the operation, then pull
 *     the sample URI with `alt=media`.
 */
import { resolveGeminiKey } from '../auth.mjs';
import { decodeBase64Media, downloadGeminiMedia } from '../download.mjs';
import { mediaError } from '../lanes.mjs';
import { upstreamError } from '../upstream-error.mjs';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const OMNI_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 8_000;
const TOTAL_TIMEOUT_MS = 900_000;

function isOmniModel(model) {
  return /omni/i.test(String(model || ''));
}

function aspectFor(options) {
  const aspect = String(options?.aspectRatio || 'auto');
  return aspect === 'auto' ? '16:9' : aspect;
}

async function generateViaOmni({ model, prompt, options, references = [], signal, key }) {
  // Omni takes a multimodal input array; a reference image switches the task
  // from text-to-video to image-to-video.
  const input = references.length
    ? [
      ...references.map((ref) => ({ type: 'image', data: ref.base64, mime_type: ref.mime || 'image/png' })),
      { type: 'text', text: prompt },
    ]
    : prompt;
  const res = await fetch(`${BASE_URL}/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      model,
      input,
      response_format: { type: 'video', aspect_ratio: aspectFor(options) },
      generation_config: {
        video_config: { task: references.length ? 'image_to_video' : 'text_to_video' },
      },
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(OMNI_TIMEOUT_MS)].filter(Boolean)),
  });
  if (!res.ok) throw upstreamError('Gemini Omni video', res.status, await res.text().catch(() => ''));
  const data = await res.json();
  for (const step of data?.steps || []) {
    const content = Array.isArray(step?.content) ? step.content : [step?.content].filter(Boolean);
    const video = content.find((item) => item?.type === 'video' && typeof item?.data === 'string');
    if (video) {
      return { bytes: decodeBase64Media(video.data, 'Gemini Omni video'), mime: video.mime_type || 'video/mp4' };
    }
  }
  throw mediaError('Gemini Omni returned no video data', 'MEDIA_EMPTY_RESULT', 502);
}

async function generateViaVeo({ model, prompt, options, references = [], signal, onProgress, key }) {
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': key };
  const parameters = { aspectRatio: aspectFor(options) };
  const instance = { prompt };
  // Veo accepts a single seed image for image-to-video.
  if (references[0]) {
    instance.image = { bytesBase64Encoded: references[0].base64, mimeType: references[0].mime || 'image/png' };
  }
  const resolution = String(options?.resolution || '');
  if (resolution === '720p' || resolution === '1080p') parameters.resolution = resolution;
  // Veo takes discrete clip lengths; anything else is rejected upstream, so an
  // out-of-contract value is dropped rather than forwarded.
  const duration = Math.trunc(Number(options?.duration) || 0);
  if ([4, 6, 8].includes(duration)) parameters.durationSeconds = duration;

  const started = await fetch(`${BASE_URL}/models/${encodeURIComponent(model)}:predictLongRunning`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ instances: [instance], parameters }),
    signal,
  });
  if (!started.ok) throw upstreamError('Veo video', started.status, await started.text().catch(() => ''));
  const operation = await started.json();
  if (!operation?.name) throw mediaError('Veo returned no operation name', 'MEDIA_UPSTREAM_FAILED', 502);

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) throw mediaError('canceled', 'MEDIA_CANCELED', 499);
    if (Date.now() > deadline) throw mediaError('Veo poll budget exceeded', 'MEDIA_TIMEOUT', 504);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const poll = await fetch(`${BASE_URL}/${operation.name}`, { headers, signal });
    if (!poll.ok) throw upstreamError('Veo poll', poll.status, await poll.text().catch(() => ''));
    const data = await poll.json();
    if (!data?.done) {
      // The operation exposes no percentage; keep the UI moving with a coarse
      // heartbeat instead of a fake number.
      if (typeof onProgress === 'function') onProgress(50);
      continue;
    }
    if (data.error) {
      throw mediaError(`Veo generation failed: ${data.error.message || 'unknown error'}`, 'MEDIA_UPSTREAM_FAILED', 502);
    }
    const sample = data?.response?.generateVideoResponse?.generatedSamples?.[0]
      || data?.response?.generatedVideos?.[0];
    const uri = sample?.video?.uri || sample?.video?.fileUri;
    if (!uri) throw mediaError('Veo finished without a video URI', 'MEDIA_EMPTY_RESULT', 502);
    return {
      bytes: await downloadGeminiMedia(uri, { key, signal }),
      mime: 'video/mp4',
    };
  }
}

export async function generateVideo({ model, prompt, options = {}, references = [], signal, onProgress }) {
  const key = resolveGeminiKey();
  return isOmniModel(model)
    ? await generateViaOmni({ model, prompt, options, references, signal, key })
    : await generateViaVeo({ model, prompt, options, references, signal, onProgress, key });
}
