import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';

import { chartPageDocument, INLINE_CHART_RENDERED, withHtmlThemePrelude } from '../../shared/visualize-inline-page.ts';
import { localVirtualPageUrl, revokeLocalPagesFor } from '../local-page-server.ts';
import { withSandboxStorageShim } from '../../shared/sandbox-storage-shim.ts';
import { inlinePageFiles } from './inline-page.ts';

function get(url) {
  const { hostname, port, pathname } = new URL(url);
  return new Promise((resolve, reject) => {
    request({ hostname, port, path: pathname }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() })
      );
    })
      .on('error', reject)
      .end();
  });
}

test('a chart page carries its option as data and the bundled library by file', async () => {
  const files = await inlinePageFiles(
    { kind: 'chart', source: '{"title":{"text":"</script><b>"}}' },
    async () => 'window.echarts={};'
  );
  assert.deepEqual(Object.keys(files).sort(), ['echarts.js', 'index.html']);
  const page = files['index.html'].body.toString();
  assert.match(page, /<script src="echarts\.js"><\/script>/);
  // The option can neither close its block nor inject markup.
  assert.equal(page.includes('</script><b>'), false);
  assert.match(
    page,
    /<script type="application\/json" id="option">\{"title":\{"text":"\\u003c\/script>\\u003cb>"\}\}<\/script>/
  );
  assert.equal(files['echarts.js'].body.toString(), 'window.echarts={};');
  assert.doesNotMatch(page, /https?:\/\//, 'no CDN or any other address');
  // Bad JSON is reported by the page itself.
  assert.match(page, /Invalid chart JSON/);

  const html = await inlinePageFiles({ kind: 'html', source: '<h1>x</h1><script>1</script>' });
  assert.deepEqual(Object.keys(html), ['index.html']);
  const body = html['index.html'].body.toString();
  assert.ok(body.endsWith('<h1>x</h1><script>1</script>'), 'the author markup follows the prelude unchanged');
  assert.ok(body.startsWith('<style data-mixdog-theme>'));
});

test('a chart page marks its root once ECharts finished drawing, or the chart failed', async () => {
  const { JSDOM } = await import('jsdom');
  const run = (option, library) => {
    return new JSDOM(chartPageDocument(option, { inline: library }), {
      runScripts: 'dangerously',
      beforeParse(window) {
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      },
    });
  };
  const library = `var echarts = { init: function () { return {
    on: function (name, handler) { window.handlers = window.handlers || {}; window.handlers[name] = handler; },
    setOption: function () {}, resize: function () {}
  }; } };`;
  const drawn = run('{"series":[]}', library);
  const root = drawn.window.document.documentElement;
  assert.equal(root.hasAttribute(INLINE_CHART_RENDERED), false, 'still animating');
  drawn.window.handlers.finished();
  assert.equal(root.hasAttribute(INLINE_CHART_RENDERED), true);
  const broken = run('{oops', library);
  assert.equal(
    broken.window.document.documentElement.hasAttribute(INLINE_CHART_RENDERED),
    true,
    'nothing left to wait for'
  );
});

test('a chart page is drawn again in the dark theme when the color scheme changes', async () => {
  const { JSDOM } = await import('jsdom');
  const media = {
    matches: false,
    listeners: [],
    addEventListener: (name, handler) => media.listeners.push([name, handler]),
    removeEventListener() {},
  };
  const library = `var echarts = { init: function (box, theme) {
    window.themes = (window.themes || []).concat([theme]);
    return { on: function () {}, setOption: function () {}, resize: function () {}, dispose: function () { window.disposed = (window.disposed || 0) + 1; } };
  } };`;
  const dom = new JSDOM(chartPageDocument('{"series":[]}', { inline: library }), {
    runScripts: 'dangerously',
    beforeParse(window) {
      window.matchMedia = () => media;
    },
  });
  assert.deepEqual([...dom.window.themes], [null], 'drawn in the light theme first');
  const change = media.listeners.find(([name]) => name === 'change');
  assert.ok(change, 'the page listens for a scheme change');
  media.matches = true;
  change[1]();
  assert.deepEqual([...dom.window.themes], [null, 'dark']);
  assert.equal(dom.window.disposed, 1, 'the light chart was disposed before the redraw');
});

test('an html sketch gets a zero-specificity app-theme base the author overrides', () => {
  const base = withHtmlThemePrelude('<p>x</p>');
  assert.match(base, /--mx-bg-base:#fff/);
  assert.match(base, /prefers-color-scheme:dark/);
  assert.match(base, /:where\(button,input,select,textarea\)\{font:inherit/);
  // Every selector sits under :where(), so author CSS always wins.
  const css = base.slice(base.indexOf('>') + 1, base.indexOf('</style>'));
  const selectors = css
    .replace(/@media[^{]*\{/, '')
    .split('}')
    .map((rule) => rule.split('{')[0].trim())
    .filter(Boolean);
  assert.ok(
    selectors.every((selector) => selector.startsWith(':where(')),
    selectors.join(' | ')
  );
  // Placement keeps standards mode and a real head.
  assert.match(
    withHtmlThemePrelude('<!doctype html><html><head><title>t</title></head><body/></html>'),
    /<head><style data-mixdog-theme>/
  );
  assert.match(
    withHtmlThemePrelude('<!doctype html><html><body>b</body></html>'),
    /<html><head><style data-mixdog-theme>[\s\S]*<\/head><body>/
  );
  assert.ok(withHtmlThemePrelude('<!DOCTYPE html><p>x</p>').startsWith('<!DOCTYPE html><style data-mixdog-theme>'));
});

test('the remote form inlines the library, and is gated like any page that runs scripts', () => {
  const page = chartPageDocument('{}', { inline: 'var echarts={};</script><i>' });
  assert.equal(page.includes('</script><i>'), false);
  assert.match(page, /<script\b/i);
});

test('a virtual page lease serves exactly its files in an opaque origin and dies with its owner', async () => {
  const owner = {};
  const url = await localVirtualPageUrl(
    {
      'index.html': { type: 'text/html; charset=utf-8', body: Buffer.from('<p>mem</p>') },
      'echarts.js': { type: 'text/javascript; charset=utf-8', body: Buffer.from('var a=1') },
    },
    { owner, authorize: async () => {} }
  );
  const page = await get(url);
  assert.equal(page.status, 200);
  // The opaque-origin page document carries the storage shim; assets do not.
  assert.equal(page.body, withSandboxStorageShim('<p>mem</p>'));
  assert.equal(page.headers['content-security-policy'], 'sandbox allow-scripts');
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  const script = await get(url.replace('index.html', 'echarts.js'));
  assert.equal(script.body, 'var a=1');
  assert.equal((await get(url.replace('index.html', 'secret.txt'))).status, 404);
  assert.equal((await get(url.replace('index.html', '..%2Findex.html'))).status, 404);
  // Another lease's token is another page.
  const other = await localVirtualPageUrl(
    { 'index.html': { type: 'text/html', body: Buffer.from('other') } },
    { authorize: async () => {} }
  );
  assert.equal((await get(other)).body, withSandboxStorageShim('other'));
  assert.notEqual(new URL(other).pathname.split('/')[1], new URL(url).pathname.split('/')[1]);

  revokeLocalPagesFor(owner);
  assert.equal((await get(url)).status, 404);
  assert.equal((await get(other)).status, 200);
  await assert.rejects(
    localVirtualPageUrl({ 'a.html': { type: 'text/html', body: Buffer.alloc(0) } }, { authorize: async () => {} }),
    /index\.html/
  );
});
