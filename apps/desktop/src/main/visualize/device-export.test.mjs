// A paired device's PNG / PDF export (`exportForDevice`) while the desktop
// panel cannot draw: the window is hidden, so `capture` must never be used for
// what can be drawn off screen.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { exportTabBytes } from './host-export-path.ts';
import { createVisualizeService } from './service.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-device-export-')));
const cwd = join(root, 'project');
const scratch = join(root, 'tmp');
for (const folder of [cwd, scratch]) mkdirSync(folder);
const savedTemp = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
// Export temp folders land in a private place the tests can list.
Object.assign(process.env, { TMPDIR: scratch, TEMP: scratch, TMP: scratch });
test.after(() => {
  for (const [name, value] of Object.entries(savedTemp)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function setup({ failRender = false, pageCount = 1 } = {}) {
  const requests = [];
  const documents = [];
  const pages = [];
  const renderers = {
    page: async (url, format) => {
      pages.push([url, format]);
      return Buffer.from(`PAGE:${format}`);
    },
    document: async (document) => {
      if (failRender) throw new Error('render failed');
      documents.push(document);
      return Buffer.from(`DOC${documents.length}`);
    },
    readFile: async (path) => readFileSync(path),
    mermaidSource: async () => 'window.mermaid = {};',
    documentPages: async (_file, pages) => {
      requests.push(pages);
      return {
        pageCount: pageCount,
        pages: pages.map((page) => ({ mime: 'image/png', bytes: Buffer.from(`P${page}`) })),
      };
    },
  };
  const deps = {
    windowAvailable: () => true,
    browserAvailable: () => true,
    preparePane: async () => 'fake://pane',
    publish: () => {},
    publishHost: () => {},
    watch: () => () => {},
    annotate: async () => [],
    // The panel is hidden: anything that reaches for it fails.
    capture: async () => {
      throw new Error('the panel is not on screen');
    },
    exportBytes: (_sessionId, tab, format, pane, files, onPagesCut) =>
      exportTabBytes(() => deps.capture(), tab, format, pane, files && { files, renderers, onPagesCut }),
    delay: async () => {},
    reloadDebounceMs: 5,
  };
  return { service: createVisualizeService(deps), documents, pages, requests };
}

const open = (service, input) => service.execute({ sessionId: 's1', cwd, action: 'open', input });
const exportOf = (service, tabId, format = 'png', pane = 0) =>
  service.exportForDevice({ sessionId: 's1', tabId, action: 'export', format, pane });
const bytesOf = (path) => readFileSync(path);
const dropExport = (path) => rmSync(join(path, '..'), { recursive: true, force: true });

test('an image file tab is sent as its own PNG bytes with the panel hidden', async () => {
  const bytes = Buffer.concat([PNG_HEADER, Buffer.from('pixels')]);
  writeFileSync(join(cwd, 'shot.png'), bytes);
  const { service, documents } = setup();
  await open(service, { targets: ['shot.png'] });
  const { path } = await exportOf(service, 'v1');
  assert.deepEqual(bytesOf(path), bytes);
  assert.equal(documents.length, 0);
  dropExport(path);
  service.dispose();
});

test('an image file that is not a PNG is drawn by a hidden window', async () => {
  writeFileSync(join(cwd, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  const { service, documents } = setup();
  await open(service, { targets: ['photo.jpg'] });
  const { path } = await exportOf(service, 'v1');
  assert.equal(bytesOf(path).toString(), 'DOC1');
  assert.match(documents[0].files['index.html'].body.toString(), /<img src="data:image\/jpeg;base64,/);
  dropExport(path);
  service.dispose();
});

test('SVG and Mermaid tabs are drawn by a hidden window with the panel hidden', async () => {
  const { service, documents } = setup();
  await open(service, {
    content: { kind: 'svg', source: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', title: 'Shape' },
  });
  await open(service, { content: { kind: 'mermaid', source: 'graph TD; A-->B', title: 'Flow' } });
  const svg = await exportOf(service, 'v1');
  const mermaid = await exportOf(service, 'v2');
  assert.equal(bytesOf(svg.path).toString(), 'DOC1');
  assert.equal(bytesOf(mermaid.path).toString(), 'DOC2');
  const [svgDoc, mermaidDoc] = documents;
  assert.match(svgDoc.files['index.html'].body.toString(), /<rect\/>/);
  assert.match(svgDoc.files['index.html'].body.toString(), /Content-Security-Policy/);
  assert.match(mermaidDoc.files['index.html'].body.toString(), /graph TD; A-->B/);
  assert.equal(mermaidDoc.files['mermaid.js'].body.toString(), 'window.mermaid = {};');
  assert.ok(mermaidDoc.ready);
  dropExport(svg.path);
  dropExport(mermaid.path);
  service.dispose();
});

test('a comparison tab is drawn pane by pane and laid side by side with the panel hidden', async () => {
  const { service, documents } = setup();
  await open(service, { content: { kind: 'markdown', source: '# One', title: 'Notes' } });
  await open(service, { content: { kind: 'markdown', source: '# Two', title: 'Notes' } });
  await service.command({ sessionId: 's1', tabId: 'v1', action: 'version', version: 1, compare: true });
  const { path } = await exportOf(service, 'v1');
  assert.equal(documents.length, 3);
  assert.match(documents[0].files['index.html'].body.toString(), /<h1>One<\/h1>/);
  assert.match(documents[1].files['index.html'].body.toString(), /<h1>Two<\/h1>/);
  const row = documents[2].files;
  assert.deepEqual(Object.keys(row).sort(), ['index.html', 'pane-0.png', 'pane-1.png']);
  assert.equal(row['pane-0.png'].body.toString(), 'DOC1');
  assert.equal(row['pane-1.png'].body.toString(), 'DOC2');
  assert.equal(bytesOf(path).toString(), 'DOC3');
  dropExport(path);
  service.dispose();
});

test('a PDF file tab is sent as its own bytes for PDF and as its page for PNG, panel hidden', async () => {
  const pdf = Buffer.from('%PDF-1.7 body');
  writeFileSync(join(cwd, 'doc.pdf'), pdf);
  const { service, requests } = setup();
  await open(service, { targets: ['doc.pdf'] });
  const exported = await exportOf(service, 'v1', 'pdf');
  assert.deepEqual(bytesOf(exported.path), pdf);
  const png = await exportOf(service, 'v1', 'png');
  assert.equal(bytesOf(png.path).toString(), 'P1');
  assert.equal(png.pages, undefined, 'nothing is cut from a one-page document');
  assert.deepEqual(requests, [[1]]);
  dropExport(exported.path);
  dropExport(png.path);
  service.dispose();
});

test('a multi-page document is stacked page by page, capped, with the panel hidden', async () => {
  writeFileSync(join(cwd, 'deck.pdf'), Buffer.from('%PDF'));
  const { service, documents, requests } = setup({ pageCount: 12 });
  await open(service, { targets: ['deck.pdf'] });
  const { path, pages } = await exportOf(service, 'v1', 'png');
  assert.deepEqual(pages, { included: 8, total: 12 }, 'the cut is reported for the download row');
  assert.deepEqual(requests, [[1], [2, 3, 4, 5], [6, 7, 8]]);
  const html = documents[0].files['index.html'].body.toString();
  assert.equal(html.match(/<img /g).length, 8);
  assert.equal(bytesOf(path).toString(), 'DOC1');
  dropExport(path);
  service.dispose();
});

test('an audio pane can only be exported through the panel', async () => {
  writeFileSync(join(cwd, 'clip.mp3'), Buffer.from('ID3'));
  const { service } = setup();
  await open(service, { targets: ['clip.mp3'] });
  await assert.rejects(exportOf(service, 'v1', 'png'), /panel is not on screen/);
  assert.deepEqual(readdirSync(scratch), []);
  service.dispose();
});

test('a failed device export removes its temp folder', async () => {
  const { service } = setup({ failRender: true });
  await open(service, { content: { kind: 'svg', source: '<svg></svg>', title: 'Shape' } });
  assert.deepEqual(readdirSync(scratch), []);
  await assert.rejects(exportOf(service, 'v1'), /render failed/);
  assert.deepEqual(readdirSync(scratch), [], 'the request-owned temp folder is gone');
  await assert.rejects(exportOf(service, 'v1', 'pdf'), /Save as PDF is for HTML pages/);
  assert.deepEqual(readdirSync(scratch), []);
  service.dispose();
});

test('a finished device export leaves its temp folder to the download', async () => {
  const { service } = setup();
  await open(service, { content: { kind: 'svg', source: '<svg></svg>', title: 'Shape' } });
  const { path } = await exportOf(service, 'v1');
  assert.equal(readdirSync(scratch).length, 1);
  dropExport(path);
  service.dispose();
});
