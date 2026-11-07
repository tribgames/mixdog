#!/usr/bin/env node
// Golden twin of the xAI Imagine adapter (`adapters/xai-media.mjs`, lane `xai`): Node's real
// `generateImage` / `generateVideo` with `globalThis.fetch`, `setTimeout` and `Date.now` stubbed (the
// 4-second poll interval costs no time; the clock advances by it). Records every request (address,
// headers, body text in key order, the timeout attached to it), the progress callbacks and the result or
// error with its attached usage.
//
//   node benchmarks/rust-core/recorders/record-media-xai.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-media-xai-'));
mkdirSync(join(ROOT, 'data'), { recursive: true });
process.env.MIXDOG_DATA_DIR = join(ROOT, 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
for (const key of Object.keys(process.env)) if (/^(XAI|GROK|GEMINI|OPENROUTER|OPENAI)_API_KEY$|^MIXDOG_MODEL_PROXY$/.test(key)) delete process.env[key];
process.env.XAI_API_KEY = 'xai-key-1';
const tree = resolveTree(parseArgs());
const adapter = await importFrom(tree, 'src/runtime/media/adapters/xai-media.mjs');
const authModule = await importFrom(tree, 'src/runtime/media/auth.mjs');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const T0 = 1_700_000_000_000;
let clock = T0;
Date.now = () => clock;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  clock += ms;
  return realSetTimeout(fn, 0, ...args);
};
const timeouts = [];
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms) => (timeouts.push(ms), realTimeout(ms));

const ok = (json, status = 200) => ({ status, json });
const pending = (n) => ({ status: 202, json: { status: 'pending' }, repeat: n });
const IMG = (over = {}) => ({ kind: 'image', model: 'grok-imagine-image', prompt: 'a cat', ...over });
const VID = (over = {}) => ({ kind: 'video', model: 'grok-imagine-video', prompt: 'a cat', ...over });
const START = ok({ request_id: 'req-1' });
const SCENARIOS = [
  { name: 'image-ok', ...IMG(), script: [ok({ data: [{ b64_json: PNG, revised_prompt: 'a cute cat' }], usage: { cost_in_usd_ticks: 200000000 } })] },
  { name: 'image-mime', ...IMG(), script: [ok({ data: [{ b64_json: PNG, mime_type: 'image/jpeg' }] })] },
  { name: 'image-size', ...IMG({ options: { aspectRatio: '16:9', resolution: '2K' } }), script: [ok({ data: [{ b64_json: PNG }] })] },
  { name: 'image-size-auto', ...IMG({ options: { aspectRatio: 'auto', resolution: '4k' } }), script: [ok({ data: [{ b64_json: PNG }] })] },
  { name: 'image-size-1k-default', ...IMG({ options: { resolution: '1k' } }), script: [ok({ data: [{ b64_json: PNG }] })] },
  { name: 'image-one-ref', ...IMG({ references: [{ base64: PNG, mime: 'image/png' }] }), script: [ok({ data: [{ b64_json: PNG }] })] },
  { name: 'image-two-refs', ...IMG({ references: [{ base64: PNG }, { base64: 'data:image/webp;base64,AAAA', mime: 'x' }], options: { aspectRatio: '1:1' } }), script: [ok({ data: [{ b64_json: PNG }] })] },
  { name: 'image-no-data', ...IMG(), script: [ok({ data: [{}] })] },
  { name: 'image-body-not-json', ...IMG(), script: [{ status: 200, text: 'oops', headers: {} }] },
  { name: 'image-body-html', ...IMG(), script: [{ status: 200, text: '<!doctype html><html><body>Bad gateway</body></html>', headers: {} }] },
  { name: 'image-body-truncated', ...IMG(), script: [{ status: 200, text: '{"data":[{"b64_json":"AAAA', headers: {} }] },
  { name: 'image-no-array', ...IMG(), script: [ok({})] },
  { name: 'image-http-401', ...IMG(), script: [{ status: 401, text: 'nope' }] },
  { name: 'image-http-402', ...IMG(), script: [{ status: 402, text: '{"error":"Insufficient credits"}' }] },
  { name: 'image-http-429', ...IMG(), script: [{ status: 429, text: '' }] },
  { name: 'image-http-500', ...IMG(), script: [{ status: 500, text: '<html>x</html>' }] },
  { name: 'image-bad-b64', ...IMG(), script: [ok({ data: [{ b64_json: '!!' }] })] },
  { name: 'image-fetch-fails', ...IMG(), script: [{ fail: 'fetch failed' }] },
  { name: 'image-timeout', ...IMG(), script: [{ fail: 'The operation was aborted due to timeout', name: 'TimeoutError' }] },
  { name: 'video-done-private-url', ...VID(), script: [START, ok({ status: 'done', video: { url: 'http://127.0.0.1/v.mp4', duration: 6 }, usage: { cost_in_usd_ticks: 5e9 }, progress: 100 })] },
  { name: 'video-defaults', ...VID(), script: [START, ok({ status: 'done', video: { url: 'http://127.0.0.1/v.mp4' } })] },
  { name: 'video-options', ...VID({ options: { duration: '30', resolution: '720p', aspectRatio: '9:16' } }), script: [START, ok({ status: 'done', video: { url: 'http://127.0.0.1/v.mp4', duration: 15 } })] },
  { name: 'video-options-low', ...VID({ options: { duration: 0.4, resolution: '4k', aspectRatio: 'auto' } }), script: [START, ok({ status: 'done', video: { url: 'http://127.0.0.1/v.mp4', duration: 0 } })] },
  { name: 'video-options-1080', ...VID({ options: { duration: 'x', resolution: '1080p' } }), script: [START, ok({ status: 'done', video: { url: 'http://127.0.0.1/v.mp4', duration: '8' } })] },
  { name: 'video-one-ref', ...VID({ references: [{ base64: PNG }] }), script: [START, ok({ status: 'done', video: { url: 'http://127.0.0.1/v.mp4' } })] },
  { name: 'video-many-refs', ...VID({ references: Array.from({ length: 9 }, (_, i) => ({ base64: `data:image/png;base64,R${i}` })) }), script: [START, ok({ status: 'done', video: { url: 'http://127.0.0.1/v.mp4' } })] },
  { name: 'video-id-fallback', ...VID(), script: [ok({ id: 'alt-id' }), ok({ status: 'done', video: { url: 'http://127.0.0.1/v.mp4' } })] },
  { name: 'video-start-not-json', ...VID(), script: [{ status: 200, text: 'Internal Server Error', headers: {} }] },
  { name: 'video-no-id', ...VID(), script: [ok({})] },
  { name: 'video-start-402', ...VID(), script: [{ status: 402, text: '{"error":{"message":"Billing limit"}}' }] },
  { name: 'video-polls-then-done', ...VID(), script: [START, pending(3), ok({ status: 'done', video: { url: 'http://127.0.0.1/v.mp4' }, progress: 100 })] },
  { name: 'video-progress', ...VID(), script: [START, ok({ status: 'processing', progress: 30 }), ok({ status: 'processing', progress: 'half' }), ok({ status: 'processing', progress: 80 }), ok({ status: 'done', video: { url: 'http://127.0.0.1/v.mp4' } })] },
  { name: 'video-no-url', ...VID(), script: [START, ok({ status: 'done', video: {}, usage: { cost_in_usd_ticks: 1e10 } })] },
  { name: 'video-failed-code', ...VID(), script: [START, ok({ status: 'failed', error: { code: 'moderation' }, usage: { cost_in_usd_ticks: 1e9 } })] },
  { name: 'video-failed', ...VID(), script: [START, ok({ status: 'failed' })] },
  { name: 'video-expired', ...VID(), script: [START, ok({ status: 'expired' })] },
  { name: 'video-poll-500', ...VID(), script: [START, { status: 500, text: 'down' }] },
  { name: 'video-poll-401', ...VID(), script: [START, { status: 401, text: '' }] },
  { name: 'video-poll-not-json', ...VID(), script: [START, { status: 200, text: 'garbage' }, ok({ status: 'done', video: { url: 'http://127.0.0.1/v.mp4' } })] },
  { name: 'video-poll-timeout', ...VID(), script: [START, { fail: 'The operation was aborted due to timeout', name: 'TimeoutError' }] },
  { name: 'video-budget', ...VID(), script: [START, pending(300)] },
  { name: 'video-canceled-first', ...VID(), abortAfterFetches: 1, script: [START, pending(5)] },
  { name: 'video-canceled-later', ...VID(), abortAfterFetches: 4, script: [START, pending(9)] },
];

