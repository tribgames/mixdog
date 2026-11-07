#!/usr/bin/env node
// Golden twin of the Gemini image adapter (`adapters/gemini-image.mjs`, API-key lane): Node's real
// `generateImage` with its injection points stubbed (`fetchFn`, `resolveKey`). Records every request
// (address, headers, body text in key order, redirect mode, timeout attached) and the result or error
// with its attached usage. The request builder and the part picker (reused by the Antigravity lane) are
// exercised through the same scenarios.
//
//   node benchmarks/rust-core/recorders/record-media-gemini-image.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-media-gemini-'));
mkdirSync(join(ROOT, 'data'), { recursive: true });
process.env.MIXDOG_DATA_DIR = join(ROOT, 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const tree = resolveTree(parseArgs());
const adapter = await importFrom(tree, 'src/runtime/media/adapters/gemini-image.mjs');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const ok = (json, status = 200) => ({ status, text: JSON.stringify(json) });
const cand = (...parts) => ok({ candidates: [{ content: { parts } }] });
const img = (extra = {}) => ({ inlineData: { mimeType: 'image/png', data: PNG, ...extra } });
const G = (over = {}) => ({ model: 'gemini-3-pro-image', prompt: 'a red circle', options: {}, references: [], ...over });
const SCENARIOS = [
  { name: 'ok', ...G(), reply: cand(img()) },
  { name: 'ok-mime', ...G(), reply: cand({ inlineData: { mimeType: 'image/jpeg', data: PNG } }) },
  { name: 'ok-no-mime', ...G(), reply: cand({ inlineData: { data: PNG } }) },
  { name: 'ok-usage', ...G(), reply: ok({ candidates: [{ content: { parts: [img()] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1290, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1290 }] } }) },
  { name: 'ok-after-text', ...G(), reply: cand({ text: 'here you go' }, img()) },
  { name: 'ok-first-image-wins', ...G(), reply: cand({ inlineData: { data: '' } }, img(), { inlineData: { mimeType: 'image/webp', data: 'AAAA' } }) },
  { name: 'aspect', ...G({ options: { aspectRatio: '16:9' } }), reply: cand(img()) },
  { name: 'aspect-auto', ...G({ options: { aspectRatio: 'auto' } }), reply: cand(img()) },
  { name: 'aspect-blank', ...G({ options: { aspectRatio: '' } }), reply: cand(img()) },
  { name: 'aspect-number', ...G({ options: { aspectRatio: 1 } }), reply: cand(img()) },
  { name: 'references', ...G({ references: [{ base64: 'cmVm', mime: 'image/jpeg' }, { base64: 'cmVm2' }] }), reply: cand(img()) },
  { name: 'model-encoded', ...G({ model: 'models/gemini 3?pro#x' }), reply: cand(img()) },
  { name: 'unicode-prompt', ...G({ prompt: '고양이 🐈 "q"\n' }), reply: cand(img()) },
  { name: 'refusal-text', ...G(), reply: cand({ text: '  I cannot draw that.  ' }) },
  { name: 'refusal-long', ...G(), reply: cand({ text: 'x'.repeat(300) }) },
  { name: 'refusal-blank-then-text', ...G(), reply: cand({ text: '   ' }, { text: 'second' }) },
  { name: 'refusal-non-string-text', ...G(), reply: cand({ text: 5 }) },
  { name: 'no-text', ...G(), reply: cand({}) },
  { name: 'refusal-usage-kept', ...G(), reply: ok({ candidates: [{ content: { parts: [{ text: 'no' }] } }], usageMetadata: { promptTokenCount: 4 } }) },
  { name: 'body-not-json', ...G(), reply: { status: 200, text: 'oops' } },
  { name: 'body-html', ...G(), reply: { status: 200, text: '<html><body>Bad gateway</body></html>' } },
  { name: 'body-truncated', ...G(), reply: { status: 200, text: '{"candidates":[{"content":' } },
  { name: 'body-empty', ...G(), reply: { status: 200, text: '' } },
  { name: 'no-candidates', ...G(), reply: ok({}) },
  { name: 'empty-candidates', ...G(), reply: ok({ candidates: [] }) },
  { name: 'null-parts', ...G(), reply: ok({ candidates: [{ content: { parts: null } }] }) },
  { name: 'null-part', ...G(), reply: ok({ candidates: [{ content: { parts: [null, img()] } }] }) },
  { name: 'bad-b64', ...G(), reply: cand({ inlineData: { mimeType: 'image/png', data: '!!' } }) },
  { name: 'http-400', ...G(), reply: { status: 400, text: '{"error":{"message":"API key not valid"}}' } },
  { name: 'http-401', ...G(), reply: { status: 401, text: '' } },
  { name: 'http-402', ...G(), reply: { status: 402, text: '{"error":"billing"}' } },
  { name: 'http-429', ...G(), reply: { status: 429, text: 'slow' } },
  { name: 'http-500', ...G(), reply: { status: 500, text: '<html>x</html>' } },
  { name: 'fetch-fails', ...G(), reply: { fail: 'fetch failed' } },
  { name: 'timeout', ...G(), reply: { fail: 'The operation was aborted due to timeout', name: 'TimeoutError' } },
];

const results = [];
for (const scenario of SCENARIOS) {
  const sent = [];
  let outcome;
  try {
    const result = await adapter.generateImage(
      { model: scenario.model, prompt: scenario.prompt, options: scenario.options, references: scenario.references },
      {
        resolveKey: () => 'secret-key',
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

writeJson(join(FIXTURES_ROOT, 'services', 'media-gemini-image-twin.json'), { domain: 'media-gemini-image-twin', recorder: 'benchmarks/rust-core/recorders/record-media-gemini-image.mjs', scenarios: results });
rmSync(ROOT, { recursive: true, force: true });
console.log(`recorded ${results.length} scenarios`);
process.exit(0);
