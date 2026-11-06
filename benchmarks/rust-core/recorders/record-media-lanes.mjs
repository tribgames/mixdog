#!/usr/bin/env node
// Golden twin of the media lane catalog: what Node's real `projectMediaModels` (catalog.mjs)
// makes of provider model rows per lane, and what `createMediaLaneCatalog` (lanes.mjs) lists and
// resolves over injected credential probes and catalog loaders (signed in or out, rows, a stale
// catalog's warning, every failure code). Rust `media::catalog` and `media::lanes` must answer
// the same.
//
//   node benchmarks/rust-core/recorders/record-media-lanes.mjs --tree <dir>
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

// Nothing here reads the user's data, but the modules do at import time: pin it to a temp dir.
const sandbox = mkdtempSync(join(tmpdir(), 'mixdog-media-lanes-'));
mkdirSync(join(sandbox, 'data'), { recursive: true });
process.env.MIXDOG_DATA_DIR = join(sandbox, 'data');
process.env.MIXDOG_HOME = join(sandbox, 'data');
const tree = resolveTree(parseArgs());
const { projectMediaModels } = await importFrom(tree, 'src/runtime/media/catalog.mjs');
const { createMediaLaneCatalog } = await importFrom(tree, 'src/runtime/media/lanes.mjs');

const LANE_IDS = ['grok-oauth', 'xai', 'openai-oauth', 'gemini', 'antigravity-oauth', 'openrouter', 'nano-gpt'];

