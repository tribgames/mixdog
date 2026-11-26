import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, useEffect } from 'react';

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.DOMParser = dom.window.DOMParser;
globalThis.document = dom.window.document;

const { createRoot } = await import('react-dom/client');
const { _runIdleReclaimForTest } = await import('./idle-reclaim.ts');
const { enforceRendererCacheBudget, totalBudgetedChars } = await import('./renderer-cache-budget.ts');
const {
  createRemotePreviewApi,
  getMediaSessionEpoch,
  retainBlobPreviewUrl,
  subscribeMediaSession,
  useBlobPreviewLease,
} = await import('./remote-file-preview.ts');
const { readRemoteFile, REMOTE_PREVIEW_CHUNK_BYTES } = await import('./remote-file-range.ts');
const { buildPageSrcdoc, resolvePageReference } = await import('./remote-page-inliner.ts');
const { openSandboxedPagePreview, PREVIEW_LINK, sandboxedPageDocument } = await import('./sandboxed-page-preview.ts');
const { sandboxStorageShimScript } = await import('../shared/sandbox-storage-shim.ts');

// Fake host serving `files` through the same two methods as the real one.
function fakeHost(files) {
  const calls = [];
  const call = async (method, params) => {
    calls.push([method, ...params]);
    const [, rel] = params;
    const file = files[rel];
    if (!file) throw new Error('missing');
    if (method === 'previewProjectFile') return { kind: 'video', mime: file.mime, mtimeMs: 1, size: file.bytes.length };
    const [, , , offset, length] = params;
    const slice = file.bytes.subarray(offset, offset + length);
    return {
      data: Buffer.from(slice).toString('base64'),
      mime: file.mime,
      offset,
      size: file.bytes.length,
      mtimeMs: 1,
    };
  };
  return { call, calls };
}
const file = (text, mime) => ({ bytes: Buffer.from(text), mime });

test('large files are read in several bounded ranges', async () => {
  const bytes = Buffer.alloc(REMOTE_PREVIEW_CHUNK_BYTES * 2 + 5, 7);
  const host = fakeHost({ 'a.mp4': { bytes, mime: 'video/mp4' } });
  const read = await readRemoteFile(host.call, ['p', 'a.mp4', null], bytes.length);
  assert.equal(read.size, bytes.length);
  assert.deepEqual(
    host.calls.map((c) => c[4]),
    [0, REMOTE_PREVIEW_CHUNK_BYTES, REMOTE_PREVIEW_CHUNK_BYTES * 2]
  );
  await assert.rejects(readRemoteFile(host.call, ['p', 'a.mp4', null], 10), /too large/);
});

test('previewProjectFile builds a cached blob URL and refuses oversize files', async () => {
  const made = [];
  globalThis.URL.createObjectURL = (blob) => {
    made.push(blob);
    return `blob:test/${made.length}`;
  };
  globalThis.URL.revokeObjectURL = () => {};
  const host = fakeHost({ 'a.mp4': file('hello', 'video/mp4') });
  const api = createRemotePreviewApi(host.call);
  const first = await api.previewProjectFile('p', 'a.mp4');
  const second = await api.previewProjectFile('p', 'a.mp4');
  assert.equal(first.url, 'blob:test/1');
  assert.equal(second.url, first.url);
  assert.equal(made[0].type, 'video/mp4');
  assert.equal(first.kind, 'video');
  const huge = createRemotePreviewApi(async () => ({ kind: 'video', mime: 'video/mp4', mtimeMs: 1, size: 1e12 }));
  await assert.rejects(huge.previewProjectFile('p', 'big.mp4'), /too large/);
});

async function withFetch(fetchImpl, body) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

test('a host with the media lane is previewed by streaming, with no RPC range reads', async () => {
  const calls = [];
  const probes = [];
  const call = async (method) => {
    calls.push(method);
    return { kind: 'video', mime: 'video/mp4', mtimeMs: 3, size: 1e12, mediaAssetId: 'aaaaaaaa-1111' };
  };
  await withFetch(
    async (url, init) => {
      probes.push([url, init.headers.Range]);
      return new Response(null, { status: 206 });
    },
    async () => {
      const api = createRemotePreviewApi(
        call,
        (assetId, variant) => `https://relay.test/media/${assetId}?variant=${variant}&sid=s`
      );
      const preview = await api.previewProjectFile('p', 'big.mp4');
      assert.equal(preview.url, 'https://relay.test/media/aaaaaaaa-1111?variant=original&sid=s');
      assert.equal(preview.kind, 'video');
      assert.equal(preview.size, 1e12);
      assert.deepEqual(calls, ['previewProjectFile']);
      assert.deepEqual(probes, [[preview.url, 'bytes=0-0']]);
    }
  );
});

test('an older host, a missing lane, or a lane that does not answer keeps the RPC blob path', async () => {
  globalThis.URL.createObjectURL = () => 'blob:test/fallback';
  globalThis.URL.revokeObjectURL = () => {};
  const bytes = Buffer.from('hello');
  const hostCall = (extra) => async (method, params) => {
    if (method === 'previewProjectFile')
      return { kind: 'video', mime: 'video/mp4', mtimeMs: 1, size: bytes.length, ...extra };
    const [, , , offset, length] = params;
    return {
      data: bytes.subarray(offset, offset + length).toString('base64'),
      mime: 'video/mp4',
      offset,
      size: bytes.length,
      mtimeMs: 1,
    };
  };
  const laneUrl = (id) => `https://relay.test/media/${id}`;
  await withFetch(
    async () => new Response(null, { status: 503 }),
    async () => {
      // Old host: no lease in its answer.
      const old = createRemotePreviewApi(hostCall({}), laneUrl);
      assert.equal((await old.previewProjectFile('p', 'a.mp4')).url, 'blob:test/fallback');
      // New host, but this browser has no lane (no worker / old host handshake).
      const noLane = createRemotePreviewApi(hostCall({ mediaAssetId: 'aaaaaaaa-1111' }), () => '');
      assert.equal((await noLane.previewProjectFile('p', 'a.mp4')).url, 'blob:test/fallback');
      // Lane advertised but the relay or host refuses it (version skew).
      const refused = createRemotePreviewApi(hostCall({ mediaAssetId: 'aaaaaaaa-1111' }), laneUrl);
      assert.equal((await refused.previewProjectFile('p', 'a.mp4')).url, 'blob:test/fallback');
    }
  );
  await withFetch(
    async () => {
      throw new TypeError('network');
    },
    async () => {
      const failing = createRemotePreviewApi(hostCall({ mediaAssetId: 'aaaaaaaa-1111' }), laneUrl);
      assert.equal((await failing.previewProjectFile('p', 'b.mp4')).url, 'blob:test/fallback');
    }
  );
  // Documents are never streamed: pdf keeps its own path even with a lease.
  const pdf = createRemotePreviewApi(async () => {
    return { kind: 'pdf', mime: 'application/pdf', mtimeMs: 1, size: 1e12, mediaAssetId: 'aaaaaaaa-1111' };
  }, laneUrl);
  await assert.rejects(pdf.previewProjectFile('p', 'x.pdf'), /too large/);
});

