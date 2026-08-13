/**
 * xAI Imagine adapter (images + video) for the `grok-oauth` and `xai` lanes.
 *
 * Both lanes speak the same api.x.ai contract; only the bearer differs. Video
 * is a submit + poll job: POST /videos/generations returns a request id and the
 * poll route answers 202 while pending, 200 with a signed URL when done.
 */
import { resolveXaiAuth } from '../auth.mjs';
import { decodeBase64Media, downloadPublicMedia } from '../download.mjs';
import { mediaError } from '../lanes.mjs';
import { upstreamError } from '../upstream-error.mjs';

const POLL_INTERVAL_MS = 4_000;
const START_TIMEOUT_MS = 60_000;
const TOTAL_TIMEOUT_MS = 900_000;

async function readError(res) {
  const text = await res.text().catch(() => '');
  return text.slice(0, 400);
}

function sizeParams({ aspectRatio, resolution }) {
  const params = {};
  const aspect = String(aspectRatio || 'auto');
  if (aspect && aspect !== 'auto') params.aspect_ratio = aspect;
  const res = String(resolution || '').toLowerCase();
  if (res === '1k' || res === '2k') params.resolution = res;
  return params;
}

/** Reference images ride as data URLs — xAI accepts them in place of a host. */
function referenceUrl(reference) {
  const data = String(reference?.base64 || '');
  if (data.startsWith('data:')) return data;
  return `data:${reference?.mime || 'image/png'};base64,${data}`;
}

export async function generateImage({ lane, model, prompt, options = {}, references = [], signal }) {
  const { baseURL, token } = await resolveXaiAuth(lane);
  const refs = references.map(referenceUrl).map((url) => ({ type: 'image_url', url }));
  const body = {
    model,
    prompt,
    n: 1,
    response_format: 'b64_json',
    // One reference edits that image; several composite into a new one.
    ...(refs.length === 1 ? { image: refs[0] } : refs.length > 1 ? { images: refs } : {}),
    ...sizeParams(options),
  };
  const route = refs.length ? 'images/edits' : 'images/generations';
  const res = await fetch(`${baseURL}/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw upstreamError('xAI image', res.status, await readError(res));
  const data = await res.json();
  const entry = data?.data?.[0];
  if (!entry?.b64_json) throw mediaError('xAI returned no image data', 'MEDIA_EMPTY_RESULT', 502);
  return {
    bytes: decodeBase64Media(entry.b64_json, 'xAI image'),
    mime: entry.mime_type || 'image/png',
    revisedPrompt: entry.revised_prompt || null,
  };
}

export async function generateVideo({ lane, model, prompt, options = {}, references = [], signal, onProgress }) {
  const { baseURL, token } = await resolveXaiAuth(lane);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const duration = Math.min(15, Math.max(1, Math.trunc(Number(options.duration) || 5)));
  const resolution = ['480p', '720p', '1080p'].includes(options.resolution) ? options.resolution : '480p';
  const body = { model, prompt, duration, resolution };
  const aspect = String(options.aspectRatio || 'auto');
  if (aspect && aspect !== 'auto') body.aspect_ratio = aspect;
  // Mode is inferred from the reference count: 1 = image-to-video,
  // 2+ = reference-to-video (capped at the documented 7).
  const refs = references.slice(0, 7).map(referenceUrl);
  if (refs.length === 1) body.image = { url: refs[0] };
  else if (refs.length > 1) body.reference_images = refs.map((url) => ({ url }));

  const started = await fetch(`${baseURL}/videos/generations`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(START_TIMEOUT_MS)].filter(Boolean)),
  });
  if (!started.ok) throw upstreamError('xAI video', started.status, await readError(started));
  const startData = await started.json();
  const requestId = startData?.request_id || startData?.id;
  if (!requestId) throw mediaError('xAI video start returned no request id', 'MEDIA_UPSTREAM_FAILED', 502);

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) throw mediaError('canceled', 'MEDIA_CANCELED', 499);
    if (Date.now() > deadline) throw mediaError('xAI video poll budget exceeded', 'MEDIA_TIMEOUT', 504);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const poll = await fetch(`${baseURL}/videos/${requestId}`, { headers, signal });
    if (!poll.ok && poll.status !== 202) throw upstreamError('xAI video poll', poll.status, await readError(poll));
    const data = await poll.json().catch(() => ({}));
    if (typeof data?.progress === 'number' && typeof onProgress === 'function') onProgress(data.progress);
    if (data?.status === 'done') {
      const url = data?.video?.url;
      if (!url) throw mediaError('xAI video finished without a URL', 'MEDIA_EMPTY_RESULT', 502);
      return {
        bytes: await downloadPublicMedia(url, { signal, label: 'xAI video' }),
        mime: 'video/mp4',
        durationSeconds: Number(data?.video?.duration) || duration,
      };
    }
    if (data?.status === 'failed' || data?.status === 'expired') {
      throw mediaError(`xAI video ${data.status}${data?.error?.code ? `: ${data.error.code}` : ''}`, 'MEDIA_UPSTREAM_FAILED', 502);
    }
  }
}
