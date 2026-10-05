import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDocument } from './document-content.mjs';
import { HostPacer, runFetchPipeline } from './fetch-pipeline.mjs';
import { applyFetchPagination, formatResponse } from './formatter.mjs';

const url = 'https://example.com/document.md';
const options = () => ({ timeoutMs: 3000, hostPacer: new HostPacer({ intervalMs: 0 }) });
const outputBody = (text) => text.slice(text.indexOf('\n\n') + 2);

test('empty searches retain warnings and crawls retain the actual failure cause', () => {
  assert.equal(
    formatResponse('web_search', { results: [], warnings: ['provider timed out', 'partial results'] }),
    'Warnings: provider timed out; partial results\n\n(no search results)'
  );
  assert.equal(formatResponse('web_search', { results: [] }), '(no search results)');
  assert.equal(
    formatResponse('crawl', { pages: [{ url, error: 'HTTP 403: denied' }] }),
    `[${url}]\n(error: HTTP 403: denied)`
  );
});

test('search omits only snippets identical to already visible title or URL', () => {
  const output = formatResponse('web_search', {
    results: [
      { title: 'Same title', url, snippet: 'Same title', publishedDate: '2026-09-21' },
      { title: 'URL repeat', url, snippet: url },
      { title: 'Distinct', url, snippet: 'Different details, kept intact.' },
    ],
  });
  assert.equal(output.split('Same title').length - 1, 1);
  assert.equal(output.split(url).length - 1, 3);
  assert.match(output, /2026-09-21/);
  assert.match(output, /Different details, kept intact\./);
});

test('query-labelled sources print as bare URLs, and not at all when the answer cites them', () => {
  const cited = 'https://example.com/cited';
  const extra = 'https://example.com/extra';
  const titled = 'https://example.com/titled';
  const output = formatResponse('web_search', {
    response: {
      answer: `Summary citing ${cited}.`,
      results: [
        { title: 'the query', url: cited, snippet: '', source: 'web_search_call' },
        { title: 'the query', url: extra, snippet: '', source: 'web_search_call', publishedDate: '2026-09-21' },
        { title: 'A page title', url: titled, snippet: '' },
      ],
    },
  });
  assert.equal(output, `Summary citing ${cited}.\n\n1. ${extra} — 2026-09-21\n\n2. A page title\n   ${titled}`);
  // No adapter marker: one label over several URLs is still a search label.
  assert.equal(
    formatResponse('web_search', {
      results: [
        { title: 'shared label', url: cited },
        { title: 'shared label', url: extra },
      ],
    }),
    `1. ${cited}\n\n2. ${extra}`
  );
  // A cited URL that merely starts with the source's URL is another page.
  assert.equal(
    formatResponse('web_search', {
      response: {
        answer: `Guide: ${cited}/guide and ${extra}.`,
        results: [
          { title: 'q', url: cited, source: 'web_search_call' },
          { title: 'q', url: extra, source: 'web_search_call' },
        ],
      },
    }),
    `Guide: ${cited}/guide and ${extra}.\n\n1. ${cited}`
  );
  // Every source already cited: the answer stands alone.
  assert.equal(
    formatResponse('web_search', {
      response: { answer: `See ${cited}`, results: [{ title: cited, url: cited }] },
    }),
    `See ${cited}`
  );
});

test('final paginated output reconstructs the exact source, including whitespace-only slices', async () => {
  const source = '    indented code\r\n\n        \n\n```js\n  const message = "한글";  \n```\n\n';
  const page = await runFetchPipeline(url, {
    ...options(),
    http: () => extractDocument(url, source, 'text/markdown'),
  });
  let reconstructed = '';
  let startIndex = 0;
  do {
    const item = { ...applyFetchPagination(page, { startIndex, maxLength: 4 }), status: 'success' };
    const rendered = formatResponse('fetch', { results: [item] });
    assert.equal(item.bytes, Buffer.byteLength(item.content));
    assert.equal(outputBody(rendered), item.content);
    reconstructed += outputBody(rendered);
    startIndex = item.nextStartIndex;
  } while (startIndex != null);
  assert.equal(reconstructed, source);

  const unlimited = applyFetchPagination(page, { maxLength: 0 });
  assert.doesNotMatch(formatResponse('fetch', { results: [unlimited] }), /attempts:|http=success/);
  assert.equal(outputBody(formatResponse('fetch', { results: [unlimited] })), source);
  const exhausted = applyFetchPagination(page, { startIndex: source.length, maxLength: 4 });
  assert.equal(outputBody(formatResponse('fetch', { results: [exhausted] })), '');
  assert.equal(exhausted.nextStartIndex, null);
  assert.equal(exhausted.hasMore, false);
});

test('final error output exposes the error code and every failed stage', async () => {
  await assert.rejects(
    runFetchPipeline(url, {
      ...options(),
      http: async () => {
        throw Object.assign(new Error('HTTP 403'), { status: 403 });
      },
      browser: async () => {
        throw Object.assign(new Error('Explicit challenge'), { status: 200, code: 'BLOCKED_CONTENT' });
      },
    }),
    (failed) => {
      const rendered = formatResponse('fetch', {
        results: [
          {
            url,
            status: 'error',
            error: failed.message,
            errorCode: failed.code,
            attempts: failed.attempts,
            failures: failed.failures,
          },
        ],
      });
      assert.match(rendered, /errorCode: BLOCKED_CONTENT/);
      assert.match(rendered, /http=HTTP_BLOCKED/);
      assert.match(rendered, /puppeteer=BLOCKED_CONTENT/);
      assert.match(rendered, /failure: http \[HTTP_BLOCKED\] HTTP 403: HTTP 403/);
      assert.match(rendered, /failure: puppeteer \[BLOCKED_CONTENT\] HTTP 200: Explicit challenge/);
      return true;
    }
  );
});

test('successful fallback keeps diagnostics separate from the unchanged body', async () => {
  const page = await runFetchPipeline(url, {
    ...options(),
    http: async () => {
      throw Object.assign(new Error('HTTP 403'), { status: 403 });
    },
    browser: async () => ({ url, content: '    recovered content\n\n', title: 'Recovered' }),
  });
  const rendered = formatResponse('fetch', { results: [{ ...applyFetchPagination(page, {}), status: 'success' }] });
  assert.match(rendered, /http=HTTP_BLOCKED/);
  assert.match(rendered, /puppeteer=success/);
  assert.equal(outputBody(rendered), '    recovered content\n\n');
});