test('page references resolve inside the project only', () => {
  assert.equal(resolvePageReference('site/index.html', 'css/a.css?v=1'), 'site/css/a.css');
  assert.equal(resolvePageReference('site/index.html', '../shared/a.js'), 'shared/a.js');
  assert.equal(resolvePageReference('site/index.html', '/root.png'), 'root.png');
  assert.equal(resolvePageReference('index.html', '../escape.png'), '');
  assert.equal(resolvePageReference('index.html', 'https://x.test/a.js'), '');
  assert.equal(resolvePageReference('index.html', '//x.test/a.js'), '');
  assert.equal(resolvePageReference('index.html', 'data:image/png;base64,AA'), '');
});

test('a page is inlined with its relative assets and unresolved ones are kept', async () => {
  const host = fakeHost({
    'site/index.html': file(
      '<link rel="stylesheet" href="a.css"><script src="app.js"></script><img src="p.png"><img src="gone.png"><script src="https://cdn.test/x.js"></script>',
      'text/html'
    ),
    'site/a.css': file('body{color:red}', 'text/css'),
    'site/app.js': file('var s="</script>";', 'text/javascript'),
    'site/p.png': file('PNG', 'image/png'),
  });
  const html = await buildPageSrcdoc(host.call, 'p', 'site/index.html', null);
  assert.match(html, /<style>body\{color:red\}<\/style>/);
  assert.match(html, /<script>var s="<\\\/script>";<\/script>/);
  assert.match(html, /src="data:image\/png;base64,UE5H"/);
  assert.match(html, /src="gone\.png"/);
  assert.match(html, /src="https:\/\/cdn\.test\/x\.js"/);
});

const b64 = (text) => Buffer.from(text).toString('base64');

test('a deferred classic script stays deferred: it becomes a data: script, not inline text', async () => {
  const host = fakeHost({
    'site/index.html': file(
      '<head><script src="boot.js" defer></script><script src="now.js"></script></head><body><p id="x"></p></body>',
      'text/html'
    ),
    'site/boot.js': file('document.getElementById("x").textContent = "ok";', 'text/javascript'),
    'site/now.js': file('var now = 1;', 'text/javascript'),
  });
  const html = await buildPageSrcdoc(host.call, 'p', 'site/index.html', null);
  const [deferred, inline] = new DOMParser().parseFromString(html, 'text/html').querySelectorAll('script');
  assert.equal(deferred.hasAttribute('defer'), true);
  assert.equal(deferred.textContent, '');
  assert.equal(
    deferred.getAttribute('src'),
    `data:text/javascript;base64,${b64('document.getElementById("x").textContent = "ok";')}`
  );
  assert.equal(inline.hasAttribute('src'), false);
  assert.equal(inline.textContent, 'var now = 1;');
});

test('stylesheets inline their @imports, url() images and fonts against their own folder', async () => {
  const host = fakeHost({
    'site/index.html': file(
      '<link rel="stylesheet" href="css/main.css" media="screen"><style>.hero{background:url(img/bg.png)}</style><div style="background-image:url(\'img/bg.png\')"></div>',
      'text/html'
    ),
    'site/css/main.css': file(
      '@import "base.css";@import url(print.css) print;body{background:url(../img/bg.png)}',
      'text/css'
    ),
    'site/css/base.css': file('@font-face{font-family:F;src:url("../fonts/f.woff2") format("woff2")}', 'text/css'),
    'site/css/print.css': file('p{color:black}', 'text/css'),
    'site/fonts/f.woff2': file('WOFF', 'font/woff2'),
    'site/img/bg.png': file('PNG', 'image/png'),
  });
  const html = await buildPageSrcdoc(host.call, 'p', 'site/index.html', null);
  assert.match(html, /<style media="screen">/);
  // The imported sheet is inlined, and its font resolves against css/.
  assert.match(html, new RegExp(`src:url\\("data:font/woff2;base64,${b64('WOFF')}"\\) format\\("woff2"\\)`));
  assert.match(html, /@media print\{p\{color:black\}\}/);
  assert.doesNotMatch(html, /@import/);
  // url() in sheets, <style> blocks and style attributes alike.
  assert.equal(
    html.match(
      new RegExp(
        `url\\(&quot;data:image/png;base64,${b64('PNG')}&quot;\\)|url\\("data:image/png;base64,${b64('PNG')}"\\)`,
        'g'
      )
    ).length,
    3
  );
  // Each file is read once, however often it is referenced.
  assert.equal(host.calls.filter((call) => call[2] === 'site/img/bg.png').length, 1);
});

test('srcset candidates, posters and nested frame pages are inlined; outside ones are kept', async () => {
  const host = fakeHost({
    'index.html': file(
      '<img srcset="a.png 1x, https://cdn.test/b.png 2x, missing.png 3x"><picture><source srcset="w.webp"></picture>' +
        '<video poster="poster.jpg" src="clip.mp4"></video><iframe src="inner/frame.html"></iframe><iframe src="https://x.test/"></iframe>',
      'text/html'
    ),
    'a.png': file('A', 'image/png'),
    'w.webp': file('W', 'image/webp'),
    'poster.jpg': file('J', 'image/jpeg'),
    'clip.mp4': file('M', 'video/mp4'),
    'inner/frame.html': file('<img src="pic.png"><p>inner</p>', 'text/html'),
    'inner/pic.png': file('P', 'image/png'),
  });
  const html = await buildPageSrcdoc(host.call, 'p', 'index.html', null);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  assert.equal(
    doc.querySelector('img').getAttribute('srcset'),
    `data:image/png;base64,${b64('A')} 1x, https://cdn.test/b.png 2x, missing.png 3x`
  );
  assert.equal(doc.querySelector('source').getAttribute('srcset'), `data:image/webp;base64,${b64('W')}`);
  assert.equal(doc.querySelector('video').getAttribute('poster'), `data:image/jpeg;base64,${b64('J')}`);
  const [inner, outside] = doc.querySelectorAll('iframe');
  assert.equal(inner.hasAttribute('src'), false);
  // The nested page's own assets resolve against its folder.
  assert.match(inner.getAttribute('srcdoc'), new RegExp(`<img src="data:image/png;base64,${b64('P')}"><p>inner</p>`));
  assert.equal(outside.getAttribute('src'), 'https://x.test/');
});

