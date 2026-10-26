import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { waitUntil } from '../bounded-wait.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MAX_VISUALIZE_HISTORY, remoteVisualizeState } from '../../shared/visualize.ts';
import { createRemoteVisualizeMethods, createRemoteVisualizeMirror } from '../remote-visualize.ts';
import {
  exportProblemLine,
  exportRequestAllowed,
  failedRequestLine,
  MAX_EXPORT_PIXELS,
  planPngExport,
} from './export-render.ts';
import { inlineExtension, mockupSlug, saveInlineToProject } from './export.ts';
import { historyId, historyItems, MAX_HISTORY_INLINE_BYTES, rememberHistory } from './history.ts';
import { createVisualizeService } from './service.ts';
import { parseVisualizeRequest } from './targets.ts';
import { writeExportFile } from './export.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-history-')));
test.after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function project() {
  counter += 1;
  const cwd = join(root, `p${counter}`);
  mkdirSync(cwd, { recursive: true });
  return realpathSync(cwd);
}

function setup(cwd, extra = {}) {
  const events = [];
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => true,
    preparePane: async (target) => `fake://${target.label}`,
    publish: (event) => events.push(event),
    publishHost: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    delay: async () => {},
    reloadDebounceMs: 5,
    ...extra,
  });
  const open = (input, sessionId = 's1') => service.execute({ sessionId, cwd, action: 'open', input });
  return { service, events, open };
}

const entry = (key, extra = {}) => ({
  id: historyId(key),
  key,
  label: key,
  remoteLabel: key,
  kind: 'html',
  targets: [key],
  at: 1,
  versions: 1,
  ...extra,
});

test('history keeps the newest entry per key first and is capped', () => {
  let list = [];
  for (let n = 0; n < MAX_VISUALIZE_HISTORY + 5; n += 1) list = rememberHistory(list, entry(`k${n}`));
  assert.equal(list.length, MAX_VISUALIZE_HISTORY);
  assert.equal(list[0].key, `k${MAX_VISUALIZE_HISTORY + 4}`);
  assert.equal(list.at(-1).key, 'k5', 'the oldest fall out first');
  list = rememberHistory(list, entry('k10', { at: 9 }));
  assert.equal(list[0].key, 'k10');
  assert.equal(list.filter((item) => item.key === 'k10').length, 1, 'a reopened key replaces its old entry');
});

test('inline sources in the history stay within a byte budget, newest kept', () => {
  const big = 'x'.repeat(512 * 1024);
  let list = [];
  for (let n = 0; n < 12; n += 1) {
    list = rememberHistory(list, entry(`i${n}`, { kind: 'svg', targets: [], content: { kind: 'svg', source: big } }));
  }
  const bytes = list.reduce((sum, item) => sum + Buffer.byteLength(item.content?.source ?? ''), 0);
  assert.ok(bytes <= MAX_HISTORY_INLINE_BYTES);
  assert.equal(list[0].key, 'i11');
  assert.ok(list.length < 12);
});

test('history items mark open entries and take the remote label for clients', () => {
  const list = [entry('a', { label: '/home/me/secret/a.html', remoteLabel: 'a.html', versions: 2 }), entry('b')];
  const items = historyItems(list, new Map([['a', 5]]), false);
  assert.deepEqual(
    items.map((item) => [item.label, item.open, item.versions]),
    [
      ['/home/me/secret/a.html', true, 5],
      ['b', false, 1],
    ]
  );
  assert.equal(historyItems(list, new Map(), true)[0].label, 'a.html');
});

