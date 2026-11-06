#!/usr/bin/env node
// Golden twin of the model-facing media tool: Node's real `executeMediaTool` (runtime/media/tool.mjs)
// over an injected media graph (lanes, jobs, store, defaults, accounts), a scratch folder and a
// scripted clock. Records the exact reply of every call, the job starts and cancels the graph saw,
// the account scopes it was listed under, and the files left behind. Rust `media::tool` must
// answer the same.
//
//   node benchmarks/rust-core/recorders/record-media-tool.mjs --tree <dir>
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const T0 = 1_700_000_000_000;
let skew = 0;
Date.now = () => T0 + skew;
const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-media-tool-'));
process.env.MIXDOG_DATA_DIR = join(ROOT, 'data');
const tree = resolveTree(parseArgs());
const { executeMediaTool } = await importFrom(tree, 'src/runtime/media/tool.mjs');
const { withProviderAccount } = await importFrom(tree, 'src/runtime/shared/provider-auth-binding.mjs');

const ASPECTS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4'];
const model = (id, label, controls, extra = {}) => ({ id, label, ...extra, controls });
const view = (id, label, authType, kinds, specs, extra = {}) => ({
  id,
  label,
  authType,
  authenticated: true,
  supportedKinds: kinds,
  kinds,
  image: specs.image ? { models: specs.image, defaultModel: specs.image[0].id, controls: {} } : null,
  video: specs.video ? { models: specs.video, defaultModel: specs.video[0].id, controls: {} } : null,
  ...extra,
});
const OPENAI = view('openai-oauth', 'OpenAI Images', 'oauth', ['image'], {
  image: [
    model('gpt-image-2', 'GPT Image 2', { maxReferences: 5, background: ['auto', 'transparent', 'opaque'] }, { description: 'ChatGPT image engine.', requestModel: 'gpt-5.5' }),
    model('gpt-sized', 'GPT Sized', { size: ['auto', '1536x1024', '1024x1536', '1024x1024'], quality: ['auto', 'high'], maxReferences: 2 }),
  ],
});
const XAI = view('xai', 'Grok Imagine', 'api-key', ['image', 'video'], {
  image: [model('grok-imagine-image', 'Grok Imagine Image', { aspectRatio: ASPECTS, resolution: ['1k', '2k'], maxReferences: 5 })],
  video: [model('grok-imagine-video', 'Grok Imagine Video', { aspectRatio: ASPECTS, resolution: ['480p', '720p', '1080p'], durationRange: [1, 15], maxReferences: 7 })],
});
const GEMINI = view('gemini', 'Google Gemini', 'api-key', ['image', 'video'], {
  image: [model('gemini-2.5-flash-image', 'Nano Banana', { aspectRatio: ASPECTS, maxReferences: 3 }), model('gemini-3-pro-image', 'Nano Banana Pro', { aspectRatio: ASPECTS, maxReferences: 3 })],
  video: [model('veo-3.1', 'Veo 3.1', { aspectRatio: ['16:9', '9:16'], resolution: ['720p', '1080p'], durations: [4, 6, 8], maxReferences: 1 })],
});
const OPENROUTER = view('openrouter', 'OpenRouter', 'api-key', ['image'], {
  image: [model('flux-1', 'Flux 1', { aspectRatio: ASPECTS, resolution: ['1k', '2k'], quality: ['low', 'high'], maxReferences: 16 })],
});
const SIGNED_OUT = { ...view('nano-gpt', 'NanoGPT', 'api-key', ['image'], {}), authenticated: false, kinds: [], image: null };
const BROKEN = {
  ...view('antigravity-oauth', 'Google Antigravity', 'oauth', ['image'], {}),
  kinds: [],
  image: null,
  catalogError: 'Google Antigravity (Account): Model catalog unavailable. Retry after checking the provider connection.',
  catalogErrorCode: 'MEDIA_CATALOG_UNAVAILABLE',
};
const STALE = { ...view('grok-oauth', 'Grok Imagine', 'oauth', ['image'], { image: [model('grok-imagine-image', 'Grok Imagine Image', { aspectRatio: ASPECTS, maxReferences: 5 })] }), catalogWarning: 'Using the last successful model catalog. Model catalog unavailable.' };

