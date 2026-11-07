#!/usr/bin/env node
// Golden twin of the media adapters' shared upstream handling: Node's real `upstreamError`,
// `usageLimitInfo`, `usageLimitFromResponse`, `usageLimitError` (upstream-error.mjs),
// `decodeBase64Media` and `geminiMediaDownloadUrl` (download.mjs). Records every answer (message,
// code, status, reset time) over a matrix of statuses and bodies. Rust `media::upstream` must
// answer the same.
//
//   node benchmarks/rust-core/recorders/record-media-upstream.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-media-upstream-'));
mkdirSync(join(ROOT, 'data'), { recursive: true });
process.env.MIXDOG_DATA_DIR = join(ROOT, 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const tree = resolveTree(parseArgs());
const upstream = await importFrom(tree, 'src/runtime/media/upstream-error.mjs');
const download = await importFrom(tree, 'src/runtime/media/download.mjs');

const view = (error) => ({ message: error.message, code: error.code ?? null, status: error.status ?? null, ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}) });
const attempt = (run) => {
  try {
    return { value: run() };
  } catch (error) {
    return { error: view(error) };
  }
};

// ── upstreamError: statuses x bodies ──
const STATUSES = [0, 400, 401, 402, 403, 404, 408, 429, 500, 502, 503];
const BODIES = [
  '',
  '   ',
  'plain text failure',
  '<html><body>Bad gateway</body></html>',
  '  <!doctype html>',
  'x'.repeat(400),
  '日本語のエラー'.repeat(60),
  JSON.stringify({ error: { message: 'Your credit balance is too low' } }),
  JSON.stringify({ error: 'Insufficient quota for this request' }),
  JSON.stringify({ message: 'Model overloaded' }),
  JSON.stringify({ error: { message: 'Billing hard limit reached' }, message: 'ignored' }),
  JSON.stringify({ error: { message: '' }, message: 'fallback message' }),
  JSON.stringify({ error: { message: 7 } }),
  JSON.stringify({ error: { code: 'x' } }),
  JSON.stringify({ error: 'payment required to continue' }),
  JSON.stringify({ error: { message: 'You hit a spending limit' } }),
  JSON.stringify([1, 2]),
  'null',
  '{broken',
];
const upstreamErrors = [];
for (const status of STATUSES) for (const text of BODIES) upstreamErrors.push({ label: 'Grok image', status, text, ...attempt(() => { throw upstream.upstreamError('Grok image', status, text); }) });

// ── usage limits ──
const Headers = globalThis.Headers;
const hdr = (entries) => Object.fromEntries(entries);
const ERRORS = [
  null,
  {},
  { type: 'usage_limit_reached' },
  { code: 'usagelimit' },
  { type: 'USAGE_LIMIT' },
  { type: 'rate_limit' },
  { type: 'usage_limit_reached', resets_at: 1_800_000_000 },
  { type: 'usage_limit_reached', resets_at: '1800000000' },
  { type: 'usage_limit_reached', resets_at: 1_800_000_000.9 },
  { type: 'usage_limit_reached', resets_at: -5 },
  { type: 'usage_limit_reached', resets_at: 'soon' },
  { type: 'usage_limit_reached', limit_id: 'image_gen' },
  { type: 'usage_limit_reached', limit_id: 7 },
  { type: 'usage_limit_reached', metered_feature: 'codex_image' },
  { type: 'usage_limit_reached', limit_id: '', metered_feature: 'meter' },
  { type: 7, code: 'usage_limit' },
];
const HEADERS = [
  {},
  { 'x-codex-rate-limit-reached-type': 'usage_limit_reached' },
  { 'x-codex-active-limit': 'codex_image' },
  { 'x-codex-active-limit': 'codex_image', 'x-codex-image-primary-used-percent': '100', 'x-codex-image-primary-reset-at': '1800000100' },
  { 'x-codex-active-limit': 'codex_image', 'x-codex-image-primary-used-percent': '99', 'x-codex-image-primary-reset-at': '1800000100' },
  { 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-at': '1800000200', 'x-codex-secondary-used-percent': '100', 'x-codex-secondary-reset-at': '1800000300' },
  { 'x-codex-active-limit': 'Codex_Image', 'x-codex-image-secondary-used-percent': '150', 'x-codex-image-secondary-reset-at': '1800000400.7', 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-at': '1800000250' },
  { 'x-codex-active-limit': ' spaced ', 'x-spaced-primary-used-percent': ' 100 ', 'x-spaced-primary-reset-at': ' 1800000500 ' },
  { 'x-codex-primary-used-percent': 'abc', 'x-codex-primary-reset-at': '1800000200' },
];
const usageInfos = [];
for (const error of ERRORS) for (const headers of HEADERS) usageInfos.push({ error, headers, ...attempt(() => upstream.usageLimitInfo(error, new Headers(hdr(Object.entries(headers))))) });
// A transport that gives no headers object at all.
usageInfos.push({ error: { type: 'usage_limit_reached' }, headers: null, ...attempt(() => upstream.usageLimitInfo({ type: 'usage_limit_reached' }, undefined)) });

const BODIES_429 = [
  JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: 1_800_000_000 } }),
  JSON.stringify({ type: 'usage_limit_reached', resets_at: 1_800_000_000 }),
  JSON.stringify({ error: 'usage_limit_reached' }),
  JSON.stringify({ error: [] }),
  JSON.stringify({ error: { type: 'rate_limit' } }),
  'not json',
  '',
];
const usageFromResponse = [];
for (const status of [200, 400, 429, 500]) for (const text of BODIES_429) for (const headers of [{}, HEADERS[1], HEADERS[3]]) usageFromResponse.push({ status, text, headers, ...attempt(() => upstream.usageLimitFromResponse(status, text, new Headers(hdr(Object.entries(headers))))) });

