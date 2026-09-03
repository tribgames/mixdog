// The model-facing Media Studio tool. It is a thin client of the media graph
// (lanes → jobs → store): the same catalog, adapters, and asset index the
// Studio UI uses, so a generation started here shows up in the gallery and a
// provider added to the catalog is available here without a code change.
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { MEDIA_ACTIONS, MEDIA_KINDS } from './tool-defs.mjs';

const POLL_MS = 750;
const TIMEOUT_MS = Object.freeze({ image: 180_000, video: 900_000 });
// OpenAI's image lane takes pixel sizes, not ratios; the placement still speaks in ratios.
const OPENAI_SIZE = Object.freeze({ '16:9': '1536x1024', '4:3': '1536x1024', '3:2': '1536x1024', '9:16': '1024x1536', '3:4': '1024x1536', '2:3': '1024x1536', '1:1': '1024x1024' });
const IMAGE_MIME = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' });
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;

let graph = null;
async function mediaGraph(deps) {
  if (deps) return deps;
  graph ??= {
    lanes: await import('./lanes.mjs'),
    jobs: await import('./jobs.mjs'),
    store: await import('./store.mjs'),
  };
  return graph;
}

function mediaToolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

class MediaToolError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.extra = extra;
  }
}

function clean(value) {
  return String(value ?? '').trim();
}

function fullPath(path, cwd) {
  const text = clean(path);
  return isAbsolute(text) ? text : resolve(cwd, text);
}

// ── list ─────────────────────────────────────────────────────────────────────

function compactLane(lane) {
  return {
    id: lane.id,
    label: lane.label,
    kinds: lane.kinds,
    ...(lane.image ? { image: lane.image.defaultModel } : {}),
    ...(lane.video ? { video: lane.video.defaultModel } : {}),
  };
}

function modelControls(lane, kind, modelId) {
  const spec = lane[kind];
  const entry = spec?.models.find((model) => model.id === modelId);
  if (!entry) return null;
  return { id: entry.id, label: entry.label, controls: entry.controls };
}

/** Narrowing catalog: nothing → lanes; kind → lanes with model ids; kind + model → one model's controls. */
export function listMediaCatalog(lanes, { kind = '', model = '' } = {}) {
  const signedIn = lanes.filter((lane) => lane.authenticated);
  const signedOut = lanes.filter((lane) => !lane.authenticated).map((lane) => lane.id);
  if (!kind) {
    return { lanes: signedIn.map(compactLane), ...(signedOut.length ? { signedOut } : {}) };
  }
  if (!MEDIA_KINDS.includes(kind)) throw new MediaToolError(`kind must be one of ${MEDIA_KINDS.join(', ')}`);
  const rows = signedIn.filter((lane) => lane.kinds.includes(kind));
  if (!model) {
    return {
      kind,
      lanes: rows.map((lane) => ({ id: lane.id, label: lane.label, defaultModel: lane[kind].defaultModel, models: lane[kind].models.map((entry) => entry.id) })),
      ...(signedOut.length ? { signedOut } : {}),
    };
  }
  const matches = rows.map((lane) => ({ lane: lane.id, ...modelControls(lane, kind, model) })).filter((entry) => entry.id);
  if (!matches.length) {
    throw new MediaToolError(`model "${model}" is not available for ${kind} on a signed-in lane`, {
      available: rows.flatMap((lane) => lane[kind].models.map((entry) => `${lane.id}/${entry.id}`)),
    });
  }
  return { kind, models: matches };
}

// ── generate ─────────────────────────────────────────────────────────────────

function pickLane(lanes, kind, requested) {
  const available = lanes.filter((lane) => lane.authenticated && lane.kinds.includes(kind));
  const catalog = available.map(compactLane);
  if (requested) {
    const lane = available.find((entry) => entry.id === requested);
    if (!lane) throw new MediaToolError(`lane "${requested}" is not signed in or does not generate ${kind}`, { lanes: catalog });
    return lane;
  }
  if (!available.length) {
    throw new MediaToolError(`No signed-in lane generates ${kind} (Settings → Providers). Use user-supplied files or continue without media.`, { lanes: [] });
  }
  return available[0];
}

function allowed(controls, key) {
  const list = controls?.[key];
  return Array.isArray(list) && list.length ? list : null;
}