test('the session list covers closed tabs and reopening an entry takes no agent turn', async () => {
  const cwd = project();
  writeFileSync(join(cwd, 'one.html'), '<p>1</p>');
  writeFileSync(join(cwd, 'two.html'), '<p>2</p>');
  const { service, open } = setup(cwd);
  await open({ targets: ['one.html'] });
  await open({ content: { kind: 'mermaid', source: 'graph TD; A-->B', title: 'Flow' } });
  await open({ targets: ['two.html'] });
  let state = service.snapshot()[0];
  assert.deepEqual(
    state.history.map((item) => [item.label, item.kind, item.open]),
    [
      ['two.html', 'html', true],
      ['Flow', 'mermaid', true],
      ['one.html', 'html', true],
    ]
  );

  await service.command({ sessionId: 's1', tabId: 'v1', action: 'close' });
  await service.command({ sessionId: 's1', tabId: 'v2', action: 'close' });
  state = service.snapshot()[0];
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    ['v3']
  );
  assert.deepEqual(
    state.history.map((item) => item.open),
    [true, false, false]
  );

  // A closed entry opens again; an open one is only selected.
  const flow = state.history.find((item) => item.label === 'Flow');
  await service.command({ sessionId: 's1', tabId: '', action: 'history', entry: flow.id });
  state = service.snapshot()[0];
  assert.equal(state.tabs.at(-1).panes[0].inline.source, 'graph TD; A-->B');
  assert.equal(state.active, state.tabs.at(-1).id);
  const two = state.history.find((item) => item.label === 'two.html');
  await service.command({ sessionId: 's1', tabId: '', action: 'history', entry: two.id });
  assert.equal(service.snapshot()[0].active, 'v3');
  assert.equal(service.snapshot()[0].tabs.length, 2, 'no duplicate tab');

  // Closing everything keeps the list; it survives in snapshots.
  await service.execute({ sessionId: 's1', cwd, action: 'close', input: {} });
  state = service.snapshot()[0];
  assert.deepEqual(state.tabs, []);
  assert.equal(state.history.length, 3);
  assert.ok(state.history.every((item) => !item.open));
  await assert.rejects(
    service.command({ sessionId: 's1', tabId: '', action: 'history', entry: 'nope' }),
    /no longer in this session/
  );
});

test('the remote view of the list is path-free and sessions stay separate', async () => {
  const cwd = project();
  writeFileSync(join(cwd, 'page.html'), '<p>x</p>');
  const hosts = [];
  const { service, open } = setup(cwd, { publishHost: (event) => hosts.push(event) });
  await open({ targets: [join(cwd, 'page.html')], label: `Page at ${cwd}` });
  await open({ content: { kind: 'svg', source: '<svg/>' } }, 's2');
  const host = service.hostSnapshot().find((state) => state.sessionId === 's1');
  assert.equal(host.history[0].label, 'page.html', 'a label naming a host path is replaced');
  const remote = remoteVisualizeState(host);
  assert.equal(JSON.stringify(remote).includes(cwd), false);
  assert.equal(service.snapshot().find((state) => state.sessionId === 's2').history.length, 1);
  assert.equal(service.snapshot().find((state) => state.sessionId === 's1').history.length, 1);
});

test('mockup slugs are file-name safe and unicode-aware', () => {
  assert.equal(mockupSlug('Sales — Q3 / 2025!', 'x'), 'sales-q3-2025');
  assert.equal(mockupSlug('대시보드 시안', 'x'), '대시보드-시안');
  assert.equal(mockupSlug('***', 'svg'), 'svg');
  assert.equal(mockupSlug('con', 'x'), 'con-mockup');
  assert.ok(mockupSlug('a'.repeat(200), 'x').length <= 48);
  assert.deepEqual(['mermaid', 'svg', 'chart', 'html', 'markdown'].map(inlineExtension), [
    'mmd',
    'svg',
    'json',
    'html',
    'md',
  ]);
});

test('save to project writes design/mockups/<slug>/<slug>.<ext> and never overwrites', async () => {
  const cwd = project();
  const content = { kind: 'svg', source: '<svg xmlns="http://www.w3.org/2000/svg"/>', title: 'Logo' };
  const first = await saveInlineToProject(cwd, content, 'Logo');
  assert.equal(first.rel, 'design/mockups/logo/logo.svg');
  assert.equal(first.openable, true, 'an svg opens as an image tab');
  assert.equal(readFileSync(first.path, 'utf8'), content.source);
  const second = await saveInlineToProject(cwd, { ...content, source: '<svg>2</svg>' }, 'Logo');
  assert.equal(second.rel, 'design/mockups/logo-2/logo-2.svg');
  const third = await saveInlineToProject(cwd, { ...content, source: '<svg>3</svg>' }, 'Logo');
  assert.equal(third.rel, 'design/mockups/logo-3/logo-3.svg');
  assert.equal(readFileSync(first.path, 'utf8'), content.source, 'the first file is untouched');
  const diagram = await saveInlineToProject(cwd, { kind: 'mermaid', source: 'graph TD; A-->B' }, 'Flow');
  assert.equal(diagram.rel, 'design/mockups/flow/flow.mmd');
  assert.equal(diagram.openable, false, 'a .mmd file is not a panel kind');
});

test('save to project refuses to leave the working directory through a link', async (t) => {
  const cwd = project();
  const outside = join(root, `outside-${counter}`);
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(cwd, 'design'), { recursive: true });
  try {
    symlinkSync(outside, join(cwd, 'design', 'mockups'), 'junction');
  } catch {
    t.skip('symlinks are unavailable here');
    return;
  }
  await assert.rejects(
    saveInlineToProject(cwd, { kind: 'html', source: '<p/>', title: 'Page' }, 'Page'),
    /outside the working directory/
  );
  assert.equal(existsSync(join(outside, 'page')), false);
});