test('module scripts get their relative imports as data: modules; bare, outside and cyclic ones stay', async () => {
  const host = fakeHost({
    'app/index.html': file(
      '<script type="module">import { a } from "./lib/a.js"; import "https://cdn.test/x.js"; import("./lib/b.js");</script><script type="module" src="lib/main.js"></script><script>import("./lib/a.js")</script>',
      'text/html'
    ),
    'app/lib/a.js': file('export { b } from "./b.js"; export const a = 1;', 'text/javascript'),
    'app/lib/b.js': file('import "./a.js"; export const b = 2;', 'text/javascript'),
    'app/lib/main.js': file('import lodash from "lodash"; import { a } from "./a.js";', 'text/javascript'),
  });
  const html = await buildPageSrcdoc(host.call, 'p', 'app/index.html', null);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const [inline, main, classic] = doc.querySelectorAll('script');
  const decode = (url) => Buffer.from(url.replace(/^data:text\/javascript;base64,/, ''), 'base64').toString();
  const specifiers = (text) => [...text.matchAll(/(["'])(data:[^"']+|[^"']+)\1/g)].map((match) => match[2]);
  const [aUrl, external, bUrl] = specifiers(inline.textContent);
  assert.match(aUrl, /^data:text\/javascript;base64,/);
  assert.equal(external, 'https://cdn.test/x.js');
  assert.match(bUrl, /^data:text\/javascript;base64,/);
  // a.js re-exports b.js (inlined); b.js imports a.js back: the cycle stays a specifier.
  const aText = decode(aUrl);
  assert.match(aText, /export \{ b \} from "data:text\/javascript;base64,/);
  assert.match(decode(specifiers(aText)[0]), /import "\.\/a\.js"; export const b = 2;/);
  // An external module file is inlined too, resolving against its own folder.
  assert.equal(main.hasAttribute('src'), false);
  assert.match(main.textContent, /import lodash from "lodash"; import \{ a \} from "data:text\/javascript;base64,/);
  // A classic script is left as written.
  assert.equal(classic.textContent, 'import("./lib/a.js")');
});

test('bare names the import map sends to project files become map entries for one shared data: module', async () => {
  const map = {
    imports: {
      three: './lib/three.module.js',
      'three/addons/': './lib/jsm/',
      cdn: 'https://cdn.test/cdn.js',
    },
    scopes: { './lib/': { other: './lib/other.js' } },
  };
  const host = fakeHost({
    'app/index.html': file(
      `<script type="importmap">${JSON.stringify(map)}</script>` +
        '<script type="module">import * as THREE from "three"; import { OrbitControls } from "three/addons/controls/OrbitControls.js"; import "cdn"; import "unmapped";</script>' +
        '<script type="module" src="main.js"></script>',
      'text/html'
    ),
    'app/main.js': file('import * as T from "./lib/three.module.js";', 'text/javascript'),
    'app/lib/three.module.js': file('export * from "./three.core.js";', 'text/javascript'),
    'app/lib/three.core.js': file('export const REVISION = "1";', 'text/javascript'),
    'app/lib/jsm/controls/OrbitControls.js': file(
      'import { REVISION } from "three"; import { u } from "../utils/u.js";',
      'text/javascript'
    ),
    'app/lib/jsm/utils/u.js': file('import "three"; export const u = 1;', 'text/javascript'),
  });
  const html = await buildPageSrcdoc(host.call, 'p', 'app/index.html', null);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const [mapScript, inline, main] = doc.querySelectorAll('script');
  const decode = (url) => Buffer.from(url.replace(/^data:text\/javascript;base64,/, ''), 'base64').toString();
  const rewritten = JSON.parse(mapScript.textContent);
  const three = rewritten.imports.three;
  // The bare imports stay bare; the map now names the inlined files for them.
  assert.equal(
    inline.textContent,
    'import * as THREE from "three"; import { OrbitControls } from "three/addons/controls/OrbitControls.js"; import "cdn"; import "unmapped";'
  );
  assert.match(decode(three), /^export \* from "data:text\/javascript;base64,/);
  const controls = decode(rewritten.imports['three/addons/controls/OrbitControls.js']);
  assert.match(controls, /^import \{ REVISION \} from "three"; import \{ u \} from "data:text\/javascript;base64,/);
  // A relative import of the same file is the very same module (one URL).
  assert.equal(main.textContent, `import * as T from "${three}";`);
  // Outside addresses, the prefix entry and the rest of the map are kept.
  assert.equal(rewritten.imports['three/addons/'], './lib/jsm/');
  assert.equal(rewritten.imports.cdn, 'https://cdn.test/cdn.js');
  assert.equal(rewritten.imports.unmapped, undefined);
  assert.deepEqual(rewritten.scopes, map.scopes);
  // Each file is read once.
  assert.equal(host.calls.filter((call) => call[2] === 'app/lib/three.module.js').length, 1);
});

test('import-looking text in strings, comments, templates and regexes is not rewritten', async () => {
  const source = [
    'const s = "import x from \'./lib/a.js\'";',
    'const t = \'export { a } from "./lib/a.js"\';',
    '// import "./lib/a.js"',
    '/* import("./lib/a.js") */',
    'const u = `import "./lib/a.js" ${1 + 1} import("./lib/a.js")`;',
    'const r = /import "\\.\\/lib\\/a.js"/; const d = 4 / 2; obj.import("./lib/a.js");',
    'import { a } from "./lib/a.js";',
  ].join('\n');
  const host = fakeHost({
    'app/index.html': file(`<script type="module">${source}</script>`, 'text/html'),
    'app/lib/a.js': file('export const a = 1;', 'text/javascript'),
  });
  const html = await buildPageSrcdoc(host.call, 'p', 'app/index.html', null);
  const text = new DOMParser().parseFromString(html, 'text/html').querySelector('script').textContent;
  const lines = text.split('\n');
  assert.equal(lines.slice(0, 6).join('\n'), source.split('\n').slice(0, 6).join('\n'));
  assert.match(lines[6], /^import \{ a \} from "data:text\/javascript;base64,/);
});

test('the inlining budget caps how many assets a page may pull', async () => {
  const files = {
    'index.html': file(Array.from({ length: 70 }, (_, n) => `<img src="i${n}.png">`).join(''), 'text/html'),
  };
  for (let n = 0; n < 70; n += 1) files[`i${n}.png`] = file('x', 'image/png');
  const host = fakeHost(files);
  const html = await buildPageSrcdoc(host.call, 'p', 'index.html', null);
  assert.equal((html.match(/src="data:/g) ?? []).length, 64);
  assert.match(html, /src="i69\.png"/);
});

test('a remote visualize page carries a fetch for its own files only, read through the pane range', async () => {
  const { readRemoteVisualizePane } = await import('./remote-file-preview.ts');
  const calls = [];
  const files = { 'site/index.html': 'page', 'site/data/x.json': '{"n":1}' };
  const call = async (method, params) => {
    calls.push([method, ...params]);
    if (method === 'visualizePaneFile')
      return { kind: 'html', mime: 'text/html', size: 4, mtimeMs: 1, rel: 'site/index.html' };
    const [, , rel, offset, length] = params;
    if (!(rel in files)) throw new Error('This file is not part of the visualize tab.');
    const bytes = Buffer.from(files[rel]).subarray(offset, offset + length);
    return { data: bytes.toString('base64'), mime: 'application/json', offset, size: files[rel].length, mtimeMs: 1 };
  };
  const source = await readRemoteVisualizePane(call, 's1', 'v1', 1);
  assert.equal(source.page, 'site/index.html');
  const reply = await source.fetch('/site/data/x.json');
  assert.equal(Buffer.from(reply.bytes).toString(), '{"n":1}');
  assert.equal(reply.mime, 'application/json');
  // The range call names the tab, the resolved path and this pane's index.
  assert.deepEqual(calls.at(-1).slice(0, 4), ['visualizePaneRange', 's1', 'v1', 'site/data/x.json']);
  assert.equal(calls.at(-1)[6], 1);
  // Outside URLs and climbs out of the root never reach the host.
  const before = calls.length;
  await assert.rejects(source.fetch('https://x.test/a.json'), /own project files/);
  await assert.rejects(source.fetch('/../secret.txt'), /own project files/);
  assert.equal(calls.length, before);
  // The host's own refusal (an unlisted file) surfaces as a failure.
  await assert.rejects(source.fetch('/site/other.bin'), /not part of the visualize tab/);
});

test('remote visualize media streams on the media lane, and falls back to the RPC blob without it', async () => {
  const { readRemoteVisualizePane } = await import('./remote-file-preview.ts');
  globalThis.URL.createObjectURL = () => 'blob:test/pane';
  const bytes = Buffer.from('png');
  const call = (meta) => async (method, params) => {
    if (method === 'visualizePaneFile')
      return { kind: 'image', mime: 'image/png', size: 3, mtimeMs: 1, rel: 'chart.png', ...meta };
    const [, , , offset, length] = params;
    return {
      data: bytes.subarray(offset, offset + length).toString('base64'),
      mime: 'image/png',
      offset,
      size: 3,
      mtimeMs: 1,
    };
  };
  const laneUrl = (id, variant) => `https://relay.test/media/${id}?variant=${variant}`;
  await withFetch(
    async () => new Response(null, { status: 206 }),
    async () => {
      const streamed = await readRemoteVisualizePane(call({ mediaAssetId: 'lease-1' }), 's1', 'v2', 0, laneUrl);
      assert.deepEqual(streamed, { kind: 'image', url: 'https://relay.test/media/lease-1?variant=original' });
      // Older host (no lease) or no lane on this browser: the blob path.
      assert.equal((await readRemoteVisualizePane(call({}), 's1', 'v2', 0, laneUrl)).url, 'blob:test/pane');
      assert.equal(
        (await readRemoteVisualizePane(call({ mediaAssetId: 'lease-1' }), 's1', 'v2', 0, () => '')).url,
        'blob:test/pane'
      );
    }
  );
  await withFetch(
    async () => new Response(null, { status: 404 }),
    async () => {
      // The lane is advertised but does not answer: the blob path.
      assert.equal(
        (await readRemoteVisualizePane(call({ mediaAssetId: 'lease-1' }), 's1', 'v2', 0, laneUrl)).url,
        'blob:test/pane'
      );
    }
  );
});

test('the viewer frame is sandboxed to scripts only, hands the document over on ready, and closes', () => {
  globalThis.window = dom.window;
  const close = openSandboxedPagePreview('<p>x</p>', 'index.html');
  const frame = document.querySelector('iframe');
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(frame.getAttribute('src'), '/preview-frame');
  const posted = [];
  const frameWindow = frame.contentWindow;
  frameWindow.postMessage = (message, target) => posted.push([message, target]);
  const ready = { type: 'mixdog-preview-ready' };
  // A message from anything but the frame is ignored.
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: ready, source: dom.window }));
  assert.equal(posted.length, 0);
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: ready, source: frameWindow }));
  // Only one document is ever delivered.
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: ready, source: frameWindow }));
  // The document arrives with the storage shim ahead of the page's own markup.
  assert.deepEqual(posted, [[{ type: 'mixdog-preview-document', html: sandboxedPageDocument('<p>x</p>') }, '*']]);
  assert.ok(posted[0][0].html.startsWith(`<script>${sandboxStorageShimScript()}</script>`));
  assert.ok(posted[0][0].html.endsWith('<p>x</p>'));
  close();
  assert.equal(document.querySelector('iframe'), null);
});

