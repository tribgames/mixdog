#!/usr/bin/env node
// Golden twin of a media lane's catalog request and its cache file: Node's real
// `fetchMediaModelRows` / `mediaCatalogTimeoutMs` (catalog.mjs) over a scripted `fetchFn`, and
// `makeModelCache` (model-cache.mjs) configured as `sourceCache` does, on a scratch data folder
// and a scripted clock. Records the requests made (url, headers, redirect rule), the rows or the
// failure (message, code, status), the cache file's bytes and what every load answers. Rust
// `media::catalog_fetch` must answer the same.
//
//   node benchmarks/rust-core/recorders/record-media-catalog-fetch.mjs --tree <dir>
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-media-fetch-'));
const DATA = join(ROOT, 'data');
mkdirSync(DATA, { recursive: true });
process.env.MIXDOG_DATA_DIR = DATA;
const tree = resolveTree(parseArgs());
const { fetchMediaModelRows, mediaCatalogTimeoutMs } = await importFrom(tree, 'src/runtime/media/catalog.mjs');
const { makeModelCache, flushModelCacheWrites } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/model-cache.mjs');

const T0 = 1_700_000_000_000;
let clock = T0;
Date.now = () => clock;

// ── the catalog request ──
const json = (body, status = 200) => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });
const FETCHES = [
  { name: 'gemini-two-pages', lane: 'gemini', auth: { token: 'g-key' }, replies: [json({ models: [{ name: 'models/a' }], nextPageToken: 'next page/1+x' }), json({ models: [{ name: 'models/b' }, { name: 'models/c' }] })] },
  { name: 'gemini-one-page', lane: 'gemini', auth: { token: 'g-key' }, replies: [json({ models: [], nextPageToken: 7 })] },
  { name: 'gemini-invalid', lane: 'gemini', auth: { token: 'g-key' }, replies: [json({ items: [] })] },
  { name: 'gemini-401', lane: 'gemini', auth: { token: 'bad' }, replies: [json('denied', 401)] },
  { name: 'gemini-second-page-429', lane: 'gemini', auth: { token: 'g-key' }, replies: [json({ models: [{ name: 'models/a' }], nextPageToken: 't' }), json('slow down', 429)] },
  { name: 'xai-ok', lane: 'xai', auth: { baseURL: 'https://api.x.ai/v1', token: 'x-key' }, replies: [json({ data: [{ id: 'grok-imagine-image' }] })] },
  { name: 'grok-oauth-403', lane: 'grok-oauth', auth: { baseURL: 'https://api.x.ai/v1', token: 'tok' }, replies: [json('no', 403)] },
  { name: 'xai-invalid', lane: 'xai', auth: { baseURL: 'https://api.x.ai/v1', token: 'x-key' }, replies: [json({ data: { id: 1 } })] },
  { name: 'xai-null-data', lane: 'xai', auth: { baseURL: 'https://api.x.ai/v1', token: 'x-key' }, replies: [json('null')] },
  { name: 'xai-500', lane: 'xai', auth: { baseURL: 'https://api.x.ai/v1', token: 'x-key' }, replies: [json('boom', 500)] },
  { name: 'xai-504', lane: 'xai', auth: { baseURL: 'https://api.x.ai/v1', token: 'x-key' }, replies: [json('', 504)] },
  { name: 'xai-408', lane: 'xai', auth: { baseURL: 'https://api.x.ai/v1', token: 'x-key' }, replies: [json('', 408)] },
  { name: 'xai-billing-text', lane: 'xai', auth: { baseURL: 'https://api.x.ai/v1', token: 'x-key' }, replies: [json('You have exceeded your spending limit', 400)] },
  { name: 'xai-billing-402', lane: 'xai', auth: { baseURL: 'https://api.x.ai/v1', token: 'x-key' }, replies: [json('Payment Required', 402)] },
  { name: 'openrouter-ok', lane: 'openrouter', auth: { baseURL: 'https://openrouter.ai/api/v1', token: 'or-key' }, replies: [json({ data: [{ id: 'flux-1' }] })] },
  { name: 'nano-gpt-ok', lane: 'nano-gpt', auth: { baseURL: 'https://api.nano-gpt.com/api/v1', token: 'ng-key' }, replies: [json({ data: [] })] },
  { name: 'nano-gpt-network', lane: 'nano-gpt', auth: { baseURL: 'https://api.nano-gpt.com/api/v1', token: 'ng-key' }, replies: [{ throws: 'fetch failed' }] },
];
const fetches = [];
for (const spec of FETCHES) {
  const calls = [];
  const queue = [...spec.replies];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? null, redirect: init.redirect ?? null, hasSignal: Boolean(init.signal), hasDispatcher: Boolean(init.dispatcher) });
    const next = queue.shift();
    if (next.throws) throw new TypeError(next.throws);
    return { ok: next.status >= 200 && next.status < 300, status: next.status, text: async () => next.body, json: async () => JSON.parse(next.body) };
  };
  let outcome;
  try {
    outcome = { rows: await fetchMediaModelRows({ lane: spec.lane, auth: spec.auth, fetchFn }) };
  } catch (error) {
    outcome = { error: { message: error.message, code: error.code ?? null, status: error.status ?? null } };
  }
  fetches.push({ ...spec, ...outcome, calls });
}
const timeouts = Object.fromEntries(['gemini', 'xai', 'grok-oauth', 'openai-oauth', 'openrouter', 'nano-gpt', 'antigravity-oauth', 'bogus'].map((lane) => [lane, mediaCatalogTimeoutMs(lane)]));