function validateChoice(controls, key, value, label) {
  const list = allowed(controls, key);
  if (!value) return;
  if (list && !list.includes(value)) throw new MediaToolError(`${label} "${value}" is not supported by this model; use one of ${list.join(', ')}`);
}

/** Lane-native options from the tool's placement vocabulary, validated against the model's controls. */
export function buildOptions(lane, kind, controls, { aspect = '', resolution = '', duration = null, quality = '' } = {}) {
  const options = {};
  if (lane.id === 'openai-oauth') {
    const size = aspect ? OPENAI_SIZE[aspect] : 'auto';
    if (aspect && !size) throw new MediaToolError(`aspect "${aspect}" has no size on ${lane.id}; use one of ${Object.keys(OPENAI_SIZE).join(', ')}`);
    validateChoice(controls, 'size', size, 'size');
    options.size = size || 'auto';
    if (quality) validateChoice(controls, 'quality', quality, 'quality');
    options.quality = quality || 'high';
  } else {
    if (aspect) {
      validateChoice(controls, 'aspectRatio', aspect, 'aspect');
      options.aspectRatio = aspect;
    }
    if (resolution) {
      validateChoice(controls, 'resolution', resolution, 'resolution');
      options.resolution = resolution;
    } else if (kind === 'image' && allowed(controls, 'resolution')?.includes('2k')) {
      options.resolution = '2k';
    }
    if (quality) {
      validateChoice(controls, 'quality', quality, 'quality');
      options.quality = quality;
    }
  }
  if (kind === 'video' && duration != null) {
    const seconds = Number(duration);
    const durations = allowed(controls, 'durations');
    const range = Array.isArray(controls?.durationRange) && controls.durationRange.length === 2 ? controls.durationRange : null;
    if (durations && !durations.includes(seconds)) throw new MediaToolError(`duration ${seconds}s is not supported; use one of ${durations.join(', ')}`);
    if (range && (seconds < range[0] || seconds > range[1])) throw new MediaToolError(`duration ${seconds}s is outside ${range[0]}-${range[1]}s`);
    options.duration = seconds;
  }
  return options;
}

async function readReferences(paths, cwd, controls) {
  const list = (Array.isArray(paths) ? paths : []).map(clean).filter(Boolean);
  if (!list.length) return [];
  const cap = Number(controls?.maxReferences) || 0;
  if (cap === 0) throw new MediaToolError('this model takes no reference images');
  if (list.length > cap) throw new MediaToolError(`this model takes at most ${cap} reference image(s); ${list.length} given`);
  const references = [];
  for (const entry of list) {
    const file = fullPath(entry, cwd);
    const mime = IMAGE_MIME[extname(file).toLowerCase()];
    if (!mime) throw new MediaToolError(`reference "${entry}" is not a png/jpg/webp/gif image`);
    const bytes = await readFile(file);
    if (bytes.length > MAX_REFERENCE_BYTES) throw new MediaToolError(`reference "${entry}" exceeds ${MAX_REFERENCE_BYTES / 1024 / 1024} MB`);
    references.push({ base64: bytes.toString('base64'), mime });
  }
  return references;
}

async function copyAsset(store, assetId, target) {
  const asset = await store.resolveMediaFile(assetId, { variant: 'original' });
  if (!asset?.path) throw new MediaToolError('the generated asset is not readable from the media store');
  const output = extname(target) ? target : `${target}${extname(asset.path) || ''}`;
  await mkdir(dirname(output), { recursive: true });
  await copyFile(asset.path, output);
  return output;
}

function jobView(job) {
  return {
    job: job.id,
    status: job.status,
    kind: job.kind,
    lane: job.lane,
    model: job.model,
    options: job.options,
    progress: job.progress,
    assetId: job.assetId,
    error: job.error,
    elapsedMs: Math.max(0, Number(job.endedAt || Date.now()) - Number(job.startedAt || Date.now())),
  };
}