test('the viewer falls back to srcdoc when the frame route never answers', async () => {
  globalThis.window = dom.window;
  const close = openSandboxedPagePreview('<p>y</p>', 'index.html');
  const frame = document.querySelector('iframe');
  await new Promise((resolve) => setTimeout(resolve, 3100));
  assert.equal(frame.getAttribute('src'), null);
  assert.equal(frame.srcdoc, sandboxedPageDocument('<p>y</p>'));
  assert.ok(frame.srcdoc.endsWith('<p>y</p>'));
  close();
});

/** Runs `sandboxedPageDocument(body)` as the framed page would, with its
 *  parent standing in as a recorder of what the page posts. */
function framedPage(body) {
  const sent = [];
  const page = new JSDOM(sandboxedPageDocument(body), {
    url: 'https://relay.test/preview-frame',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, 'parent', {
        value: { postMessage: (message, target) => sent.push([message, target]) },
      });
    },
  });
  const click = (selector) => {
    const event = new page.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    page.window.document.querySelector(selector).dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { sent, click };
}

test('a link in a previewed page is handed to the app instead of blanking the frame', () => {
  const page = framedPage(
    '<a id="out" href="https://example.com/">out</a><a id="rel" href="other.html"><b id="inner">rel</b></a>' +
      '<a id="hash" href="#part">hash</a><a id="js" href="javascript:void 0">js</a>' +
      '<a id="own" href="https://example.com/own">own</a>' +
      '<script>document.getElementById("own").addEventListener("click", (e) => e.preventDefault())</script>'
  );
  // Before the fix every one of these navigated the frame itself.
  assert.equal(page.click('#out'), true);
  assert.equal(page.click('#inner'), true);
  // The page's objects come from its own realm: compare their data.
  assert.deepEqual(JSON.parse(JSON.stringify(page.sent)), [
    [{ type: PREVIEW_LINK, href: 'https://example.com/' }, '*'],
    [{ type: PREVIEW_LINK, href: 'https://relay.test/other.html' }, '*'],
  ]);
  // In-page anchors stay in the page, but move by replacing the frame's history
  // entry (so phone Back still closes the panel); script links and clicks the
  // page handles stay its own.
  assert.equal(page.click('#hash'), true);
  assert.equal(page.click('#js'), false);
  page.click('#own');
  assert.equal(page.sent.length, 2);
});

