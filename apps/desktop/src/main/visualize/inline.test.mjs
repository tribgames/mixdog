import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import { MAX_VISUALIZE_INLINE_BYTES, remoteVisualizeState } from '../../shared/visualize.ts';
import { requiredVisualizeTabCommand } from '../ipc-validation.ts';
import { createRemoteVisualizeMethods, createRemoteVisualizeMirror } from '../remote-visualize.ts';
import { createVisualizeService } from './service.ts';
import { parseVisualizeRequest } from './targets.ts';

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-inline-')));
test.after(() => rmSync(cwd, { recursive: true, force: true }));

function setup(delay = async () => {}) {
  const events = [];
  const hostEvents = [];
  const prepared = [];
  const deps = {
    windowAvailable: () => true,
    browserAvailable: () => true,
    async preparePane(target) {
      prepared.push(target);
      return 'fake://pane';
    },
    publish: (event) => events.push(event),
    publishHost: (event) => hostEvents.push(event),
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    delay: (ms) => delay(ms),
    reloadDebounceMs: 5,
  };
  const holder = {};
  deps.delay = (ms) => delay(ms, holder.service);
  holder.service = createVisualizeService(deps);
  return { service: holder.service, events, hostEvents, prepared };
}

/** The render id the desktop window was issued for a tab's pane. */
const renderIdOf = (service, sessionId = 's1', tabId = 'v1', pane = 0) =>
  service
    .snapshot()
    .find((state) => state.sessionId === sessionId)
    ?.tabs.find((tab) => tab.id === tabId)?.panes[pane]?.renderId;

/** What the desktop window sends once its pane rendered (or failed to). */
const report = (service, error, overrides = {}) =>
  service.command({
    sessionId: 's1',
    tabId: 'v1',
    action: 'render',
    pane: 0,
    renderId: renderIdOf(service),
    ...(error ? { error } : {}),
    ...overrides,
  });

const open = (service, input) => service.execute({ sessionId: 's1', cwd, action: 'open', input });
const parse = (input) => parseVisualizeRequest({ sessionId: 's1', cwd, action: 'open', input });

test('input.content is validated and exclusive with targets', () => {
  const content = { kind: 'mermaid', source: 'graph TD; A-->B', title: 'Flow' };
  assert.deepEqual(parse({ content }).content, content);
  assert.deepEqual(parse({ content }).targets, []);
  assert.throws(() => parse({ content, targets: ['a.html'] }), /either input\.targets or input\.content/);
  assert.throws(() => parse({ content: { kind: 'png', source: 'x' } }), /content\.kind must be one of/);
  assert.throws(() => parse({ content: { kind: 'svg', source: '   ' } }), /non-empty/);
  assert.throws(() => parse({ content: 'graph' }), /content must be/);
  assert.throws(
    () => parse({ content: { kind: 'svg', source: 'x'.repeat(MAX_VISUALIZE_INLINE_BYTES + 1) } }),
    /at most 512 KiB/
  );
  assert.ok(parse({ content: { kind: 'svg', source: 'x'.repeat(MAX_VISUALIZE_INLINE_BYTES) } }).content);
  assert.throws(() => parse({}), /1-3 files or URLs/);
});

