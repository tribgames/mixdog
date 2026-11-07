#!/usr/bin/env node
// Golden twin of the Antigravity image adapter (`adapters/antigravity-image.mjs`, lane
// `antigravity-oauth`): Node's real `generateImage` with `fetchFn` and `resolveAuth` injected and
// `crypto.randomUUID` replaced by a counter (the two ids the request carries are random). Records every
// request (address, headers, body text in key order, redirect mode, timeout attached) and the result or
// error with its attached usage; also `antigravityImageParts` over SSE bodies.
//
//   node benchmarks/rust-core/recorders/record-media-antigravity-image.mjs --tree <dir>
import { createRequire } from 'node:module';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-media-agy-'));
mkdirSync(join(ROOT, 'data'), { recursive: true });
process.env.MIXDOG_DATA_DIR = join(ROOT, 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_ANTIGRAVITY_VERSION = '1.0.0';
const tree = resolveTree(parseArgs());
const adapter = await importFrom(tree, 'src/runtime/media/adapters/antigravity-image.mjs');
const tokens = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/antigravity-oauth-tokens.mjs');

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
createRequire(import.meta.url)('node:crypto').randomUUID = uuid;
syncBuiltinESMExports();

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const part = () => ({ inlineData: { mimeType: 'image/png', data: PNG } });
const chunk = (parts, extra = {}) => frame({ response: { candidates: [{ content: { parts } }], ...extra } });
const sse = (...frames) => ({ status: 200, text: frames.join('') });
const A = (over = {}) => ({ model: 'gemini-3-pro-image', prompt: 'a red circle', options: {}, references: [], ...over });
const SCENARIOS = [
  { name: 'ok', ...A(), reply: sse(chunk([part()])) },
  { name: 'ok-usage-cumulative', ...A(), reply: sse(chunk([{ text: 'x' }], { usageMetadata: { promptTokenCount: 3 } }), chunk([part()], { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1290 } })) },
  { name: 'ok-unwrapped-chunk', ...A(), reply: sse(frame({ candidates: [{ content: { parts: [part()] } }] })) },
  { name: 'ok-aspect-refs', ...A({ options: { aspectRatio: '16:9' }, references: [{ base64: 'cmVm', mime: 'image/jpeg' }] }), reply: sse(chunk([part()])) },
  { name: 'ok-crlf-comments', ...A(), reply: { status: 200, text: `: ping\r\nevent: message\r\ndata: ${JSON.stringify({ response: { candidates: [{ content: { parts: [part()] } }] } })}\r\n\r\n` } },
  { name: 'ok-no-trailing-newline', ...A(), reply: { status: 200, text: `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [part()] } }] } })}` } },
  { name: 'ok-done-marker-and-garbage', ...A(), reply: { status: 200, text: `data: {broken\n\n${chunk([part()])}data: [DONE]\n\n` } },
  { name: 'ok-parts-across-chunks', ...A(), reply: sse(chunk([{ text: 'thinking' }]), chunk([part()])) },
  { name: 'ok-array-response', ...A(), reply: sse(frame({ response: [1], candidates: [{ content: { parts: [part()] } }] })) },
  { name: 'refusal-text', ...A(), reply: sse(chunk([{ text: 'I cannot.' }], { usageMetadata: { promptTokenCount: 2 } })) },
  { name: 'in-band-error-message', ...A(), reply: sse(frame({ error: { message: 'quota exceeded', code: 429 } })) },
  { name: 'in-band-error-no-message', ...A(), reply: sse(frame({ error: { code: 500 } })) },
  { name: 'in-band-error-then-text', ...A(), reply: sse(frame({ error: { message: 'first' } }), chunk([{ text: 'later' }])) },
  { name: 'blocked', ...A(), reply: sse(frame({ response: { promptFeedback: { blockReason: 'SAFETY' } } })) },
  { name: 'blocked-after-error', ...A(), reply: sse(frame({ error: { message: 'e' } }), frame({ response: { promptFeedback: { blockReason: 'SAFETY' } } })) },
  { name: 'empty-stream', ...A(), reply: { status: 200, text: '' } },
  { name: 'empty-candidates', ...A(), reply: sse(frame({ response: { candidates: [] } })) },
  { name: 'bad-b64', ...A(), reply: sse(chunk([{ inlineData: { mimeType: 'image/png', data: '!!' } }])) },
  { name: 'http-401', ...A(), reply: { status: 401, text: 'nope' } },
  { name: 'http-403-json', ...A(), reply: { status: 403, text: '{"error":{"message":"Insufficient credits"}}' } },
  { name: 'http-429', ...A(), reply: { status: 429, text: '' } },
  { name: 'http-500', ...A(), reply: { status: 500, text: '<html>x</html>' } },
  { name: 'fetch-fails', ...A(), reply: { fail: 'fetch failed' } },
  { name: 'timeout', ...A(), reply: { fail: 'The operation was aborted due to timeout', name: 'TimeoutError' } },
];

const results = [];
for (const scenario of SCENARIOS) {
  counter = 0;
  const sent = [];
  let outcome;
  try {
    const result = await adapter.generateImage(
      { model: scenario.model, prompt: scenario.prompt, options: scenario.options, references: scenario.references },
      {
        resolveAuth: async () => ({ token: 'agy-token-1', projectId: 'proj-1' }),
        endpoint: 'https://agy.example.test',
        fetchFn: async (url, init) => {
          sent.push({ url: String(url), method: init.method, headers: init.headers, body: init.body, redirect: init.redirect, signal: init.signal != null });
          if (scenario.reply.fail) {
            const error = new Error(scenario.reply.fail);
            if (scenario.reply.name) error.name = scenario.reply.name;
            throw error;
          }
          return new Response(scenario.reply.text, { status: scenario.reply.status });
        },
      }
    );
    outcome = { value: { bytes: Buffer.from(result.bytes).toString('hex'), mime: result.mime, revisedPrompt: result.revisedPrompt, usage: result.usage } };
  } catch (error) {
    outcome = { error: { message: error.message, code: error.code ?? null, status: error.status ?? null, usage: error.usage ?? null } };
  }
  results.push({ name: scenario.name, model: scenario.model, prompt: scenario.prompt, options: scenario.options, references: scenario.references, reply: scenario.reply, sent, ...outcome });
}

writeJson(join(FIXTURES_ROOT, 'services', 'media-antigravity-image-twin.json'), {
  domain: 'media-antigravity-image-twin',
  recorder: 'benchmarks/rust-core/recorders/record-media-antigravity-image.mjs',
  headers: tokens.antigravityHeaders(),
  scenarios: results,
});
rmSync(ROOT, { recursive: true, force: true });
console.log(`recorded ${results.length} scenarios`);
process.exit(0);
