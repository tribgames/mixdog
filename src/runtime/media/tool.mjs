// The model-facing Media Studio tool. It is a thin client of the media graph
// (lanes → jobs → store): the same catalog, adapters, and asset index the
// Studio UI uses, so a generation started here shows up in the gallery and a
// provider added to the catalog is available here without a code change.
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { MEDIA_ACTIONS, MEDIA_KINDS } from './tool-defs.mjs';
import { clean } from '../shared/clean.mjs';

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
    defaults: await import('./defaults.mjs'),
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

function fullPath(path, cwd) {
  const text = clean(path);
  return isAbsolute(text) ? text : resolve(cwd, text);
}

// ── list ─────────────────────────────────────────────────────────────────────

function compactLane(lane) {
  return {
    id: lane.id,
    label: lane.label,
    authType: lane.authType,
    kinds: lane.kinds,
    ...(lane.image ? { image: lane.image.defaultModel } : {}),
    ...(lane.video ? { video: lane.video.defaultModel } : {}),
  };
}

function modelControls(lane, kind, modelId) {
  const spec = lane[kind];
  const entry = spec?.models.find((model) => model.id === modelId);
  if (!entry) return null;
  return { id: entry.id, label: entry.label, controls: entry.controls, ...(entry.description ? { description: entry.description } : {}) };
}

