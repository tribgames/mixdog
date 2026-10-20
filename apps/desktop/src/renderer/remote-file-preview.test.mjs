import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  buildPageSrcdoc,
  createRemotePreviewApi,
  readRemoteFile,
  REMOTE_PREVIEW_CHUNK_BYTES,
  resolvePageReference,
} from './remote-file-preview.ts';
import { openSandboxedPagePreview, PREVIEW_LINK, sandboxedPageDocument } from './sandboxed-page-preview.ts';
import { sandboxStorageShimScript } from '../shared/sandbox-storage-shim.ts';

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.DOMParser = dom.window.DOMParser;
globalThis.document = dom.window.document;

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
  const { readRemoteVisualizePane, PAGE_FETCH_MAX_BYTES } = await import('./remote-file-preview.ts');
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
  assert.equal(PAGE_FETCH_MAX_BYTES, 16 * 1024 * 1024);
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
  const close = openSandboxedPagePreview('<p>z</p>', 'index.html');
  const frameWindow = document.querySelector('iframe').contentWindow;
  const link = (href, source = frameWindow) =>
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: PREVIEW_LINK, href }, source }));
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
  const { dropMediaSession } = await import('./remote-shim-socket.ts');
  const seen = [];
  const stop = subscribeMediaSession(() => seen.push(getMediaSessionEpoch()));
  const before = getMediaSessionEpoch();
  notifyMediaSessionChanged();
  // Dropping an authenticated session (reconnect) revokes it and notifies.
  const ctx = { mediaSid: 'sid-1', peerMediaE2ee: true };
  dropMediaSession(ctx);
  assert.equal(ctx.mediaSid, null);
  // No session to drop: nothing changed.
  dropMediaSession(ctx);
  assert.deepEqual(seen, [before + 1, before + 2]);
  stop();
  notifyMediaSessionChanged();
  assert.equal(seen.length, 2);
});