const USAGE_ERRORS = [{}, { limitId: 'codex_image' }, { limitId: 'IMAGE' }, { resetsAt: 1_800_000_000 }, { limitId: 'codex', resetsAt: 1_800_000_000 }, { limitId: 'image_gen', resetsAt: 1_700_000_000 }, { resetsAt: 0 }, { resetsAt: null }];
const usageErrors = USAGE_ERRORS.map((options) => ({ options, ...attempt(() => { throw upstream.usageLimitError('Codex image', options); }) }));

// ── generated media ──
const decodeCases = ['aGVsbG8=', 'aGVsbG8', 'aGVs bG8=', 'aGVs\nbG8=', '-_-_', '+/+/', 'aGVsbG8=aGVsbG8=', 'aGVs!bG8=', '!!!!', '=', 'a', 'ab', 'abc', 'YQ==', '', 7, null, undefined, {}];
const decoded = decodeCases.map((input) => ({ input, ...attempt(() => download.decodeBase64Media(input, 'Grok image')) })).map((row) => (row.value ? { ...row, value: Buffer.from(row.value).toString('hex') } : row));
const URLS = [
  'https://generativelanguage.googleapis.com/v1beta/files/abc:download',
  'https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=json',
  'https://generativelanguage.googleapis.com/v1beta/files/abc:download?a=b c&alt=x&alt=y&z=1',
  'https://generativelanguage.googleapis.com/v1beta/files/abc:download?a=%20x&b=é',
  'https://generativelanguage.googleapis.com/v1beta/files/abc:download#frag',
  'https://GENERATIVELANGUAGE.googleapis.com/v1/f',
  'https://generativelanguage.googleapis.com:443/v1/f',
  'https://generativelanguage.googleapis.com:8443/v1/f',
  'https://generativelanguage.googleapis.com./v1/f',
  'http://generativelanguage.googleapis.com/v1/f',
  'https://user@generativelanguage.googleapis.com/v1/f',
  'https://user:pw@generativelanguage.googleapis.com/v1/f',
  'https://evil.example.com/v1/f',
  'https://generativelanguage.googleapis.com.evil.com/v1/f',
  'not a url',
  '',
  null,
  7,
];
const geminiUrls = URLS.map((input) => ({ input, ...attempt(() => download.geminiMediaDownloadUrl(input)) }));

writeJson(join(FIXTURES_ROOT, 'services', 'media-upstream-twin.json'), { domain: 'media-upstream-twin', recorder: 'benchmarks/rust-core/recorders/record-media-upstream.mjs', upstreamErrors, usageInfos, usageFromResponse, usageErrors, decoded, geminiUrls });
rmSync(ROOT, { recursive: true, force: true });
console.log(`recorded ${upstreamErrors.length} upstream errors, ${usageInfos.length} usage infos, ${usageFromResponse.length} responses, ${decoded.length} decodes, ${geminiUrls.length} urls`);
process.exit(0);