test('the app opens only outside web links the framed page hands over, every time', () => {
  globalThis.window = dom.window;
  const opened = [];
  dom.window.open = (...args) => opened.push(args);
  const activation = { isActive: false };
  Object.defineProperty(dom.window.navigator, 'userActivation', { configurable: true, value: activation });
  const close = openSandboxedPagePreview('<p>z</p>', 'index.html');
  const frameWindow = document.querySelector('iframe').contentWindow;
  const link = (href, source = frameWindow) =>
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: PREVIEW_LINK, href }, source }));
  // A page posting the message with no click behind it opens nothing.
  link('https://example.com/?leak=1');
  assert.deepEqual(opened, []);
  activation.isActive = true;
  for (let cycle = 0; cycle < 3; cycle += 1) link('https://example.com/');
  // The app's own origin (where a relative link lands), other schemes and
  // anything not from the frame are ignored.
  link(`${dom.window.location.origin}/secret`);
  link('javascript:alert(1)');
  link('file:///C:/Users/me/.ssh/id_rsa');
  link('https://evil.example/', dom.window);
  assert.deepEqual(opened, [
    ['https://example.com/', '_blank', 'noopener,noreferrer'],
    ['https://example.com/', '_blank', 'noopener,noreferrer'],
    ['https://example.com/', '_blank', 'noopener,noreferrer'],
  ]);
  close();
});

test('media session changes notify subscribers until they unsubscribe', async () => {
  const { getMediaSessionEpoch, notifyMediaSessionChanged, subscribeMediaSession } = await import(
    './remote-file-preview.ts'
  );
  const seen = [];
  const stop = subscribeMediaSession(() => seen.push(getMediaSessionEpoch()));
  const before = getMediaSessionEpoch();
  notifyMediaSessionChanged();
  notifyMediaSessionChanged();
  assert.deepEqual(seen, [before + 1, before + 2]);
  stop();
  notifyMediaSessionChanged();
  assert.equal(seen.length, 2);
});