test('a folder swapped for a link between validation and the write puts no file outside cwd', async (t) => {
  const cwd = project();
  const outside = join(root, `swap-outside-${counter}`);
  mkdirSync(outside, { recursive: true });
  const folder = join(cwd, 'design', 'mockups', 'page');
  let swapped = false;
  const result = await saveInlineToProject(cwd, { kind: 'html', source: '<p/>', title: 'Page' }, 'Page', {
    beforeOpen() {
      try {
        renameSync(folder, `${folder}-moved`);
        symlinkSync(outside, folder, 'junction');
        swapped = true;
      } catch {
        // links unavailable: the save simply succeeds below
      }
    },
  }).catch((error) => error);
  if (!swapped) {
    t.skip('symlinks are unavailable here');
    return;
  }
  assert.ok(result instanceof Error, 'the swapped write is refused');
  assert.match(result.message, /changed while it was restored|outside the working directory/);
  assert.deepEqual(readdirSync(outside), [], 'nothing was left outside the working directory');
});

test('a parent already replaced by a link is refused before anything is created', async (t) => {
  const cwd = project();
  const outside = join(root, `pre-outside-${counter}`);
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(cwd, 'design'), { recursive: true });
  try {
    symlinkSync(outside, join(cwd, 'design', 'mockups'), 'junction');
  } catch {
    t.skip('symlinks are unavailable here');
    return;
  }
  await assert.rejects(
    saveInlineToProject(cwd, { kind: 'svg', source: '<svg/>' }, 'x'),
    /outside the working directory/
  );
  assert.deepEqual(readdirSync(outside), []);
});

test('an existing file is never overwritten, even one that appears after the check', async () => {
  const cwd = project();
  const content = { kind: 'markdown', source: 'new', title: 'Doc' };
  const first = await saveInlineToProject(cwd, content, 'Doc');
  const second = await saveInlineToProject(cwd, { ...content, source: 'later' }, 'Doc', {
    beforeOpen() {
      writeFileSync(join(cwd, 'design', 'mockups', 'doc-2', 'doc-2.md'), 'raced');
    },
  });
  assert.equal(readFileSync(first.path, 'utf8'), 'new');
  assert.equal(second.rel, 'design/mockups/doc-3/doc-3.md');
  assert.equal(readFileSync(join(cwd, 'design/mockups/doc-2/doc-2.md'), 'utf8'), 'raced');
});

test('export command: project saves inline content, files refuse it, png/pdf use the dialog', async () => {
  const cwd = project();
  writeFileSync(join(cwd, 'page.html'), '<p>x</p>');
  const calls = [];
  const { service, open } = setup(cwd, {
    chooseExportPath: async (request) => {
      calls.push(['choose', request.name, request.format, request.directory.endsWith(join('design', 'mockups'))]);
      return request.format === 'png' ? join(cwd, 'out.png') : null;
    },
    exportBytes: async (_session, tab, format, pane) => {
      calls.push(['bytes', tab.id, format, pane]);
      return Buffer.from(format);
    },
  });
  await open({ content: { kind: 'html', source: '<h1>Hi</h1>', title: 'Landing' } });
  await open({ targets: ['page.html'] });

  const saved = await service.command({ sessionId: 's1', tabId: 'v1', action: 'export', format: 'project' });
  assert.deepEqual(saved, { path: 'design/mockups/landing/landing.html', openable: true });
  assert.equal(readFileSync(join(cwd, saved.path), 'utf8'), '<h1>Hi</h1>');
  await assert.rejects(
    service.command({ sessionId: 's1', tabId: 'v2', action: 'export', format: 'project' }),
    /only inline content/
  );

  // The opened-as-tab offer is the ordinary reopen path: the saved file opens.
  await service.command({ sessionId: 's1', tabId: 'v1', action: 'reopen', targets: [saved.path] });
  assert.ok(service.snapshot()[0].tabs.some((tab) => tab.panes[0].label === 'landing.html'));

  assert.deepEqual(await service.command({ sessionId: 's1', tabId: 'v2', action: 'export', format: 'png' }), {
    path: join(cwd, 'out.png'),
  });
  assert.deepEqual(await service.command({ sessionId: 's1', tabId: 'v2', action: 'export', format: 'pdf' }), {
    canceled: true,
  });
  assert.deepEqual(calls, [
    ['choose', 'page-html.png', 'png', true],
    ['bytes', 'v2', 'png', 0],
    ['choose', 'page-html.pdf', 'pdf', true],
  ]);
  assert.equal(readFileSync(join(cwd, 'out.png'), 'utf8'), 'png');
  // Only HTML pages offer a PDF.
  const inlineSvg = await open({ content: { kind: 'svg', source: '<svg/>', title: 'S' } });
  await assert.rejects(
    service.command({ sessionId: 's1', tabId: inlineSvg.tabs[0].id, action: 'export', format: 'pdf' }),
    /PDF is for HTML/
  );
});

