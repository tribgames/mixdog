#!/usr/bin/env node
// Records Node's web tool output for the k1 UNTESTED fetch-output.test.mjs (gaps-tools.md row 81, mixdog-tools
// `web/format.rs`, `web/search.rs`, `web/pipeline.rs`). Every call of the test goes through Node's real
// `applyFetchPagination`, `formatResponse`, `runFetchPipeline` and `extractDocument`; each whole rendered text is
// recorded. In the pipeline cases the fetched url is written as <url> and each stage's elapsed time as <n>ms.
//
//   node benchmarks/rust-core/recorders/record-fetch-output-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/fetch-output-cases/{golden.json,MANIFEST.json}.
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-fetch-output-cases.mjs';
const TEST = 'src/runtime/web-search/lib/fetch-output.test.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const { extractDocument } = await importFrom(tree, 'src/runtime/web-search/lib/document-content.mjs');
const { HostPacer, runFetchPipeline } = await importFrom(tree, 'src/runtime/web-search/lib/fetch-pipeline.mjs');
const { applyFetchPagination, formatResponse } = await importFrom(tree, 'src/runtime/web-search/lib/formatter.mjs');

const url = 'https://example.com/document.md';
const options = () => ({ timeoutMs: 3000, hostPacer: new HostPacer({ intervalMs: 0 }) });
const mask = (text) => text.split(url).join('<url>').replace(/\(\d+ms\)/g, '(<n>ms)');
const cases = [];

{
  // `content` is `x` repeated `repeat` times unless given.
  const windows = [
    { repeat: 30000, startIndex: 0, maxLength: 10 },
    { repeat: 30000 },
    { content: 'short' },
  ].map((w) => {
    const content = w.content ?? 'x'.repeat(w.repeat);
    const paged = applyFetchPagination({ content }, w.startIndex === undefined ? {} : { startIndex: w.startIndex, maxLength: w.maxLength });
    return { ...w, url, rendered: formatResponse('fetch', { results: [{ ...paged, status: 'success', url }] }) };
  });
  cases.push({ case: 'fetch marks a requested window and a default-length cap differently, both with startIndex', kind: 'windows', recorded: windows });
}

const search = (name, payloads) =>
  cases.push({ case: name, kind: 'search', recorded: payloads.map((payload) => ({ payload, rendered: formatResponse('web_search', payload) })) });
search('empty searches retain warnings and crawls retain the actual failure cause', [
  { results: [], warnings: ['provider timed out', 'partial results'] },
  { results: [] },
]);
cases.push({
  case: 'empty searches retain warnings and crawls retain the actual failure cause: crawl',
  kind: 'crawl',
  recorded: [{ payload: { pages: [{ url, error: 'HTTP 403: denied' }] }, rendered: formatResponse('crawl', { pages: [{ url, error: 'HTTP 403: denied' }] }) }],
});
search('search omits only snippets identical to already visible title or URL', [
  {
    results: [
      { title: 'Same title', url, snippet: 'Same title', publishedDate: '2026-09-21' },
      { title: 'URL repeat', url, snippet: url },
      { title: 'Distinct', url, snippet: 'Different details, kept intact.' },
    ],
  },
]);
{
  const cited = 'https://example.com/cited';
  const extra = 'https://example.com/extra';
  const titled = 'https://example.com/titled';
  search('query-labelled sources print as bare URLs, and not at all when the answer cites them', [
    {
      response: {
        answer: `Summary citing ${cited}.`,
        results: [
          { title: 'the query', url: cited, snippet: '', source: 'web_search_call' },
          { title: 'the query', url: extra, snippet: '', source: 'web_search_call', publishedDate: '2026-09-21' },
          { title: 'A page title', url: titled, snippet: '' },
        ],
      },
    },
    { results: [{ title: 'shared label', url: cited }, { title: 'shared label', url: extra }] },
    {
      response: {
        answer: `Guide: ${cited}/guide and ${extra}.`,
        results: [
          { title: 'q', url: cited, source: 'web_search_call' },
          { title: 'q', url: extra, source: 'web_search_call' },
        ],
      },
    },
    { response: { answer: `See ${cited}`, results: [{ title: cited, url: cited }] } },
  ]);
}

{
  const source = '    indented code\r\n\n        \n\n```js\n  const message = "한글";  \n```\n\n';
  const page = await runFetchPipeline(url, { ...options(), http: () => extractDocument(url, source, 'text/markdown') });
  const calls = [];
  let startIndex = 0;
  do {
    const item = { ...applyFetchPagination(page, { startIndex, maxLength: 4 }), status: 'success' };
    calls.push({ startIndex, maxLength: 4, rendered: mask(formatResponse('fetch', { results: [item] })) });
    startIndex = item.nextStartIndex;
  } while (startIndex != null);
  calls.push({ maxLength: 0, rendered: mask(formatResponse('fetch', { results: [applyFetchPagination(page, { maxLength: 0 })] })) });
  calls.push({ startIndex: source.length, maxLength: 4, rendered: mask(formatResponse('fetch', { results: [applyFetchPagination(page, { startIndex: source.length, maxLength: 4 })] })) });
  cases.push({ case: 'final paginated output reconstructs the exact source, including whitespace-only slices', kind: 'pages', source, contentType: 'text/markdown', recorded: calls });
}
{
  let rendered;
  try {
    await runFetchPipeline(url, {
      ...options(),
      http: async () => {
        throw Object.assign(new Error('HTTP 403'), { status: 403 });
      },
      browser: async () => {
        throw Object.assign(new Error('Explicit challenge'), { status: 200, code: 'BLOCKED_CONTENT' });
      },
    });
  } catch (failed) {
    rendered = formatResponse('fetch', {
      results: [{ url, status: 'error', error: failed.message, errorCode: failed.code, attempts: failed.attempts, failures: failed.failures }],
    });
  }
  cases.push({ case: 'final error output exposes the error code and every failed stage', kind: 'blocked', recorded: [{ rendered: mask(rendered) }] });
}
{
  const page = await runFetchPipeline(url, {
    ...options(),
    http: async () => {
      throw Object.assign(new Error('HTTP 403'), { status: 403 });
    },
    browser: async () => ({ url, content: '    recovered content\n\n', title: 'Recovered' }),
  });
  const rendered = formatResponse('fetch', { results: [{ ...applyFetchPagination(page, {}), status: 'success' }] });
  cases.push({ case: 'successful fallback keeps diagnostics separate from the unchanged body', kind: 'fallback', recorded: [{ rendered: mask(rendered) }] });
}

const excluded = {
  'empty searches retain warnings and crawls retain the actual failure cause: crawl':
    "GONE: the core has no crawl tool (Node's `formatResponse('crawl')` has no Rust caller); the case's two search outputs are replayed",
};

const finalDir = join(FIXTURES_ROOT, 'fetch-output-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's web tool output at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'fetch-output-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      "each whole rendered text. windows: through paginate and format_fetch; search: through format_results; pages, blocked, fallback: through the web_fetch tool against a local server (and a fake render stage), the url written as <url> and elapsed times as <n>ms",
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`fetch-output-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