async function generate(args, { cwd, signal, deps }) {
  const kind = clean(args.kind);
  if (!MEDIA_KINDS.includes(kind)) throw new MediaToolError(`generate requires kind: ${MEDIA_KINDS.join(' | ')}`);
  const prompt = clean(args.prompt);
  if (!prompt) throw new MediaToolError('generate requires prompt: the subject, the treatment, the mood, the framing, and what must not appear');
  const requestedPath = clean(args.path);
  if (!requestedPath) throw new MediaToolError('generate requires path: where to write the file');
  const target = fullPath(requestedPath, cwd);
  const { lanes, jobs, store } = await mediaGraph(deps);
  const lane = pickLane(lanes.listMediaLanes(), kind, clean(args.lane));
  const spec = lane[kind];
  const modelId = clean(args.model) || spec.defaultModel;
  const model = modelControls(lane, kind, modelId);
  if (!model) throw new MediaToolError(`model "${modelId}" is not available on ${lane.id} for ${kind}`, { available: spec.models.map((entry) => entry.id) });
  const options = buildOptions(lane, kind, model.controls, {
    aspect: clean(args.aspect), resolution: clean(args.resolution), duration: args.duration ?? null, quality: clean(args.quality),
  });
  const references = await readReferences(args.references, cwd, model.controls);
  const started = jobs.startMediaJob({ lane: lane.id, kind, model: modelId, prompt, options, references });
  const base = { lane: lane.id, model: modelId, options, referenceCount: references.length, prompt };
  if (args.wait === false) {
    return { ok: true, ...jobView(started), ...base, nextAction: `Poll media status job:${started.id} path:${requestedPath}; the file is written when status is done.` };
  }
  const deadline = Date.now() + TIMEOUT_MS[kind];
  let job = started;
  while (job.status === 'running') {
    if (signal?.aborted) {
      jobs.cancelMediaJob(job.id);
      throw new MediaToolError('generation canceled');
    }
    if (Date.now() > deadline) {
      throw new MediaToolError(`generation is still running after ${TIMEOUT_MS[kind] / 1000}s on ${lane.id}; poll media status job:${job.id}`, { job: job.id });
    }
    await new Promise((done) => setTimeout(done, POLL_MS));
    job = jobs.getMediaJob(job.id) || job;
  }
  if (job.status !== 'done' || !job.assetId) {
    throw new MediaToolError(`generation failed on ${lane.id}/${modelId}: ${job.error || job.status}`, { job: job.id });
  }
  const output = await copyAsset(store, job.assetId, target);
  return { ok: true, output, ...base, assetId: job.assetId, elapsedMs: jobView(job).elapsedMs };
}

async function status(args, { cwd, deps }) {
  const { jobs, store } = await mediaGraph(deps);
  const id = clean(args.job);
  if (!id) throw new MediaToolError('status requires job');
  const job = jobs.getMediaJob(id);
  if (!job) throw new MediaToolError(`job "${id}" is not known (finished jobs expire after 10 minutes)`);
  const view = { ok: job.status !== 'failed', ...jobView(job) };
  if (job.status === 'done' && job.assetId && clean(args.path)) {
    view.output = await copyAsset(store, job.assetId, fullPath(args.path, cwd));
  }
  return view;
}

async function cancel(args, { deps }) {
  const { jobs } = await mediaGraph(deps);
  const id = clean(args.job);
  if (!id) throw new MediaToolError('cancel requires job');
  const job = jobs.cancelMediaJob(id);
  if (!job) throw new MediaToolError(`job "${id}" is not known`);
  return { ok: true, ...jobView(job) };
}

export async function executeMediaTool(args = {}, { cwd = process.cwd(), signal = null, deps = null } = {}) {
  const action = clean(args.action).toLowerCase();
  try {
    if (!MEDIA_ACTIONS.includes(action)) throw new MediaToolError(`Unsupported media action "${action}"; use ${MEDIA_ACTIONS.join(', ')}`);
    if (action === 'list') {
      const { lanes } = await mediaGraph(deps);
      return mediaToolResult({ ok: true, ...listMediaCatalog(lanes.listMediaLanes(), { kind: clean(args.kind), model: clean(args.model) }) });
    }
    if (action === 'generate') return mediaToolResult(await generate(args, { cwd, signal, deps }));
    if (action === 'status') return mediaToolResult(await status(args, { cwd, deps }));
    return mediaToolResult(await cancel(args, { deps }));
  } catch (error) {
    const extra = error instanceof MediaToolError ? error.extra : {};
    return mediaToolResult({ ok: false, action, error: error?.message || String(error), ...(error?.code ? { code: error.code } : {}), ...extra }, true);
  }
}