const LANE_SETS = {
  full: [OPENAI, XAI, GEMINI, OPENROUTER, SIGNED_OUT, BROKEN, STALE],
  'no-openai': [XAI, GEMINI, OPENROUTER],
  'xai-gemini': [XAI, GEMINI],
  'broken-only': [BROKEN],
  'broken-two': [BROKEN, { ...BROKEN, id: 'x2', catalogError: 'Second lane failed.' }],
  'signed-out-only': [SIGNED_OUT],
  empty: [],
};

const GEN = (extra = {}) => ({ action: 'generate', kind: 'image', prompt: ' a red fox ', path: 'out/fox.png', ...extra });
const PNG = 'PNGBYTES';

// A scenario: a lane set, the graph's remembered/pinned choices, how jobs behave, the files laid
// down first ({root} is the scratch root), and the calls.
const SCENARIOS = [
  { name: 'list', lanes: 'full', remembered: { image: { kind: 'image', lane: 'xai', model: 'grok-imagine-image' } }, calls: [
    { action: 'list' }, { action: ' LIST ' }, { action: 'list', kind: 'image' }, { action: 'list', kind: 'video' },
    { action: 'list', kind: 'image', model: 'flux-1' }, { action: 'list', kind: 'image', model: 'nope' }, { action: 'list', kind: 'audio' }, { action: 'list', kind: 'video', model: 'veo-3.1' },
  ] },
  { name: 'list-pinned-and-clean', lanes: 'xai-gemini', pins: { image: { kind: 'image', lane: 'gemini', model: 'gemini-3-pro-image', account: '' } }, calls: [{ action: 'list', kind: 'image' }, { action: 'list', kind: 'video' }] },
  { name: 'list-empty', lanes: 'empty', calls: [{ action: 'list' }, { action: 'list', kind: 'image' }] },
  { name: 'unsupported-action', lanes: 'full', calls: [{}, { action: 'frobnicate' }, { action: null }, { action: 7 }] },
  { name: 'generate-validation', lanes: 'full', calls: [
    { action: 'generate' }, { action: 'generate', kind: 'audio' }, { action: 'generate', kind: 'image' }, { action: 'generate', kind: 'image', prompt: '  ' },
    { action: 'generate', kind: 'image', prompt: 'x' }, GEN({ lane: 'nano-gpt' }), GEN({ lane: 'antigravity-oauth' }), GEN({ lane: 'nowhere' }), GEN({ lane: 'xai', model: 'nope' }),
    GEN({ kind: 'video', lane: 'openrouter' }),
  ] },
  { name: 'generate-lane-pick', lanes: 'full', job: { outcome: 'done', assetId: 'asset-1' }, calls: [
    GEN(), GEN({ lane: 'xai' }), GEN({ lane: 'xai', model: 'grok-imagine-image', path: 'out/two' }), GEN({ path: ' ' }),
  ] },
  { name: 'generate-remembered', lanes: 'full', remembered: { image: { kind: 'image', lane: 'gemini', model: 'gemini-3-pro-image' } }, job: { outcome: 'done', assetId: 'asset-1' }, calls: [GEN(), GEN({ lane: 'xai' }), GEN({ model: 'flux-1' })] },
  { name: 'generate-remembered-model-gone', lanes: 'full', remembered: { image: { kind: 'image', lane: 'gemini', model: 'retired-model' } }, job: { outcome: 'done', assetId: 'asset-1' }, calls: [GEN()] },
  { name: 'generate-remembered-lane-gone', lanes: 'xai-gemini', remembered: { image: { kind: 'image', lane: 'openai-oauth', model: '' } }, job: { outcome: 'done', assetId: 'asset-1' }, calls: [GEN()] },
  { name: 'generate-pinned', lanes: 'full', pins: { image: { kind: 'image', lane: 'xai', model: 'grok-imagine-image', account: '' } }, remembered: { image: { kind: 'image', lane: 'gemini', model: '' } }, job: { outcome: 'done', assetId: 'asset-1' }, calls: [GEN(), GEN({ lane: 'gemini' }), GEN({ model: 'gemini-3-pro-image' })] },
  { name: 'generate-pinned-account', lanes: 'full', pins: { image: { kind: 'image', lane: 'gemini', model: '', account: 'work' } }, accountProviders: { gemini: 'gemini' }, job: { outcome: 'done', assetId: 'asset-1' }, calls: [GEN(), GEN({ lane: 'xai' })] },
  { name: 'generate-pinned-account-valid', lanes: 'full', pins: { image: { kind: 'image', lane: 'xai', model: '', account: '11111111-2222-3333-4444-555555555555' } }, accountProviders: { xai: 'grok-oauth' }, job: { outcome: 'done', assetId: 'asset-1' }, calls: [GEN(), GEN({ lane: 'gemini' })] },
  { name: 'generate-pinned-account-bad-id', lanes: 'full', pins: { image: { kind: 'image', lane: 'xai', model: '', account: 'work' } }, accountProviders: { xai: 'grok-oauth' }, calls: [GEN()] },
  { name: 'generate-pinned-account-no-provider', lanes: 'full', pins: { image: { kind: 'image', lane: 'xai', model: '', account: 'work' } }, job: { outcome: 'done', assetId: 'asset-1' }, calls: [GEN()] },
  { name: 'generate-pinned-lane-missing', lanes: 'no-openai', pins: { image: { kind: 'image', lane: 'openai-oauth', model: '', account: '' } }, calls: [GEN()] },
  { name: 'generate-broken-catalog', lanes: 'broken-only', calls: [GEN(), GEN({ lane: 'antigravity-oauth' })] },
  { name: 'generate-broken-two', lanes: 'broken-two', calls: [GEN()] },
  { name: 'generate-signed-out', lanes: 'signed-out-only', calls: [GEN(), { action: 'generate', kind: 'video', prompt: 'p', path: 'v.mp4' }] },
  { name: 'options-openai', lanes: 'full', job: { outcome: 'done', assetId: 'asset-1' }, calls: [
    GEN({ lane: 'openai-oauth', aspect: '16:9' }), GEN({ lane: 'openai-oauth', resolution: '2k' }), GEN({ lane: 'openai-oauth', quality: 'high' }), GEN({ lane: 'openai-oauth', aspect: 'auto' }),
    GEN({ lane: 'openai-oauth', background: 'transparent' }), GEN({ lane: 'openai-oauth', background: 'auto' }), GEN({ lane: 'openai-oauth', background: 'checker' }),
    GEN({ lane: 'openai-oauth', model: 'gpt-sized' }), GEN({ lane: 'openai-oauth', model: 'gpt-sized', aspect: '9:16', quality: 'high' }), GEN({ lane: 'openai-oauth', model: 'gpt-sized', aspect: '21:9' }),
    GEN({ lane: 'openai-oauth', model: 'gpt-sized', quality: 'ultra' }), GEN({ lane: 'openai-oauth', model: 'gpt-sized', aspect: '1:1' }),
  ] },
  { name: 'options-other-lanes', lanes: 'full', job: { outcome: 'done', assetId: 'asset-1' }, calls: [
    GEN({ lane: 'xai', aspect: '16:9', resolution: '1k' }), GEN({ lane: 'xai' }), GEN({ lane: 'xai', aspect: '21:9' }), GEN({ lane: 'xai', resolution: '8k' }), GEN({ lane: 'xai', quality: 'high' }),
    GEN({ lane: 'openrouter' }), GEN({ lane: 'openrouter', quality: 'high', resolution: '1k' }), GEN({ lane: 'openrouter', quality: 'mid' }), GEN({ lane: 'gemini', aspect: '4:3' }),
  ] },
  { name: 'options-video', lanes: 'full', job: { outcome: 'done', assetId: 'asset-1' }, calls: [
    { action: 'generate', kind: 'video', prompt: 'p', path: 'v.mp4', lane: 'xai', duration: 5 }, { action: 'generate', kind: 'video', prompt: 'p', path: 'v.mp4', lane: 'xai', duration: 99 },
    { action: 'generate', kind: 'video', prompt: 'p', path: 'v.mp4', lane: 'xai', duration: '7' }, { action: 'generate', kind: 'video', prompt: 'p', path: 'v.mp4', lane: 'xai', duration: 'soon' },
    { action: 'generate', kind: 'video', prompt: 'p', path: 'v.mp4', lane: 'gemini', duration: 6 }, { action: 'generate', kind: 'video', prompt: 'p', path: 'v.mp4', lane: 'gemini', duration: 5 },
    { action: 'generate', kind: 'video', prompt: 'p', path: 'v.mp4', lane: 'gemini', resolution: '1080p', aspect: '9:16' }, { action: 'generate', kind: 'video', prompt: 'p', path: 'v.mp4', lane: 'gemini', duration: null },
    { action: 'generate', kind: 'image', prompt: 'p', path: 'i.png', lane: 'xai', duration: 5 },
  ] },
  { name: 'references', lanes: 'full', job: { outcome: 'done', assetId: 'asset-1' }, files: [
    { path: '{root}/refs/a.png', text: PNG }, { path: '{root}/refs/b.JPG', text: 'JPGBYTES' }, { path: '{root}/refs/c.txt', text: 'text' }, { path: '{root}/refs/d.webp', text: 'WEBP' },
    { path: '{root}/refs/big.png', size: 12 * 1024 * 1024 + 1 }, { path: '{root}/refs/noext', text: 'x' },
  ], calls: [
    GEN({ lane: 'xai', references: ['{root}/refs/a.png'] }), GEN({ lane: 'xai', references: ['{root}/refs/a.png', ' {root}/refs/b.JPG ', '', null] }),
    GEN({ lane: 'xai', references: ['{root}/refs/c.txt'] }), GEN({ lane: 'xai', references: ['{root}/refs/missing.png'] }), GEN({ lane: 'xai', references: ['{root}/refs/big.png'] }),
    GEN({ lane: 'xai', references: ['{root}/refs/noext'] }), GEN({ lane: 'xai', references: '{root}/refs/a.png' }), GEN({ lane: 'xai', references: [] }),
    GEN({ lane: 'openai-oauth', references: ['{root}/refs/a.png', '{root}/refs/a.png', '{root}/refs/a.png', '{root}/refs/a.png', '{root}/refs/a.png', '{root}/refs/a.png'] }),
    GEN({ lane: 'openai-oauth', model: 'gpt-sized', references: ['{root}/refs/a.png', '{root}/refs/b.JPG', '{root}/refs/d.webp'] }),
    { action: 'generate', kind: 'video', prompt: 'p', path: 'v.mp4', lane: 'gemini', references: ['{root}/refs/a.png', '{root}/refs/b.JPG'] },
    GEN({ lane: 'openrouter', references: ['refs-relative.png'] }),
  ] },
  { name: 'generate-paths', lanes: 'full', job: { outcome: 'done', assetId: 'asset-1' }, calls: [
    GEN({ path: 'plain' }), GEN({ path: 'dir/inner/pic.jpg' }), GEN({ path: '../up/pic.png' }), GEN({ path: '{root}/abs/out.png' }), GEN({ path: 'dotted.' }), GEN({ path: '.hidden' }), GEN({ path: 'a/b.c/d' }),
  ] },
  { name: 'generate-asset-missing', lanes: 'full', job: { outcome: 'done', assetId: 'ghost' }, missingAssets: ['ghost'], calls: [GEN()] },
  // The asset is indexed but its file is gone (copyfile fails), and the target's folder is a file (mkdir fails).
  { name: 'copy-failures', lanes: 'full', job: { outcome: 'done', assetId: 'asset-nofile' }, files: [{ path: '{root}/cwd/blocker', text: 'a file' }], seeds: [
    { id: 'j-done', status: 'done', kind: 'image', lane: 'xai', model: 'm', options: {}, progress: 100, assetId: 'asset-nofile', error: null, startedAt: T0 - 9000, endedAt: T0 - 4000 },
  ], calls: [GEN(), GEN({ path: 'blocker/inner.png' }), { action: 'status', job: 'j-done', path: 'got/it.png' }, { action: 'status', job: 'j-done', path: 'blocker/x.png' }] },
  { name: 'generate-job-failed', lanes: 'full', job: { outcome: 'failed', error: 'provider said no' }, calls: [GEN(), GEN({ lane: 'xai' })] },
  { name: 'generate-job-failed-silent', lanes: 'full', job: { outcome: 'failed', error: '' }, calls: [GEN()] },
  { name: 'generate-start-error', lanes: 'full', job: { outcome: 'start-error', message: 'too many media generations are already running (4/4)', code: 'MEDIA_TOO_MANY_JOBS' }, calls: [GEN()] },
  { name: 'generate-start-error-plain', lanes: 'full', job: { outcome: 'start-error', message: 'boom' }, calls: [GEN()] },
  { name: 'generate-no-wait', lanes: 'full', job: { outcome: 'done', assetId: 'asset-1' }, calls: [GEN({ wait: false }), GEN({ wait: false, lane: 'xai', aspect: '1:1' }), GEN({ wait: 'false' }), GEN({ wait: 0 })] },
  { name: 'generate-timeout-image', lanes: 'full', job: { outcome: 'never' }, calls: [GEN()] },
  { name: 'generate-timeout-video', lanes: 'full', job: { outcome: 'never' }, calls: [{ action: 'generate', kind: 'video', prompt: 'p', path: 'v.mp4', lane: 'xai' }] },
  { name: 'generate-abort', lanes: 'full', job: { outcome: 'never' }, abortAfterGets: 1, calls: [GEN()] },
  { name: 'generate-slow-done', lanes: 'full', job: { outcome: 'done', assetId: 'asset-1', polls: 3 }, calls: [GEN()] },
  { name: 'status', lanes: 'full', seeds: [
    { id: 'j-run', status: 'running', kind: 'image', lane: 'xai', model: 'm', options: { a: 1 }, progress: 40, assetId: null, error: null, startedAt: T0 - 5000, endedAt: null },
    { id: 'j-done', status: 'done', kind: 'image', lane: 'xai', model: 'm', options: {}, progress: 100, assetId: 'asset-1', error: null, startedAt: T0 - 9000, endedAt: T0 - 4000 },
    { id: 'j-fail', status: 'failed', kind: 'video', lane: 'gemini', model: 'v', options: {}, progress: 10, assetId: null, error: 'bad', startedAt: T0 - 9000, endedAt: T0 - 8000 },
    { id: 'j-canceled', status: 'canceled', kind: 'image', lane: 'xai', model: 'm', options: {}, progress: 0, assetId: null, error: 'canceled', startedAt: T0 - 9000, endedAt: T0 - 8000 },
    { id: 'j-future', status: 'done', kind: 'image', lane: 'xai', model: 'm', options: {}, progress: 100, assetId: 'asset-1', error: null, startedAt: T0 + 50, endedAt: T0 },
  ], calls: [
    { action: 'status' }, { action: 'status', job: 'nope' }, { action: 'status', job: 'j-run' }, { action: 'status', job: ' j-done ' }, { action: 'status', job: 'j-done', path: 'got/it.png' },
    { action: 'status', job: 'j-done', path: 'got/it' }, { action: 'status', job: 'j-fail', path: 'x.png' }, { action: 'status', job: 'j-canceled' }, { action: 'status', job: 'j-future' }, { action: 'status', job: 'j-run', path: 'x.png' },
  ] },
  { name: 'cancel', lanes: 'full', seeds: [
    { id: 'j-run', status: 'running', kind: 'image', lane: 'xai', model: 'm', options: {}, progress: 40, assetId: null, error: null, startedAt: T0 - 5000, endedAt: null },
    { id: 'j-done', status: 'done', kind: 'image', lane: 'xai', model: 'm', options: {}, progress: 100, assetId: 'asset-1', error: null, startedAt: T0 - 9000, endedAt: T0 - 4000 },
  ], calls: [{ action: 'cancel' }, { action: 'cancel', job: 'nope' }, { action: 'cancel', job: 'j-done' }, { action: 'cancel', job: 'j-run' }, { action: 'cancel', job: 'j-run' }] },
];