const results = [];
const realFetch = globalThis.fetch;
for (const scenario of SCENARIOS) {
  clock = T0;
  timeouts.length = 0;
  const sent = [];
  const queue = scenario.script.flatMap((entry) => Array.from({ length: entry.repeat ?? 1 }, () => entry));
  const controller = new AbortController();
  globalThis.fetch = async (url, init) => {
    const timeout = timeouts.splice(0);
    sent.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ?? null, timeoutMs: timeout.length ? timeout[0] : null, signal: init?.signal != null });
    if (scenario.abortAfterFetches && sent.length >= scenario.abortAfterFetches) controller.abort();
    const entry = queue.shift();
    if (!entry) throw new Error('unscripted fetch');
    if (entry.fail) {
      const error = new Error(entry.fail);
      if (entry.name) error.name = entry.name;
      throw error;
    }
    return new Response(entry.json !== undefined ? JSON.stringify(entry.json) : entry.text, { status: entry.status });
  };
  const auth = await authModule.resolveXaiAuth('xai');
  const progress = [];
  const args = { lane: 'xai', model: scenario.model, prompt: scenario.prompt, options: scenario.options ?? {}, references: scenario.references ?? [], signal: controller.signal };
  let outcome;
  try {
    const result = scenario.kind === 'image' ? await adapter.generateImage(args) : await adapter.generateVideo({ ...args, onProgress: (value) => progress.push(value) });
    outcome = { value: { bytes: Buffer.from(result.bytes).toString('hex'), mime: result.mime, revisedPrompt: result.revisedPrompt, durationSeconds: result.durationSeconds, usage: result.usage ?? null } };
  } catch (error) {
    outcome = { error: { message: error.message, code: error.code ?? null, status: error.status ?? null, usage: error.usage ?? null } };
  }
  results.push({ name: scenario.name, kind: scenario.kind, model: scenario.model, prompt: scenario.prompt, options: scenario.options ?? {}, references: scenario.references ?? [], abortAfterFetches: scenario.abortAfterFetches ?? null, auth: { token: auth.token, baseURL: auth.baseURL }, script: scenario.script, sent, progress, elapsedMs: clock - T0, ...outcome });
}
globalThis.fetch = realFetch;

writeJson(join(FIXTURES_ROOT, 'services', 'media-xai-twin.json'), { domain: 'media-xai-twin', recorder: 'benchmarks/rust-core/recorders/record-media-xai.mjs', clock: T0, scenarios: results });
rmSync(ROOT, { recursive: true, force: true });
console.log(`recorded ${results.length} scenarios`);
process.exit(0);
