#!/usr/bin/env node
// Golden twin of the media adapters' download of generated media (`download.mjs`
// `downloadPublicMedia` / `downloadGeminiMedia`, `bounded-download.mjs` `readResponseBuffer`). Node's real
// functions run over a scripted `fetchImpl`; the recorder keeps what each call answered (bytes in hex or the
// error: message, code, status, and whether it was a media error) and what the fetch saw (url, headers,
// redirect mode). `assertPublicUrl` (the SSRF guard) is Node's own: the verdict of every url in a scenario is
// recorded too, since the Rust port reaches the guard through its fetch seam.
//
//   node benchmarks/rust-core/recorders/record-media-download-public.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-media-public-'));
mkdirSync(join(ROOT, 'data'), { recursive: true });
process.env.MIXDOG_DATA_DIR = join(ROOT, 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const tree = resolveTree(parseArgs());
const download = await importFrom(tree, 'src/runtime/media/download.mjs');
const guard = await importFrom(tree, 'src/runtime/web-search/lib/ssrf-guard.mjs');

const enc = new TextEncoder();
const bytes = (text) => enc.encode(text);
const chunked = (parts) => new ReadableStream({
  start(controller) {
    for (const part of parts) controller.enqueue(typeof part === 'string' ? bytes(part) : part);
    controller.close();
  },
});
const reply = ({ status = 200, headers = {}, body = null, chunks = null }) => {
  const stream = chunks ? chunked(chunks) : body === null ? null : chunked([body]);
  return new Response(stream, { status: status === 204 || status === 304 ? status : status, headers });
};

const A = 'https://cdn.example.com/a.png';
const B = 'https://cdn.example.com/dir/b.png';
// [{ at: url, ... }] scripts one answer per url in order of request; `fail` makes the fetch itself throw.
const SCENARIOS = [
  { name: 'ok', url: A, answers: { [A]: [{ chunks: ['hel', 'lo'] }] } },
  { name: 'ok-empty-body', url: A, answers: { [A]: [{ body: '' }] } },
  { name: 'ok-many-chunks', url: A, answers: { [A]: [{ chunks: ['a', 'b', 'c', 'd', 'e'] }] }, maxBytes: 5 },
  { name: 'no-body', url: A, answers: { [A]: [{ status: 204 }] } },
  { name: 'content-length-over', url: A, answers: { [A]: [{ headers: { 'content-length': '11' }, body: 'x' }] }, maxBytes: 10 },
  { name: 'content-length-exact', url: A, answers: { [A]: [{ headers: { 'content-length': '10' }, body: '0123456789' }] }, maxBytes: 10 },
  { name: 'content-length-junk', url: A, answers: { [A]: [{ headers: { 'content-length': 'abc' }, body: 'x' }] }, maxBytes: 10 },
  { name: 'content-length-spaced', url: A, answers: { [A]: [{ headers: { 'content-length': ' 99 ' }, body: 'x' }] }, maxBytes: 10 },
  { name: 'body-over-in-chunks', url: A, answers: { [A]: [{ chunks: ['01234', '56789', 'x'] }] }, maxBytes: 10 },
  { name: 'body-over-single-chunk', url: A, answers: { [A]: [{ body: '0123456789x' }] }, maxBytes: 10 },
  { name: 'custom-label', url: A, answers: { [A]: [{ status: 404 }] }, label: 'Grok image' },
  { name: 'not-found', url: A, answers: { [A]: [{ status: 404 }] } },
  { name: 'server-error', url: A, answers: { [A]: [{ status: 500 }] } },
  { name: 'not-modified', url: A, answers: { [A]: [{ status: 304 }] } },
  { name: 'redirect-absolute', url: A, answers: { [A]: [{ status: 302, headers: { location: B } }], [B]: [{ body: 'moved' }] } },
  { name: 'redirect-relative', url: B, answers: { [B]: [{ status: 301, headers: { location: '../c.png' } }], 'https://cdn.example.com/c.png': [{ body: 'rel' }] } },
  { name: 'redirect-root-relative', url: B, answers: { [B]: [{ status: 307, headers: { location: '/r.png?x=1' } }], 'https://cdn.example.com/r.png?x=1': [{ body: 'root' }] } },
  { name: 'redirect-scheme-relative', url: A, answers: { [A]: [{ status: 308, headers: { location: '//other.example.com/z.png' } }], 'https://other.example.com/z.png': [{ body: 'sr' }] } },
  { name: 'redirect-300', url: A, answers: { [A]: [{ status: 300, headers: { location: B } }], [B]: [{ body: 'x' }] } },
  { name: 'redirect-no-location', url: A, answers: { [A]: [{ status: 302 }] } },
  { name: 'redirect-empty-location', url: A, answers: { [A]: [{ status: 302, headers: { location: '' } }] } },
  { name: 'redirect-bad-location', url: A, answers: { [A]: [{ status: 302, headers: { location: 'http://' } }] } },
  { name: 'redirect-to-private', url: A, answers: { [A]: [{ status: 302, headers: { location: 'http://127.0.0.1/secret' } }] } },
  { name: 'redirect-to-metadata', url: A, answers: { [A]: [{ status: 302, headers: { location: 'http://169.254.169.254/latest' } }] } },
  { name: 'redirect-to-file', url: A, answers: { [A]: [{ status: 302, headers: { location: 'file:///etc/passwd' } }] } },
  { name: 'redirect-chain-5', url: 'https://h.example.com/0', answers: Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`https://h.example.com/${i}`, [{ status: 302, headers: { location: `/${i + 1}` } }]]).concat([['https://h.example.com/5', [{ body: 'done' }]]])) },
  { name: 'redirect-chain-6', url: 'https://h.example.com/0', answers: Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [`https://h.example.com/${i}`, [{ status: 302, headers: { location: `/${i + 1}` } }]])) },
  { name: 'redirect-loop', url: A, answers: { [A]: Array.from({ length: 7 }, () => ({ status: 302, headers: { location: A } })) } },
  { name: 'private-start', url: 'http://localhost/a.png', answers: {} },
  { name: 'private-start-10', url: 'http://10.0.0.1/a.png', answers: {} },
  { name: 'private-start-v6', url: 'http://[::1]/a.png', answers: {} },
  { name: 'not-a-url', url: 'nonsense', answers: {} },
  { name: 'empty-url', url: '', answers: {} },
  { name: 'non-http', url: 'ftp://cdn.example.com/a.png', answers: {} },
  { name: 'network-failure', url: A, answers: { [A]: [{ fail: 'fetch failed' }] } },
  { name: 'abort-failure', url: A, answers: { [A]: [{ fail: 'This operation was aborted', abort: true }] } },
  { name: 'unscripted-url', url: A, answers: {} },
];

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/files/abc:download';
const GEMINI_OK = `${GEMINI}?alt=media`;
const GEMINI_SCENARIOS = [
  { name: 'gemini-ok', input: GEMINI, key: 'k-1', answers: { [GEMINI_OK]: [{ chunks: ['vi', 'deo'] }] } },
  { name: 'gemini-ok-with-query', input: `${GEMINI}?alt=json&x=1`, key: 'k-2', answers: { [`${GEMINI}?alt=media&x=1`]: [{ body: 'v' }] } },
  { name: 'gemini-redirect-rejected', input: GEMINI, key: 'k-1', answers: { [GEMINI_OK]: [{ status: 302, headers: { location: 'https://evil.example.com/x' } }] } },
  { name: 'gemini-redirect-no-location', input: GEMINI, key: 'k-1', answers: { [GEMINI_OK]: [{ status: 302 }] } },
  { name: 'gemini-not-found', input: GEMINI, key: 'k-1', answers: { [GEMINI_OK]: [{ status: 404 }] } },
  { name: 'gemini-too-large-header', input: GEMINI, key: 'k-1', answers: { [GEMINI_OK]: [{ headers: { 'content-length': '11' }, body: 'x' }] }, maxBytes: 10 },
  { name: 'gemini-too-large-body', input: GEMINI, key: 'k-1', answers: { [GEMINI_OK]: [{ chunks: ['0123456', '789ab'] }] }, maxBytes: 10 },
  { name: 'gemini-label', input: GEMINI, key: 'k-1', label: 'Veo clip', answers: { [GEMINI_OK]: [{ status: 500 }] } },
  { name: 'gemini-untrusted', input: 'https://evil.example.com/v', key: 'k-1', answers: {} },
  { name: 'gemini-invalid', input: 'nope', key: 'k-1', answers: {} },
  { name: 'gemini-network-failure', input: GEMINI, key: 'k-1', answers: { [GEMINI_OK]: [{ fail: 'fetch failed' }] } },
];

