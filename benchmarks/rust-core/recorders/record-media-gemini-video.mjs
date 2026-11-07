#!/usr/bin/env node
// Golden twin of the xAI Imagine adapter (`adapters/gemini-video.mjs`, lane `xai`): Node's real
// `generateImage` / `generateVideo` with `globalThis.fetch`, `setTimeout` and `Date.now` stubbed (the
// 4-second poll interval costs no time; the clock advances by it). Records every request (address,
// headers, body text in key order, the timeout attached to it), the progress callbacks and the result or
// error with its attached usage.
//
//   node benchmarks/rust-core/recorders/record-media-gemini-video.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-media-gemini-video-'));
mkdirSync(join(ROOT, 'data'), { recursive: true });
process.env.MIXDOG_DATA_DIR = join(ROOT, 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
for (const key of Object.keys(process.env)) if (/^(XAI|GROK|GEMINI|OPENROUTER|OPENAI)_API_KEY$|^MIXDOG_MODEL_PROXY$/.test(key)) delete process.env[key];
process.env.GEMINI_API_KEY = 'gem-key-1';
const tree = resolveTree(parseArgs());
const adapter = await importFrom(tree, 'src/runtime/media/adapters/gemini-video.mjs');

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
const pending = (n) => ({ status: 200, json: { done: false }, repeat: n });
const URI = 'https://evil.example.test/v.mp4';
const V = (over = {}) => ({ model: 'veo-3.1-generate-preview', prompt: 'a cat', options: {}, references: [], ...over });
const O = (over = {}) => ({ model: 'gemini-omni-flash', prompt: 'a cat', options: {}, references: [], ...over });
const OP = ok({ name: 'operations/op-1' });
const doneWith = (uri, extra = {}) => ok({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } }, ...extra });
const MP4 = Buffer.from('000000206674797069736f6d', 'hex').toString('base64');
const stepVideo = (data = MP4, extra = {}) => ({ content: [{ type: 'video', data, ...extra }] });
const SCENARIOS = [
  { name: 'omni-ok', ...O(), script: [ok({ steps: [stepVideo()], usage: { total_input_tokens: 5, total_output_tokens: 300, output_tokens_by_modality: [{ modality: 'video', tokens: 280 }] } })] },
  { name: 'omni-mime', ...O(), script: [ok({ steps: [stepVideo(MP4, { mime_type: 'video/webm' })] })] },
  { name: 'omni-single-content', ...O(), script: [ok({ steps: [{ content: { type: 'video', data: MP4 } }] })] },
  { name: 'omni-second-step', ...O(), script: [ok({ steps: [{ content: [{ type: 'text', text: 'hi' }] }, null, stepVideo()] })] },
  { name: 'omni-aspect', ...O({ options: { aspectRatio: '9:16' } }), script: [ok({ steps: [stepVideo()] })] },
  { name: 'omni-aspect-auto', ...O({ options: { aspectRatio: 'auto' } }), script: [ok({ steps: [stepVideo()] })] },
  { name: 'omni-refs', ...O({ references: [{ base64: 'cmVm', mime: 'image/jpeg' }, { base64: 'cmVm2' }] }), script: [ok({ steps: [stepVideo()] })] },
  { name: 'omni-model-upper', ...O({ model: 'GEMINI-OMNI-X' }), script: [ok({ steps: [stepVideo()] })] },
  { name: 'omni-no-video', ...O(), script: [ok({ steps: [{ content: [{ type: 'text', text: 'no' }] }], usage: { total_input_tokens: 4 } })] },
  { name: 'omni-no-steps', ...O(), script: [ok({})] },
  { name: 'omni-data-not-string', ...O(), script: [ok({ steps: [{ content: [{ type: 'video', data: 5 }] }] })] },
  { name: 'omni-bad-b64', ...O(), script: [ok({ steps: [stepVideo('!!')] })] },
  { name: 'omni-http-402', ...O(), script: [{ status: 402, text: '{"error":{"message":"billing"}}' }] },
  { name: 'omni-http-500', ...O(), script: [{ status: 500, text: '' }] },
  { name: 'omni-not-json', ...O(), script: [{ status: 200, text: 'oops' }] },
  { name: 'omni-fetch-fails', ...O(), script: [{ fail: 'fetch failed' }] },
  { name: 'veo-untrusted-uri', ...V(), script: [OP, doneWith(URI)] },
  { name: 'veo-invalid-uri', ...V(), script: [OP, doneWith('nope')] },
  { name: 'veo-usage-from-options', ...V({ options: { duration: 6, resolution: '1080p', aspectRatio: '9:16' } }), script: [OP, doneWith(URI)] },
  { name: 'veo-usage-720', ...V({ options: { duration: '4', resolution: '720p' } }), script: [OP, doneWith(URI)] },
  { name: 'veo-duration-dropped', ...V({ options: { duration: 5, resolution: '480p' } }), script: [OP, doneWith(URI)] },
  { name: 'veo-aspect-auto', ...V({ options: { aspectRatio: 'auto' } }), script: [OP, doneWith(URI)] },
  { name: 'veo-ref', ...V({ references: [{ base64: 'cmVm', mime: 'image/jpeg' }, { base64: 'ignored' }] }), script: [OP, doneWith(URI)] },
  { name: 'veo-ref-no-mime', ...V({ references: [{ base64: 'cmVm' }] }), script: [OP, doneWith(URI)] },
  { name: 'veo-model-encoded', ...V({ model: 'veo 3/x' }), script: [OP, doneWith(URI)] },
  { name: 'veo-file-uri', ...V(), script: [OP, ok({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { fileUri: URI } }] } } })] },
  { name: 'veo-generated-videos', ...V(), script: [OP, ok({ done: true, response: { generatedVideos: [{ video: { uri: URI } }] } })] },
  { name: 'veo-no-uri', ...V(), script: [OP, ok({ done: true, response: { generateVideoResponse: { generatedSamples: [{}] } } })] },
  { name: 'veo-no-response', ...V(), script: [OP, ok({ done: true })] },
  { name: 'veo-error', ...V(), script: [OP, ok({ done: true, error: { message: 'content blocked' } })] },
  { name: 'veo-error-no-message', ...V(), script: [OP, ok({ done: true, error: {} })] },
  { name: 'veo-polls-then-done', ...V(), script: [OP, pending(3), doneWith(URI)] },
  { name: 'veo-no-operation', ...V(), script: [ok({})] },
  { name: 'veo-start-400', ...V(), script: [{ status: 400, text: '{"error":{"message":"bad"}}' }] },
  { name: 'veo-start-not-json', ...V(), script: [{ status: 200, text: '<html>' }] },
  { name: 'veo-poll-500', ...V(), script: [OP, { status: 500, text: 'down' }] },
  { name: 'veo-poll-not-json', ...V(), script: [OP, { status: 200, text: 'garbage' }] },
  { name: 'veo-poll-timeout', ...V(), script: [OP, { fail: 'The operation was aborted due to timeout', name: 'TimeoutError' }] },
  { name: 'veo-budget', ...V(), script: [OP, pending(200)] },
  { name: 'veo-canceled-first', ...V(), abortAfterFetches: 1, script: [OP, pending(5)] },
  { name: 'veo-canceled-later', ...V(), abortAfterFetches: 4, script: [OP, pending(9)] },
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
  const progress = [];
  let outcome;
  try {
    const result = await adapter.generateVideo({ model: scenario.model, prompt: scenario.prompt, options: scenario.options, references: scenario.references, signal: controller.signal, onProgress: (value) => progress.push(value) });
    outcome = { value: { bytes: Buffer.from(result.bytes).toString('hex'), mime: result.mime, usage: result.usage ?? null } };
  } catch (error) {
    outcome = { error: { message: error.message, code: error.code ?? null, status: error.status ?? null, usage: error.usage ?? null } };
  }
  results.push({ name: scenario.name, model: scenario.model, prompt: scenario.prompt, options: scenario.options, references: scenario.references, abortAfterFetches: scenario.abortAfterFetches ?? null, script: scenario.script, sent, progress, elapsedMs: clock - T0, ...outcome });
}
globalThis.fetch = realFetch;

writeJson(join(FIXTURES_ROOT, 'services', 'media-gemini-video-twin.json'), { domain: 'media-gemini-video-twin', recorder: 'benchmarks/rust-core/recorders/record-media-gemini-video.mjs', clock: T0, scenarios: results });
rmSync(ROOT, { recursive: true, force: true });
console.log(`recorded ${results.length} scenarios`);
process.exit(0);