/** Narrowing catalog: nothing → lanes; kind → lanes with model ids (+ the remembered lane/model); kind + model → one model's controls. */
export function listMediaCatalog(lanes, { kind = '', model = '' } = {}, remembered = null) {
  const signedIn = lanes.filter((lane) => lane.authenticated);
  const signedOut = lanes.filter((lane) => !lane.authenticated).map((lane) => lane.id);
  const catalogErrors = lanes.filter((lane) => lane.catalogError)
    .map((lane) => ({ lane: lane.id, error: lane.catalogError, code: lane.catalogErrorCode }));
  const catalogWarnings = lanes.filter((lane) => lane.catalogWarning)
    .map((lane) => ({ lane: lane.id, warning: lane.catalogWarning }));
  const diagnostics = {
    ...(catalogErrors.length ? { catalogErrors } : {}),
    ...(catalogWarnings.length ? { catalogWarnings } : {}),
  };
  if (!kind) {
    return { lanes: signedIn.map(compactLane), ...(signedOut.length ? { signedOut } : {}), ...diagnostics };
  }
  if (!MEDIA_KINDS.includes(kind)) throw new MediaToolError(`kind must be one of ${MEDIA_KINDS.join(', ')}`);
  const rows = signedIn.filter((lane) => lane.kinds.includes(kind));
  if (!model) {
    return {
      kind,
      lanes: rows.map((lane) => ({ id: lane.id, label: lane.label, defaultModel: lane[kind].defaultModel, models: lane[kind].models.map((entry) => entry.id) })),
      // What a generate without lane/model will run on — the caller reads that
      // model's controls instead of guessing from the first lane.
      ...(remembered?.lane ? { remembered: { lane: remembered.lane, model: remembered.model || '' } } : {}),
      ...(signedOut.length ? { signedOut } : {}),
      ...diagnostics,
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

/**
 * Lane for a generate: the requested one, else the lane the user last chose
 * for this kind (Studio selection or last generation), else the first
 * signed-in lane. `laneSource` tells the caller which of the three applied.
 */
function pickLane(lanes, kind, requested, remembered = null) {
  const available = lanes.filter((lane) => lane.authenticated && lane.kinds.includes(kind));
  const catalog = available.map(compactLane);
  if (requested) {
    const lane = available.find((entry) => entry.id === requested);
    const unavailable = lanes.find((entry) => entry.id === requested && entry.catalogError);
    if (unavailable) throw new MediaToolError(unavailable.catalogError, { lanes: catalog });
    if (!lane) throw new MediaToolError(`lane "${requested}" is not signed in or does not generate ${kind}`, { lanes: catalog });
    return { lane, laneSource: 'requested' };
  }
  if (!available.length) {
    const failures = lanes.filter((lane) => lane.catalogError);
    if (failures.length) throw new MediaToolError(failures.map((lane) => lane.catalogError).join('\n'), { lanes: [] });
    throw new MediaToolError(`No signed-in lane generates ${kind} (Settings → Providers). Use user-supplied files or continue without media.`, { lanes: [] });
  }
  const rememberedLane = remembered?.lane ? available.find((entry) => entry.id === remembered.lane) : null;
  return rememberedLane ? { lane: rememberedLane, laneSource: 'remembered' } : { lane: available[0], laneSource: 'first' };
}

function readRemembered(defaults, kind) {
  try {
    return defaults?.getMediaDefault?.(kind) || null;
  } catch {
    return null;
  }
}

function allowed(controls, key) {
  const list = controls?.[key];
  return Array.isArray(list) && list.length ? list : null;
}

function validateChoice(controls, key, value, label) {
  const list = allowed(controls, key);
  if (!value) return;
  if (!list || !list.includes(value)) throw new MediaToolError(`${label} "${value}" is not supported by this model${list ? `; use one of ${list.join(', ')}` : ''}`);
}

/** Lane-native options from the tool's placement vocabulary, validated against the model's controls. */
export function buildOptions(lane, kind, controls, { aspect = '', resolution = '', duration = null, quality = '' } = {}) {
  const options = {};
  if (lane.id === 'openai-oauth') {
    if (!allowed(controls, 'size')) {
      if ([aspect, resolution, quality].some(value => value && value !== 'auto')) {
        throw new MediaToolError('ChatGPT selects image output settings; explicit size and quality are not supported on this connection.');
      }
      return options;
    }
    const size = aspect ? OPENAI_SIZE[aspect] : 'auto';
    if (aspect && !size) throw new MediaToolError(`aspect "${aspect}" has no size on ${lane.id}; use one of ${Object.keys(OPENAI_SIZE).join(', ')}`);
    validateChoice(controls, 'size', size, 'size');
    options.size = size || 'auto';
    if (quality) validateChoice(controls, 'quality', quality, 'quality');
    if (allowed(controls, 'quality')) options.quality = quality || 'auto';
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
  const { lanes, jobs, store, defaults } = await mediaGraph(deps);
  const remembered = readRemembered(defaults, kind);
  const { lane, laneSource } = pickLane(await lanes.listMediaLanes(), kind, clean(args.lane), remembered);
  const spec = lane[kind];
  // The remembered model only applies on the remembered lane and only while
  // that lane still lists it; otherwise the lane default is the safe choice.
  const rememberedModel = laneSource === 'remembered' && remembered.model && spec.models.some((entry) => entry.id === remembered.model)
    ? remembered.model
    : '';
  const modelId = clean(args.model) || rememberedModel || spec.defaultModel;
  const model = modelControls(lane, kind, modelId);
  if (!model) throw new MediaToolError(`model "${modelId}" is not available on ${lane.id} for ${kind}`, { available: spec.models.map((entry) => entry.id) });
  const options = buildOptions(lane, kind, model.controls, {
    aspect: clean(args.aspect), resolution: clean(args.resolution), duration: args.duration ?? null, quality: clean(args.quality),
  });
  const references = await readReferences(args.references, cwd, model.controls);
  const started = await jobs.startMediaJob({ lane: lane.id, kind, model: modelId, prompt, options, references });
  const base = { lane: lane.id, model: modelId, laneSource, options, referenceCount: references.length, prompt };
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
      const { lanes, defaults } = await mediaGraph(deps);
      const kind = clean(args.kind);
      return mediaToolResult({ ok: true, ...listMediaCatalog(await lanes.listMediaLanes(), { kind, model: clean(args.model) }, readRemembered(defaults, kind)) });
    }
    if (action === 'generate') return mediaToolResult(await generate(args, { cwd, signal, deps }));
    if (action === 'status') return mediaToolResult(await status(args, { cwd, deps }));
    return mediaToolResult(await cancel(args, { deps }));
  } catch (error) {
    const extra = error instanceof MediaToolError ? error.extra : {};
    return mediaToolResult({ ok: false, action, error: error?.message || String(error), ...(error?.code ? { code: error.code } : {}), ...extra }, true);
  }
}