const view = (error) => ({ message: error?.message ?? String(error), code: error?.code ?? null, status: error?.status ?? null, name: error?.name ?? null });
const hex = (buffer) => Buffer.from(buffer).toString('hex');

async function run(scenario, call) {
  const seen = [];
  const queues = new Map(Object.entries(scenario.answers).map(([url, answers]) => [url, [...answers]]));
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init?.headers ?? {}, redirect: init?.redirect ?? null });
    const next = queues.get(url)?.shift();
    if (!next) throw new Error(`unscripted fetch ${url}`);
    if (next.fail) {
      const error = new Error(next.fail);
      if (next.abort) error.name = 'AbortError';
      throw error;
    }
    return reply(next);
  };
  let outcome;
  try {
    outcome = { value: hex(await call(fetchImpl)) };
  } catch (error) {
    outcome = { error: view(error) };
  }
  return { ...outcome, seen };
}

// What Node's SSRF guard says of a url (the Rust fetch seam answers the same).
function verdict(url) {
  try {
    guard.assertPublicUrl(url);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message, code: error.code ?? null };
  }
}
const urlsOf = (scenario) => [...new Set([scenario.url ?? scenario.input, ...Object.keys(scenario.answers), ...Object.values(scenario.answers).flat().map((a) => a.headers?.location).filter(Boolean)])];