test('the PNG size cap counts physical pixels, not CSS pixels', () => {
  // Ordinary pages pass at their own size, whatever the scale.
  assert.deepEqual(planPngExport(1264, 835, 1), { ok: true, width: 1264, height: 835 });
  assert.deepEqual(planPngExport(1264.2, 835.5, 2), { ok: true, width: 1265, height: 836 });
  // 4096×16384 CSS px is 67 MP even at 1×, ~268 MP at 2×: both refused.
  for (const scale of [1, 2]) {
    const plan = planPngExport(4096, 16384, scale);
    assert.equal(plan.ok, false);
    assert.match(plan.error, /page too large to export as PNG.*export as PDF or reduce the page height/);
  }
  // The same CSS size passes at 1× and is refused at 2×: 6000×6000 is 36 MP, then 144 MP.
  assert.equal(planPngExport(1280, 30000, 1).ok, false, 'taller than the height cap');
  assert.equal(planPngExport(4000, 9000, 1).ok, true);
  assert.equal(planPngExport(4000, 9000, 1.5).ok, false);
  // The boundary is exact: MAX_EXPORT_PIXELS physical pixels fit, one more row does not.
  assert.equal(planPngExport(4000, MAX_EXPORT_PIXELS / 4000, 1).ok, true);
  assert.equal(planPngExport(4000, MAX_EXPORT_PIXELS / 4000 + 1, 1).ok, false);
  // A missing scale factor counts as 1×.
  assert.equal(planPngExport(1000, 1000, 0).ok, true);
});

test('a failed render rejects the export with its reason and writes no file', async () => {
  const cwd = project();
  const { service, open } = setup(cwd, {
    chooseExportPath: async () => join(cwd, 'broken.png'),
    exportBytes: async () => {
      throw new Error('the page took too long to render for the export');
    },
  });
  await open({ content: { kind: 'html', source: '<p>x</p>', title: 'Slow' } });
  await assert.rejects(
    service.command({ sessionId: 's1', tabId: 'v1', action: 'export', format: 'png' }),
    /took too long to render/
  );
  assert.equal(existsSync(join(cwd, 'broken.png')), false);
});

test('export acts on the displayed version', async () => {
  const cwd = project();
  const { service, open } = setup(cwd);
  await open({ content: { kind: 'markdown', source: '# one', title: 'Doc' } });
  await open({ content: { kind: 'markdown', source: '# two', title: 'Doc' } });
  await service.command({ sessionId: 's1', tabId: 'v1', action: 'version', version: 1 });
  const saved = await service.command({ sessionId: 's1', tabId: 'v1', action: 'export', format: 'project', pane: 0 });
  assert.equal(saved.path, 'design/mockups/doc/doc.md');
  assert.equal(readFileSync(join(cwd, saved.path), 'utf8'), '# one');
});

test('remote export: png/pdf stay on the desktop, project saves on the host and answers path-free', async () => {
  const cwd = project();
  const requests = [];
  const mirror = createRemoteVisualizeMirror();
  const methods = createRemoteVisualizeMethods({
    mirror,
    invokeDesktopOperation: async () => null,
    hostRequest: async (method, args) => {
      requests.push([method, args]);
      return method === 'visualizeCommand'
        ? { path: 'design/mockups/x/x.svg', openable: true, host: join(cwd, 'secret') }
        : [];
    },
  });
  const base = { sessionId: 's1', tabId: 'v1', action: 'export' };
  await assert.rejects(methods.visualizeCommand([{ ...base, format: 'png' }]), /desktop window/);
  await assert.rejects(methods.visualizeCommand([{ ...base, format: 'pdf' }]), /desktop window/);
  assert.deepEqual(await methods.visualizeCommand([{ ...base, format: 'project' }]), {
    path: 'design/mockups/x/x.svg',
    openable: true,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0][1][0].format, 'project');
});

test('pane text: inline source, an HTML file as read now, a kept version from its snapshot', async () => {
  const cwd = project();
  writeFileSync(join(cwd, 'page.html'), '<h1>live</h1>\n');
  const { service, open } = setup(cwd);
  await open({ content: { kind: 'chart', source: '{"a":1}', title: 'C' } });
  await open({ targets: ['page.html'] });
  assert.deepEqual(await service.paneText('s1', 'v1', 0), { text: '{"a":1}', truncated: false });
  assert.deepEqual(await service.paneText('s1', 'v2', 0), { text: '<h1>live</h1>\n', truncated: false });
  await assert.rejects(service.paneText('s1', 'v2', 3), /no pane 3/);
  await assert.rejects(service.paneText('s1', 'v9', 0), /no visualize tab/);
});

