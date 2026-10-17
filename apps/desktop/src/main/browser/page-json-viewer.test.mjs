import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { JSON_PRETTY_PRINT_SCRIPT, JSON_VIEWER_BAR_CSS, injectJsonViewerTweaks } from './page-json-viewer.ts';

const run = (html, contentType) => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  Object.defineProperty(dom.window.document, 'contentType', { value: contentType });
  dom.window.eval(JSON_PRETTY_PRINT_SCRIPT);
  return dom.window.document;
};

test('every document hides the JSON viewer bar and pretty-prints its text', async () => {
  const handlers = new Map();
  const css = [];
  const scripts = [];
  injectJsonViewerTweaks({
    on: (event, handler) => handlers.set(event, handler),
    insertCSS: async (value) => css.push(value),
    executeJavaScript: async (value) => scripts.push(value),
    isDestroyed: () => false,
  });
  handlers.get('dom-ready')();
  assert.deepEqual(css, [JSON_VIEWER_BAR_CSS]);
  assert.deepEqual(scripts, [JSON_PRETTY_PRINT_SCRIPT]);
  assert.match(JSON_VIEWER_BAR_CSS, /\.json-formatter-container \{ display: none !important/);
});

test('a destroyed guest is left alone', () => {
  const handlers = new Map();
  let calls = 0;
  injectJsonViewerTweaks({
    on: (event, handler) => handlers.set(event, handler),
    insertCSS: async () => void calls++,
    executeJavaScript: async () => void calls++,
    isDestroyed: () => true,
  });
  handlers.get('dom-ready')();
  assert.equal(calls, 0);
});

test('a one-line JSON document is shown indented; other documents are untouched', () => {
  const json = run(
    '<html><body><pre>{"a":[1,2],"b":{"c":null}}</pre><div class="json-formatter-container"></div></body></html>',
    'application/json'
  );
  assert.equal(
    json.querySelector('pre').textContent,
    '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {\n    "c": null\n  }\n}'
  );
  const text = run('<html><body><pre>not json {</pre></body></html>', 'text/plain');
  assert.equal(text.querySelector('pre').textContent, 'not json {');
  const page = run('<html><body><pre>{"a":1}</pre><p>a normal page</p><p>x</p></body></html>', 'text/html');
  assert.equal(page.querySelector('pre').textContent, '{"a":1}');
});

test('depth and output budgets leave an oversized document unformatted', () => {
  const nested = `${'['.repeat(2000)}${']'.repeat(2000)}`;
  assert.equal(nested.length, 4000);
  const deep = run(`<html><body><pre>${nested}</pre></body></html>`, 'application/json');
  assert.equal(
    deep.querySelector('pre').textContent,
    nested,
    'indentation would have grown it to millions of characters'
  );
  const wide = `[${'[],'.repeat(1_200_000)}[]]`;
  const bulky = run(`<html><body><pre>${wide}</pre></body></html>`, 'application/json');
  assert.equal(bulky.querySelector('pre').textContent, wide, 'output beyond the budget is not built');
  const shallow = `${'['.repeat(60)}${']'.repeat(60)}`;
  const fine = run(`<html><body><pre>${shallow}</pre></body></html>`, 'application/json');
  assert.notEqual(fine.querySelector('pre').textContent, shallow, 'nesting within budget is still indented');
});

test('indenting keeps every number and string exactly as written', () => {
  const doc = run(
    '<html><body><pre>{"id":9007199254740993,"big":1e400,"s":"\\u00e9 \\"q\\" , : {","e":[ ],"o":{},"n":[-0.10]}</pre></body></html>',
    'application/json'
  );
  assert.equal(
    doc.querySelector('pre').textContent,
    '{\n  "id": 9007199254740993,\n  "big": 1e400,\n  "s": "\\u00e9 \\"q\\" , : {",\n  "e": [],\n  "o": {},\n  "n": [\n    -0.10\n  ]\n}'
  );
});