// ── the cache file ──
const cacheOf = (key, stale = false) => makeModelCache({ fileName: `studio-models-${key}.json`, ttlMs: stale ? Infinity : 24 * 60 * 60_000, version: 1 });
const file = (key) => join(DATA, `studio-models-${key}.json`);
const HOUR = 3_600_000;
const STEPS = [
  { op: 'save', key: 'k1', at: 0, rows: [{ id: 'a' }, { id: 'b', n: 1 }] },
  { op: 'load', key: 'k1', at: 0 },
  { op: 'load', key: 'k1', at: 24 * HOUR },
  { op: 'load', key: 'k1', at: 24 * HOUR + 1 },
  { op: 'load', key: 'k1', at: 24 * HOUR + 1, stale: true },
  { op: 'load', key: 'k1', at: -HOUR },
  { op: 'load', key: 'missing', at: 0 },
  { op: 'save', key: 'k1', at: 30 * HOUR, rows: [] },
  { op: 'load', key: 'k1', at: 30 * HOUR },
  { op: 'raw', key: 'old-version', text: JSON.stringify({ version: 2, fetchedAt: T0, models: [{ id: 'x' }] }) },
  { op: 'load', key: 'old-version', at: 0 },
  { op: 'load', key: 'old-version', at: 0, stale: true },
  { op: 'raw', key: 'no-version', text: JSON.stringify({ fetchedAt: T0, models: [{ id: 'x' }] }) },
  { op: 'load', key: 'no-version', at: 0, stale: true },
  { op: 'raw', key: 'zero-time', text: JSON.stringify({ version: 1, fetchedAt: 0, models: [{ id: 'x' }] }) },
  { op: 'load', key: 'zero-time', at: 0, stale: true },
  { op: 'raw', key: 'string-time', text: JSON.stringify({ version: 1, fetchedAt: String(T0), models: [{ id: 'x' }] }) },
  { op: 'load', key: 'string-time', at: 0 },
  { op: 'load', key: 'string-time', at: 25 * HOUR },
  { op: 'raw', key: 'models-object', text: JSON.stringify({ version: 1, fetchedAt: T0, models: { id: 'x' } }) },
  { op: 'load', key: 'models-object', at: 0, stale: true },
  { op: 'raw', key: 'garbage', text: '{not json' },
  { op: 'load', key: 'garbage', at: 0, stale: true },
  { op: 'raw', key: 'empty', text: '' },
  { op: 'load', key: 'empty', at: 0, stale: true },
  { op: 'raw', key: 'extra-fields', text: JSON.stringify({ version: 1, fetchedAt: T0, requestedAt: T0, models: [{ id: 'x' }] }) },
  { op: 'load', key: 'extra-fields', at: 0 },
];
const cache = [];
for (const step of STEPS) {
  clock = T0 + (step.at ?? 0);
  if (step.op === 'raw') writeFileSync(file(step.key), step.text);
  let result = null;
  if (step.op === 'save') {
    cacheOf(step.key).save(step.rows);
    await flushModelCacheWrites();
  } else if (step.op === 'load') {
    result = cacheOf(step.key, step.stale === true).loadSync();
  }
  let text = null;
  try {
    text = readFileSync(file(step.key), 'utf8');
  } catch {}
  cache.push({ step, result, file: step.op === 'load' ? undefined : text });
}

const normalize = (text) => text.replaceAll('\\', '/').replaceAll(DATA.replaceAll('\\', '/'), '{data}');
writeJson(join(FIXTURES_ROOT, 'services', 'media-catalog-fetch-twin.json'), {
  domain: 'media-catalog-fetch-twin',
  recorder: 'benchmarks/rust-core/recorders/record-media-catalog-fetch.mjs',
  clock: T0,
  timeouts,
  fetches,
  cache,
  cachePath: normalize(cacheOf('k1').path()),
});
rmSync(ROOT, { recursive: true, force: true });
console.log(`recorded ${fetches.length} fetches, ${cache.length} cache steps`);
process.exit(0);