const results = [];
for (const scenario of SCENARIOS) {
  const options = { ...(scenario.maxBytes ? { maxBytes: scenario.maxBytes } : {}), ...(scenario.label ? { label: scenario.label } : {}) };
  const outcome = await run(scenario, (fetchImpl) => download.downloadPublicMedia(scenario.url, { ...options, fetchImpl }));
  const urls = {};
  for (const url of urlsOf(scenario)) urls[url] = verdict(url);
  // The redirect targets Node resolved (so the Rust fake can answer the url it is asked for).
  results.push({ name: scenario.name, kind: 'public', url: scenario.url, options, answers: scenario.answers, guard: urls, ...outcome });
}
for (const scenario of GEMINI_SCENARIOS) {
  const options = { key: scenario.key, ...(scenario.maxBytes ? { maxBytes: scenario.maxBytes } : {}), ...(scenario.label ? { label: scenario.label } : {}) };
  const outcome = await run(scenario, (fetchImpl) => download.downloadGeminiMedia(scenario.input, { ...options, fetchImpl }));
  const urls = {};
  for (const url of urlsOf(scenario)) urls[url] = verdict(url);
  results.push({ name: scenario.name, kind: 'gemini', url: scenario.input, options, answers: scenario.answers, guard: urls, ...outcome });
}

writeJson(join(FIXTURES_ROOT, 'services', 'media-download-public-twin.json'), { domain: 'media-download-public-twin', recorder: 'benchmarks/rust-core/recorders/record-media-download-public.mjs', scenarios: results });
rmSync(ROOT, { recursive: true, force: true });
console.log(`recorded ${results.length} scenarios`);
process.exit(0);