test('export page requests stay on the page lease unless the tab allowed network', () => {
  const lease = 'http://127.0.0.1:5555/token/';
  assert.equal(exportRequestAllowed(lease, 'http://127.0.0.1:5555/token/app.js', false), true);
  assert.equal(exportRequestAllowed(lease, 'data:text/plain,hi', false), true);
  assert.equal(exportRequestAllowed(lease, 'https://example.com/x.js', false), false);
  assert.equal(exportRequestAllowed(lease, 'ws://127.0.0.1:9999/', false), false);
  assert.equal(exportRequestAllowed(lease, 'file:///etc/passwd', true), false);
  assert.equal(exportRequestAllowed(lease, 'https://example.com/x.js', true), true);
  assert.equal(exportRequestAllowed(lease, 'not a url', true), false);
});

// ---- the agent's `export` action ----

/** A minimal PNG header: 1264×835. */
const pngBytes = () => {
  const data = Buffer.alloc(40);
  data.write('\x89PNG', 0, 'latin1');
  data.writeUInt32BE(1264, 16);
  data.writeUInt32BE(835, 20);
  return data;
};

function exportSetup(cwd, extra = {}) {
  const rendered = [];
  const captured = [];
  const harness = setup(cwd, {
    prepareInlinePage: async (content) => `fake://inline/${content.source}`,
    renderExport: async (pane, format, allowNetwork) => {
      rendered.push({ url: pane.url, format, allowNetwork });
      return { data: format === 'png' ? pngBytes() : Buffer.from('%PDF-1.7 x'), problems: ['error: boom (line 3)'] };
    },
    capture: async () => {
      captured.push(1);
      return Buffer.from('CAPTURED');
    },
    ...extra,
  });
  const run = (input, sessionId = 's1') => harness.service.execute({ sessionId, cwd, action: 'export', input });
  return { ...harness, rendered, captured, run };
}

test('export requests are validated', () => {
  const cwd = project();
  const parse = (input) => parseVisualizeRequest({ sessionId: 's1', cwd, action: 'export', input });
  assert.deepEqual(parse({ tab: 'v1', format: 'pdf', output: 'a.pdf', version: 2, overwrite: true }), {
    sessionId: 's1',
    cwd,
    action: 'export',
    tab: 'v1',
    format: 'pdf',
    output: 'a.pdf',
    version: 2,
    overwrite: true,
  });
  assert.throws(() => parse({ tab: 'v1', format: 'gif', output: 'a.gif' }), /format must be png or pdf/);
  assert.throws(() => parse({ format: 'png', output: 'a.png' }), /tab/);
  assert.throws(() => parse({ tab: 'v1', format: 'png', output: 'a.png', version: 0 }), /version/);
  assert.throws(() => parse({ tab: 'v1', format: 'png', output: 'a.png', overwrite: 'yes' }), /overwrite/);
});