test('inline open makes an inline pane tab without files, and re-opening a title keeps versions', async () => {
  const { service, prepared } = setup();
  const first = await open(service, { content: { kind: 'chart', source: '{"series":[]}', title: 'Sales' } });
  assert.match(first.text, /as tab v1/);
  assert.equal(first.tabs[0].kind, 'inline');
  assert.deepEqual(prepared, [], 'no file pane is prepared');
  let tab = service.snapshot()[0].tabs[0];
  assert.equal(tab.panes[0].kind, 'inline');
  assert.equal(tab.panes[0].inline.kind, 'chart');
  assert.equal(tab.panes[0].label, 'Sales');

  // Same title + same content: same tab, no new version.
  await open(service, { content: { kind: 'chart', source: '{"series":[]}', title: 'Sales' } });
  assert.equal(service.snapshot()[0].tabs.length, 1);
  assert.equal(service.snapshot()[0].tabs[0].versions.length, 1);

  // Same title, new content: same tab, version 2.
  const third = await open(service, { content: { kind: 'chart', source: '{"series":[1]}', title: 'Sales' } });
  assert.match(third.text, /2 versions kept/);
  tab = service.snapshot()[0].tabs[0];
  assert.equal(tab.id, 'v1');
  assert.deepEqual(
    tab.versions.map((version) => version.n),
    [1, 2]
  );

  // An older version is shown read-only, beside live when comparing.
  await service.command({ sessionId: 's1', tabId: 'v1', action: 'version', version: 1 });
  tab = service.snapshot()[0].tabs[0];
  assert.equal(tab.version, 1);
  assert.equal(tab.panes[0].inline.source, '{"series":[]}');
  assert.equal(tab.panes[0].version, 1);
  await service.command({ sessionId: 's1', tabId: 'v1', action: 'version', version: 1, compare: true });
  tab = service.snapshot()[0].tabs[0];
  assert.deepEqual(
    tab.panes.map((pane) => pane.version),
    [1, undefined]
  );
  await service.command({ sessionId: 's1', tabId: 'v1', action: 'version', version: null });
  assert.equal(service.snapshot()[0].tabs[0].version, null);

  // open with input.version shows a kept version.
  const older = await open(service, {
    content: { kind: 'chart', source: '{"series":[1]}', title: 'Sales' },
    version: 1,
  });
  assert.match(older.text, /Showing kept version v1/);

  // Restore has no file to write.
  await assert.rejects(
    service.command({ sessionId: 's1', tabId: 'v1', action: 'restore', version: 1 }),
    /no project file to restore/
  );

  // A different title is a different tab.
  await open(service, { content: { kind: 'svg', source: '<svg/>', title: 'Other' } });
  assert.equal(service.snapshot()[0].tabs.length, 2);
  service.dispose();
});

test('a render error reported by the panel is a page problem in the open and check results', async () => {
  // The panel reports while open waits for the render.
  const { service } = setup(async (_ms, svc) => {
    await report(svc, 'Parse error on line 2:\n  A--\nExpecting X');
  });
  const result = await open(service, { content: { kind: 'mermaid', source: 'graph TD\nA--', title: 'Bad' } });
  assert.match(result.text, /Page problems on tab v1 \(1\)/);
  assert.match(result.text, /render: The mermaid could not be rendered: Parse error on line 2: A-- Expecting X/);
  assert.equal(result.problems[0].kind, 'render');
  const tab = service.snapshot()[0].tabs[0];
  assert.equal(tab.problems.length, 1);

  // A render id is good for one report: repeating it files nothing more.
  await report(service, 'Parse error on line 2:\n  A--\nExpecting X');
  assert.equal(service.snapshot()[0].tabs[0].problems[0].count, 1);
  const checked = await service.execute({ sessionId: 's1', cwd, action: 'check', input: { tab: 'v1' } });
  assert.match(checked.text, /Checked tab v1/);

  // A successful render of a fresh open has no problems; re-open resets them.
  const ok = setup(async (_ms, svc) => report(svc));
  const fine = await open(ok.service, { content: { kind: 'svg', source: '<svg/>' } });
  assert.doesNotMatch(fine.text, /Page problems/);
  assert.equal(
    (await ok.service.execute({ sessionId: 's1', cwd, action: 'check', input: { tab: 'v1' } })).text,
    'No page problems on tab v1.'
  );
  service.dispose();
  ok.service.dispose();
});

test('the panel render report is validated', () => {
  const base = { sessionId: 's1', tabId: 'v1', action: 'render', renderId: 'id-1' };
  assert.deepEqual(requiredVisualizeTabCommand({ ...base, pane: 1, error: 'bad' }), { ...base, pane: 1, error: 'bad' });
  assert.equal(requiredVisualizeTabCommand({ ...base, pane: 0 }).error, undefined);
  assert.throws(() => requiredVisualizeTabCommand({ ...base, pane: -1 }), /pane index/);
  assert.throws(() => requiredVisualizeTabCommand({ ...base, pane: 0, error: 3 }), /text/);
  assert.throws(
    () => requiredVisualizeTabCommand({ sessionId: 's1', tabId: 'v1', action: 'render', pane: 0 }),
    /render id/
  );
  assert.equal(requiredVisualizeTabCommand({ ...base, pane: 0, error: 'x'.repeat(9000) }).error.length, 4000);
});