const sub = (value, root) => (typeof value === 'string' ? value.replaceAll('{root}', root) : Array.isArray(value) ? value.map((v) => sub(v, root)) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sub(v, root)])) : value);
const sha = (data) => createHash('sha256').update(data).digest('hex');

function listing(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path).replaceAll('\\', '/');
      if (statSync(path).isDirectory()) {
        out[`${rel}/`] = null;
        walk(path);
      } else {
        const data = readFileSync(path);
        out[rel] = { size: data.length, sha256: sha(data) };
      }
    }
  };
  walk(root);
  return out;
}

const results = [];
for (const scenario of SCENARIOS) {
  const base = join(ROOT, 's', scenario.name);
  const cwd = join(base, 'cwd');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(base, 'assets'), { recursive: true });
  const root = base;
  // The scenario sees `{root}` as its own folder, so recordings of different scenarios do not share paths.
  const sc = sub(scenario, root);
  for (const asset of ['asset-1']) writeFileSync(join(base, 'assets', `${asset}.png`), `asset:${asset}`);
  for (const file of sc.files ?? []) {
    mkdirSync(join(file.path, '..'), { recursive: true });
    writeFileSync(file.path, file.size ? Buffer.alloc(file.size) : file.text);
  }
  const starts = [];
  const cancels = [];
  const scopes = [];
  const jobs = new Map();
  for (const seed of sc.seeds ?? []) jobs.set(seed.id, { job: { ...seed }, gets: 0, script: null });
  const script = sc.job ?? {};
  const controller = new AbortController();
  skew = 0;
  const lanes = LANE_SETS[sc.lanes];
  const deps = {
    lanes: {
      listMediaLanes: async () => structuredClone(lanes),
      mediaLaneAccountProvider: (lane) => sc.accountProviders?.[lane] ?? '',
    },
    accounts: {
      withProviderAccount: async (provider, account, fn) => {
        scopes.push([provider, account]);
        return await withProviderAccount(provider, account, fn);
      },
    },
    defaults: {
      getMediaDefault: (kind) => sc.remembered?.[kind] ?? null,
      getMediaPin: (kind) => sc.pins?.[kind] ?? null,
    },
    store: {
      resolveMediaFile: async (assetId) => (sc.missingAssets?.includes(assetId) ? null : { path: join(base, 'assets', `${assetId}.png`) }),
    },
    jobs: {
      startMediaJob: async (input) => {
        starts.push(structuredClone(input));
        if (script.outcome === 'start-error') throw Object.assign(new Error(script.message), script.code ? { code: script.code } : {});
        const id = `job-${starts.length}`;
        const job = { id, status: 'running', kind: input.kind, lane: input.lane, model: input.model, options: input.options, progress: 0, assetId: null, error: null, startedAt: Date.now(), endedAt: null };
        jobs.set(id, { job, gets: 0, script });
        return structuredClone(job);
      },
      getMediaJob: (id) => {
        const rec = jobs.get(id);
        if (!rec) return undefined;
        rec.gets += 1;
        const s = rec.script;
        if (s?.outcome === 'never') skew += 100_000;
        else if (s && rec.gets >= (s.polls ?? 1)) {
          if (s.outcome === 'done') Object.assign(rec.job, { status: 'done', progress: 100, assetId: s.assetId, endedAt: T0 + 1234 });
          if (s.outcome === 'failed') Object.assign(rec.job, { status: 'failed', error: s.error, endedAt: T0 + 1234 });
        }
        if (sc.abortAfterGets && rec.gets >= sc.abortAfterGets) controller.abort();
        return structuredClone(rec.job);
      },
      cancelMediaJob: (id) => {
        cancels.push(id);
        const rec = jobs.get(id);
        if (rec?.job.status !== 'running') return { id, canceled: false };
        Object.assign(rec.job, { status: 'canceled', error: 'canceled', endedAt: T0 + 500 });
        return { id, canceled: true };
      },
    },
  };
  const calls = [];
  for (const call of sc.calls) {
    const reply = await executeMediaTool(call, { cwd, signal: controller.signal, deps, sessionId: 'sess-1', sourceType: 'lead' });
    calls.push({ args: scenario.calls[calls.length], reply: JSON.parse(reply.content[0].text), isError: reply.isError === true });
  }
  results.push({ name: scenario.name, scenario: { ...scenario, calls: undefined }, calls, starts, cancels, scopes, tree: listing(base) });
}

// Where the run happened is not part of the recording: the scratch root becomes `{root}`.
const slash = (path) => path.replaceAll('\\', '/');
const norm = (text) => text.replaceAll(slash(ROOT), '{root}').replaceAll(ROOT, '{root}');
const normalize = (value) =>
  typeof value === 'string' ? norm(value) : Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)])) : value;
// A scenario's own folder is `{root}/s/<name>`; the replay lays its scenarios down the same way.
writeJson(join(FIXTURES_ROOT, 'services', 'media-tool-twin.json'), {
  domain: 'media-tool-twin',
  recorder: 'benchmarks/rust-core/recorders/record-media-tool.mjs',
  clock: T0,
  laneSets: LANE_SETS,
  scenarios: normalize(results),
});
rmSync(ROOT, { recursive: true, force: true });
console.log(`recorded ${results.length} scenarios, ${results.reduce((n, s) => n + s.calls.length, 0)} calls`);
process.exit(0);