test('remote preview blob URLs pin while leased, revoke on trim/reclaim once unleased, and refresh mounted previews after backgrounding', async () => {
  _runIdleReclaimForTest();
  await Promise.resolve();
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  let seq = 0;
  const revoked = [];
  URL.createObjectURL = () => `blob:test-${++seq}`;
  URL.revokeObjectURL = (value) => {
    revoked.push(value);
  };
  let visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  let epochBumps = 0;
  const stopMedia = subscribeMediaSession(() => {
    epochBumps += 1;
  });
  try {
    const bytes = new Uint8Array(400_000);
    const host = fakeHost({
      'a.bin': { mime: 'application/octet-stream', bytes },
      'b.bin': { mime: 'application/octet-stream', bytes },
      'c.bin': { mime: 'application/octet-stream', bytes },
      'd.bin': { mime: 'application/octet-stream', bytes },
      'inflight.bin': { mime: 'application/octet-stream', bytes },
    });
    const api = createRemotePreviewApi(host.call);

    const before = totalBudgetedChars();
    const first = await api.previewProjectFile('/p', 'a.bin');
    assert.ok(totalBudgetedChars() - before >= 200_000, 'blob URL bytes are accounted in the shared cache budget');

    // A leased (mounted/active) preview URL must survive budget trim and idle reclaim.
    const releaseFirst = retainBlobPreviewUrl(first.url);
    assert.ok(releaseFirst, 'live blob URL can be leased');
    enforceRendererCacheBudget(0);
    _runIdleReclaimForTest();
    await Promise.resolve();
    assert.deepEqual(revoked, [], 'leased blob URL is not revoked while displayed');

    // Releasing the lease allows budget trim to evict and revoke it.
    releaseFirst();
    enforceRendererCacheBudget(0);
    await Promise.resolve();
    assert.deepEqual(revoked, [first.url], 'budget trim revokes unleased blob URLs');
    assert.equal(retainBlobPreviewUrl(first.url), null, 'revoked blob URL cannot be leased again');

    const second = await api.previewProjectFile('/p', 'b.bin');
    _runIdleReclaimForTest();
    await Promise.resolve();
    assert.deepEqual(revoked, [first.url, second.url], 'idle reclaim revokes unleased blob URLs');

    // Backgrounding respects isPinned: leased and in-flight blob URLs stay alive, unleased ones are revoked,
    // and active in-flight fetches mark visibility return to bump mediaSessionEpoch.
    const third = await api.previewProjectFile('/p', 'c.bin');
    const releaseThird = retainBlobPreviewUrl(third.url);
    assert.ok(releaseThird);
    const fourth = await api.previewProjectFile('/p', 'd.bin');
    const epochBefore = getMediaSessionEpoch();
    visibility = 'hidden';
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    await Promise.resolve();
    assert.deepEqual(
      revoked,
      [first.url, second.url, fourth.url],
      'backgrounding revokes unleased blob URLs while keeping leased (pinned) URLs intact'
    );
    assert.equal(epochBumps, 0, 'hiding does not bump media session epoch yet');

    visibility = 'visible';
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    assert.equal(getMediaSessionEpoch(), epochBefore + 1, 'returning visible refreshes after unpinned eviction');
    assert.equal(epochBumps, 1);
    releaseThird();
    enforceRendererCacheBudget(0);

    // Active in-flight fetch during hidden stays unrevoked and triggers refresh on visibility return.
    let releaseInflight;
    const inflightStarted = new Promise((resolve) => {
      const origCall = host.call;
      host.callWithGate = async (method, params) => {
        if (method !== 'previewProjectFile' && params?.[1] === 'inflight.bin') {
          resolve();
          await new Promise((done) => {
            releaseInflight = done;
          });
        }
        return origCall(method, params);
      };
    });
    const inflightApi = createRemotePreviewApi(host.callWithGate);
    const inflightPromise = inflightApi.previewProjectFile('/p', 'inflight.bin');
    await inflightStarted;
    const epochBeforeInflight = getMediaSessionEpoch();
    visibility = 'hidden';
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    releaseInflight();
    const inflight = await inflightPromise;
    assert.ok(!revoked.includes(inflight.url), 'in-flight blob URL is not silently revoked on hide');
    visibility = 'visible';
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    assert.equal(
      getMediaSessionEpoch(),
      epochBeforeInflight + 1,
      'active in-flight fetch during hide marks visibility return for refresh'
    );
  } finally {
    stopMedia();
    visibility = 'visible';
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
});

test('concurrent remote preview reads enforce byte budget and entry limit once pending reads settle', async () => {
  _runIdleReclaimForTest();
  await Promise.resolve();
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  let seq = 0;
  const revoked = [];
  URL.createObjectURL = () => `blob:concurrent-${++seq}`;
  URL.revokeObjectURL = (value) => {
    revoked.push(value);
  };
  try {
    // 1. Byte budget: 3 concurrent 20 MiB reads (10M chars each = 30M chars > 24M chars budget)
    //    whose metadata sizes match actual byte counts.
    const largeBytes = 20 * 1024 * 1024;
    const largeGates = [];
    const largeCall = async (method, params) => {
      if (method === 'previewProjectFile') {
        return { kind: 'video', mime: 'video/mp4', mtimeMs: 1, size: largeBytes };
      }
      const [, , , offset] = params;
      if (offset === 0) {
        await new Promise((resolve) => {
          largeGates.push(resolve);
        });
      }
      return {
        data: Buffer.alloc(largeBytes).toString('base64'),
        mime: 'video/mp4',
        offset: 0,
        size: largeBytes,
        mtimeMs: 1,
      };
    };
    const budgetApi = createRemotePreviewApi(largeCall);
    const beforeBudget = totalBudgetedChars();
    const largePromises = [
      budgetApi.previewProjectFile('/p', 'big-1.mp4'),
      budgetApi.previewProjectFile('/p', 'big-2.mp4'),
      budgetApi.previewProjectFile('/p', 'big-3.mp4'),
    ];
    while (largeGates.length < 3) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(revoked.length, 0, 'in-flight reads stay pinned until settlement');

    for (const release of largeGates) release();
    const largeResults = await Promise.all(largePromises);
    assert.equal(revoked.length, 0, 'concurrently settled reads stay live across caller continuation');
    assert.equal(largeResults.length, 3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(revoked.length >= 1, 'unleased concurrent reads over budget evict and revoke older blobs after handoff');
    assert.ok(
      totalBudgetedChars() - beforeBudget <= 24 * 1024 * 1024,
      `retained chars (${totalBudgetedChars() - beforeBudget}) must fit within the 24M char budget`
    );

    // 2. Entry limit: 52 concurrent small reads exceed BLOB_CACHE_LIMIT (48) while pending,
    //    stay live across caller resolution, then trim down to 48 once unleased handoffs expire.
    const smallGates = [];
    const smallData = Buffer.from('ok').toString('base64');
    const smallCall = async (method) => {
      if (method === 'previewProjectFile') {
        return { kind: 'image', mime: 'image/png', mtimeMs: 1, size: 2 };
      }
      await new Promise((resolve) => {
        smallGates.push(resolve);
      });
      return { data: smallData, mime: 'image/png', offset: 0, size: 2, mtimeMs: 1 };
    };
    const countApi = createRemotePreviewApi(smallCall);
    const revokedBeforeCount = revoked.length;
    const smallPromises = Array.from({ length: 52 }, (_, i) => countApi.previewProjectFile('/p', `s-${i}.png`));
    while (smallGates.length < 52) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(revoked.length, revokedBeforeCount, 'all 52 pending reads remain pinned until settlement');

    for (const release of smallGates) release();
    const smallResults = await Promise.all(smallPromises);
    assert.equal(
      revoked.length,
      revokedBeforeCount,
      'all 52 concurrently settled previews remain unrevoked when returned to callers'
    );
    assert.equal(smallResults.length, 52);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      revoked.length - revokedBeforeCount,
      4,
      'unleased concurrent reads trim back to BLOB_CACHE_LIMIT (48) once handoff expires'
    );
  } finally {
    _runIdleReclaimForTest();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
});

test('50 concurrent previews return only live URLs and releasing 50 leases trims count and byte caps', async () => {
  _runIdleReclaimForTest();
  await Promise.resolve();
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  let seq = 0;
  const revoked = [];
  const revokedSet = new Set();
  URL.createObjectURL = () => `blob:lease-50-${++seq}`;
  URL.revokeObjectURL = (value) => {
    revoked.push(value);
    revokedSet.add(value);
  };
  try {
    // 1. 50 concurrent small previews: none revoked on return, all 50 leaseable, releasing all 50 trims count to 48.
    const smallGates = [];
    const smallData = Buffer.from('ok').toString('base64');
    const smallApi = createRemotePreviewApi(async (method) => {
      if (method === 'previewProjectFile') {
        return { kind: 'image', mime: 'image/png', mtimeMs: 1, size: 2 };
      }
      await new Promise((resolve) => {
        smallGates.push(resolve);
      });
      return { data: smallData, mime: 'image/png', offset: 0, size: 2, mtimeMs: 1 };
    });
    const smallPromises = Array.from({ length: 50 }, (_, i) => smallApi.previewProjectFile('/p', `c-${i}.png`));
    while (smallGates.length < 50) await new Promise((resolve) => setTimeout(resolve, 0));
    for (const release of smallGates) release();
    const smallPreviews = await Promise.all(smallPromises);
    assert.equal(
      smallPreviews.filter((preview) => revokedSet.has(preview.url)).length,
      0,
      'none of the 50 concurrent preview URLs may be revoked before callers acquire leases'
    );
    const smallLeases = smallPreviews.map((preview) => retainBlobPreviewUrl(preview.url));
    assert.ok(smallLeases.every(Boolean), 'every returned URL from 50 concurrent previews must be leaseable');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(revoked.length, 0, 'all 50 leased URLs stay live while leased');

    for (const release of smallLeases) release();
    assert.equal(revoked.length, 2, 'releasing 50 leases immediately trims back to BLOB_CACHE_LIMIT (48)');
    const liveSmallAfterRelease = smallPreviews.filter((preview) => !revokedSet.has(preview.url));
    assert.equal(liveSmallAfterRelease.length, 48);

    _runIdleReclaimForTest();
    await Promise.resolve();

    // 2. 50 concurrent 2 MiB previews (1M chars each = 50M chars > 24M budget):
    //    all 50 stay live while leased, and releasing all 50 immediately trims within count and byte caps.
    const twoMiB = 2 * 1024 * 1024;
    const chunkBase64 = Buffer.alloc(twoMiB).toString('base64');
    const sizedGates = [];
    const sizedApi = createRemotePreviewApi(async (method) => {
      if (method === 'previewProjectFile') {
        return { kind: 'image', mime: 'image/png', mtimeMs: 1, size: twoMiB };
      }
      await new Promise((resolve) => {
        sizedGates.push(resolve);
      });
      return { data: chunkBase64, mime: 'image/png', offset: 0, size: twoMiB, mtimeMs: 1 };
    });
    const beforeChars = totalBudgetedChars();
    const revokedBeforeSized = revoked.length;
    const sizedPromises = Array.from({ length: 50 }, (_, i) => sizedApi.previewProjectFile('/p', `big-${i}.png`));
    while (sizedGates.length < 50) await new Promise((resolve) => setTimeout(resolve, 0));
    for (const release of sizedGates) release();
    const sizedPreviews = await Promise.all(sizedPromises);
    assert.equal(
      sizedPreviews.filter((preview) => revokedSet.has(preview.url)).length,
      0,
      'none of the 50 concurrent 2 MiB previews may be revoked before lease acquisition'
    );
    const sizedLeases = sizedPreviews.map((preview) => retainBlobPreviewUrl(preview.url));
    assert.ok(sizedLeases.every(Boolean), 'all 50 concurrent 2 MiB preview URLs must be leaseable');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(revoked.length, revokedBeforeSized, 'leased previews stay live even above byte budget');
    assert.ok(totalBudgetedChars() - beforeChars >= 50 * 1024 * 1024, 'all 50 leased previews are accounted in budget');

    for (const release of sizedLeases) release();
    const remainingChars = totalBudgetedChars() - beforeChars;
    const liveSizedAfterRelease = sizedPreviews.filter((preview) => !revokedSet.has(preview.url)).length;
    assert.ok(
      liveSizedAfterRelease <= 48,
      `releasing 50 leases must enforce count limit (got ${liveSizedAfterRelease} live)`
    );
    assert.ok(
      remainingChars <= 24 * 1024 * 1024,
      `releasing 50 leases must enforce 24M char byte budget (got ${remainingChars})`
    );
    assert.ok(
      revoked.length - revokedBeforeSized >= 26,
      'releasing 50 x 2 MiB leases revokes excess blobs immediately without waiting for another insert'
    );
  } finally {
    _runIdleReclaimForTest();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
});

test('releasing an 8 MiB lease while a 46 MiB blob stays leased strictly enforces the 24M byte cap', async () => {
  _runIdleReclaimForTest();
  await Promise.resolve();
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  let seq = 0;
  const revoked = [];
  URL.createObjectURL = () => `blob:strict-cap-${++seq}`;
  URL.revokeObjectURL = (value) => {
    revoked.push(value);
  };
  try {
    const fortySixMiB = 46 * 1024 * 1024;
    const eightMiB = 8 * 1024 * 1024;
    const payload = Buffer.alloc(16).toString('base64');
    const api = createRemotePreviewApi(async (method, params) => {
      const size = params[1] === 'large.bin' ? fortySixMiB : eightMiB;
      if (method === 'previewProjectFile') {
        return { kind: 'video', mime: 'video/mp4', mtimeMs: 1, size };
      }
      return { data: payload, mime: 'video/mp4', offset: 0, size: 16, mtimeMs: 1 };
    });

    const beforeChars = totalBudgetedChars();
    const large = await api.previewProjectFile('/p', 'large.bin');
    const releaseLarge = retainBlobPreviewUrl(large.url);
    assert.ok(releaseLarge, '46 MiB blob must be leaseable');

    const medium = await api.previewProjectFile('/p', 'medium.bin');
    const releaseMedium = retainBlobPreviewUrl(medium.url);
    assert.ok(releaseMedium, '8 MiB blob must be leaseable');

    assert.equal(revoked.length, 0, 'both leased blobs stay live while pinned');
    assert.equal(
      totalBudgetedChars() - beforeChars,
      27 * 1024 * 1024,
      '46 MiB (23M chars) + 8 MiB (4M chars) = 27M chars while both are leased'
    );

    releaseMedium();
    assert.deepEqual(
      revoked,
      [medium.url],
      'releasing the 8 MiB lease immediately evicts it even though 4M fits the shared budget 25% reserve'
    );
    assert.equal(
      totalBudgetedChars() - beforeChars,
      23 * 1024 * 1024,
      'remaining retained chars strictly fit within the 24M cap'
    );
    const verifyLarge = retainBlobPreviewUrl(large.url);
    assert.ok(verifyLarge, 'the 46 MiB leased blob remains live');
    verifyLarge();
    releaseLarge();
    _runIdleReclaimForTest();
    assert.equal(totalBudgetedChars() - beforeChars, 0, 'releasing all leases leaves zero leaked bytes');
  } finally {
    _runIdleReclaimForTest();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
});

test('staggered concurrent reads over budget keep all returned URLs leaseable until Promise.all completes', async () => {
  _runIdleReclaimForTest();
  await Promise.resolve();
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  let seq = 0;
  const revoked = [];
  URL.createObjectURL = () => `blob:staggered-${++seq}`;
  URL.revokeObjectURL = (value) => {
    revoked.push(value);
  };
  try {
    const thirtyMiB = 30 * 1024 * 1024;
    const payload = Buffer.alloc(16).toString('base64');
    let secondRangeStarted;
    const waitSecondRange = new Promise((resolve) => {
      secondRangeStarted = resolve;
    });
    let releaseSecondRange;
    const api = createRemotePreviewApi(async (method, params) => {
      if (method === 'previewProjectFile') {
        return { kind: 'video', mime: 'video/mp4', mtimeMs: 1, size: thirtyMiB };
      }
      if (params[1] === 'second.mp4') {
        secondRangeStarted();
        await new Promise((resolve) => {
          releaseSecondRange = resolve;
        });
      }
      return { data: payload, mime: 'video/mp4', offset: 0, size: 16, mtimeMs: 1 };
    });

    const beforeChars = totalBudgetedChars();
    const firstPromise = api.previewProjectFile('/p', 'first.mp4');
    const secondPromise = api.previewProjectFile('/p', 'second.mp4');
    const batchPromise = Promise.all([firstPromise, secondPromise]);

    // First settles while second is still in flight; wait across macrotasks and invoke
    // shared-budget trimming (simulating an unrelated cache call like composer-draft)
    // to ensure neither post-settlement trim nor shared-budget trim evicts it early.
    const firstSettled = await firstPromise;
    await waitSecondRange;
    await new Promise((resolve) => setTimeout(resolve, 15));
    enforceRendererCacheBudget();
    assert.deepEqual(
      revoked,
      [],
      'earlier-settling read must not be evicted by post-settlement or shared-budget trim while a concurrent read is still in flight'
    );

    releaseSecondRange();
    const [first, second] = await batchPromise;
    assert.equal(first.url, firstSettled.url);
    assert.deepEqual(revoked, [], 'neither staggered URL may be revoked before Promise.all continuation');

    const releaseFirst = retainBlobPreviewUrl(first.url);
    const releaseSecond = retainBlobPreviewUrl(second.url);
    assert.ok(releaseFirst, 'first staggered URL must be leaseable at Promise.all continuation');
    assert.ok(releaseSecond, 'second staggered URL must be leaseable at Promise.all continuation');

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(revoked, [], 'both leased URLs stay live');

    releaseFirst();
    assert.deepEqual(revoked, [first.url], 'releasing first lease trims back within 24M cap');
    assert.equal(totalBudgetedChars() - beforeChars, 15 * 1024 * 1024);
    releaseSecond();
    _runIdleReclaimForTest();
    assert.equal(totalBudgetedChars() - beforeChars, 0);
  } finally {
    _runIdleReclaimForTest();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
});

test('useBlobPreviewLease acquires at layout commit before passive effects, detects pre-render revocation, preserves hold() replacements, and ignores unmanaged blobs', async () => {
  _runIdleReclaimForTest();
  await Promise.resolve();
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  const prevWindow = globalThis.window;
  const prevHTMLElement = globalThis.HTMLElement;
  const prevNode = globalThis.Node;
  const prevElement = globalThis.Element;
  const prevActEnv = globalThis.IS_REACT_ACT_ENVIRONMENT;
  let seq = 0;
  const revoked = [];
  URL.createObjectURL = () => `blob:hook-managed-${++seq}`;
  URL.revokeObjectURL = (value) => {
    revoked.push(value);
  };
  globalThis.window = dom.window;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.Element = dom.window.Element;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    const host = fakeHost({
      'a.png': file('png', 'image/png'),
      'b.png': file('png2', 'image/png'),
    });
    const api = createRemotePreviewApi(host.call);
    const livePreview = await api.previewProjectFile('/p', 'b.png');

    // Declare the reclaiming passive useEffect BEFORE useBlobPreviewLease so this
    // test fails if acquisition ever regresses from useLayoutEffect to useEffect.
    let survivedReclaimInPassiveEffect = false;
    function LayoutOrderProbe({ url }) {
      useEffect(() => {
        _runIdleReclaimForTest();
        survivedReclaimInPassiveEffect = !revoked.includes(url);
      }, [url]);
      useBlobPreviewLease(url, () => {});
      return null;
    }

    await act(async () => {
      root.render(React.createElement(LayoutOrderProbe, { url: livePreview.url }));
    });
    assert.equal(
      survivedReclaimInPassiveEffect,
      true,
      'useBlobPreviewLease must acquire its lease in useLayoutEffect before earlier-declared passive useEffect runs'
    );

    // Replacing a small pending lease via hold() with a newly settled 50 MiB over-budget URL
    // must retain the replacement before releasing the old lease so the replacement is never revoked.
    let controller = null;
    function HoldProbe({ url }) {
      controller = useBlobPreviewLease(url, () => {});
      return null;
    }
    await act(async () => {
      root.render(React.createElement(HoldProbe, { url: '' }));
    });
    const fiftyMiB = 50 * 1024 * 1024;
    const payload = Buffer.alloc(16).toString('base64');
    const sizedApi = createRemotePreviewApi(async (method, params) => {
      const size = params[1] === 'huge.png' ? fiftyMiB : 16;
      if (method === 'previewProjectFile') {
        return { kind: 'image', mime: 'image/png', mtimeMs: 1, size };
      }
      return { data: payload, mime: 'image/png', offset: 0, size: 16, mtimeMs: 1 };
    });
    const small = await sizedApi.previewProjectFile('/p', 'small.png');
    controller.hold(small.url);
    const huge = await sizedApi.previewProjectFile('/p', 'huge.png');
    controller.hold(huge.url);
    assert.ok(!revoked.includes(huge.url), 'hold() replacement must not revoke the incoming 50 MiB URL');
    const verifyHuge = retainBlobPreviewUrl(huge.url);
    assert.ok(verifyHuge, 'incoming 50 MiB URL must remain live and leaseable after hold() replacement');
    verifyHuge();
    controller.releasePending();

    const preview = await api.previewProjectFile('/p', 'a.png');
    // Revoke before any component renders with `preview.url`.
    _runIdleReclaimForTest();
    assert.equal(retainBlobPreviewUrl(preview.url), null);

    let revokedCalls = 0;
    function Probe({ url }) {
      useBlobPreviewLease(url, () => {
        revokedCalls += 1;
      });
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Probe, { url: preview.url }));
    });
    assert.equal(revokedCalls, 1, 'hook notifies caller when a managed blob URL was revoked before first render');

    await act(async () => {
      root.render(React.createElement(Probe, { url: 'blob:unmanaged-external' }));
    });
    assert.equal(revokedCalls, 1, 'hook does not fire onRevoked for unmanaged blob URLs');
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    globalThis.window = prevWindow;
    globalThis.HTMLElement = prevHTMLElement;
    globalThis.Node = prevNode;
    globalThis.Element = prevElement;
    globalThis.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    _runIdleReclaimForTest();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
});
