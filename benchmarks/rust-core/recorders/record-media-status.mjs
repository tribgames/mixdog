#!/usr/bin/env node
// Golden twin of the setup tool's `status` reader for the `media` domain: what Node's real
// `createSetupToolExecutor` answers for `{ action: 'status', domain: 'media' }` over the real media
// API (`createMediaApi`: the pins and remembered selection of `runtime/media/defaults.mjs` on a
// sandbox data dir). Each world is built by the real writers (`setMediaPin`, `setMediaDefault`) and
// the answer is recorded raw: its key order is part of the text. Rust `media::status` must answer
// the same over the same files.
//
//   node benchmarks/rust-core/recorders/record-media-status.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'media-status-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT']) {
  const directory = join(sandbox, key);
  mkdirSync(directory);
  process.env[key] = directory;
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const tree = resolveTree(parseArgs());
const { createSetupToolExecutor } = await importFrom(tree, 'src/session-runtime/setup-tool/executor.mjs');
const { createMediaApi } = await importFrom(tree, 'src/session-runtime/media-api.mjs');
const { resolvePluginData } = await importFrom(tree, 'src/runtime/shared/plugin-paths.mjs');

const long = 'x'.repeat(600);
// Each world: the pins and remembered selections to write, then (optionally) a raw defaults.json.
const WORLDS = [
  { name: 'empty' },
  { name: 'pin-image', pins: [{ kind: 'image', lane: 'xai', model: 'grok-imagine-image', account: 'work' }] },
  { name: 'pin-video-lane-default', pins: [{ kind: 'video', lane: 'gemini', model: '', account: '' }] },
  { name: 'pin-both', pins: [{ kind: 'image', lane: 'openai-oauth', model: 'gpt-image-2', account: 'a' }, { kind: 'video', lane: 'xai', model: 'grok-imagine-video', account: 'b' }] },
  { name: 'remembered-only', defaults: [{ kind: 'image', lane: 'gemini', model: 'gemini-2.5-flash-image' }, { kind: 'video', lane: 'xai', model: '' }] },
  { name: 'pin-and-remembered', pins: [{ kind: 'image', lane: 'xai', model: 'm', account: '' }], defaults: [{ kind: 'image', lane: 'gemini', model: 'g' }, { kind: 'video', lane: 'xai', model: 'v' }] },
  { name: 'pin-cleared', pins: [{ kind: 'image', lane: 'xai', model: 'm', account: 'a' }, { kind: 'image', lane: '', model: '', account: '' }] },
  { name: 'pin-replaced', pins: [{ kind: 'image', lane: 'xai', model: 'm', account: 'a' }, { kind: 'image', lane: 'gemini', model: '', account: '' }] },
  { name: 'trimmed', pins: [{ kind: ' image ', lane: '  xai ', model: ' m ', account: ' a ' }], defaults: [{ kind: 'video', lane: ' gemini ', model: ' v ' }] },
  { name: 'long-ids', pins: [{ kind: 'image', lane: long, model: long, account: long }], defaults: [{ kind: 'image', lane: long, model: long }] },
  { name: 'unicode', pins: [{ kind: 'image', lane: 'lane-日本', model: '모델 😀', account: 'ä' }] },
  { name: 'raw-not-an-object', raw: '[1,2]' },
  { name: 'raw-broken', raw: '{broken' },
  { name: 'raw-empty', raw: '' },
  { name: 'raw-null-pins', raw: JSON.stringify({ pinned: null, image: { lane: 'xai', model: 'm' } }) },
  { name: 'raw-array-pins', raw: JSON.stringify({ pinned: [1] }) },
  { name: 'raw-wrong-types', raw: JSON.stringify({ pinned: { image: { lane: 5, model: ['x'], account: {} }, video: 'x' }, image: { lane: 7 }, video: 'str' }) },
  { name: 'raw-extra-fields', raw: JSON.stringify({ pinned: { image: { lane: 'xai', model: 'm', account: 'a', extra: 1, kind: 'other' } }, image: { lane: 'gemini', model: 'g', updatedAt: 5 }, audio: { lane: 'x' } }) },
  { name: 'raw-unknown-kind-pin', raw: JSON.stringify({ pinned: { audio: { lane: 'x' } } }) },
  { name: 'raw-lane-blank', raw: JSON.stringify({ pinned: { image: { lane: '   ', model: 'm' } }, video: { lane: '', model: 'm' } }) },
];

const cases = [];
for (const world of WORLDS) {
  const dir = join(resolvePluginData(), 'media');
  rmSync(dir, { recursive: true, force: true });
  const api = createMediaApi();
  if (world.raw !== undefined) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'defaults.json'), world.raw);
  }
  for (const pin of world.pins ?? []) await api.setMediaPin(pin);
  for (const row of world.defaults ?? []) await api.setMediaDefault(row);
  const executor = createSetupToolExecutor({ getApi: () => api, getConfig: () => ({}), getSessionId: () => 'sess_a', notifySessionUi: () => false });
  const text = await executor.execute({ action: 'status', domain: 'media' }, {});
  const detailed = await executor.execute({ action: 'status', domain: 'media', detail: true }, {});
  let defaults = null;
  try {
    defaults = (await import('node:fs')).readFileSync(join(dir, 'defaults.json'), 'utf8');
  } catch {}
  cases.push({ name: world.name, defaults, text, sameWithDetail: text === detailed });
}

writeJson(join(FIXTURES_ROOT, 'services', 'media-status-twin.json'), { domain: 'media-status-twin', recorder: 'benchmarks/rust-core/recorders/record-media-status.mjs', cases });
rmSync(sandbox, { recursive: true, force: true });
console.log(`recorded ${cases.length} worlds`);
process.exit(0);
