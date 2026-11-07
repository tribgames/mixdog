#!/usr/bin/env node
// Golden twin of the ChatGPT image adapter (`adapters/codex-image.mjs`, lane `openai-oauth`) and of the
// usage-window lookup it uses (`chatgpt-usage.mjs`). Node's real code runs with its injectable seams
// stubbed (`fetchFn`, `resolveAuth`, `warmVersion`, `lookupReset`); the client identity headers are pinned
// through the documented MIXDOG_CODEX_USER_AGENT / MIXDOG_CODEX_VERSION overrides. Records every request
// (address, headers, body text in key order), the lookups, and the result or error with its attached usage
// and reset time. `x-client-request-id` is random: the recorder checks it is 32 hex characters and records
// only that fact.
//
//   node benchmarks/rust-core/recorders/record-media-codex-image.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-media-codex-'));
mkdirSync(join(ROOT, 'data'), { recursive: true });
process.env.MIXDOG_DATA_DIR = join(ROOT, 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_CODEX_USER_AGENT = 'codex-test-ua/1';
process.env.MIXDOG_CODEX_VERSION = '0.200.0';
const tree = resolveTree(parseArgs());
const adapter = await importFrom(tree, 'src/runtime/media/adapters/codex-image.mjs');
const usageModule = await importFrom(tree, 'src/runtime/media/chatgpt-usage.mjs');
const oauth = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/openai-oauth.mjs');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const T0 = 1_700_000_000_000;
const json = (body, status = 200, headers = {}) => ({ status, text: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const sse = (...events) => ({ status: 200, text: events.map((e) => (typeof e === 'string' ? e : `data: ${JSON.stringify(e)}\n\n`)).join(''), headers: { 'content-type': 'text/event-stream' } });
const done = (result = PNG, extra = {}) => ({ type: 'response.output_item.done', item: { type: 'image_generation_call', result, ...extra } });
const OK = json({ data: [{ b64_json: PNG }], usage: { input_tokens: 10, output_tokens: 20, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { image_tokens: 15 } } });
const LIMIT_BODY = (extra = {}) => JSON.stringify({ error: { type: 'usage_limit_reached', ...extra } });
const A = (over = {}) => ({ model: 'gpt-5.5', prompt: 'a cat', options: {}, references: [], accountId: 'acct-1', ...over });
const SCENARIOS = [
  { name: 'ok', ...A(), script: [OK] },
  { name: 'ok-no-account', ...A({ accountId: null }), script: [json({ data: [{ b64_json: PNG }] })] },
  { name: 'ok-no-image-tokens', ...A(), script: [json({ data: [{ b64_json: PNG }], usage: { input_tokens: 3, output_tokens_details: { image_tokens: 0 } } })] },
  { name: 'ok-image-tokens-only', ...A(), script: [json({ data: [{ b64_json: PNG }], usage: { output_tokens_details: { image_tokens: '7' } } })] },
  { name: 'edit-with-references', ...A({ references: [{ base64: PNG, mime: 'image/jpeg' }, { base64: 'AAAA' }] }), script: [OK] },
  { name: 'background', ...A({ options: { background: 'transparent' } }), script: [OK] },
  { name: 'auto-options-pass', ...A({ options: { size: 'auto', quality: 'auto', aspectRatio: 'auto', resolution: 'auto', background: 'auto' } }), script: [OK] },
  { name: 'size-refused', ...A({ options: { size: '1024x1024' } }), script: [] },
  { name: 'quality-refused', ...A({ options: { quality: 'high' } }), script: [] },
  { name: 'aspect-refused', ...A({ options: { aspectRatio: '16:9' } }), script: [] },
  { name: 'resolution-number-refused', ...A({ options: { resolution: 2 } }), script: [] },
  { name: 'background-bad', ...A({ options: { background: 'blurry' } }), script: [] },
  { name: 'empty-b64', ...A(), script: [json({ data: [{ b64_json: '' }], usage: { input_tokens: 2 } })] },
  { name: 'b64-not-string', ...A(), script: [json({ data: [{ b64_json: 5 }] })] },
  { name: 'body-not-json', ...A(), script: [{ status: 200, text: 'oops', headers: {} }] },
  { name: 'bad-b64', ...A(), script: [json({ data: [{ b64_json: '!!' }] })] },
  { name: 'fallback-404', ...A(), script: [{ status: 404, text: '', headers: {} }, sse(done(PNG, { model: 'gpt-image-2', revised_prompt: 'nicer cat' }), { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 9 } } })] },
  { name: 'fallback-405', ...A({ options: { background: 'opaque' }, references: [{ base64: PNG }] }), script: [{ status: 405, text: '', headers: {} }, sse(done())] },
  { name: 'fallback-501', ...A(), script: [{ status: 501, text: '', headers: {} }, sse(done())] },
  { name: 'fallback-403-html', ...A(), script: [{ status: 403, text: '<html>', headers: { 'content-type': 'text/html' } }, sse(done())] },
  { name: 'fallback-403-no-type', ...A(), script: [{ status: 403, text: '', headers: {} }, sse(done())] },
  { name: 'http-403-json', ...A(), script: [json({ error: { message: 'no' } }, 403)] },
  { name: 'http-401', ...A(), script: [{ status: 401, text: 'nope', headers: {} }] },
  { name: 'http-402', ...A(), script: [json({ error: { message: 'Insufficient credits' } }, 402)] },
  { name: 'http-500', ...A(), script: [{ status: 500, text: 'x'.repeat(500), headers: {} }] },
  { name: 'limit-with-reset', ...A(), script: [{ status: 429, text: LIMIT_BODY({ resets_at: 1_800_000_000 }), headers: {} }] },
  { name: 'limit-image-with-reset', ...A(), script: [{ status: 429, text: LIMIT_BODY({ limit_id: 'codex_image', resets_at: 1_800_000_000 }), headers: {} }] },
  { name: 'limit-lookup-hit', ...A(), reset: 1_800_000_500, script: [{ status: 429, text: LIMIT_BODY(), headers: { 'x-codex-active-limit': 'codex_image' } }] },
  { name: 'limit-lookup-miss', ...A(), reset: null, script: [{ status: 429, text: LIMIT_BODY(), headers: {} }] },
  { name: 'limit-from-headers', ...A(), script: [{ status: 429, text: LIMIT_BODY(), headers: { 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-at': '1800000200' } }] },
  { name: 'rate-limited', ...A(), script: [json({ error: { type: 'rate_limit' } }, 429)] },
  { name: 'fetch-fails', ...A(), script: [{ fail: 'fetch failed' }] },
  { name: 'fallback-fetch-fails', ...A(), script: [{ status: 404, text: '', headers: {} }, { fail: 'fetch failed' }] },
  { name: 'fallback-http-500', ...A(), script: [{ status: 404, text: '', headers: {} }, { status: 500, text: 'down', headers: {} }] },
  { name: 'fallback-limit', ...A(), reset: 1_800_000_900, script: [{ status: 404, text: '', headers: {} }, { status: 429, text: LIMIT_BODY(), headers: {} }] },
  { name: 'stream-model-and-prompt', ...A(), script: [{ status: 404, text: '', headers: {} }, sse(': keepalive\n', 'event: x\n', { type: 'response.image_generation_call.partial_image', partial_image_b64: 'AA' }, done(PNG, { model: 'gpt-image-2', revised_prompt: 'p2' }), 'data: [DONE]\n\n')] },
  { name: 'stream-bad-lines', ...A(), script: [{ status: 404, text: '', headers: {} }, sse('data: {broken\n\n', 'data:\n\n', 'data: null\n\n', done())] },
  { name: 'stream-last-result-wins', ...A(), script: [{ status: 404, text: '', headers: {} }, sse(done('AAAA'), done(PNG))] },
  { name: 'stream-empty-result-ignored', ...A(), script: [{ status: 404, text: '', headers: {} }, sse(done(''), { type: 'response.completed', response: { usage: { input_tokens: 4 } } })] },
  { name: 'stream-partial-only', ...A(), script: [{ status: 404, text: '', headers: {} }, sse({ type: 'response.image_generation_call.partial_image', partial_image_b64: 'AAAA' }, { type: 'response.image_generation_call.partial_image', partial_image_b64: 'AA' }, { type: 'response.completed', response: { usage: { output_tokens: 6 } } })] },
  { name: 'stream-partial-then-failed', ...A(), script: [{ status: 404, text: '', headers: {} }, sse({ type: 'response.image_generation_call.partial_image', partial_image_b64: 'AAAA' }, { type: 'response.failed', response: { error: { message: 'content policy' } } })] },
  { name: 'stream-empty', ...A(), script: [{ status: 404, text: '', headers: {} }, sse()] },
  { name: 'stream-failed-message', ...A(), script: [{ status: 404, text: '', headers: {} }, sse({ type: 'response.failed', response: { error: { message: 'boom' } }, usage: 1 })] },
  { name: 'stream-failed-no-message', ...A(), script: [{ status: 404, text: '', headers: {} }, sse({ type: 'response.failed', response: { error: {} } })] },
  { name: 'stream-error-event', ...A(), script: [{ status: 404, text: '', headers: {} }, sse({ type: 'error', message: 'top level' })] },
  { name: 'stream-error-string', ...A(), script: [{ status: 404, text: '', headers: {} }, sse({ type: 'error', error: 'plain text' })] },
  { name: 'stream-limit-event', ...A(), script: [{ status: 404, text: '', headers: {} }, sse({ type: 'response.completed', response: { usage: { input_tokens: 8 } } }, { type: 'error', code: 'usage_limit_reached', resets_at: 1_800_000_000 })] },
  { name: 'stream-limit-lookup', ...A(), reset: 1_800_000_700, script: [{ status: 404, text: '', headers: {} }, sse({ type: 'response.failed', response: { error: { type: 'usage_limit_reached' } } })] },
  { name: 'stream-bad-final', ...A(), script: [{ status: 404, text: '', headers: {} }, sse(done('!!'))] },
];

const results = [];
for (const scenario of SCENARIOS) {
  const sent = [];
  const lookups = [];
  let warmed = 0;
  const queue = [...scenario.script];
  const fetchFn = async (url, init) => {
    const headers = { ...init.headers };
    const id = headers['x-client-request-id'];
    if (id !== undefined) {
      if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('request id is not 32 hex characters');
      delete headers['x-client-request-id'];
    }
    sent.push({ url: String(url), method: init.method, headers, requestId: id !== undefined, body: init.body, redirect: init.redirect, signal: init.signal != null });
    const entry = queue.shift();
    if (!entry) throw new Error('unscripted fetch');
    if (entry.fail) throw new Error(entry.fail);
    return new Response(entry.text, { status: entry.status, headers: entry.headers });
  };
  let outcome;
  try {
    const result = await adapter.generateImage(
      { model: scenario.model, prompt: scenario.prompt, options: scenario.options, references: scenario.references },
      {
        fetchFn,
        resolveAuth: async () => ({ access_token: 'tok-1', ...(scenario.accountId ? { account_id: scenario.accountId } : {}) }),
        warmVersion: async () => { warmed += 1; },
        lookupReset: async (args) => { lookups.push({ token: args.auth.access_token, limitId: args.limitId }); return scenario.reset ?? null; },
      }
    );
    outcome = { value: { bytes: Buffer.from(result.bytes).toString('hex'), mime: result.mime, revisedPrompt: result.revisedPrompt, actualModel: result.actualModel, usage: result.usage } };
  } catch (error) {
    outcome = { error: { message: error.message, code: error.code ?? null, status: error.status ?? null, usage: error.usage ?? null, resetsAt: error.resetsAt ?? null } };
  }
  results.push({ name: scenario.name, model: scenario.model, prompt: scenario.prompt, options: scenario.options, references: scenario.references, accountId: scenario.accountId, reset: scenario.reset ?? null, script: scenario.script, sent, lookups, warmed, ...outcome });
}

// chatgpt-usage.mjs: the reset time of the exhausted window.
const row = (over) => ({ used_percent: 100, reset_at: 1_800_000_000, ...over });
const PAYLOADS = [
  null, 'x', {}, { rate_limit: null }, { rate_limit: 'x' },
  { rate_limit: { primary_window: row({}), secondary_window: row({ reset_at: 1_800_000_900 }) } },
  { rate_limit: { primary_window: row({ used_percent: 50 }), secondary_window: row({ used_percent: 100, reset_at: 1_800_000_300 }) } },
  { rate_limit: { primary_window: row({ used_percent: 50 }), secondary_window: row({ used_percent: 60 }) } },
  { rate_limit: { limit_reached: true, primary_window: row({ used_percent: 50 }), secondary_window: row({ used_percent: 60, reset_at: 1_800_000_100.9 }) } },
  { rate_limit: { limit_reached: true, primary_window: row({ reset_at: 0 }), secondary_window: row({ reset_at: '1800000050' }) } },
  { rate_limit: { primary_window: row({ reset_at: 'x' }) } },
  { rate_limit: { primary_window: row({ used_percent: '100', reset_at: 1_800_000_400 }) } },
  { additional_rate_limits: [{ metered_feature: 'codex_image', rate_limit: { primary_window: row({ reset_at: 1_800_001_000 }) } }], rate_limit: { primary_window: row({}) } },
  { additional_rate_limits: [{ limit_name: 'Other', rate_limit: { primary_window: row({ reset_at: 1_800_002_000 }) } }, { limit_name: 'IMAGE_GEN', rate_limit: { primary_window: row({ reset_at: 1_800_003_000 }) } }], rate_limit: { primary_window: row({}) } },
  { additional_rate_limits: [{ metered_feature: 'alpha', rate_limit: { primary_window: row({ reset_at: 1_800_004_000 }) } }, { metered_feature: 'codex_image', rate_limit: { primary_window: row({ reset_at: 1_800_005_000 }) } }], rate_limit: { primary_window: row({}) } },
  { additional_rate_limits: [{ metered_feature: 'alpha' }], rate_limit: { primary_window: row({}) } },
  { additional_rate_limits: 'x', rate_limit: { primary_window: row({}) } },
  { additional_rate_limits: [null, {}], rate_limit: { primary_window: row({}) } },
];
const LIMIT_IDS = ['', 'alpha', 'ALPHA', 'codex_image', 'missing', 7];
const fromUsage = [];
for (const payload of PAYLOADS) for (const limitId of LIMIT_IDS) fromUsage.push({ payload, limitId, resetAt: usageModule.limitResetFromUsage(payload, limitId) });

const LOOKUPS = [
  { name: 'hit', auth: { access_token: 'tok-1', account_id: 'acct-1' }, limitId: 'codex_image', reply: json({ rate_limit: { primary_window: row({}) } }) },
  { name: 'no-account', auth: { access_token: 'tok-2' }, limitId: '', reply: json({ rate_limit: { primary_window: row({}) } }) },
  { name: 'not-ok', auth: { access_token: 'tok-1' }, limitId: '', reply: { status: 500, text: 'x', headers: {} } },
  { name: 'not-json', auth: { access_token: 'tok-1' }, limitId: '', reply: { status: 200, text: 'x', headers: {} } },
  { name: 'fetch-fails', auth: { access_token: 'tok-1' }, limitId: '', reply: { fail: 'fetch failed' } },
];
const lookups = [];
for (const lookup of LOOKUPS) {
  const sent = [];
  const resetAt = await usageModule.chatgptLimitResetAt({
    auth: lookup.auth,
    limitId: lookup.limitId,
    fetchFn: async (url, init) => {
      sent.push({ url: String(url), headers: init.headers, redirect: init.redirect, signal: init.signal != null });
      if (lookup.reply.fail) throw new Error(lookup.reply.fail);
      return new Response(lookup.reply.text, { status: lookup.reply.status, headers: lookup.reply.headers });
    },
  });
  lookups.push({ ...lookup, sent, resetAt });
}

writeJson(join(FIXTURES_ROOT, 'services', 'media-codex-image-twin.json'), {
  domain: 'media-codex-image-twin',
  recorder: 'benchmarks/rust-core/recorders/record-media-codex-image.mjs',
  constants: { responsesUrl: oauth.CODEX_RESPONSES_URL, originator: oauth.CODEX_OAUTH_ORIGINATOR, usageUrl: usageModule.CHATGPT_USAGE_URL, userAgent: process.env.MIXDOG_CODEX_USER_AGENT, version: process.env.MIXDOG_CODEX_VERSION },
  scenarios: results,
  fromUsage,
  lookups,
});
rmSync(ROOT, { recursive: true, force: true });
console.log(`recorded ${results.length} scenarios, ${fromUsage.length} usage windows, ${lookups.length} lookups`);
process.exit(0);
