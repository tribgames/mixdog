#!/usr/bin/env node
// Golden twin of the Image API adapter (`adapters/image-api.mjs`, the OpenRouter and NanoGPT lanes):
// Node's real `generateImage` with the network stubbed at `globalThis.fetch`. Records, per scenario,
// what was sent (address, headers, body text with its key order, redirect mode, whether a timeout was
// attached) and what came back (bytes, mime, revised prompt and reported usage, or the error with its
// message, code, status and attached usage). The credentials are Node's own `resolveImageApiAuth`.
//
//   node benchmarks/rust-core/recorders/record-media-image-api.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-media-imageapi-'));
const DATA = join(ROOT, 'data');
mkdirSync(DATA, { recursive: true });
process.env.MIXDOG_DATA_DIR = DATA;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
for (const key of Object.keys(process.env)) if (/^(XAI|GROK|GEMINI|OPENROUTER|OPENAI)_API_KEY$|^MIXDOG_MODEL_PROXY$/.test(key)) delete process.env[key];
process.env.OPENROUTER_API_KEY = 'or-key-1';
writeFileSync(join(DATA, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-nano': { type: 'custom', baseURL: 'https://nano-gpt.com/api/v1', apiKey: 'ng-key-1' } } } }));
const tree = resolveTree(parseArgs());
const adapter = await importFrom(tree, 'src/runtime/media/adapters/image-api.mjs');
const authModule = await importFrom(tree, 'src/runtime/media/auth.mjs');

const PNG = '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd400000000 49454e44ae426082'.replace(' ', '');
const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64');
const PNG64 = b64(PNG);
const JPEG64 = b64('ffd8ffe000104a464946');
const WEBP64 = b64(`52494646${'00000000'}57454250${'00'.repeat(4)}`);
const GIF64 = b64('47494638396101000100');
const ok = (body) => ({ status: 200, json: body });
const SCENARIOS = [
  { name: 'openrouter-b64', lane: 'openrouter', model: 'google/gemini-image', prompt: 'a cat', reply: ok({ data: [{ b64_json: PNG64, revised_prompt: 'a cute cat' }], usage: { prompt_tokens: 5, completion_tokens: 1290, completion_tokens_details: { image_tokens: 1290 }, cost: 0.039 } }) },
  { name: 'nano-b64-xno-cost', lane: 'nano-gpt', model: 'flux', prompt: 'p', reply: ok({ data: [{ b64_json: JPEG64 }], cost: 0.5, paymentSource: 'XNO' }) },
  { name: 'nano-b64-usd-cost', lane: 'nano-gpt', model: 'flux', prompt: 'p', reply: ok({ data: [{ b64_json: WEBP64 }], cost: 0.5, paymentSource: 'USD' }) },
  { name: 'options-all', lane: 'openrouter', model: 'm', prompt: 'p', options: { aspectRatio: ' 16:9 ', resolution: '2K', quality: 'high', background: 'transparent', ignored: 'x' }, reply: ok({ data: [{ b64_json: PNG64 }] }) },
  { name: 'options-blank', lane: 'openrouter', model: 'm', prompt: 'p', options: { aspectRatio: '   ', resolution: '', quality: null, background: 0 }, reply: ok({ data: [{ b64_json: PNG64 }] }) },
  { name: 'options-numbers', lane: 'openrouter', model: 'm', prompt: 'p', options: { resolution: 2, quality: true }, reply: ok({ data: [{ b64_json: PNG64 }] }) },
  { name: 'references', lane: 'openrouter', model: 'm', prompt: 'p', references: [{ base64: PNG64, mime: 'image/png' }, { base64: 'data:image/jpeg;base64,/9j/', mime: 'image/png' }, { base64: PNG64 }, { base64: '', mime: 'image/webp' }, {}], reply: ok({ data: [{ b64_json: PNG64 }] }) },
  { name: 'unicode-prompt', lane: 'openrouter', model: 'm', prompt: '고양이 🐈 "quoted" \\ line\nbreak', reply: ok({ data: [{ b64_json: PNG64 }] }) },
  { name: 'unsupported-format', lane: 'openrouter', model: 'm', prompt: 'p', reply: ok({ data: [{ b64_json: GIF64 }], usage: { prompt_tokens: 3, cost: 0.01 } }) },
  { name: 'unsupported-no-usage', lane: 'openrouter', model: 'm', prompt: 'p', reply: ok({ data: [{ b64_json: GIF64 }] }) },
  { name: 'short-bytes', lane: 'openrouter', model: 'm', prompt: 'p', reply: ok({ data: [{ b64_json: b64('89504e47') }] }) },
  { name: 'bad-b64', lane: 'openrouter', model: 'm', prompt: 'p', reply: ok({ data: [{ b64_json: '!!!' }], usage: { completion_tokens: 4 } }) },
  { name: 'no-data', lane: 'openrouter', model: 'm', prompt: 'p', reply: ok({ data: [], usage: { prompt_tokens: 9 } }) },
  { name: 'data-not-array', lane: 'openrouter', model: 'm', prompt: 'p', reply: ok({ data: { b64_json: PNG64 } }) },
  { name: 'entry-empty', lane: 'openrouter', model: 'm', prompt: 'p', reply: ok({ data: [{}] }) },
  { name: 'entry-null', lane: 'openrouter', model: 'm', prompt: 'p', reply: ok({ data: [null] }) },
  { name: 'body-not-json', lane: 'openrouter', model: 'm', prompt: 'p', reply: { status: 200, text: 'oops' } },
  { name: 'body-null', lane: 'openrouter', model: 'm', prompt: 'p', reply: { status: 200, text: 'null' } },
  { name: 'url-private', lane: 'nano-gpt', model: 'm', prompt: 'p', reply: ok({ data: [{ url: 'http://127.0.0.1/a.png' }], cost: 0.2, paymentSource: 'USD' }) },
  { name: 'url-metadata', lane: 'nano-gpt', model: 'm', prompt: 'p', reply: ok({ data: [{ url: 'http://169.254.169.254/x' }] }) },
  { name: 'b64-wins-over-url', lane: 'nano-gpt', model: 'm', prompt: 'p', reply: ok({ data: [{ b64_json: PNG64, url: 'http://127.0.0.1/a.png' }] }) },
  { name: 'http-401', lane: 'openrouter', model: 'm', prompt: 'p', reply: { status: 401, text: '{"error":{"message":"bad key"}}' } },
  { name: 'http-402', lane: 'openrouter', model: 'm', prompt: 'p', reply: { status: 402, text: '{"error":{"message":"Insufficient credits"}}' } },
  { name: 'http-429', lane: 'nano-gpt', model: 'm', prompt: 'p', reply: { status: 429, text: 'slow down' } },
  { name: 'http-500-html', lane: 'openrouter', model: 'm', prompt: 'p', reply: { status: 500, text: '<html>bad gateway</html>' } },
  { name: 'http-500-long', lane: 'openrouter', model: 'm', prompt: 'p', reply: { status: 500, text: 'é'.repeat(500) } },
  { name: 'http-400-json', lane: 'nano-gpt', model: 'm', prompt: 'p', reply: { status: 400, text: '{"message":"prompt rejected"}' } },
  { name: 'redirect', lane: 'openrouter', model: 'm', prompt: 'p', reply: { fail: 'fetch failed' } },
  { name: 'timeout', lane: 'openrouter', model: 'm', prompt: 'p', reply: { fail: 'The operation was aborted due to timeout', name: 'TimeoutError' } },
  { name: 'timeout-nano', lane: 'nano-gpt', model: 'm', prompt: 'p', reply: { fail: 'The operation was aborted due to timeout', name: 'TimeoutError' } },
  { name: 'aborted', lane: 'openrouter', model: 'm', prompt: 'p', reply: { fail: 'This operation was aborted', name: 'AbortError' } },
  { name: 'unknown-lane-label', lane: 'nano-gpt', model: 'm', prompt: 'p', reply: { status: 503, text: '' } },
];

const realFetch = globalThis.fetch;
const results = [];
for (const scenario of SCENARIOS) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ?? null, redirect: init?.redirect ?? null, timeout: init?.signal != null });
    const { reply } = scenario;
    if (reply.fail) {
      const error = new Error(reply.fail);
      if (reply.name) error.name = reply.name;
      throw error;
    }
    return new Response(reply.json !== undefined ? JSON.stringify(reply.json) : reply.text, { status: reply.status });
  };
  const auth = authModule.resolveImageApiAuth(scenario.lane);
  let outcome;
  try {
    const result = await adapter.generateImage({ lane: scenario.lane, model: scenario.model, prompt: scenario.prompt, options: scenario.options, references: scenario.references ?? [] });
    outcome = { value: { bytes: Buffer.from(result.bytes).toString('hex'), mime: result.mime, revisedPrompt: result.revisedPrompt, usage: result.usage ?? null } };
  } catch (error) {
    outcome = { error: { message: error.message, code: error.code ?? null, status: error.status ?? null, usage: error.usage ?? null } };
  }
  results.push({ name: scenario.name, lane: scenario.lane, model: scenario.model, prompt: scenario.prompt, options: scenario.options ?? null, references: scenario.references ?? [], auth: { token: auth.token, baseURL: auth.baseURL }, reply: scenario.reply, sent, ...outcome });
}
globalThis.fetch = realFetch;

writeJson(join(FIXTURES_ROOT, 'services', 'media-image-api-twin.json'), { domain: 'media-image-api-twin', recorder: 'benchmarks/rust-core/recorders/record-media-image-api.mjs', scenarios: results });
rmSync(ROOT, { recursive: true, force: true });
console.log(`recorded ${results.length} scenarios`);
process.exit(0);
