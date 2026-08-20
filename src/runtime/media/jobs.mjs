/**
 * Media generation jobs.
 *
 * Image lanes answer in one request, video lanes submit + poll for minutes, so
 * both run as background jobs with a polled snapshot instead of a blocking
 * call. The desktop reads snapshots over the normal capability bridge; nothing
 * here streams, which keeps a long video job independent of window lifetime.
 */
import { randomUUID } from 'crypto';
import { MAX_GENERATED_MEDIA_BYTES } from './download.mjs';
import { mediaError, resolveMediaRequest } from './lanes.mjs';
import { saveMediaAsset } from './store.mjs';

const JOBS = new Map();
// Finished jobs stay readable for a while so a slow poller still sees the
// terminal state, then drop out to bound memory.
const TERMINAL_TTL_MS = 10 * 60_000;
const MAX_PROMPT_CHARS = 8_000;

function snapshot(job) {
  return {
    id: job.id,
    status: job.status,
    kind: job.kind,
    lane: job.lane,
    model: job.model,
    prompt: job.prompt,
    options: job.options,
    progress: job.progress,
    assetId: job.assetId,
    error: job.error,
    errorCode: job.errorCode,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
  };
}

function sweep() {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (job.endedAt && now - job.endedAt > TERMINAL_TTL_MS) JOBS.delete(id);
  }
}

async function runAdapter({ lane, kind, model, prompt, options, references, signal, onProgress }) {
  if (lane.id === 'grok-oauth' || lane.id === 'xai') {
    const adapter = await import('./adapters/xai-media.mjs');
    return kind === 'video'
      ? await adapter.generateVideo({ lane: lane.id, model, prompt, options, references, signal, onProgress })
      : await adapter.generateImage({ lane: lane.id, model, prompt, options, references, signal });
  }
  if (lane.id === 'openai-oauth') {
    const adapter = await import('./adapters/codex-image.mjs');
    return await adapter.generateImage({ model, prompt, options, references, signal });
  }
  if (lane.id === 'gemini') {
    if (kind === 'video') {
      const adapter = await import('./adapters/gemini-video.mjs');
      return await adapter.generateVideo({ model, prompt, options, references, signal, onProgress });
    }
    const adapter = await import('./adapters/gemini-image.mjs');
    return await adapter.generateImage({ model, prompt, options, references, signal });
  }
  throw mediaError(`lane "${lane.id}" has no adapter`, 'MEDIA_LANE_UNKNOWN');
}

/**
 * Validate + start one generation. Returns the initial snapshot immediately;
 * the caller polls getMediaJob for progress and the finished asset id.
 */
export function startMediaJob({ lane: laneId, kind, model, prompt, options = {}, references = [] } = {}) {
  const text = String(prompt || '').trim();
  if (!text) throw mediaError('prompt is required', 'MEDIA_PROMPT_REQUIRED');
  if (text.length > MAX_PROMPT_CHARS) throw mediaError('prompt is too long', 'MEDIA_PROMPT_TOO_LONG');
  const resolved = resolveMediaRequest({ lane: laneId, kind, model });
  // Reference images: the MODEL publishes its own cap (Veo takes one start
  // frame, Grok ref2v takes seven), so the bound follows the resolved model.
  const modelEntry = resolved.spec.models.find((entry) => entry.id === resolved.model);
  const maxRefs = Number(
    modelEntry?.controls?.maxReferences ?? resolved.spec.controls?.maxReferences ?? 0,
  ) || (resolved.kind === 'video' ? 7 : 5);
  const refs = (Array.isArray(references) ? references : [])
    .filter((ref) => typeof ref?.base64 === 'string' && ref.base64.length > 0)
    .slice(0, maxRefs)
    .map((ref) => ({ base64: ref.base64, mime: String(ref.mime || 'image/png') }));
  sweep();

  const controller = new AbortController();
  const job = {
    id: randomUUID(),
    status: 'running',
    kind: resolved.kind,
    lane: resolved.lane.id,
    model: resolved.model,
    prompt: text,
    options: { ...options },
    referenceCount: refs.length,
    progress: 0,
    assetId: null,
    error: null,
    errorCode: null,
    startedAt: Date.now(),
    endedAt: null,
    controller,
  };
  JOBS.set(job.id, job);

  (async () => {
    try {
      const result = await runAdapter({
        lane: resolved.lane,
        kind: resolved.kind,
        model: resolved.model,
        prompt: text,
        options,
        references: refs,
        signal: controller.signal,
        onProgress: (value) => {
          const raw = Number(value);
          if (!Number.isFinite(raw)) return;
          // Lanes report either a 0-1 fraction or a percentage, and a poll can
          // come back stale — normalize and never let the rail walk backwards.
          const next = Math.round(Math.max(0, Math.min(100, raw > 1 ? raw : raw * 100)));
          if (next > job.progress) job.progress = next;
        },
      });
      if (!Buffer.isBuffer(result?.bytes)
        || !result.bytes.length
        || result.bytes.length > MAX_GENERATED_MEDIA_BYTES) {
        throw mediaError(
          'generated media exceeds the media size limit',
          'MEDIA_RESULT_TOO_LARGE',
          502,
        );
      }
      const asset = saveMediaAsset({
        kind: resolved.kind,
        lane: resolved.lane.id,
        model: resolved.model,
        prompt: text,
        options: job.options,
        mime: result.mime,
        bytes: result.bytes,
        meta: {
          ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
          ...(result.durationSeconds ? { durationSeconds: result.durationSeconds } : {}),
        },
      });
      job.assetId = asset.id;
      job.progress = 100;
      job.status = 'done';
    } catch (err) {
      const canceled = controller.signal.aborted || err?.code === 'MEDIA_CANCELED' || err?.name === 'AbortError';
      job.status = canceled ? 'canceled' : 'failed';
      job.error = canceled ? 'canceled' : String(err?.message || err).slice(0, 500);
      job.errorCode = err?.code || null;
      // The job snapshot is the ONLY record of a failure, and it is swept
      // once its TTL passes. Print the reason so a run that died upstream
      // stays diagnosable after its tile is gone.
      if (!canceled) {
        try {
          console.error(`[media] job failed lane=${job.lane} model=${job.model} `
            + `kind=${job.kind} code=${job.errorCode || 'none'}: ${job.error}`);
        } catch { /* logging must never mask the job failure */ }
      }
    } finally {
      job.endedAt = Date.now();
    }
  })();

  return snapshot(job);
}

export function getMediaJob(id) {
  const job = JOBS.get(String(id || ''));
  return job ? snapshot(job) : null;
}

export function listMediaJobs() {
  sweep();
  return [...JOBS.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(snapshot);
}

export function cancelMediaJob(id) {
  const job = JOBS.get(String(id || ''));
  if (!job) return { id, canceled: false };
  if (job.status === 'running') {
    try { job.controller.abort(); } catch {}
  }
  return { id: job.id, canceled: job.status === 'running' };
}
