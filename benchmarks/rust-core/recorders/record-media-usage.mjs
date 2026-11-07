#!/usr/bin/env node
// Golden twin of the usage readers of the media adapters (`media-usage.mjs`): `geminiUsage`,
// `interactionsUsage`, `responsesUsage`, `xaiUsage`, `imageApiUsage` and `withReportedUsage`, over a
// matrix of provider answers (missing fields, strings, negatives, fractions, other shapes). Records the
// result (key order included: it is what the ledger row is built from). Rust `media::usage` must answer
// the same.
//
//   node benchmarks/rust-core/recorders/record-media-usage.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-media-usage-'));
mkdirSync(join(ROOT, 'data'), { recursive: true });
process.env.MIXDOG_DATA_DIR = join(ROOT, 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const tree = resolveTree(parseArgs());
const usage = await importFrom(tree, 'src/runtime/media/media-usage.mjs');

const COUNTS = [undefined, null, 0, 1, 7, 12.9, -3, '5', ' 8 ', 'abc', '', true, false, [], [4], {}, 1e21, 0.4];
const OTHER = [null, undefined, 0, 5, 'x', true, [], [1, 2], {}];

// geminiUsage: every count field against the value matrix, both spellings, detail lists.
const gemini = [];
for (const meta of OTHER) gemini.push(meta === undefined ? { input: '__undefined__' } : { input: meta });
for (const v of COUNTS) {
  for (const key of ['promptTokenCount', 'prompt_token_count', 'cachedContentTokenCount', 'cached_content_token_count', 'candidatesTokenCount', 'candidates_token_count', 'thoughtsTokenCount', 'thoughts_token_count']) {
    gemini.push({ input: { [key]: v === undefined ? undefined : v } });
  }
}
gemini.push({ input: { promptTokenCount: 3, prompt_token_count: 9 } });
gemini.push({ input: { promptTokenCount: null, prompt_token_count: 9 } });
gemini.push({ input: { promptTokenCount: 0, prompt_token_count: 9 } });
gemini.push({ input: { promptTokenCount: 10, cachedContentTokenCount: 4, candidatesTokenCount: 20, thoughtsTokenCount: 6 } });
for (const details of [
  [{ modality: 'IMAGE', tokenCount: 1290 }],
  [{ modality: 'image', token_count: 5 }, { modality: 'Image', tokenCount: 6 }, { modality: 'TEXT', tokenCount: 99 }],
  [{ modality: 'IMAGE' }, null, 7, 'x', { modality: 7, tokenCount: 3 }, { modality: ['IMAGE'], tokenCount: 3 }],
  [{ modality: 'IMAGE', tokenCount: '12' }],
  {},
  'IMAGE',
  null,
]) {
  gemini.push({ input: { candidatesTokensDetails: details } });
  gemini.push({ input: { candidates_tokens_details: details, candidatesTokenCount: 2 } });
}
gemini.push({ input: { candidatesTokensDetails: null, candidates_tokens_details: [{ modality: 'IMAGE', tokenCount: 4 }] } });
gemini.push({ input: { unrelated: 1 } });
const geminiOut = gemini.map((c) => {
  const input = c.input === '__undefined__' ? undefined : c.input;
  return { input: c.input, output: usage.geminiUsage(input) ?? null };
});

const interactions = [];
for (const u of OTHER) interactions.push({ input: u === undefined ? '__undefined__' : u });
for (const v of COUNTS) for (const key of ['total_input_tokens', 'total_cached_tokens', 'total_output_tokens', 'total_thought_tokens']) interactions.push({ input: { [key]: v === undefined ? undefined : v } });
for (const list of [
  [{ modality: 'video', tokens: 100 }],
  [{ modality: 'VIDEO', tokens: 100 }, { modality: 'Video', tokens: 5 }, { modality: 'audio', tokens: 9 }],
  [{ modality: 'video' }, null, 3, { modality: 'video', tokens: '7' }, { modality: 7 }],
  {},
  'video',
  null,
]) interactions.push({ input: { output_tokens_by_modality: list, total_output_tokens: 3 } });
interactions.push({ input: { total_input_tokens: 5, total_cached_tokens: 2, total_output_tokens: 30, total_thought_tokens: 4, output_tokens_by_modality: [{ modality: 'video', tokens: 25 }] } });
const interactionsOut = interactions.map((c) => ({ input: c.input, output: usage.interactionsUsage(c.input === '__undefined__' ? undefined : c.input) ?? null }));

const responses = [];
for (const u of OTHER) responses.push({ input: u === undefined ? '__undefined__' : u });
for (const v of COUNTS) {
  responses.push({ input: { input_tokens: v === undefined ? undefined : v } });
  responses.push({ input: { output_tokens: v === undefined ? undefined : v } });
  responses.push({ input: { input_tokens_details: { cached_tokens: v === undefined ? undefined : v } } });
}
responses.push({ input: { input_tokens_details: null } });
responses.push({ input: { input_tokens_details: 7 } });
responses.push({ input: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 250 } });
const responsesOut = responses.map((c) => ({ input: c.input, output: usage.responsesUsage(c.input === '__undefined__' ? undefined : c.input) ?? null }));

