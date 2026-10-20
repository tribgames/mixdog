import assert from 'node:assert/strict';
import test from 'node:test';

import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

import { remoteInlinePageSource } from './visualize-inline-remote.ts';
import {
  buildInlineDocument,
  fitDiagram,
  INLINE_FRAME_CSP,
  INLINE_FRAME_SANDBOX,
  renderInlineContent,
  useInlinePurifier,
} from './visualize-inline.ts';

useInlinePurifier(createDOMPurify(new JSDOM('').window));

const dark = {
  scheme: 'dark',
  background: '#111111',
  text: '#eeeeee',
  muted: '#999999',
  border: '#333333',
  accent: '#58a6ff',
};
const light = {
  scheme: 'light',
  background: '#ffffff',
  text: '#111111',
  muted: '#666666',
  border: '#dddddd',
  accent: '#0b63ce',
};

test('the frame is fully sandboxed under a no-network, no-script CSP', () => {
  // No allow-scripts (nothing runs); the app's origin only so the app can hear a pinch on it.
  assert.equal(INLINE_FRAME_SANDBOX, 'allow-same-origin');
  assert.equal(INLINE_FRAME_CSP, "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  const doc = buildInlineDocument('<p>hi</p>', dark);
  assert.ok(doc.includes(`<meta http-equiv="Content-Security-Policy" content="${INLINE_FRAME_CSP}">`));
  assert.ok(doc.includes('<body style') === false);
  assert.ok(doc.includes('<p>hi</p>'));
});

test('the theme prelude carries the panel colors as CSS variables', () => {
  const darkDoc = buildInlineDocument('', dark);
  assert.match(darkDoc, /--mx-bg-base:#111111/);
  assert.match(darkDoc, /--mx-text:#eeeeee/);
  assert.match(darkDoc, /color-scheme:dark/);
  assert.match(buildInlineDocument('', light), /color-scheme:light/);
  // A theme value cannot break out of its declaration.
  const hostile = buildInlineDocument('', { ...dark, accent: 'red;}</style><script>x()</script>' });
  assert.equal(hostile.includes('<script>'), false);
});

test('a remote client builds scripted inline pages from the content in the tab state', async () => {
  const chart = await remoteInlinePageSource({ kind: 'chart', source: '{"series":[]}' }, async () => 'var echarts={};');
  assert.equal(chart.kind, 'html');
  assert.match(chart.srcdoc, /<script>var echarts=\{\};<\/script>/);
  assert.match(chart.srcdoc, /id="option">\{"series":\[\]\}</);
  const html = await remoteInlinePageSource({ kind: 'html', source: '<p>sketch</p>' });
  assert.equal(html.kind, 'html');
  assert.ok(html.srcdoc.startsWith('<style data-mixdog-theme>') && html.srcdoc.endsWith('<p>sketch</p>'));
  // No library, no page: the caller falls back to the static render.
  await assert.rejects(
    remoteInlinePageSource({ kind: 'chart', source: '{}' }, async () => {
      throw new Error('chunk failed');
    }),
    /chunk failed/
  );
});

test('a diagram fits the pane, never upscales, and scrolls only below 0.6x natural width', () => {
  const wide = fitDiagram('<svg viewBox="0 0 2000 400" style="max-width: 2000px"></svg>');
  // Pane width, capped at natural (2000) and floored at 0.6x natural (1200), centered.
  assert.match(
    wide,
    /class="fit" style="overflow:auto"><div style="width:100%;margin:0 auto;max-width:2000px;min-width:1200px">/
  );
  assert.match(fitDiagram('<svg viewBox="0 0 300 200"></svg>'), /max-width:300px;min-width:180px/);
  assert.match(fitDiagram('<svg></svg>'), /style="width:100%;margin:0 auto">/);
  // The page rule overrides Mermaid's inline max-width and keeps the aspect.
  assert.match(buildInlineDocument(wide, dark), /\.fit svg\{max-width:none!important;width:100%;height:auto\}/);
});

test('bad chart JSON is a render error, not a throw', async () => {
  const bad = await renderInlineContent({ kind: 'chart', source: '{"series": [' }, dark);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /^Invalid chart JSON/);
  const notObject = await renderInlineContent({ kind: 'chart', source: '[1,2]' }, dark);
  assert.equal(notObject.ok, false);
  assert.match(notObject.error, /JSON object/);
});

test('a chart option renders to a static SVG', async () => {
  const option = { xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: {}, series: [{ type: 'bar', data: [1, 2] }] };
  const result = await renderInlineContent({ kind: 'chart', source: JSON.stringify(option) }, dark);
  assert.equal(result.ok, true, result.error);
  assert.match(result.html, /<svg[\s>]/);
  assert.equal(/<script/i.test(result.html), false);
});

test('SVG is sanitized: scripts, handlers and external links are removed', async () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script>' +
    '<a href="https://evil.example/"><circle cx="5" cy="5" r="4" onclick="alert(3)"/></a>' +
    '<a href="#sec"><rect width="2" height="2"/></a></svg>';
  const result = await renderInlineContent({ kind: 'svg', source }, dark);
  assert.equal(result.ok, true);
  assert.equal(/script|onload|onclick|alert|evil\.example/i.test(result.html), false, result.html);
  assert.match(result.html, /<circle/);
  assert.match(result.html, /href="#sec"/);
  const notSvg = await renderInlineContent({ kind: 'svg', source: '<div>x</div>' }, dark);
  assert.equal(notSvg.ok, false);
});

test('HTML and Markdown render without scripts or off-page links', async () => {
  const html = await renderInlineContent(
    {
      kind: 'html',
      source:
        '<style>p{color:red}</style><p onclick="x()">a</p><script>x()</script><a href="https://evil.example/">l</a>',
    },
    dark
  );
  assert.equal(html.ok, true);
  assert.match(html.html, /<style>/);
  assert.equal(/script|onclick|evil\.example/i.test(html.html), false, html.html);

  const markdown = await renderInlineContent(
    { kind: 'markdown', source: '# Title\n\n- one\n- two\n\n<script>x()</script>\n\n[link](https://evil.example/)' },
    dark
  );
  assert.equal(markdown.ok, true);
  assert.match(markdown.html, /<h1>Title<\/h1>/);
  assert.match(markdown.html, /<li>one<\/li>/);
  assert.equal(/script|evil\.example/i.test(markdown.html), false, markdown.html);
});