test('render reports need the id issued to the window: wrong, reused, stale and cross-session ids are ignored', async () => {
  // A wrong id files nothing.
  const { service } = setup();
  await open(service, { content: { kind: 'mermaid', source: 'graph TD;A-->', title: 'Flow' } });
  await report(service, 'forged', { renderId: 'guess' });
  await report(service, 'forged', { renderId: undefined });
  assert.equal(service.snapshot()[0].tabs[0].problems, undefined);

  // The right id counts once; reusing it is ignored.
  const id = renderIdOf(service);
  await report(service, 'real failure');
  assert.equal(service.snapshot()[0].tabs[0].problems.length, 1);
  await report(service, 'second failure', { renderId: id });
  assert.equal(service.snapshot()[0].tabs[0].problems.length, 1);

  // A new render instance (re-open) gets a new id; the old one is stale.
  await open(service, { content: { kind: 'mermaid', source: 'graph TD;A-->', title: 'Flow' } });
  assert.notEqual(renderIdOf(service), id);
  await report(service, 'stale', { renderId: id });
  assert.equal(service.snapshot()[0].tabs[0].problems, undefined);
  await report(service, 'fresh');
  assert.equal(service.snapshot()[0].tabs[0].problems.length, 1);

  // The id is bound to the version shown: v1 and live (compare) differ.
  await open(service, { content: { kind: 'mermaid', source: 'graph TD;B-->C', title: 'Flow' } });
  await service.command({ sessionId: 's1', tabId: 'v1', action: 'version', version: 1, compare: true });
  const [oldId, liveId] = service.snapshot()[0].tabs[0].panes.map((pane) => pane.renderId);
  assert.notEqual(oldId, liveId);
  await report(service, 'wrong pane', { pane: 1, renderId: oldId });
  assert.equal(service.snapshot()[0].tabs[0].problems, undefined);
  await report(service, 'v1 broke', { pane: 0, renderId: oldId });
  assert.equal(service.snapshot()[0].tabs[0].problems[0].version, 1);

  // Another session's tab with the same tab id cannot be reported with this one's id.
  await service.execute({
    sessionId: 's2',
    cwd,
    action: 'open',
    input: { content: { kind: 'mermaid', source: 'graph TD;A-->', title: 'Flow' } },
  });
  const s2 = () => service.snapshot().find((state) => state.sessionId === 's2').tabs[0];
  assert.equal(s2().id, 'v1');
  await report(service, 'cross', { sessionId: 's2', renderId: liveId, pane: 0 });
  await report(service, 'cross', { sessionId: 's2', renderId: oldId, pane: 0 });
  assert.equal(s2().problems, undefined);
  service.dispose();
});

test('a remote client reports renders with its own id; the desktop id never reaches it', async () => {
  const { service, hostEvents } = setup();
  await open(service, { content: { kind: 'mermaid', source: 'graph TD;A-->B', title: 'Flow' } });
  assert.ok(renderIdOf(service), 'the desktop window is issued an id');
  const id = renderIdOf(service);

  const remote = [
    ...hostEvents.filter((event) => event.state).map((event) => remoteVisualizeState(event.state)),
    ...service.hostSnapshot().map(remoteVisualizeState),
  ];
  assert.equal(JSON.stringify(remote).includes(id), false, 'the desktop id stays in the desktop window');
  assert.equal(JSON.stringify(service.hostSnapshot()).includes(id), false);
  const remoteId = remote.at(-1).tabs[0].panes[0].renderId;
  assert.ok(remoteId, 'a remote client is issued its own id');
  assert.notEqual(remoteId, id);

  // The remote command path forwards the validated report to the host.
  const requests = [];
  const methods = createRemoteVisualizeMethods({
    mirror: createRemoteVisualizeMirror(),
    hostRequest: async (method, args) => {
      requests.push([method, args]);
      return method === 'visualizeCommand' ? service.command(args[0]) : service.hostSnapshot();
    },
    invokeDesktopOperation: async () => null,
  });
  await assert.rejects(
    methods.visualizeCommand([{ sessionId: 's1', tabId: 'v1', action: 'render', pane: 'x', renderId: remoteId }]),
    /pane index/
  );
  assert.deepEqual(requests, [], 'an invalid report never reaches the host');
  // A forged id is forwarded but files nothing.
  await methods.visualizeCommand([
    { sessionId: 's1', tabId: 'v1', action: 'render', pane: 0, renderId: 'guess', error: 'forged' },
  ]);
  assert.equal(service.snapshot()[0].tabs[0].problems, undefined);
  // The issued remote id files the failure once, like the desktop's.
  await methods.visualizeCommand([
    { sessionId: 's1', tabId: 'v1', action: 'render', pane: 0, renderId: remoteId, error: 'Parse error' },
  ]);
  assert.match(service.snapshot()[0].tabs[0].problems[0].message, /could not be rendered: Parse error/);
  await methods.visualizeCommand([
    { sessionId: 's1', tabId: 'v1', action: 'render', pane: 0, renderId: remoteId, error: 'again' },
  ]);
  // Either audience spends the render instance: the desktop's late report is ignored.
  await report(service, 'desktop too');
  assert.equal(service.snapshot()[0].tabs[0].problems.length, 1);
  service.dispose();
});