test('export renders an HTML page off screen into the project and reports path, size and page problems', async () => {
  const cwd = project();
  writeFileSync(join(cwd, 'page.html'), '<h1>x</h1>');
  const { open, run, rendered, captured } = exportSetup(cwd);
  await open({ targets: ['page.html'] });
  const result = await run({ tab: 'v1', format: 'png', output: 'design/shots/page.png' });
  assert.equal(result.path, 'design/shots/page.png', 'project-relative, never a host path');
  assert.match(result.text, /Exported tab v1 to design\/shots\/page\.png \(png, 1264×835 px, 40 B; /);
  assert.match(result.text, /rendered off screen: the tab did not need to be on screen/);
  assert.match(result.text, /Page problems during the render:\n- error: boom \(line 3\)/);
  assert.doesNotMatch(result.text, new RegExp(cwd.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  assert.deepEqual(readFileSync(join(cwd, 'design/shots/page.png')), pngBytes());
  assert.deepEqual(captured, [], 'no screen capture was needed');
  assert.deepEqual(rendered, [{ url: 'fake://page.html', format: 'png', allowNetwork: true }]);

  const pdf = await run({ tab: 'v1', format: 'pdf', output: 'design/shots/page.pdf' });
  assert.match(pdf.text, /\(pdf, 10 B; rendered off screen/);
  assert.equal(readFileSync(join(cwd, 'design/shots/page.pdf'), 'latin1'), '%PDF-1.7 x');
});

test('export: png of other kinds falls back to the capture path, pdf is for HTML pages only', async () => {
  const cwd = project();
  writeFileSync(join(cwd, 'pic.png'), 'x');
  const { open, run, captured } = exportSetup(cwd);
  await open({ targets: ['pic.png'] });
  const result = await run({ tab: 'v1', format: 'png', output: 'shots/pic.png' });
  assert.match(result.text, /captured as the panel shows it/);
  assert.equal(readFileSync(join(cwd, 'shots/pic.png'), 'utf8'), 'CAPTURED');
  assert.equal(captured.length, 1);
  await assert.rejects(
    run({ tab: 'v1', format: 'pdf', output: 'shots/pic.pdf' }),
    /Save as PDF is for a single HTML page/
  );
  await assert.rejects(run({ tab: 'v1', format: 'png', output: 'shots/pic.png', version: 1 }), /no version 1/);
  await open({ content: { kind: 'svg', source: '<svg/>', title: 'S' } });
  await assert.rejects(
    run({ tab: 'v2', format: 'pdf', output: 'shots/s.pdf' }),
    /Save as PDF is for a single HTML page/
  );
});

test('export refuses to overwrite unless the path is under design/ and overwrite is true', async () => {
  const cwd = project();
  writeFileSync(join(cwd, 'page.html'), '<h1>x</h1>');
  const { open, run } = exportSetup(cwd);
  await open({ targets: ['page.html'] });
  await run({ tab: 'v1', format: 'png', output: 'out/a.png' });
  writeFileSync(join(cwd, 'out/a.png'), 'KEEP');
  await assert.rejects(run({ tab: 'v1', format: 'png', output: 'out/a.png' }), /already exists/);
  await assert.rejects(run({ tab: 'v1', format: 'png', output: 'out/a.png', overwrite: true }), /already exists/);
  assert.equal(readFileSync(join(cwd, 'out/a.png'), 'utf8'), 'KEEP');

  await run({ tab: 'v1', format: 'png', output: 'design/a.png' });
  await assert.rejects(run({ tab: 'v1', format: 'png', output: 'design/a.png' }), /already exists/);
  await run({ tab: 'v1', format: 'png', output: 'design/a.png', overwrite: true });
  assert.deepEqual(readFileSync(join(cwd, 'design/a.png')), pngBytes());
});

test('export keeps to the project: outside paths, links and wrong extensions are refused', async (t) => {
  const cwd = project();
  writeFileSync(join(cwd, 'page.html'), '<h1>x</h1>');
  const outside = join(root, `export-outside-${counter}`);
  mkdirSync(outside, { recursive: true });
  const { open, run } = exportSetup(cwd);
  await open({ targets: ['page.html'] });
  await assert.rejects(run({ tab: 'v1', format: 'png', output: '../escape.png' }), /outside the working directory/);
  await assert.rejects(
    run({ tab: 'v1', format: 'png', output: join(outside, 'abs.png') }),
    /outside the working directory/
  );
  await assert.rejects(run({ tab: 'v1', format: 'png', output: 'shot.pdf' }), /output must be a \.png path/);
  await assert.rejects(run({ tab: 'v1', format: 'pdf', output: 'shot.png' }), /output must be a \.pdf path/);
  try {
    symlinkSync(outside, join(cwd, 'link'), 'junction');
  } catch {
    t.skip('symlinks are unavailable here');
    return;
  }
  await assert.rejects(run({ tab: 'v1', format: 'png', output: 'link/shot.png' }), /outside the working directory/);
  assert.deepEqual(readdirSync(outside), []);
});

test('an export folder swapped for a link between validation and the write puts no file outside cwd', async (t) => {
  const cwd = project();
  const outside = join(root, `export-swap-${counter}`);
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(cwd, 'design', 'shots'), { recursive: true });
  const folder = join(cwd, 'design', 'shots');
  let swapped = false;
  const result = await writeExportFile(cwd, 'design/shots/a.png', Buffer.from('x'), {
    beforeOpen() {
      try {
        renameSync(folder, `${folder}-moved`);
        symlinkSync(outside, folder, 'junction');
        swapped = true;
      } catch {
        // links unavailable
      }
    },
  }).catch((error) => error);
  if (!swapped) {
    t.skip('symlinks are unavailable here');
    return;
  }
  assert.ok(result instanceof Error);
  assert.deepEqual(readdirSync(outside), []);
});

test('export of a kept inline version renders that version, with the tab off screen', async () => {
  const cwd = project();
  const { open, run, rendered, captured } = exportSetup(cwd);
  await open({ content: { kind: 'html', source: '<p>one</p>', title: 'Sketch' } });
  await open({ content: { kind: 'html', source: '<p>two</p>', title: 'Sketch' } });
  await run({ tab: 'v1', format: 'png', output: 'design/live.png' });
  const old = await run({ tab: 'v1', format: 'png', output: 'design/old.png', version: 1 });
  assert.deepEqual(
    rendered.map((entry) => entry.url),
    ['fake://inline/<p>two</p>', 'fake://inline/<p>one</p>']
  );
  assert.match(old.text, /Exported tab v1 v1 to design\/old\.png/);
  await assert.rejects(
    run({ tab: 'v1', format: 'png', output: 'design/x.png', version: 9 }),
    /no version 9; kept versions: 1, 2/
  );
  assert.deepEqual(captured, []);
});

test('export of a kept file version renders its snapshot, not the live file', async () => {
  const cwd = project();
  const page = join(cwd, 'site', 'index.html');
  mkdirSync(join(cwd, 'site'));
  writeFileSync(page, '<h1>one</h1>');
  const watched = new Map();
  const { open, run, rendered, service } = exportSetup(cwd, {
    versions: { directory: join(root, `export-versions-${counter}`) },
    preparePane: async (target) => `fake://${target.root}|${target.path}`,
    watch: (path, onChange) => {
      watched.set(path, onChange);
      return () => watched.delete(path);
    },
  });
  await open({ targets: ['site/index.html'] });
  writeFileSync(page, '<h1>two</h1>');
  [...watched.values()][0]();
  await service.settled();
  const result = await run({ tab: 'v1', format: 'pdf', output: 'design/v1.pdf', version: 1 });
  assert.match(result.text, /Exported tab v1 v1 to design\/v1\.pdf \(pdf/);
  assert.equal(readFileSync(rendered[0].url.split('|')[1], 'utf8'), '<h1>one</h1>');
  assert.notEqual(rendered[0].url.split('|')[1], page);
  assert.equal(service.snapshot()[0].tabs[0].version ?? null, null, 'the panel view is untouched');
  await assert.rejects(
    run({ tab: 'v1', format: 'png', output: 'design/x.png', version: 7 }),
    /no version 7; kept versions: 1, 2/
  );
});
test('export problem lines carry no host path and no page-server lease URL', () => {
  const token = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  const cwd = join(root, 'secret-project');
  const lines = [
    exportProblemLine('error', `Uncaught Error at http://127.0.0.1:51234/${token}/app.js (line 3)`, 3, [cwd]),
    exportProblemLine('load failed', `could not open http://127.0.0.1:51234/${token}`, 0, [cwd]),
    exportProblemLine('error', `bad http://localhost:80/${token} and [http://127.0.0.1:9]`, 0, [cwd]),
    exportProblemLine('error', `read ${join(cwd, 'design', 'a.png')} failed`, 0, [cwd]),
    exportProblemLine('error', 'read C:\\Users\\someone\\private\\data.json failed', 0, [cwd]),
    exportProblemLine('error', 'read /home/someone/private/data.json failed'),
  ];
  for (const line of lines) {
    assert.doesNotMatch(
      line,
      new RegExp(`${token}|127\\.0\\.0\\.1|localhost|secret-project|someone|C:\\\\|/home/`),
      line
    );
  }
  assert.equal(lines[0], 'error: Uncaught Error at app.js (line 3) (line 3)');
  assert.match(lines[3], /read design[\\/]a\.png failed/);
});

test('failed subresource loads become problem lines, except ones the export blocked itself', () => {
  const token = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  const base = `http://127.0.0.1:51234/${token}`;
  const none = new Set();
  assert.equal(
    failedRequestLine({ id: 1, url: `${base}/style.css?v=2`, resourceType: 'stylesheet', statusCode: 404 }, none, [
      root,
    ]),
    'failed request: HTTP 404 style.css'
  );
  assert.equal(
    failedRequestLine({ id: 2, url: `${base}/img/logo.png`, resourceType: 'image', statusCode: 500 }, none),
    'failed request: HTTP 500 img/logo.png'
  );
  assert.equal(
    failedRequestLine(
      { id: 3, url: 'https://cdn.example.com/lib.js', resourceType: 'script', error: 'net::ERR_NAME_NOT_RESOLVED' },
      none
    ),
    'failed request: net::ERR_NAME_NOT_RESOLVED https://cdn.example.com/lib.js'
  );
  assert.equal(failedRequestLine({ id: 4, url: `${base}/ok.css`, statusCode: 200 }, none), null);
  assert.equal(failedRequestLine({ id: 5, url: `${base}/x.js`, statusCode: 304 }, none), null);
  assert.equal(
    failedRequestLine({ id: 6, url: 'https://x.test/a.js', error: 'net::ERR_BLOCKED_BY_CLIENT' }, new Set([6])),
    null,
    'blocked by the export itself'
  );
  assert.equal(failedRequestLine({ id: 7, url: `${base}/a.js`, error: 'net::ERR_ABORTED' }, none), null);
  // Electron's onCompleted details name a finished request `net::OK`.
  assert.equal(
    failedRequestLine(
      { id: 10, url: `${base}/pic.svg`, resourceType: 'image', statusCode: 200, error: 'net::OK' },
      none
    ),
    null
  );
  assert.equal(
    failedRequestLine(
      { id: 11, url: `${base}/gone.svg`, resourceType: 'image', statusCode: 404, error: 'net::OK' },
      none
    ),
    'failed request: HTTP 404 gone.svg'
  );
  assert.equal(
    failedRequestLine({ id: 8, url: `${base}/`, resourceType: 'mainFrame', error: 'net::ERR_FAILED' }, none),
    null
  );
  assert.doesNotMatch(failedRequestLine({ id: 9, url: `${base}`, statusCode: 404 }, none), new RegExp(token));
});

test('an export result and its errors carry no host path', async () => {
  const cwd = project();
  mkdirSync(join(cwd, 'site'));
  const absolute = join(cwd, 'site', 'index.html');
  writeFileSync(absolute, '<h1>x</h1>');
  let fail = false;
  const { open, run } = exportSetup(cwd, {
    renderExport: async () => {
      if (fail) throw new Error(`cannot render ${absolute} at ${cwd}`);
      return { data: pngBytes(), problems: [] };
    },
  });
  await open({ targets: [absolute], label: `Mockup of ${absolute}` });
  const result = await run({ tab: 'v1', format: 'png', output: 'design/a.png' });
  const everything = JSON.stringify(result);
  assert.equal(result.tabs[0].target, 'site/index.html');
  assert.equal(everything.includes(cwd), false, everything);
  assert.equal(everything.includes(cwd.replaceAll('\\', '\\\\')), false, everything);
  fail = true;
  const error = await run({ tab: 'v1', format: 'png', output: 'design/b.png' }).catch((caught) => caught);
  assert.ok(error instanceof Error);
  assert.equal(error.message.includes(cwd), false, error.message);
  assert.match(error.message, /cannot render/);
});

test('an export past the host deadline aborts the render and writes no file', async (t) => {
  const cwd = project();
  writeFileSync(join(cwd, 'page.html'), '<h1>x</h1>');
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const until = (ready) => waitUntil(ready, 'the export render to start');

  // A render that honours the abort (the real one destroys its window).
  let signalSeen;
  const honouring = exportSetup(cwd, {
    exportDeadlineMs: 30,
    renderExport: (_pane, _format, _network, options) =>
      new Promise((_resolve, reject) => {
        signalSeen = options.signal;
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')));
      }),
  });
  // A render that ignores the abort and finishes only when released, after the deadline.
  let release;
  const stubborn = exportSetup(cwd, {
    exportDeadlineMs: 30,
    renderExport: () =>
      new Promise((resolve) => {
        release = () => resolve({ data: pngBytes(), problems: [] });
      }),
  });
  await honouring.open({ targets: ['page.html'] });
  await stubborn.open({ targets: ['page.html'] });

  // The deadline is the export's own timer: fake time passes it exactly.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = assert.rejects(
    honouring.run({ tab: 'v1', format: 'png', output: 'design/slow.png' }),
    /export timed out after 0s; no file was written/
  );
  await until(() => signalSeen);
  t.mock.timers.tick(30);
  await slow;
  assert.equal(signalSeen.aborted, true);
  assert.equal(existsSync(join(cwd, 'design', 'slow.png')), false);

  const late = assert.rejects(stubborn.run({ tab: 'v1', format: 'png', output: 'design/late.png' }), /timed out/);
  await until(() => release);
  t.mock.timers.tick(30);
  await late;
  release();
  await turn();
  await readdir(cwd); // a real I/O round trip: a late write would have started by now
  assert.equal(existsSync(join(cwd, 'design', 'late.png')), false);
  assert.deepEqual(existsSync(join(cwd, 'design')) ? readdirSync(join(cwd, 'design')) : [], []);

  // Within the deadline the file is written.
  t.mock.timers.reset();
  const quick = exportSetup(cwd, { exportDeadlineMs: 5000 });
  await quick.open({ targets: ['page.html'] });
  await quick.run({ tab: 'v1', format: 'png', output: 'design/ok.png' });
  assert.equal(existsSync(join(cwd, 'design', 'ok.png')), true);
});