const xai = [];
for (const ticks of [undefined, null, 0, 1, 5e9, 1e10, 123456789, 25_000_000_000, 0.5, -1, '100', 1e21, true, [], {}, 3]) xai.push({ input: { cost_in_usd_ticks: ticks === undefined ? undefined : ticks } });
for (const u of OTHER) xai.push({ input: u === undefined ? '__undefined__' : u });
xai.push({ input: { cost_in_usd_ticks: 4e9, other: 1 } });
const xaiOut = xai.map((c) => ({ input: c.input, output: usage.xaiUsage(c.input === '__undefined__' ? undefined : c.input) ?? null }));

const imageApi = [];
for (const body of OTHER) imageApi.push({ input: body === undefined ? '__undefined__' : body });
for (const u of OTHER) imageApi.push({ input: { usage: u } });
for (const v of COUNTS) {
  imageApi.push({ input: { usage: { prompt_tokens: v === undefined ? undefined : v } } });
  imageApi.push({ input: { usage: { completion_tokens: v === undefined ? undefined : v } } });
  imageApi.push({ input: { usage: { completion_tokens_details: { image_tokens: v === undefined ? undefined : v } } } });
}
for (const cost of [0, 0.04, 1, -1, '0.5', null, true, 12.5, 1e21]) imageApi.push({ input: { usage: { cost } } });
for (const source of ['USD', 'usd', ' USD', 'XNO', '', null, 7]) {
  for (const cost of [0.02, 3, -2, '1', null]) imageApi.push({ input: { cost, paymentSource: source } });
}
imageApi.push({ input: { usage: { cost: 0.1 }, cost: 0.2, paymentSource: 'USD' } });
imageApi.push({ input: { usage: { cost: -1 }, cost: 0.2, paymentSource: 'USD' } });
imageApi.push({ input: { usage: { cost: 'x' }, cost: 0.2, paymentSource: 'usd' } });
imageApi.push({ input: { usage: { prompt_tokens: 12, completion_tokens: 1290, completion_tokens_details: { image_tokens: 1290 }, cost: 0.039 } } });
imageApi.push({ input: { usage: { prompt_tokens: 12 }, cost: 0.5, paymentSource: 'USD' } });
const imageApiOut = imageApi.map((c) => ({ input: c.input, output: usage.imageApiUsage(c.input === '__undefined__' ? undefined : c.input) ?? null }));

// withReportedUsage: what is worth attaching to a failure.
const reportable = [null, undefined, {}, 0, 'x', { costUsd: 0 }, { costUsd: 1.5 }, { costUsd: '1' }, { costUsd: null }, { inputTokens: 1 }, { inputTokens: 0 }, { outputTokens: 3 }, { cachedTokens: 2 }, { seconds: 8 }, { seconds: 0 }, { seconds: '8' }, { outputImageTokens: 5 }, { outputVideoTokens: 5 }, { images: 1 }, { resolution: '1K' }, { inputTokens: '3' }, { inputTokens: -1 }, { inputTokens: 'x', costUsd: 0 }];
const withReported = reportable.map((u) => {
  const error = usage.withReportedUsage(new Error('boom'), u);
  return { input: u === undefined ? '__undefined__' : u, attached: 'usage' in error ? error.usage : '__absent__' };
});

writeJson(join(FIXTURES_ROOT, 'services', 'media-usage-twin.json'), { domain: 'media-usage-twin', recorder: 'benchmarks/rust-core/recorders/record-media-usage.mjs', gemini: geminiOut, interactions: interactionsOut, responses: responsesOut, xai: xaiOut, imageApi: imageApiOut, withReported });
rmSync(ROOT, { recursive: true, force: true });
console.log(`recorded ${geminiOut.length} gemini, ${interactionsOut.length} interactions, ${responsesOut.length} responses, ${xaiOut.length} xai, ${imageApiOut.length} image-api, ${withReported.length} reported`);
process.exit(0);