const GROK = [
  { id: 'grok-imagine-image', created: 100 },
  { id: 'grok-imagine-image-quality', created: 200 },
  { id: 'grok-imagine-image-pro', created: 150 },
  { id: 'grok-imagine-video', created: 100 },
  { id: 'grok-imagine-video-1.5', created: 400 },
  { id: 'grok-imagine-video-2', created: 300 },
  { id: 'grok-2-vision' },
  { id: 'grok-imagine-image', created: 999 },
  { name: 'models/grok-imagine-video-quality', created: '250' },
  { id: 'grok-imagine-image-old', deprecated: true },
  { id: 'grok-imagine-image-off', disabled: true },
  { id: '  ' },
  null,
  'grok-imagine-image-str',
];
const GEMINI = [
  { name: 'models/gemini-2.5-flash-image', displayName: 'Nano Banana', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.1-flash-image-preview', displayName: 'Gemini 3.1 Flash Image Preview', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.1-flash-lite-image', displayName: 'x', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3-pro-image', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3-pro-image-experimental', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-2.0-flash-image-generation', supportedGenerationMethods: ['predict'] },
  { name: 'models/gemini-omni-flash' },
  { name: 'models/gemini-omni-1.5-flash-preview', displayName: 'Omni' },
  { name: 'models/veo-3.1-generate-preview', supportedGenerationMethods: ['predictLongRunning'] },
  { name: 'models/veo-3.0-generate-001', supportedGenerationMethods: ['predictLongRunning'] },
  { name: 'models/veo-3.1-fast-generate-preview', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-2.5-pro' },
];
const OPENAI = [
  { id: 'gpt-5.4-mini' },
  { id: 'gpt-5.5', supportedTools: ['image_generation', 'web_search'] },
  { id: 'gpt-5.5-codex' },
  { id: 'gpt-6' },
  { id: 'gpt-5-nano' },
  { id: 'gpt-4.1', supportsImageGeneration: true },
  { id: 'gpt-5.9', supportsImageGeneration: false },
  { id: 'gpt-5.1-chat', supportedTools: [] },
  { id: 'o3' },
];
const GATEWAY = [
  {
    id: 'flux-1',
    created: 5,
    architecture: { output_modalities: ['image'], input_modalities: ['text', 'image'] },
    supported_parameters: {
      aspect_ratio: { type: 'enum', values: ['1:1', ' 16:9 ', '1:1', '', 3] },
      resolution: { type: 'enum', values: [] },
      quality: { type: 'range', max: 3 },
      background: { type: 'enum', values: ['opaque'] },
      input_references: { type: 'range', max: 40.9 },
    },
  },
  { id: 'upscaler', architecture: { output_modalities: ['image'], input_modalities: ['image'] }, capabilities: { image_to_image: false } },
  { id: 'text-model', architecture: { output_modalities: ['text'] } },
  { id: 'no-gen', architecture: { output_modalities: ['image'] }, capabilities: { image_generation: false } },
  { id: 'ref-range', architecture: { output_modalities: ['image'] }, supported_parameters: { input_references: { type: 'range', max: 'x' } } },
  { id: 'ref-neg', architecture: { output_modalities: ['image'] }, supported_parameters: { input_references: { type: 'range', max: -4 } } },
  { id: 'preview-image-1', created: 9, architecture: { output_modalities: ['image'] } },
];
const CORPUS = {
  'grok-oauth': GROK,
  xai: GROK,
  'openai-oauth': OPENAI,
  gemini: GEMINI,
  'antigravity-oauth': GEMINI,
  openrouter: GATEWAY,
  'nano-gpt': GATEWAY,
};

const projections = [];
for (const lane of LANE_IDS) projections.push({ lane, rows: CORPUS[lane], result: projectMediaModels(lane, CORPUS[lane]) });
projections.push({ lane: 'openai-oauth', rows: [], result: projectMediaModels('openai-oauth', []) });
projections.push({ lane: 'gemini', rows: 'not an array', result: projectMediaModels('gemini', 'not an array') });
projections.push({ lane: 'unknown-lane', rows: GROK, result: projectMediaModels('unknown-lane', GROK) });

const failure = (spec) => Object.assign(new Error('upstream'), spec.code ? { code: spec.code } : {}, spec.name ? { name: spec.name } : {});
const scenarios = [
  {
    name: 'all-signed-in',
    authenticated: LANE_IDS,
    models: Object.fromEntries(LANE_IDS.map((lane) => [lane, { rows: CORPUS[lane] }])),
    calls: [
      { op: 'list' },
      { op: 'resolve', lane: 'gemini', kind: 'video', model: '' },
      { op: 'resolve', lane: 'gemini', kind: 'image', model: 'gemini-2.5-flash-image' },
      { op: 'resolve', lane: 'gemini', kind: 'image', model: 'nope' },
      { op: 'resolve', lane: ' xai ', kind: ' video ', model: ' grok-imagine-video ' },
      { op: 'resolve', lane: 'openai-oauth', kind: 'image', model: '' },
      { op: 'resolve', lane: 'openai-oauth', kind: 'video', model: '' },
      { op: 'resolve', lane: 'openrouter', kind: 'image', model: 'flux-1' },
      { op: 'resolve', lane: 'nowhere', kind: 'image', model: '' },
      { op: 'resolve', lane: 'xai', kind: 'audio', model: '' },
    ],
  },
  {
    name: 'signed-out',
    authenticated: ['gemini'],
    models: { gemini: { rows: GEMINI } },
    calls: [{ op: 'list' }, { op: 'resolve', lane: 'xai', kind: 'image', model: '' }, { op: 'resolve', lane: 'gemini', kind: 'image', model: '' }],
  },
  {
    name: 'stale-catalog-warning',
    authenticated: ['gemini', 'xai'],
    models: { gemini: { rows: GEMINI, warning: 'Using the last successful model catalog. Model catalog unavailable. Retry after checking the provider connection.' }, xai: { rows: [] } },
    calls: [{ op: 'list' }, { op: 'resolve', lane: 'gemini', kind: 'image', model: '' }, { op: 'resolve', lane: 'xai', kind: 'image', model: '' }],
  },
  ...['MEDIA_AUTH_REJECTED', 'MEDIA_ACCESS_DENIED', 'MEDIA_RATE_LIMITED', 'MEDIA_CATALOG_TIMEOUT', 'MEDIA_CATALOG_UNAVAILABLE', 'MEDIA_BILLING_BLOCKED', 'SOMETHING_ELSE'].map((code) => ({
    name: `catalog-failure-${code}`,
    authenticated: ['gemini', 'grok-oauth'],
    models: { gemini: { error: { code } }, 'grok-oauth': { rows: GROK } },
    calls: [{ op: 'list' }, { op: 'resolve', lane: 'gemini', kind: 'image', model: '' }, { op: 'resolve', lane: 'grok-oauth', kind: 'video', model: '' }],
  })),
  {
    name: 'catalog-timeout-by-name',
    authenticated: ['openrouter'],
    models: { openrouter: { error: { name: 'TimeoutError' } } },
    calls: [{ op: 'list' }, { op: 'resolve', lane: 'openrouter', kind: 'image', model: '' }],
  },
];

const results = [];
for (const scenario of scenarios) {
  const catalog = createMediaLaneCatalog({
    authenticated: (lane) => scenario.authenticated.includes(lane.id),
    loadModels: async (laneId) => {
      const entry = scenario.models[laneId];
      if (!entry) return [];
      if (entry.error) throw failure(entry.error);
      const rows = [...entry.rows];
      if (entry.warning) Object.defineProperty(rows, 'catalogWarning', { value: entry.warning });
      return rows;
    },
  });
  const calls = [];
  for (const call of scenario.calls) {
    if (call.op === 'list') {
      calls.push({ ...call, result: await catalog.listMediaLanes() });
      continue;
    }
    try {
      calls.push({ ...call, result: await catalog.resolveMediaRequest({ lane: call.lane, kind: call.kind, model: call.model }) });
    } catch (error) {
      calls.push({ ...call, error: { message: error.message, code: error.code, status: error.status } });
    }
  }
  results.push({ ...scenario, calls });
}

writeJson(join(FIXTURES_ROOT, 'services', 'media-lanes-twin.json'), { domain: 'media-lanes-twin', recorder: 'benchmarks/rust-core/recorders/record-media-lanes.mjs', projections, scenarios: results });
console.log(`recorded ${projections.length} projections, ${results.length} scenarios`);
process.exit(0);