test('a paired device export renders into a fresh temp folder instead of the save dialog', async () => {
  const written = [];
  const deps = {
    windowAvailable: () => true,
    browserAvailable: () => true,
    preparePane: async () => 'fake://pane',
    publish: () => {},
    publishHost: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    chooseExportPath: async () => {
      throw new Error('no dialog for a device export');
    },
    exportBytes: async (_sessionId, _tab, format) => {
      written.push(format);
      return Buffer.from(format === 'png' ? 'PNGDATA' : '%PDF');
    },
    delay: async () => {},
    reloadDebounceMs: 5,
  };
  const service = createVisualizeService(deps);
  await service.execute({
    sessionId: 's1',
    cwd,
    action: 'open',
    input: { content: { kind: 'svg', source: '<svg/>', title: 'Flow' } },
  });
  const { path } = await service.exportForDevice({
    sessionId: 's1',
    tabId: 'v1',
    action: 'export',
    format: 'png',
    pane: 0,
  });
  try {
    assert.match(basename(dirname(path)), /^mixdog-visualize-export-/);
    assert.equal(dirname(dirname(path)), tmpdir());
    assert.match(basename(path), /\.png$/);
    assert.equal(readFileSync(path, 'utf8'), 'PNGDATA');
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
  await assert.rejects(
    service.exportForDevice({ sessionId: 's1', tabId: 'v1', action: 'export', format: 'project', pane: 0 }),
    /format is invalid/
  );
  await assert.rejects(
    service.exportForDevice({ sessionId: 's1', tabId: 'v9', action: 'export', format: 'png' }),
    /closed/
  );
  // PDF is for HTML pages, as in the desktop menu.
  await assert.rejects(
    service.exportForDevice({ sessionId: 's1', tabId: 'v1', action: 'export', format: 'pdf', pane: 0 }),
    /Save as PDF is for HTML pages/
  );
  assert.deepEqual(written, ['png']);
  service.dispose();
});
test('remote clients get inline content in the state, with no host path', async () => {
  const { service, hostEvents } = setup();
  await open(service, { content: { kind: 'markdown', source: '# Title', title: 'Notes' } });
  await open(service, { content: { kind: 'markdown', source: '# Title 2', title: 'Notes' } });
  await service.command({ sessionId: 's1', tabId: 'v1', action: 'version', version: 1, compare: true });

  const host = service.hostSnapshot()[0].tabs[0];
  assert.deepEqual(
    host.panes.map((pane) => [pane.kind, pane.path, pane.version]),
    [
      ['inline', '', 1],
      ['inline', '', undefined],
    ]
  );
  const states = [
    ...hostEvents.filter((event) => event.state).map((event) => remoteVisualizeState(event.state)),
    ...service.hostSnapshot().map(remoteVisualizeState),
  ];
  assert.equal(JSON.stringify(states).includes(cwd.replace(/\\/g, '\\\\')), false);
  const remote = states.at(-1).tabs[0];
  assert.equal(remote.label, 'Notes');
  assert.deepEqual(
    remote.panes.map((pane) => [pane.kind, pane.url, pane.inline.source, pane.version]),
    [
      ['inline', '', '# Title', 1],
      ['inline', '', '# Title 2', undefined],
    ]
  );
  service.dispose();
});

// ── Scripted pages: chart / html content as in-memory pages ──────────────

const LEASE = 'a'.repeat(32);
const pageUrl = (n) => `http://127.0.0.1:4000/${LEASE.slice(0, 31)}${n}/index.html`;

function pageSetup(overrides = {}) {
  const prepared = [];
  const events = [];
  const deps = {
    windowAvailable: () => true,
    browserAvailable: () => true,
    async preparePane() {
      throw new Error('inline content has no file pane');
    },
    async prepareInlinePage(content) {
      prepared.push(content.kind);
      return pageUrl(prepared.length);
    },
    publish: (event) => events.push(event),
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    delay: async () => {},
    reloadDebounceMs: 5,
    ...overrides,
  };
  return { service: createVisualizeService(deps), prepared };
}

test('chart and html content are served as pages; mermaid, svg and markdown stay static', async () => {
  const { service, prepared } = pageSetup();
  await open(service, { content: { kind: 'chart', source: '{"series":[]}', title: 'Sales' } });
  await open(service, { content: { kind: 'html', source: '<p>hi</p>', title: 'Sketch' } });
  await open(service, { content: { kind: 'mermaid', source: 'graph TD;A-->B', title: 'Flow' } });
  const tabs = service.snapshot()[0].tabs;
  assert.deepEqual(prepared, ['chart', 'html']);
  assert.deepEqual(
    tabs.map((tab) => [tab.panes[0].kind, tab.panes[0].url !== '']),
    [
      ['html', true],
      ['html', true],
      ['inline', false],
    ]
  );
  assert.equal(tabs[0].panes[0].inline.kind, 'chart');

  // Remote clients see the inline content (and a page kind), never a host path or page URL.
  const host = service.hostSnapshot()[0].tabs[0].panes[0];
  assert.deepEqual([host.kind, host.path, host.inline.kind], ['html', '', 'chart']);
  const remote = remoteVisualizeState(service.hostSnapshot()[0]).tabs[0].panes[0];
  assert.equal(remote.url, '');
  assert.equal(remote.inline.source, '{"series":[]}');
  service.dispose();
});

test('a scripted page gets the HTML-pane protections: network guard and page problems', async () => {
  const { service } = pageSetup();
  await open(service, { content: { kind: 'chart', source: '{"series":[', title: 'Bad' } });
  // Tabs open with network allowed; the guard is exercised once it is switched off.
  assert.equal(service.snapshot()[0].tabs[0].networkAllowed, true);
  await service.command({ sessionId: 's1', tabId: 'v1', action: 'network', allow: false });
  const url = service.snapshot()[0].tabs[0].panes[0].url;
  const origin = url.slice(0, url.lastIndexOf('/') + 1);

  // Outside network is blocked and reported; the page's own lease is not.
  assert.equal(service.guardRequest([url], { url: 'https://cdn.example/lib.js', resourceType: 'script' }), true);
  assert.equal(service.guardRequest([url], { url: `${origin}echarts.js`, resourceType: 'script' }), false);
  assert.equal(service.snapshot()[0].tabs[0].problems[0].kind, 'blocked-network');

  // The page's own error (bad chart JSON logged by the page) is a page problem.
  service.reportConsole({
    level: 'error',
    message: 'Invalid chart JSON: Unexpected end',
    sourceId: url,
    lineNumber: 1,
    frameUrl: url,
  });
  const checked = await service.execute({ sessionId: 's1', cwd, action: 'check', input: { tab: 'v1' } });
  assert.match(checked.text, /console-error: Invalid chart JSON/);

  // The user may allow network for the tab; the page remounts under the new policy.
  const revision = service.snapshot()[0].tabs[0].revision;
  await service.command({ sessionId: 's1', tabId: 'v1', action: 'network', allow: true });
  assert.equal(service.snapshot()[0].tabs[0].revision, revision + 1);
  assert.equal(service.guardRequest([url], { url: 'https://cdn.example/lib.js', resourceType: 'script' }), false);
  service.dispose();
});

test('scripted inline tabs version by title and fall back to the static render when no page can be served', async () => {
  const { service } = pageSetup();
  await open(service, { content: { kind: 'html', source: '<p>1</p>', title: 'Sketch' } });
  await open(service, { content: { kind: 'html', source: '<p>2</p>', title: 'Sketch' } });
  await service.command({ sessionId: 's1', tabId: 'v1', action: 'version', version: 1 });
  const shown = service.snapshot()[0].tabs[0].panes[0];
  assert.equal(shown.kind, 'html');
  assert.equal(shown.inline.source, '<p>1</p>');
  assert.equal(shown.version, 1);
  service.dispose();

  const failing = pageSetup({
    async prepareInlinePage() {
      throw new Error('page server down');
    },
  });
  const result = await open(failing.service, { content: { kind: 'chart', source: '{}', title: 'C' } });
  assert.match(result.text, /as tab v1/);
  assert.equal(failing.service.snapshot()[0].tabs[0].panes[0].kind, 'inline');
  failing.service.dispose();
});

test('a closed inline tab reopens from its stored content', async () => {
  const { service } = pageSetup({ sessionCwd: async () => cwd });
  await open(service, { content: { kind: 'mermaid', source: 'graph TD;A-->B', title: 'Flow' } });
  await service.command({ sessionId: 's1', tabId: 'v1', action: 'close' });
  assert.deepEqual(service.snapshot()[0].tabs, [], 'only the list of closed visuals remains');
  await service.command({
    sessionId: 's1',
    tabId: 'v1',
    action: 'reopen',
    targets: [],
    content: { kind: 'mermaid', source: 'graph TD;A-->B', title: 'Flow' },
  });
  const tab = service.snapshot()[0].tabs[0];
  assert.equal(tab.id, 'v2', 'ids are never reused');
  assert.equal(tab.panes[0].inline.title, 'Flow');
  service.dispose();
});

test('reopen content is validated', () => {
  const base = { sessionId: 's1', tabId: 'v1', action: 'reopen' };
  const ok = requiredVisualizeTabCommand({ ...base, content: { kind: 'chart', source: '{}', title: 'T' }, label: 'L' });
  assert.deepEqual(ok.content, { kind: 'chart', source: '{}', title: 'T' });
  assert.deepEqual(ok.targets, []);
  assert.throws(
    () => requiredVisualizeTabCommand({ ...base, content: { kind: 'gif', source: 'x' } }),
    /content is invalid/
  );
  assert.throws(
    () => requiredVisualizeTabCommand({ ...base, content: { kind: 'svg', source: 3 } }),
    /content is invalid/
  );
  assert.throws(() => requiredVisualizeTabCommand({ ...base, targets: [] }), /1-3 file paths/);
});

const READING = {
  viewport: { width: 375, height: 812 },
  page: { width: 375, height: 1200 },
  scope: '',
  outline: [{ depth: 0, kind: 'heading', role: 'heading', level: 1, name: 'Sketch', selector: 'h1' }],
  elements: [
    { role: 'button', name: 'Save', selector: '#save', tag: 'button', x: 10, y: 20, w: 100, h: 20, flags: [] },
  ],
  elementCount: 1,
  findings: [
    {
      kind: 'small-target',
      severity: 'warning',
      message: 'tap target is 100x20px (WCAG minimum 24x24)',
      selector: '#save',
      x: 10,
      y: 20,
      w: 100,
      h: 20,
    },
  ],
  findingCount: 1,
  contrastUnknown: 0,
  partial: false,
};

test('inspect requests are validated: tab, viewport bounds and selector', () => {
  const parseInspect = (input) => parseVisualizeRequest({ sessionId: 's1', cwd, action: 'inspect', input });
  assert.deepEqual(parseInspect({ tab: 'v1' }).viewport, undefined);
  assert.deepEqual(parseInspect({ tab: 'v1', viewport: { width: 375, height: 812 }, selector: ' main ' }).viewport, {
    width: 375,
    height: 812,
  });
  assert.equal(parseInspect({ tab: 'v1', selector: ' main ' }).selector, 'main');
  assert.deepEqual(parseInspect({ tab: 'v1', viewport: { width: 375 } }).viewport, { width: 375, height: 800 });
  assert.throws(() => parseInspect({}), /tab must be/);
  for (const viewport of [
    { height: 800 },
    { width: 100 },
    { width: 3001 },
    { width: 375.5 },
    { width: '375' },
    { width: 375, height: 5000 },
    375,
  ]) {
    assert.throws(() => parseInspect({ tab: 'v1', viewport }), /viewport/, JSON.stringify(viewport));
  }
  assert.throws(() => parseInspect({ tab: 'v1', selector: 'x'.repeat(501) }), /selector must be at most/);
});

test('inspect returns the page reading for html pages and refuses static or missing content', async () => {
  const calls = [];
  const { service } = pageSetup({
    async inspect(_sessionId, tab, options) {
      calls.push(options);
      return tab.panes.filter((pane) => pane.kind === 'html').map((pane) => ({ pane: pane.label, result: READING }));
    },
  });
  await open(service, { content: { kind: 'html', source: '<button id="save">Save</button>', title: 'Sketch' } });
  await open(service, { content: { kind: 'mermaid', source: 'graph TD;A-->B', title: 'Flow' } });
  const run = (tab, input = {}) =>
    service.execute({ sessionId: 's1', cwd, action: 'inspect', input: { tab, ...input } });

  const result = await run('v1', { viewport: { width: 375, height: 812 }, selector: 'main' });
  assert.deepEqual(calls, [{ viewport: { width: 375, height: 812 }, selector: 'main' }]);
  assert.match(result.text, /^Inspection of tab v1 at 375×812:\nSketch: viewport 375×812, page 375×1200/);
  assert.match(result.text, /Layout findings \(1\):\n {2}- \[warning\] small-target: tap target is 100x20px/);
  assert.match(result.text, /- button "Save" · #save \(10,20 100×20\)/);
  assert.doesNotMatch(result.text, /127\.0\.0\.1|fake:/);
  await run('v1');
  assert.deepEqual(calls.at(-1), {}, 'no viewport: the page is read as shown');

  await assert.rejects(run('v2'), /static mermaid content, which has no elements to read/);
  await assert.rejects(run('v9'), /no visualize tab/i);
  service.dispose();

  const bare = pageSetup();
  await open(bare.service, { content: { kind: 'html', source: '<p>x</p>', title: 'Sketch' } });
  await assert.rejects(
    bare.service.execute({ sessionId: 's1', cwd, action: 'inspect', input: { tab: 'v1' } }),
    /inspect is unavailable here/
  );
  bare.service.dispose();
});

test('inspect treats the page answer as untrusted data', async () => {
  const answers = [
    { nonsense: true },
    { error: 'the selector matched nothing' },
    {
      ...READING,
      elements: [
        {
          role: 'button',
          name: 'x'.repeat(500),
          selector: 's',
          flags: ['secret'],
          value: 'hunter2',
          x: 1,
          y: 1,
          w: 1,
          h: 1,
        },
      ],
      elementCount: 1,
    },
  ];
  const { service } = pageSetup({
    inspect: async (_s, tab) => [{ pane: tab.panes[0].label, result: answers.shift() }],
  });
  await open(service, { content: { kind: 'html', source: '<p>x</p>', title: 'Sketch' } });
  const run = () => service.execute({ sessionId: 's1', cwd, action: 'inspect', input: { tab: 'v1' } });
  assert.match((await run()).text, /Sketch: the page returned no reading/);
  assert.match((await run()).text, /Sketch: the selector matched nothing/);
  const text = (await run()).text;
  assert.match(text, /value="\[redacted\]"/);
  assert.doesNotMatch(text, /hunter2/);
  assert.ok(text.length < 8_200);
  service.dispose();
});

test('check adds a one-line layout findings summary, only when there are findings', async () => {
  let findingCount = 3;
  const { service } = pageSetup({
    inspect: async (_s, tab) => [
      {
        pane: tab.panes[0].label,
        result: { ...READING, findings: findingCount ? READING.findings : [], findingCount },
      },
    ],
  });
  await open(service, { content: { kind: 'html', source: '<p>x</p>', title: 'Sketch' } });
  const check = () => service.execute({ sessionId: 's1', cwd, action: 'check', input: { tab: 'v1' } });
  assert.equal((await check()).text, 'No page problems on tab v1.\n3 layout findings — run inspect');
  findingCount = 1;
  assert.match((await check()).text, /\n1 layout finding — run inspect$/);
  findingCount = 0;
  assert.equal((await check()).text, 'No page problems on tab v1.');
  service.dispose();
  const failing = pageSetup({ inspect: async () => Promise.reject(new Error('gone')) });
  await open(failing.service, { content: { kind: 'html', source: '<p>x</p>', title: 'Sketch' } });
  assert.equal(
    (await failing.service.execute({ sessionId: 's1', cwd, action: 'check', input: { tab: 'v1' } })).text,
    'No page problems on tab v1.'
  );
  failing.service.dispose();
});
