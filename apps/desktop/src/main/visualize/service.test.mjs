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
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { filePreviewServable, registerFilePreview, resolveFilePreview } from '../file-preview.ts';
import { createRemoteVisualizeMethods, createRemoteVisualizeMirror } from '../remote-visualize.ts';
import { panePreviewUrl } from './host-pane-preview.ts';
import { VisualizeBridgeServer } from './bridge-server.ts';
import { createDesktopVisualize, REMOTE_ONLY_ANNOTATE } from './host.ts';
import { createVisualizeService } from './service.ts';
import {
  buildProblem,
  classifyConsole,
  formatProblemsSection,
  localizeProblemText,
  recordProblem,
} from './page-problems.ts';
import { MAX_VISUALIZE_PROBLEMS, remoteVisualizeState, VISUALIZE_THUMBNAIL_MAX_BYTES } from '../../shared/visualize.ts';
import {
  parseVisualizeRequest,
  resolveCaptureOutput,
  resolveVisualizeTarget,
  visualizeKindForPath,
} from './targets.ts';
import { visualizeOverlayScript } from './overlay-script.ts';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-visualize-'));
  const cwd = join(root, 'project');
  mkdirSync(join(cwd, 'site'), { recursive: true });
  writeFileSync(join(cwd, 'site', 'index.html'), '<h1>hi</h1>');
  writeFileSync(join(cwd, 'report.docx'), 'docx');
  writeFileSync(join(cwd, 'chart.png'), 'png');
  writeFileSync(join(cwd, 'paper.pdf'), 'pdf');
  writeFileSync(join(cwd, 'notes.txt'), 'text');
  writeFileSync(join(root, 'secret.html'), '<p>outside</p>');
  return { root, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function fakeDeps(overrides = {}) {
  const events = [];
  const watched = new Map();
  const prepared = [];
  let browser = true;
  const deps = {
    windowAvailable: () => true,
    browserAvailable: () => browser,
    async preparePane(target) {
      prepared.push(target.kind);
      return `fake://${target.kind}/${target.label}?${prepared.length}`;
    },
    publish: (event) => events.push(event),
    watch(path, onChange) {
      watched.set(path, onChange);
      return () => watched.delete(path);
    },
    async annotate(_sessionId, tab, marks) {
      return tab.panes.flatMap((pane, index) =>
        pane.kind === 'html'
          ? [
              {
                pane: pane.label,
                result: {
                  invalid: [],
                  marks: marks
                    .filter((mark) => mark.pane === index)
                    .map((mark) => ({ selector: mark.selector, label: mark.label ?? '', count: 1 })),
                },
              },
            ]
          : []
      );
    },
    capture: async () => Buffer.from('PNGDATA'),
    delay: async () => {},
    reloadDebounceMs: 5,
    ...overrides,
  };
  return { deps, events, watched, prepared, setBrowser: (value) => (browser = value) };
}

test('requests are validated before anything runs', () => {
  const cwd = tmpdir();
  assert.throws(() => parseVisualizeRequest(null), /must be an object/);
  assert.throws(() => parseVisualizeRequest({ sessionId: '../x', cwd, action: 'open' }), /sessionId is invalid/);
  assert.throws(() => parseVisualizeRequest({ sessionId: 's1', cwd: 'relative', action: 'open' }), /absolute/);
  assert.throws(() => parseVisualizeRequest({ sessionId: 's1', cwd, action: 'zap' }), /action must be/);
  assert.throws(() => parseVisualizeRequest({ sessionId: 's1', cwd, action: 'open', input: { targets: [] } }), /1-3/);
  assert.throws(
    () => parseVisualizeRequest({ sessionId: 's1', cwd, action: 'open', input: { targets: ['a', 'b', 'c', 'd'] } }),
    /1-3/
  );
  assert.throws(
    () =>
      parseVisualizeRequest({
        sessionId: 's1',
        cwd,
        action: 'annotate',
        input: { tab: 'v1', clear: true, remove: ['a'] },
      }),
    /exactly one/
  );
  assert.throws(
    () =>
      parseVisualizeRequest({ sessionId: 's1', cwd, action: 'annotate', input: { tab: 'v1', add: [{ label: 'x' }] } }),
    /selector/
  );
  assert.deepEqual(
    parseVisualizeRequest({
      sessionId: 's1',
      cwd,
      action: 'annotate',
      input: { tab: 'v1', add: [{ selector: '#a', label: 'Hero' }] },
    }).op,
    { add: [{ selector: '#a', label: 'Hero' }] }
  );
  assert.equal(parseVisualizeRequest({ sessionId: 's1', cwd, action: 'close' }).tab, undefined);
});

test('targets route by type and may live anywhere, rooted in cwd or their own folder', async () => {
  const { root, cwd, cleanup } = workspace();
  try {
    assert.equal(visualizeKindForPath('a/page.HTM'), 'html');
    assert.equal(visualizeKindForPath('deck.pptx'), 'document');
    assert.equal(visualizeKindForPath('doc.pdf'), 'pdf');
    assert.equal(visualizeKindForPath('clip.webm'), 'video');
    assert.equal(visualizeKindForPath('song.mp3'), 'audio');
    assert.equal(visualizeKindForPath('pic.svg'), 'image');
    assert.equal(visualizeKindForPath('code.ts'), '');

    assert.equal((await resolveVisualizeTarget(cwd, 'site/index.html')).kind, 'html');
    assert.equal((await resolveVisualizeTarget(cwd, join(cwd, 'report.docx'))).kind, 'document');
    assert.equal((await resolveVisualizeTarget(cwd, 'chart.png')).kind, 'image');
    const web = await resolveVisualizeTarget(cwd, 'http://127.0.0.1:5173/app');
    assert.deepEqual([web.kind, web.url], ['url', 'http://127.0.0.1:5173/app']);

    assert.equal((await resolveVisualizeTarget(cwd, 'site/index.html')).root, realpathSync(cwd));
    // Outside cwd: opened all the same, rooted in the file's own folder.
    for (const raw of ['../secret.html', join(root, 'secret.html')]) {
      const outside = await resolveVisualizeTarget(cwd, raw);
      assert.deepEqual(
        [outside.kind, outside.path, outside.root],
        ['html', realpathSync(join(root, 'secret.html')), realpathSync(root)]
      );
    }
    await assert.rejects(resolveVisualizeTarget(cwd, 'notes.txt'), /unsupported file type/);
    await assert.rejects(resolveVisualizeTarget(cwd, 'missing.html'), /not found/);
    await assert.rejects(resolveVisualizeTarget(cwd, 'site'), /not a file/);
    await assert.rejects(resolveVisualizeTarget(cwd, 'file:///etc/passwd'), /only http\(s\)/);
    await assert.rejects(resolveVisualizeTarget(cwd, 'ftp://example.com/x.html'), /only http\(s\)/);

    // A link inside cwd that points outside it is rooted where it resolves.
    let linked = false;
    try {
      symlinkSync(join(root, 'secret.html'), join(cwd, 'link.html'));
      linked = true;
    } catch {
      /* symlinks need privileges on some Windows hosts */
    }
    if (linked) assert.equal((await resolveVisualizeTarget(cwd, 'link.html')).root, realpathSync(root));

    const output = await resolveCaptureOutput(cwd, 'shots/home.png');
    assert.equal(output, join(cwd, 'shots', 'home.png'));
    assert.ok(existsSync(join(cwd, 'shots')));
    await assert.rejects(resolveCaptureOutput(cwd, 'shots/home.jpg'), /\.png/);
    await assert.rejects(resolveCaptureOutput(cwd, '../escape.png'), /outside the working directory/);
  } finally {
    cleanup();
  }
});

test('open says so when the panel is not on screen, keeping "as tab vN"', async () => {
  const { cwd, cleanup } = workspace();
  let visible = false;
  const asked = [];
  const { deps } = fakeDeps({
    onScreen: async (sessionId, tab) => {
      asked.push([sessionId, tab.id]);
      return visible ? 'visible' : 'hidden';
    },
  });
  const service = createVisualizeService(deps);
  try {
    const hidden = await service.execute({
      sessionId: 's1',
      cwd,
      action: 'open',
      input: { targets: ['site/index.html'] },
    });
    assert.match(hidden.text, /\bas tab v1\b/);
    assert.match(hidden.text, /not on screen/);
    assert.doesNotMatch(hidden.text, /Showing/);
    assert.deepEqual(asked, [['s1', 'v1']]);

    visible = true;
    const shown = await service.execute({
      sessionId: 's1',
      cwd,
      action: 'open',
      input: { targets: ['site/index.html'] },
    });
    assert.match(shown.text, /^Showing site\/index\.html \(html\) in the side panel as tab v1\./);
    assert.doesNotMatch(shown.text, /not on screen/);
  } finally {
    cleanup();
  }
});

test("a sub-agent's or room member's open lands in its owner conversation's panel", async () => {
  const { cwd, cleanup } = workspace();
  const { deps, events } = fakeDeps({
    ownerSessionId: (sessionId) => ({ sess_child: 'sess_lead', sess_member: 'sess_room' })[sessionId] ?? sessionId,
  });
  const service = createVisualizeService(deps);
  try {
    const opened = await service.execute({
      sessionId: 'sess_child',
      cwd,
      action: 'open',
      input: { targets: ['site/index.html'] },
    });
    assert.match(opened.text, /\bas tab v1\b/);
    assert.match(
      opened.text,
      /\nShown in the side panel of session sess_lead \(the conversation this agent works for\)\.$/
    );
    assert.equal(events.at(-1).sessionId, 'sess_lead', 'published to the listed owner');
    assert.equal(events.at(-1).reveal, true);
    assert.deepEqual(
      service.snapshot().map((state) => [state.sessionId, state.tabs.map((tab) => tab.id)]),
      [['sess_lead', ['v1']]],
      'no tab under the unlisted child session'
    );
    assert.equal(opened.ownerSessionId, 'sess_lead', 'the owner rides as a field for the chat cards');
    // Its later actions find the tab under the owner too.
    const closed = await service.execute({ sessionId: 'sess_child', cwd, action: 'close', input: { tab: 'v1' } });
    assert.match(closed.text, /^Closed visualize tab v1\./);
    // A room member's opens go to the room's own conversation.
    await service.execute({ sessionId: 'sess_member', cwd, action: 'open', input: { targets: ['chart.png'] } });
    assert.equal(events.at(-1).sessionId, 'sess_room');
    // A top-level session is its own owner: no note.
    const own = await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['chart.png'] } });
    assert.doesNotMatch(own.text, /Shown in the side panel of session/);
    assert.equal(own.ownerSessionId, undefined);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('open says so when the panel keeps showing another tab the user picked', async () => {
  const { cwd, cleanup } = workspace();
  const { deps } = fakeDeps({ onScreen: async () => 'other-tab' });
  const service = createVisualizeService(deps);
  try {
    const result = await service.execute({
      sessionId: 's1',
      cwd,
      action: 'open',
      input: { targets: ['site/index.html'] },
    });
    assert.match(
      result.text,
      /^Opened site\/index\.html \(html\) in the side panel as tab v1, but the panel keeps showing another tab the user picked/
    );
    assert.match(result.text, /marked updated .*tell the user it is there/);
    assert.doesNotMatch(result.text, /not on screen/);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('open reuses tabs, splits panes, reloads on change, and closes', async () => {
  const { cwd, cleanup } = workspace();
  const { deps, events, watched } = fakeDeps();
  const service = createVisualizeService(deps);
  try {
    const first = await service.execute({
      sessionId: 's1',
      cwd,
      action: 'open',
      input: { targets: ['site/index.html'] },
    });
    assert.deepEqual(first.tabs, [{ id: 'v1', label: 'site', kind: 'html', target: 'site/index.html' }]);
    assert.match(first.text, /site\/index\.html \(html\)/);
    const opened = events.at(-1);
    assert.equal(opened.reveal, true);
    assert.equal(opened.state.active, 'v1');
    assert.equal(opened.state.tabs[0].panes[0].kind, 'html');

    const split = await service.execute({
      sessionId: 's1',
      cwd,
      action: 'open',
      input: { targets: ['report.docx', 'paper.pdf', 'chart.png'], label: 'Compare' },
    });
    assert.deepEqual(split.tabs, [
      { id: 'v2', label: 'Compare', kind: 'split', target: 'report.docx | paper.pdf | chart.png' },
    ]);
    assert.deepEqual(
      events.at(-1).state.tabs[1].panes.map((pane) => [pane.kind, pane.label]),
      [
        ['document', 'report.docx'],
        ['pdf', 'paper.pdf'],
        ['image', 'chart.png'],
      ]
    );

    // Same targets again: the existing tab comes back, not a new one.
    const again = await service.execute({
      sessionId: 's1',
      cwd,
      action: 'open',
      input: { targets: ['site/index.html'] },
    });
    assert.equal(again.tabs[0].id, 'v1');
    assert.equal(service.snapshot()[0].tabs.length, 2);

    // A watched file change reloads that tab (debounced) in place: the
    // event names the updated tab and asks for no reveal (only an open does).
    const before = service.snapshot()[0].tabs.find((tab) => tab.id === 'v1').revision;
    const change = [...watched.entries()].find(([path]) => path.endsWith('index.html'))[1];
    const eventsBefore = events.length;
    change();
    change();
    await service.settled();
    const reloaded = events.slice(eventsBefore).findLast((event) => event.updated);
    assert.equal(reloaded.updated, 'v1');
    assert.equal(reloaded.reveal, undefined);
    assert.equal(
      events.slice(eventsBefore).some((event) => event.reveal),
      false
    );
    assert.equal(reloaded.state.tabs.find((tab) => tab.id === 'v1').revision, before + 1);

    // Other sessions never see this session's tabs.
    assert.match(
      (await service.execute({ sessionId: 's2', cwd, action: 'close', input: {} })).text,
      /No visualize tabs/
    );
    await assert.rejects(
      service.execute({ sessionId: 's2', cwd, action: 'close', input: { tab: 'v1' } }),
      /no visualize tab "v1"/
    );

    const closed = await service.execute({ sessionId: 's1', cwd, action: 'close', input: { tab: 'v2' } });
    assert.deepEqual(
      closed.tabs.map((tab) => tab.id),
      ['v1']
    );
    assert.equal(watched.size, 1);
    const all = await service.execute({ sessionId: 's1', cwd, action: 'close', input: {} });
    assert.match(all.text, /Closed 1 visualize tab/);
    assert.equal(watched.size, 0);
    assert.deepEqual(events.at(-1).state.tabs, []);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('web URLs go to the browser panel alone; failures are errors', async () => {
  const { cwd, cleanup } = workspace();
  const { deps, events, setBrowser } = fakeDeps();
  const service = createVisualizeService(deps);
  try {
    const opened = await service.execute({
      sessionId: 's1',
      cwd,
      action: 'open',
      input: { targets: ['http://localhost:3000/'] },
    });
    assert.equal(opened.tabs[0].kind, 'url');
    assert.deepEqual(events.at(-1), {
      sessionId: 's1',
      openUrl: 'http://localhost:3000/',
      openRequestId: events.at(-1).openRequestId,
    });
    assert.ok(events.at(-1).openRequestId);
    // No page exists yet in this fake panel: the result never offers the
    // visualize id as a browser tab (the browser tool's `v1` is its first page).
    assert.doesNotMatch(opened.text, /\(tab v1\)/);
    assert.match(opened.text, /list_tabs/);
    await assert.rejects(
      service.execute({
        sessionId: 's1',
        cwd,
        action: 'open',
        input: { targets: ['http://localhost:3000/', 'chart.png'] },
      }),
      /opens alone/
    );
    await assert.rejects(
      service.execute({ sessionId: 's1', cwd, action: 'capture', input: { tab: opened.tabs[0].id, output: 'a.png' } }),
      /browser tool/
    );
    setBrowser(false);
    await assert.rejects(
      service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['https://example.com'] } }),
      /Browser Use/
    );
    // A failed file resolution leaves no tab behind.
    await assert.rejects(
      service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['chart.png', '../missing.html'] } }),
      /target not found/
    );
    assert.equal(service.snapshot().length, 0);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('a web URL open names the page its own new tab created, not an older page at the same address', async () => {
  const { cwd, cleanup } = workspace();
  const url = 'http://127.0.0.1:8765/index.html';
  // The panel already shows p1 at this address; the open makes p2.
  const { deps, watched, panel, serve } = fakePanelDeps({ pages: [{ id: 'p1', url }] });
  const service = createVisualizeService(deps);
  try {
    const pending = opening(service, cwd, url);
    await published(panel, 1);
    serve(panel.published[0], 'p2');
    const opened = await pending;
    assert.equal(watched.length, 1, 'the watch starts before the pane is asked');
    assert.equal(watched[0][1], panel.published[0].openRequestId, 'the watch and the pane share the request id');
    assert.match(opened.text, /as page p2; pass tab:"p2" to the browser tool/);
    assert.doesNotMatch(opened.text, /\bp1\b|\bv1\b/);
    assert.equal(panel.pages.length, 2);
  } finally {
    service.dispose();
    cleanup();
  }
});

// A tiny fake of the pane + host: a published `openUrl` event is queued, and
// `serve(requestId, pageId)` plays the pane creating that request's tab.
function fakePanelDeps({ pages = [] } = {}) {
  const panel = { pages: [...pages], published: [] };
  const watchers = new Map();
  const watched = [];
  const { deps } = fakeDeps({
    watchBrowserTab(sessionId, requestId) {
      watched.push([sessionId, requestId]);
      let settle;
      const page = new Promise((resolve) => {
        settle = resolve;
      });
      watchers.set(requestId, settle);
      return { page, cancel: () => settle(null) };
    },
    publish(event) {
      if (event.openUrl) panel.published.push(event);
    },
  });
  // Auto-serve every request in order unless the test takes over.
  const serve = (event, pageId) => {
    panel.pages.push({ id: pageId, url: event.openUrl });
    watchers.get(event.openRequestId)?.(pageId);
  };
  const supersede = (event) => watchers.get(event.openRequestId)?.(null);
  return { deps, watched, panel, serve, supersede };
}

const opening = (service, cwd, url) =>
  service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: [url] } });
const published = async (panel, count) => {
  while (panel.published.length < count) await new Promise((resolve) => setImmediate(resolve));
};

test('a user "+" while a URL open waits does not answer it; the open gets its own tab', async () => {
  const { cwd, cleanup } = workspace();
  const url = 'http://127.0.0.1:8765/index.html';
  const { deps, panel, serve } = fakePanelDeps();
  const service = createVisualizeService(deps);
  try {
    const pending = opening(service, cwd, url);
    await published(panel, 1);
    assert.ok(panel.published[0].openRequestId, 'the pane is told which request the tab is for');
    // The user's "+" makes p9 with no request id: it resolves nobody (the
    // host ignores an unnamed tab), so the open is still waiting.
    panel.pages.push({ id: 'p9', url: 'about:blank' });
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false);
    serve(panel.published[0], 'p10');
    assert.match((await pending).text, /as page p10;/);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('opens A then B coalesced by the pane: A gets the fallback, B its own page', async () => {
  const { cwd, cleanup } = workspace();
  const { deps, panel, serve, supersede } = fakePanelDeps();
  const service = createVisualizeService(deps);
  try {
    const a = opening(service, cwd, 'http://127.0.0.1:8765/a.html');
    await published(panel, 1);
    const b = opening(service, cwd, 'http://127.0.0.1:8765/b.html');
    await published(panel, 2);
    assert.notEqual(panel.published[0].openRequestId, panel.published[1].openRequestId);
    // The pane kept only B's address; the host settles A when B's tab appears.
    supersede(panel.published[0]);
    serve(panel.published[1], 'p3');
    const [first, second] = await Promise.all([a, b]);
    assert.match(first.text, /list_tabs/);
    assert.doesNotMatch(first.text, /p3/);
    assert.match(second.text, /as page p3;/);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('two concurrent URL opens that both get tabs each name their own page', async () => {
  const { cwd, cleanup } = workspace();
  const { deps, panel, serve } = fakePanelDeps();
  const service = createVisualizeService(deps);
  try {
    const a = opening(service, cwd, 'http://127.0.0.1:8765/a.html');
    const b = opening(service, cwd, 'http://127.0.0.1:8765/b.html');
    await published(panel, 2);
    serve(panel.published[1], 'p8');
    serve(panel.published[0], 'p7');
    const [first, second] = await Promise.all([a, b]);
    assert.match(first.text, /as page p7;/);
    assert.match(second.text, /as page p8;/);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('a web URL open without a browser host answers at once with the list_tabs fallback', async () => {
  const { cwd, cleanup } = workspace();
  // Every wait the service could make never elapses: the answer must not depend on one.
  const { deps } = fakeDeps({ delay: () => new Promise(() => {}) });
  const service = createVisualizeService(deps);
  try {
    const outcome = await Promise.race([
      service.execute({
        sessionId: 's1',
        cwd,
        action: 'open',
        input: { targets: ['http://127.0.0.1:8765/index.html'] },
      }),
      (async () => {
        for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
        return null;
      })(),
    ]);
    assert.notEqual(outcome, null, 'the open waited for a page that nothing will create');
    const opened = outcome;
    assert.match(opened.text, /list_tabs/);
    assert.doesNotMatch(opened.text, /as page/);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('a web URL open whose publish fails cancels its tab watch', async () => {
  const { cwd, cleanup } = workspace();
  let cancelled = 0;
  const { deps } = fakeDeps({
    watchBrowserTab: () => ({ page: new Promise(() => {}), cancel: () => (cancelled += 1) }),
    publish() {
      throw new Error('window gone');
    },
  });
  const service = createVisualizeService(deps);
  try {
    await assert.rejects(
      service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['http://127.0.0.1:8765/'] } }),
      /window gone/
    );
    assert.equal(cancelled, 1);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('annotate is HTML-only and capture writes the PNG inside cwd', async () => {
  const { cwd, cleanup } = workspace();
  const { deps, events } = fakeDeps();
  const service = createVisualizeService(deps);
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } });
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['chart.png'] } });
    await assert.rejects(
      service.execute({ sessionId: 's1', cwd, action: 'annotate', input: { tab: 'v2', clear: true } }),
      /HTML tabs only/
    );
    const marked = await service.execute({
      sessionId: 's1',
      cwd,
      action: 'annotate',
      input: { tab: 'v1', add: [{ selector: 'h1', label: 'Title' }] },
    });
    assert.match(marked.text, /h1 "Title" → 1 match/);
    // Annotating a background tab brings it to front first.
    assert.equal(events.find((event) => event.state?.active === 'v1' && !event.reveal)?.sessionId, 's1');

    const shot = await service.execute({
      sessionId: 's1',
      cwd,
      action: 'capture',
      input: { tab: 'v2', output: 'out/view.png' },
    });
    assert.equal(shot.path, join(cwd, 'out', 'view.png'));
    assert.equal(readFileSync(shot.path, 'utf8'), 'PNGDATA');
    await assert.rejects(
      service.execute({ sessionId: 's1', cwd, action: 'capture', input: { tab: 'v2', output: '../x.png' } }),
      /outside the working directory/
    );
  } finally {
    service.dispose();
    cleanup();
  }
});

test('a parent folder swapped for a link outside its recorded root stops serving and closes the tab', async () => {
  const { root, cwd, cleanup } = workspace();
  mkdirSync(join(cwd, 'media'));
  writeFileSync(join(cwd, 'media', 'pic.png'), 'inside');
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(root, 'outside', 'pic.png'), 'outside');
  const { deps, events, watched } = fakeDeps();
  const service = createVisualizeService(deps);
  try {
    const realCwd = realpathSync(cwd);
    const preview = registerFilePreview(join(realCwd, 'media', 'pic.png'), 'v1', { root: realCwd });
    const record = resolveFilePreview(new URL(preview.url).pathname.split('/')[1]);
    assert.equal(await filePreviewServable(record), true);
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['media/pic.png'] } });
    assert.equal(service.snapshot()[0].tabs.length, 1);

    renameSync(join(cwd, 'media'), join(cwd, 'media-old'));
    symlinkSync(join(root, 'outside'), join(cwd, 'media'), 'junction');
    // Serving re-resolves the registered path and fails closed.
    assert.equal(await filePreviewServable(record), false);
    // The reload re-resolves the target inside the root recorded at open and
    // closes the tab instead of adopting the folder the link points to.
    [...watched.values()][0]();
    await service.settled();
    assert.deepEqual(events.at(-1).state.tabs, []);
    assert.deepEqual(
      service.snapshot().flatMap((state) => state.tabs),
      []
    );
    assert.deepEqual(
      service.snapshot()[0].history.map((item) => item.open),
      [false]
    );
    assert.equal(watched.size, 0);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('a page outside cwd opens with its own folder as root: assets, versions, restore and remote reads', async () => {
  const { root, cwd, cleanup } = workspace();
  const elsewhere = join(root, 'workspace', 'unclassified', 'design');
  mkdirSync(elsewhere, { recursive: true });
  const page = join(elsewhere, 'mockup.html');
  const css = join(elsewhere, 'style.css');
  const write = (word, color) => {
    writeFileSync(page, `<link rel="stylesheet" href="style.css"><img src="pic.png"><h1>${word}</h1>`);
    writeFileSync(css, `h1{color:${color}}`);
  };
  write('one', 'red');
  writeFileSync(join(elsewhere, 'pic.png'), 'png');
  writeFileSync(join(root, 'workspace', 'unclassified', 'above.css'), 'above');
  const { deps, events, watched } = fakeDeps({
    versions: { directory: join(root, 'app-data', 'visualize-versions') },
    preparePane: (target) =>
      panePreviewUrl(target, {
        contents: () => undefined,
        observe: () => {},
        convertDocument: async () => {
          throw new Error('no documents here');
        },
      }),
  });
  const service = createVisualizeService(deps);
  const get = (url, path) =>
    new Promise((resolve, reject) => {
      const { hostname, port } = new URL(url);
      const req = httpRequest({ hostname, port, path }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end();
    });
  const latest = () => events.filter((event) => event.state).at(-1).state.tabs[0];
  const command = (rest) => service.command({ sessionId: 's1', tabId: 'v1', ...rest });
  try {
    const opened = await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: [page] } });
    assert.match(opened.text, /as tab v1/);
    assert.ok(opened.text.includes(realpathSync(page)), 'the result names the outside file by its path');

    // Served from its own folder: the page and its sibling style and image,
    // but nothing above that folder.
    const url = latest().panes[0].url;
    const { pathname } = new URL(url);
    const prefix = pathname.slice(0, pathname.lastIndexOf('/'));
    assert.match((await get(url, pathname)).body, /<h1>one<\/h1>/);
    assert.deepEqual(await get(url, `${prefix}/style.css`), { status: 200, body: 'h1{color:red}' });
    assert.equal((await get(url, `${prefix}/pic.png`)).status, 200);
    assert.equal((await get(url, `${prefix}/../above.css`)).status, 404);
    assert.equal((await get(url, `${prefix}/%2e%2e/above.css`)).status, 404);
    assert.equal(latest().panes[0].file, 'mockup.html');

    // A change keeps a version; the old one restores page and stylesheet in place.
    write('two', 'blue');
    [...watched.entries()].find(([path]) => path.endsWith('mockup.html'))[1]();
    await service.settled();
    assert.deepEqual(
      latest().versions.map((version) => version.n),
      [1, 2]
    );
    await command({ action: 'version', version: 1 });
    assert.deepEqual(latest().restoreAssets, ['style.css']);
    await command({ action: 'restore', version: 1, assets: ['style.css'] });
    assert.match(readFileSync(page, 'utf8'), /<h1>one<\/h1>/);
    assert.equal(readFileSync(css, 'utf8'), 'h1{color:red}');
    assert.deepEqual(
      latest().versions.map((version) => [version.n, version.label ?? '']),
      [
        [1, ''],
        [2, ''],
        [3, 'Restored from v1'],
      ]
    );

    // A paired device reads the tab from the same root.
    const host = service.hostSnapshot()[0];
    assert.equal(host.tabs[0].panes[0].root, realpathSync(elsewhere));
    const methods = createRemoteVisualizeMethods({
      mirror: createRemoteVisualizeMirror(),
      hostRequest: async (method) => (method === 'visualizeState' ? service.hostSnapshot() : null),
      invokeDesktopOperation: async () => null,
    });
    const text = (range) => Buffer.from(range.data, 'base64').toString();
    const remote = await methods.visualizePaneFile(['s1', 'v1', 0]);
    assert.deepEqual([remote.kind, remote.rel], ['html', 'mockup.html']);
    assert.match(text(await methods.visualizePaneRange(['s1', 'v1', 'mockup.html', 0, 200, 0])), /one/);
    assert.equal(text(await methods.visualizePaneRange(['s1', 'v1', 'style.css', 0, 100, 0])), 'h1{color:red}');
    await assert.rejects(methods.visualizePaneRange(['s1', 'v1', '../above.css', 0, 100, 0]), /outside the project/);
    const json = JSON.stringify(remoteVisualizeState(host));
    assert.equal(json.includes(JSON.stringify(realpathSync(root)).slice(1, -1)), false, 'no host path');
  } finally {
    service.dispose();
    cleanup();
  }
});

test('a restore after the page folder was swapped for a link to another folder writes nothing there', async () => {
  const { root, cwd, cleanup } = workspace();
  const design = join(root, 'elsewhere', 'design');
  const unrelated = join(root, 'unrelated');
  mkdirSync(design, { recursive: true });
  mkdirSync(unrelated);
  const pic = join(design, 'pic.png');
  writeFileSync(pic, 'one');
  writeFileSync(join(unrelated, 'pic.png'), 'victim');
  const { deps, events, watched } = fakeDeps({ versions: { directory: join(root, 'app-data', 'visualize-versions') } });
  const service = createVisualizeService(deps);
  const latest = () => events.filter((event) => event.state).at(-1).state.tabs[0];
  const command = (rest) => service.command({ sessionId: 's1', tabId: 'v1', ...rest });
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: [pic] } });
    writeFileSync(pic, 'two');
    [...watched.values()][0]();
    await service.settled();
    assert.deepEqual(
      latest().versions.map((version) => version.n),
      [1, 2]
    );
    await command({ action: 'version', version: 1 });
    // The page's folder now links to a folder the tab never recorded.
    renameSync(design, `${design}-old`);
    symlinkSync(unrelated, design, 'junction');
    await assert.rejects(
      command({ action: 'restore', version: 1 }),
      /v1 was not restored: target resolves outside the folder recorded for it/
    );
    assert.equal(readFileSync(join(unrelated, 'pic.png'), 'utf8'), 'victim', 'the unrelated file is untouched');
    assert.deepEqual(readdirSync(unrelated), ['pic.png']);
    assert.equal(readFileSync(join(`${design}-old`, 'pic.png'), 'utf8'), 'two');
  } finally {
    service.dispose();
    cleanup();
  }
});

test('a two-folder tab confirms each style.css by its own folder: one never authorizes the other', async () => {
  const { root, cwd, cleanup } = workspace();
  const { deps, events, watched } = fakeDeps({ versions: { directory: join(root, 'app-data', 'visualize-versions') } });
  const service = createVisualizeService(deps);
  const folder = (name) => join(root, 'elsewhere', name);
  const page = (name) => join(folder(name), 'index.html');
  const css = (name) => join(folder(name), 'style.css');
  for (const name of ['a', 'b']) {
    mkdirSync(folder(name), { recursive: true });
    writeFileSync(page(name), `<link rel="stylesheet" href="style.css"><h1>${name} one</h1>`);
    writeFileSync(css(name), 'h1{color:red}');
  }
  const latest = () => events.filter((event) => event.state).at(-1).state.tabs[0];
  const command = (rest) => service.command({ sessionId: 's1', tabId: 'v1', ...rest });
  const files = () => ['a', 'b'].flatMap((name) => [readFileSync(page(name), 'utf8'), readFileSync(css(name), 'utf8')]);
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: [page('a'), page('b')] } });
    for (const name of ['a', 'b'])
      writeFileSync(page(name), `<link rel="stylesheet" href="style.css"><h1>${name} two</h1>`);
    writeFileSync(css('a'), 'h1{color:blue}');
    [...watched.values()][0]();
    await service.settled();
    assert.deepEqual(
      latest().versions.map((version) => version.n),
      [1, 2]
    );
    await command({ action: 'version', version: 1 });
    // Only a's stylesheet differs from v1, named with its folder (b keeps one too).
    assert.deepEqual(latest().restoreAssets, ['style.css (a)']);

    // b's stylesheet changes after the confirm listed only a's.
    writeFileSync(css('b'), 'h1{color:green}');
    const before = files();
    await assert.rejects(
      command({ action: 'restore', version: 1, assets: ['style.css (a)'] }),
      /v1 was not restored: it would also overwrite style\.css \(b\), which the confirmation did not list/
    );
    assert.deepEqual(files(), before, "a's confirmation wrote nothing, b's file least of all");
    // The reverse: b's confirmation does not authorize a's file.
    await assert.rejects(
      command({ action: 'restore', version: 1, assets: ['style.css (b)'] }),
      /it would also overwrite style\.css \(a\),/
    );
    // A bare name authorizes neither root's file.
    await assert.rejects(command({ action: 'restore', version: 1, assets: ['style.css'] }), /was not restored/);
    assert.deepEqual(files(), before);
    assert.deepEqual(latest().restoreAssets, ['style.css (a)', 'style.css (b)']);

    // b back as v1 kept it: restoring with a's confirmation writes a's file only.
    writeFileSync(css('b'), 'h1{color:red}');
    const old = new Date(Date.now() - 60_000);
    utimesSync(css('b'), old, old);
    const bStamp = statSync(css('b')).mtimeMs;
    await command({ action: 'restore', version: 1, assets: ['style.css (a)'] });
    assert.equal(readFileSync(css('a'), 'utf8'), 'h1{color:red}');
    assert.match(readFileSync(page('a'), 'utf8'), /a one/);
    assert.equal(statSync(css('b')).mtimeMs, bStamp, "b's stylesheet was not written");
  } finally {
    service.dispose();
    cleanup();
  }
});

test('a rejected capture output creates no folder outside cwd through a link', async () => {
  const { root, cwd, cleanup } = workspace();
  try {
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), join(cwd, 'out-link'), 'junction');
    await assert.rejects(resolveCaptureOutput(cwd, 'out-link/deep/er/shot.png'), /outside the working directory/);
    assert.equal(existsSync(join(root, 'elsewhere', 'deep')), false);
  } finally {
    cleanup();
  }
});

test('closing never reports a browser-panel page as closed', async () => {
  const { cwd, cleanup } = workspace();
  const { deps } = fakeDeps();
  const service = createVisualizeService(deps);
  try {
    const page = await service.execute({
      sessionId: 's1',
      cwd,
      action: 'open',
      input: { targets: ['http://localhost:3000/'] },
    });
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['chart.png'] } });
    const id = page.tabs[0].id;
    await assert.rejects(
      service.execute({ sessionId: 's1', cwd, action: 'close', input: { tab: id } }),
      /browser panel .*close it with the browser tool/
    );
    const all = await service.execute({ sessionId: 's1', cwd, action: 'close', input: {} });
    assert.match(
      all.text,
      /Closed 1 visualize tab\. Still open in the browser panel: v1 \(http:\/\/localhost:3000\/\)/
    );
    assert.deepEqual(
      all.tabs.map((tab) => [tab.id, tab.kind]),
      [[id, 'url']]
    );
    // The browser-panel page is no visual; the closed chart stays listed.
    assert.deepEqual(
      service.snapshot().flatMap((state) => state.tabs),
      []
    );
    assert.deepEqual(
      service.snapshot()[0].history.map((item) => [item.label, item.open]),
      [['chart.png', false]]
    );
  } finally {
    service.dispose();
    cleanup();
  }
});

test('rapid writes settle into one reload and one version, updated in place without a reveal', async () => {
  const { root, cwd, cleanup } = workspace();
  const { deps, events, watched, prepared } = fakeDeps({
    versions: { directory: join(root, 'app-data', 'visualize-versions') },
    reloadDebounceMs: 40,
  });
  const service = createVisualizeService(deps);
  const page = join(cwd, 'site', 'index.html');
  const latest = () => events.filter((event) => event.state).at(-1).state.tabs[0];
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } });
    assert.deepEqual(
      latest().versions.map((version) => version.n),
      [1]
    );
    const opened = events.at(-1);
    assert.equal(opened.reveal, true, 'an open still reveals its tab');
    const preparedBefore = prepared.length;
    const revisionBefore = latest().revision;
    const eventsBefore = events.length;
    const change = [...watched.entries()].find(([path]) => path.endsWith('index.html'))[1];
    for (let write = 1; write <= 5; write += 1) {
      writeFileSync(page, `<h1>write ${write}</h1>`);
      change();
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    await service.settled();
    assert.equal(prepared.length - preparedBefore, 1, 'one reload for the burst');
    assert.equal(latest().revision, revisionBefore + 1);
    assert.deepEqual(
      latest().versions.map((version) => version.n),
      [1, 2],
      'one version per settled update'
    );
    const published = events.slice(eventsBefore);
    assert.equal(
      published.some((event) => event.reveal),
      false,
      'a content update never reveals'
    );
    assert.equal(published.filter((event) => event.updated === 'v1').length, 1);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('a tab whose folder is deleted and recreated shows a removed state, then reloads and re-arms its watch', async () => {
  const { cwd, cleanup } = workspace();
  const { deps, events, watched } = fakeDeps({ reloadDebounceMs: 20 });
  let watches = 0;
  const watch = deps.watch;
  deps.watch = (path, onChange) => {
    watches += 1;
    return watch(path, onChange);
  };
  const service = createVisualizeService(deps);
  const site = join(cwd, 'site');
  const latest = () => events.filter((event) => event.state).at(-1).state.tabs[0];
  const until = async (done) => {
    for (let waited = 0; waited < 3000 && !done(); waited += 20)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(done(), 'condition not reached in time');
  };
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } });
    const revision = latest().revision;
    const armed = watches;
    // The agent removes the whole folder: the one change event is all the dead watch reports.
    rmSync(site, { recursive: true, force: true });
    [...watched.values()][0]();
    await until(() => latest().missing === true);
    assert.equal(latest().revision, revision, 'the last view is not replaced by a broken one');
    assert.deepEqual(
      remoteVisualizeState({
        sessionId: 's1',
        active: 'v1',
        tabs: [{ ...latest(), remoteLabel: 'x', cwd, panes: [] }],
      }).tabs[0].missing,
      true,
      'a paired device is told too'
    );
    // Seconds later the file is written again; no watch event ever arrives.
    await new Promise((resolve) => setTimeout(resolve, 150));
    mkdirSync(site, { recursive: true });
    writeFileSync(join(site, 'index.html'), '<h1>back</h1>');
    await until(() => latest().missing !== true);
    assert.equal(latest().revision, revision + 1, 'the recreated file reloads the tab');
    assert.ok(watches > armed, 'the watch is armed again for the new folder');
    assert.equal(latest().problems, undefined);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('the default debounce waits for 1200ms of quiet', async (t) => {
  const { cwd, cleanup } = workspace();
  const { deps, watched, prepared } = fakeDeps({ reloadDebounceMs: undefined });
  const service = createVisualizeService(deps);
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } });
    const preparedBefore = prepared.length;
    const change = [...watched.entries()].find(([path]) => path.endsWith('index.html'))[1];
    t.mock.timers.enable({ apis: ['setTimeout'] });
    change();
    t.mock.timers.tick(1000);
    change();
    t.mock.timers.tick(1199);
    assert.equal(prepared.length, preparedBefore, 'each change restarts the wait');
    t.mock.timers.tick(1);
    t.mock.timers.reset();
    await service.settled();
    assert.equal(prepared.length - preparedBefore, 1);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('version history: kept on change, shown read-only, compared, restored, path-free remotely', async () => {
  const { root, cwd, cleanup } = workspace();
  const versionsDir = join(root, 'app-data', 'visualize-versions');
  const { deps, events, watched } = fakeDeps({
    versions: { directory: versionsDir },
    // The URL names the file the pane loads, so a kept version is visible.
    preparePane: async (target) => `fake://${target.root}|${target.path}`,
  });
  const service = createVisualizeService(deps);
  const page = join(cwd, 'site', 'index.html');
  const open = (input = {}) =>
    service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'], ...input } });
  const command = (rest) => service.command({ sessionId: 's1', tabId: 'v1', ...rest });
  const latest = () => events.filter((event) => event.state).at(-1).state.tabs[0];
  const numbers = () => latest().versions.map((version) => version.n);
  const paneFile = (pane) => readFileSync(pane.url.split('|')[1], 'utf8');
  const reload = async () => {
    [...watched.entries()].find(([path]) => path.endsWith('index.html'))[1]();
    await service.settled();
  };
  try {
    let result = await open();
    assert.deepEqual(numbers(), [1]);
    assert.equal(latest().version, null);
    assert.doesNotMatch(result.text, /version/);

    await reload();
    assert.deepEqual(numbers(), [1], 'an unchanged reload keeps no version');
    writeFileSync(page, '<h1>two</h1>');
    await reload();
    assert.deepEqual(numbers(), [1, 2]);
    result = await open();
    assert.match(result.text, /2 versions kept \(v1–v2\)/);

    // An old version shows its kept bytes, read-only; live reloads wait.
    await command({ action: 'version', version: 1 });
    let tab = latest();
    assert.equal(tab.version, 1);
    assert.equal(tab.panes.length, 1);
    assert.equal(tab.panes[0].version, 1);
    assert.equal(paneFile(tab.panes[0]), '<h1>hi</h1>');
    assert.ok(tab.panes[0].url.startsWith(`fake://${realpathSync(versionsDir)}`), 'served from the app data folder');
    const paused = tab.revision;
    writeFileSync(page, '<h1>three</h1>');
    await reload();
    assert.equal(latest().revision, paused, 'live reloads pause while a kept version is shown');
    assert.deepEqual(numbers(), [1, 2]);

    // Compare: the kept version beside live.
    await command({ action: 'version', version: 1, compare: true });
    tab = latest();
    assert.equal(tab.compare, true);
    assert.deepEqual(
      tab.panes.map((pane) => pane.version ?? 'live'),
      [1, 'live']
    );
    assert.equal(paneFile(tab.panes[0]), '<h1>hi</h1>');
    assert.deepEqual(numbers(), [1, 2], 'the live side still waits');

    // Back to live catches up on the change made meanwhile.
    await command({ action: 'version', version: null });
    tab = latest();
    assert.equal(tab.version, null);
    assert.equal(tab.compare, undefined);
    assert.deepEqual(numbers(), [1, 2, 3]);
    assert.equal(paneFile(tab.panes[0]), '<h1>three</h1>');

    // Restore writes the kept bytes back; they become the newest version.
    await command({ action: 'version', version: 1 });
    await command({ action: 'restore', version: 1 });
    assert.equal(readFileSync(page, 'utf8'), '<h1>hi</h1>');
    tab = latest();
    assert.equal(tab.version, null);
    assert.deepEqual(
      tab.versions.map((version) => [version.n, version.label ?? '']),
      [
        [1, ''],
        [2, ''],
        [3, ''],
        [4, 'Restored from v1'],
      ]
    );

    // The tool opens a kept version on request, and names the kept ones.
    result = await open({ version: 2 });
    assert.match(result.text, /Showing kept version v2 of 4 \(v1–v4\), read-only/);
    assert.equal(latest().version, 2);
    // The tab was already opened (and published) live: a version it does not
    // keep is a note of the result, never an error after the fact.
    result = await open({ version: 9 });
    assert.match(result.text, /\bas tab v1\b/);
    assert.match(
      result.text,
      /Version not shown: tab v1 has no version 9; kept versions: 1, 2, 3, 4; tab v1 shows the live files\./
    );
    assert.equal(latest().version, null);

    // Remote clients: the versions and kept-version panes, never a host path.
    await command({ action: 'version', version: 2, compare: true });
    const host = service.hostSnapshot()[0];
    assert.equal(host.tabs[0].panes[0].root.startsWith(realpathSync(versionsDir)), true);
    assert.equal(host.tabs[0].panes[1].root, realpathSync(cwd));
    const remote = remoteVisualizeState(host);
    const json = JSON.stringify(remote);
    for (const path of [root, realpathSync(root)]) {
      assert.equal(json.includes(path) || json.includes(JSON.stringify(path).slice(1, -1)), false, 'no host path');
    }
    assert.deepEqual(
      remote.tabs[0].versions.map((version) => version.n),
      [1, 2, 3, 4]
    );
    assert.equal(remote.tabs[0].version, 2);
    assert.equal(remote.tabs[0].compare, true);
    assert.deepEqual(
      remote.tabs[0].panes.map((pane) => [pane.target, pane.version ?? 'live', pane.url]),
      [
        ['site/index.html', 2, ''],
        ['site/index.html', 'live', ''],
      ]
    );

    result = await service.execute({ sessionId: 's1', cwd, action: 'close', input: { tab: 'v1' } });
    assert.match(result.text, /Its 4 kept versions were discarded/);
  } finally {
    service.dispose();
    cleanup();
  }
});

/** A tab on site/index.html (linking `css`) with v1 = (`one`, red) and
 *  v2 = (`two`, blue), for the restore tests. */
async function pageWithTwoVersions(cssRel, options = {}) {
  const space = workspace();
  const { deps, events, watched } = fakeDeps({
    versions: { directory: join(space.root, 'app-data', 'visualize-versions') },
    ...options,
  });
  const service = createVisualizeService(deps);
  const page = join(space.cwd, 'site', 'index.html');
  const css = join(space.cwd, 'site', ...cssRel.split('/'));
  mkdirSync(join(css, '..'), { recursive: true });
  const write = (word, color) => {
    writeFileSync(page, `<link rel="stylesheet" href="${cssRel}"><h1>${word}</h1>`);
    writeFileSync(css, `h1{color:${color}}`);
  };
  write('one', 'red');
  await service.execute({ sessionId: 's1', cwd: space.cwd, action: 'open', input: { targets: ['site/index.html'] } });
  write('two', 'blue');
  [...watched.values()][0]();
  await service.settled();
  return {
    ...space,
    service,
    page,
    css,
    latest: () => events.filter((event) => event.state).at(-1).state.tabs[0],
    command: (rest) => service.command({ sessionId: 's1', tabId: 'v1', ...rest }),
  };
}

test('restore also writes the kept page assets that changed, once the confirm listed them', async () => {
  const { service, page, css, latest, command, cleanup } = await pageWithTwoVersions('style.css');
  try {
    assert.deepEqual(
      latest().versions.map((version) => version.n),
      [1, 2]
    );
    await command({ action: 'version', version: 1 });
    assert.deepEqual(latest().restoreAssets, ['site/style.css'], 'the confirm lists the shared stylesheet');
    assert.deepEqual(remoteVisualizeState(service.hostSnapshot()[0]).tabs[0].restoreAssets, ['site/style.css']);

    // A changed asset the confirm did not list refuses the whole restore.
    await assert.rejects(
      command({ action: 'restore', version: 1 }),
      /v1 was not restored: it would also overwrite site\/style\.css, which the confirmation did not list/
    );
    assert.match(readFileSync(page, 'utf8'), /two/);
    assert.equal(readFileSync(css, 'utf8'), 'h1{color:blue}');

    await command({ action: 'restore', version: 1, assets: ['site/style.css'] });
    assert.match(readFileSync(page, 'utf8'), /one/);
    assert.equal(readFileSync(css, 'utf8'), 'h1{color:red}', 'the page looks as it did');
    const tab = latest();
    assert.equal(tab.version, null);
    assert.equal(tab.restoreAssets, undefined);
    assert.deepEqual(
      tab.versions.map((version) => [version.n, version.label ?? '']),
      [
        [1, ''],
        [2, ''],
        [3, 'Restored from v1'],
      ]
    );
  } finally {
    service.dispose();
    cleanup();
  }
});

test('a restore writes nothing once a folder became a link outside cwd after validation', async () => {
  const { root, cwd, service, page, latest, command, cleanup } = await pageWithTwoVersions('css/style.css');
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'style.css'), 'outside');
  try {
    await command({ action: 'version', version: 1 });
    assert.deepEqual(latest().restoreAssets, ['site/css/style.css']);
    renameSync(join(cwd, 'site', 'css'), join(cwd, 'site', 'css-old'));
    symlinkSync(outside, join(cwd, 'site', 'css'), 'junction');
    await assert.rejects(
      command({ action: 'restore', version: 1, assets: ['site/css/style.css'] }),
      /v1 was not restored: site\/css\/style\.css is outside the working directory/
    );
    assert.equal(readFileSync(join(outside, 'style.css'), 'utf8'), 'outside');
    assert.deepEqual(readdirSync(outside), ['style.css']);
    assert.match(readFileSync(page, 'utf8'), /two/, 'fails closed: not even the page was written');
    assert.equal(latest().version, 1);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('a full version history keeps the tab live, its list unchanged, and says so', async () => {
  const { root, cwd, cleanup } = workspace();
  const { deps, events } = fakeDeps({
    versions: { directory: join(root, 'app-data', 'visualize-versions'), maxSessionBytes: 6 },
  });
  const service = createVisualizeService(deps);
  const open = (target) => service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: [target] } });
  try {
    assert.doesNotMatch((await open('chart.png')).text, /history is full/);
    assert.doesNotMatch((await open('paper.pdf')).text, /history is full/);
    const full = await open('site/index.html');
    assert.match(full.text, /The current files were not kept as a version: this session's version history is full/);
    assert.deepEqual(
      full.tabs.map((tab) => [tab.id, tab.kind]),
      [['v3', 'html']]
    );
    const tabs = events.filter((event) => event.state).at(-1).state.tabs;
    assert.deepEqual(
      tabs.map((tab) => [tab.id, tab.versions.map((version) => version.n)]),
      [
        ['v1', [1]],
        ['v2', [1]],
        ['v3', []],
      ]
    );
  } finally {
    service.dispose();
    cleanup();
  }
});

test('a settled open takes the tab thumbnail; remote state carries it only within the cap', async () => {
  const { cwd, cleanup } = workspace();
  const asked = [];
  const png = Buffer.from('PNGTHUMB');
  const { deps, events } = fakeDeps({
    async thumbnail(sessionId, tab, targets) {
      asked.push([sessionId, tab.id, targets.map((target) => target.kind)]);
      return png;
    },
  });
  const service = createVisualizeService(deps);
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['chart.png'] } });
    await service.settled();
    assert.deepEqual(asked, [['s1', 'v1', ['image']]]);
    const thumbnail = `data:image/png;base64,${png.toString('base64')}`;
    assert.equal(events.at(-1).state.tabs[0].thumbnail, thumbnail);
    assert.equal(remoteVisualizeState(service.hostSnapshot()[0]).tabs[0].thumbnail, thumbnail);
    const oversized = `data:image/png;base64,${Buffer.alloc(VISUALIZE_THUMBNAIL_MAX_BYTES + 1).toString('base64')}`;
    const host = service.hostSnapshot()[0];
    assert.equal(
      remoteVisualizeState({ ...host, tabs: [{ ...host.tabs[0], thumbnail: oversized }] }).tabs[0].thumbnail,
      undefined
    );
    assert.equal(
      remoteVisualizeState({ ...host, tabs: [{ ...host.tabs[0], thumbnail: 'data:text/html,<b>' }] }).tabs[0].thumbnail,
      undefined
    );
  } finally {
    service.dispose();
    cleanup();
  }
});

test('no thumbnail when none can be taken; a closed tab is dropped from the pending capture', async () => {
  const { cwd, cleanup } = workspace();
  const { deps, events } = fakeDeps({ thumbnail: async () => null });
  const service = createVisualizeService(deps);
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } });
    await service.settled();
    assert.equal(events.at(-1).state.tabs[0].thumbnail, undefined, 'the card keeps its kind icon');
  } finally {
    service.dispose();
    cleanup();
  }
});

test('a tab that was off screen when its picture was due gets it once shown', async () => {
  const { cwd, cleanup } = workspace();
  // Only the tab on screen can be pictured; v2 opening right after v1 hides it.
  let onScreen = '';
  const asked = [];
  const { deps, events } = fakeDeps({
    async thumbnail(_sessionId, tab) {
      asked.push(tab.id);
      return tab.id === onScreen ? Buffer.from(`PNG-${tab.id}`) : null;
    },
  });
  const service = createVisualizeService(deps);
  const thumbnails = () =>
    Object.fromEntries(events.at(-1).state.tabs.map((tab) => [tab.id, tab.thumbnail ? 'yes' : 'no']));
  try {
    const diagram = { kind: 'mermaid', source: 'graph TD; A-->B', title: 'Flow' };
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { content: diagram } });
    onScreen = 'v2';
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['chart.png'] } });
    await service.settled();
    assert.deepEqual(thumbnails(), { v1: 'no', v2: 'yes' });
    // The user shows v1 (a tab click or a card press): its picture is taken then.
    onScreen = 'v1';
    asked.length = 0;
    await service.command({ sessionId: 's1', tabId: 'v1', action: 'activate' });
    await service.settled();
    assert.deepEqual(thumbnails(), { v1: 'yes', v2: 'yes' });
    // A tab that has its picture is not taken again on a mere switch.
    onScreen = 'v2';
    await service.command({ sessionId: 's1', tabId: 'v2', action: 'activate' });
    await service.settled();
    assert.deepEqual(asked, ['v1']);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('a closed tab reopens from its card with the same targets, ids never reused', async () => {
  const { cwd, cleanup } = workspace();
  const { deps, events } = fakeDeps({ sessionCwd: async (sessionId) => (sessionId === 's2' ? cwd : null) });
  const service = createVisualizeService(deps);
  const tabs = () => events.filter((event) => event.state && event.sessionId === 's1').at(-1).state.tabs;
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['chart.png'] } });
    await service.execute({ sessionId: 's1', cwd, action: 'close', input: {} });
    assert.deepEqual(tabs(), []);
    // A card reopens it in the cwd main remembers, revealing the panel.
    await service.command({ sessionId: 's1', tabId: 'v1', action: 'reopen', targets: ['chart.png'], label: 'Chart' });
    assert.deepEqual(
      tabs().map((tab) => [tab.id, tab.label, tab.panes[0].target]),
      [['v2', 'Chart', 'chart.png']]
    );
    assert.equal(events.at(-1).reveal, true);
    // Validated like an agent open.
    await assert.rejects(
      service.command({ sessionId: 's1', tabId: 'v9', action: 'reopen', targets: ['../missing.html'] }),
      /target not found/
    );
    // A session this run never opened: its own cwd from the session list.
    await service.command({ sessionId: 's2', tabId: 'v1', action: 'reopen', targets: ['paper.pdf'] });
    assert.equal(service.snapshot().find((state) => state.sessionId === 's2').tabs[0].panes[0].kind, 'pdf');
    await assert.rejects(
      service.command({ sessionId: 's3', tabId: 'v1', action: 'reopen', targets: ['paper.pdf'] }),
      /working directory is unknown/
    );
  } finally {
    service.dispose();
    cleanup();
  }
});

test('an absolute-path open puts no host path anywhere in the remote state', async () => {
  const { root, cwd, cleanup } = workspace();
  const hostEvents = [];
  const { deps } = fakeDeps({ publishHost: (event) => hostEvents.push(event) });
  const service = createVisualizeService(deps);
  const remote = () => [
    ...hostEvents.filter((event) => event.state).map((event) => remoteVisualizeState(event.state)),
    ...service.hostSnapshot().map(remoteVisualizeState),
  ];
  const leaks = (states) => {
    const json = JSON.stringify(states);
    // Both separators: JSON escapes backslashes, so check raw and escaped forms.
    return [root, realpathSync(root), cwd].some(
      (path) => json.includes(path) || json.includes(JSON.stringify(path).slice(1, -1))
    );
  };
  try {
    const page = join(cwd, 'site', 'index.html');
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: [page] } });
    await service.execute({
      sessionId: 's1',
      cwd,
      action: 'open',
      input: { targets: [join(cwd, 'chart.png'), 'paper.pdf'], label: `Charts from ${cwd}` },
    });
    await service.execute({
      sessionId: 's1',
      cwd,
      action: 'open',
      input: { targets: [join(cwd, 'report.docx')], label: 'see C:\\Users\\me\\report.docx' },
    });
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['chart.png'], label: 'Chart' } });
    const states = remote();
    assert.equal(leaks(states), false, 'no absolute host path in any remote field');
    const tabs = states.at(-1).tabs;
    assert.deepEqual(
      tabs.map((tab) => [tab.label, tab.panes.map((pane) => pane.target)]),
      [
        ['site', ['site/index.html']],
        ['chart.png · paper.pdf', ['chart.png', 'paper.pdf']],
        ['report.docx', ['report.docx']],
        ['Chart', ['chart.png']],
      ]
    );
    // The daemon's copy still has the files it serves.
    assert.equal(service.hostSnapshot()[0].tabs[0].panes[0].path, realpathSync(page));
  } finally {
    service.dispose();
    cleanup();
  }
});

test('annotate needs the tab on screen, like capture', async () => {
  const { cwd, cleanup } = workspace();
  let minimized = false;
  let bodyShown = false;
  const injected = [];
  const frame = {
    url: '',
    isDestroyed: () => false,
    async executeJavaScript(script) {
      injected.push(script);
      return { invalid: [], marks: [] };
    },
  };
  const window = {
    isDestroyed: () => false,
    isMinimized: () => minimized,
    isVisible: () => true,
    webContents: {
      id: 7,
      isDestroyed: () => false,
      on(name, listener) {
        if (name === 'will-frame-navigate') network.navigate = listener;
      },
      session: {
        webRequest: {
          onBeforeRequest: (_filter, listener) => (network.before = listener),
          onCompleted: (_filter, listener) => (network.completed = listener),
          onErrorOccurred: (_filter, listener) => (network.failed = listener),
        },
      },
      send(_channel, event) {
        const pane = event.state?.tabs[0]?.panes[0];
        if (pane) frame.url = pane.url;
      },
      // The rect query and the hit-test query answer differently: a rect, or whether the body is uncovered.
      executeJavaScript: async (script) => {
        if (script.includes('elementFromPoint')) return bodyShown ? true : null;
        return bodyShown ? { x: 0, y: 0, width: 10, height: 10 } : null;
      },
      mainFrame: { framesInSubtree: [frame] },
    },
  };
  const network = {};
  let remoteViewer = false;
  const remoteEvents = [];
  const service = createDesktopVisualize({
    window: () => window,
    invokeDesktopOperation: async () => {
      throw new Error('unused');
    },
    browserAvailable: () => true,
    publishRemote: (event) => remoteEvents.push(event),
    remoteViewing: async (sessionId) => remoteViewer && sessionId === 's1',
  });
  const annotate = () =>
    service.execute({ sessionId: 's1', cwd, action: 'annotate', input: { tab: 'v1', add: [{ selector: 'h1' }] } });
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } });
    assert.ok(frame.url.startsWith('http://127.0.0.1:'));
    // The daemon's copy names the resolved file and cwd (never sent to clients).
    const hostTab = remoteEvents.at(-1).state.tabs[0];
    assert.equal(hostTab.cwd, cwd);
    assert.equal(hostTab.panes[0].path, realpathSync(join(cwd, 'site', 'index.html')));
    assert.equal(remoteEvents.at(-1).reveal, true);

    // Failed local asset loads come from the network layer: a 404 of the
    // page's stylesheet and a network error are problems; a good response, an
    // aborted request, the page document itself and foreign requests are not.
    const asset = (name) => new URL(name, frame.url).href;
    const problems = () => remoteEvents.at(-1).state.tabs[0].problems;
    // The webRequest session is shared: only the main window's page frame
    // (webContents 7) owns a request to its lease.
    const fromPage = (details, over = {}) => ({
      webContentsId: 7,
      referrer: '',
      frame: { url: frame.url, isDestroyed: () => false, parent: null },
      ...details,
      ...over,
    });
    network.completed(fromPage({ url: asset('ok.css'), statusCode: 200, resourceType: 'stylesheet' }));
    network.completed(fromPage({ url: frame.url, statusCode: 404, resourceType: 'subFrame' }));
    network.completed(fromPage({ url: 'http://127.0.0.1:1/other/x.css', statusCode: 404, resourceType: 'stylesheet' }));
    network.failed(fromPage({ url: asset('gone.js'), error: 'net::ERR_ABORTED', resourceType: 'script' }));
    // A failed lease-URL request of another webContents, of a frame that is
    // not a pane of that lease, or of no frame at all, is not this page's.
    const failing = { url: asset('missing.css'), statusCode: 404, resourceType: 'stylesheet' };
    network.completed(fromPage(failing, { webContentsId: 99 }));
    network.completed(fromPage(failing, { webContentsId: undefined }));
    network.completed(
      fromPage(failing, { frame: { url: 'file:///C:/app/index.html', isDestroyed: () => false, parent: null } })
    );
    network.completed(fromPage(failing, { frame: null }));
    network.failed(
      fromPage(
        { url: asset('font.woff'), error: 'net::ERR_CONNECTION_RESET', resourceType: 'font' },
        { webContentsId: 99 }
      )
    );
    assert.equal(problems(), undefined);
    network.completed(fromPage(failing));
    network.failed(fromPage({ url: asset('font.woff'), error: 'net::ERR_CONNECTION_RESET', resourceType: 'font' }));
    assert.deepEqual(
      problems().map((problem) => [problem.kind, problem.message]),
      [
        ['asset-failed', 'site/missing.css (404)'],
        ['asset-failed', 'site/font.woff (net::ERR_CONNECTION_RESET)'],
      ]
    );
    assert.doesNotMatch(JSON.stringify(problems()), /127\.0\.0\.1/);

    // Outside network: refused only for requests made by a visualize page
    // (or a frame nested in one, or by its referrer); the app, other
    // origins' frames and the page's own lease stay untouched. Tabs open with
    // network allowed; the guard is exercised once it is switched off.
    assert.equal(remoteEvents.at(-1).state.tabs[0].networkAllowed, true, 'allowed by default');
    // A paired device's view carries it too: its frame drops the block on it.
    assert.equal(remoteVisualizeState(remoteEvents.at(-1).state).tabs[0].networkAllowed, true);
    await service.command({ sessionId: 's1', tabId: 'v1', action: 'network', allow: false });
    const page = { url: frame.url, isDestroyed: () => false, parent: null };
    const child = { url: 'https://ads.example/frame.html', isDestroyed: () => false, parent: page };
    const appFrame = { url: 'file:///C:/app/index.html', isDestroyed: () => false, parent: null };
    const cancelled = (details) => {
      let result;
      network.before(
        { webContentsId: 7, referrer: '', resourceType: 'xhr', ...details },
        (answer) => (result = answer)
      );
      return result.cancel;
    };
    assert.equal(
      cancelled({
        webContentsId: 99,
        frame: { url: frame.url, isDestroyed: () => false, parent: null },
        url: 'https://cdn.example.com/lib.js',
      }),
      false,
      'another webContents is never judged'
    );
    assert.equal(cancelled({ frame: page, url: 'https://cdn.example.com/lib.js', resourceType: 'script' }), true);
    assert.equal(cancelled({ frame: page, url: 'wss://live.example.com/socket', resourceType: 'webSocket' }), true);
    assert.equal(
      cancelled({ frame: child, url: 'https://tracker.example/p.gif', resourceType: 'image' }),
      true,
      'a nested frame'
    );
    assert.equal(
      cancelled({ frame: null, referrer: frame.url, url: 'http://localhost:3000/api', resourceType: 'xhr' }),
      true,
      'by referrer'
    );
    assert.equal(
      cancelled({ frame: page, url: new URL('app.js', frame.url).href, resourceType: 'script' }),
      false,
      'its own lease'
    );
    assert.equal(cancelled({ frame: appFrame, url: 'https://api.github.com/user' }), false, 'the app UI');
    assert.equal(cancelled({ frame: null, url: 'https://example.com/' }), false, 'a request of no visualize page');
    assert.equal(
      cancelled({
        frame: { url: 'http://127.0.0.1:1/other/x.html', isDestroyed: () => false, parent: null },
        url: 'https://example.com/',
      }),
      false
    );
    assert.deepEqual(
      problems()
        .filter((problem) => problem.kind === 'blocked-network')
        .map((problem) => problem.message),
      ['cdn.example.com (script)', 'live.example.com (webSocket)', 'tracker.example (image)', 'localhost:3000 (xhr)']
    );
    assert.equal(remoteEvents.at(-1).state.tabs[0].networkAllowed, undefined);
    assert.equal(remoteVisualizeState(remoteEvents.at(-1).state).tabs[0].networkAllowed, undefined);

    // A paired device's page frame enforces the same block with a CSP and files
    // each refusal as the very same problem; a local address files nothing.
    const filed = problems().length;
    await service.command({
      sessionId: 's1',
      tabId: 'v1',
      action: 'blocked',
      pane: 0,
      url: 'https://fonts.example/f.woff2',
      resource: 'font',
    });
    await service.command({
      sessionId: 's1',
      tabId: 'v1',
      action: 'blocked',
      pane: 0,
      url: 'data:,x',
      resource: 'image',
    });
    assert.equal(problems().length, filed + 1);
    assert.deepEqual([problems().at(-1).kind, problems().at(-1).message], ['blocked-network', 'fonts.example (font)']);

    // The user's toggle lifts the block for this tab alone, reloads it (the
    // blocked problems are gone) and can be turned off again.
    const revision = remoteEvents.at(-1).state.tabs[0].revision;
    await service.command({ sessionId: 's1', tabId: 'v1', action: 'network', allow: true });
    assert.equal(remoteEvents.at(-1).state.tabs[0].networkAllowed, true);
    assert.equal(remoteEvents.at(-1).state.tabs[0].revision, revision + 1);
    assert.equal(problems(), undefined);
    // A network-enabled tab still files a genuine CSP refusal of the paired device's frame
    // (the relay preview CSP refuses wss:) as a blocked-network problem.
    await service.command({
      sessionId: 's1',
      tabId: 'v1',
      action: 'blocked',
      pane: 0,
      url: 'wss://live.example/socket',
      resource: 'webSocket',
    });
    assert.deepEqual(
      problems().map((problem) => [problem.kind, problem.message]),
      [['blocked-network', 'live.example (webSocket)']]
    );
    const reloaded = { url: frame.url, isDestroyed: () => false, parent: null };
    assert.notEqual(reloaded.url, page.url, 'a reload serves a fresh lease');
    assert.equal(
      cancelled({ frame: reloaded, url: 'https://cdn.example.com/lib.js', resourceType: 'script' }),
      false,
      'allowed'
    );
    assert.equal(
      cancelled({ frame: page, url: 'https://cdn.example.com/lib.js', resourceType: 'script' }),
      false,
      'the earlier lease too'
    );
    await service.command({ sessionId: 's1', tabId: 'v1', action: 'network', allow: false });
    assert.equal(remoteEvents.at(-1).state.tabs[0].networkAllowed, undefined);
    assert.equal(
      cancelled({
        frame: { ...reloaded, url: frame.url },
        url: 'https://cdn.example.com/lib.js',
        resourceType: 'script',
      }),
      true,
      'blocked again'
    );

    // Ownership is by frame, not by its current URL: a pane that navigates
    // itself to blob:/data:/about: and then fetches is still blocked, and the
    // navigation itself is refused and reported. Other frames (the app UI, the
    // browser panel, an iframe the app reuses) are never affected.
    const topFrame = { url: 'file:///C:/app/index.html', isDestroyed: () => false, parent: null };
    const paneFrame = (url) => ({ url, frameTreeNodeId: 41, isDestroyed: () => false, parent: topFrame });
    const evil = { url: 'https://evil.example/x', resourceType: 'xhr' };
    assert.equal(cancelled({ frame: paneFrame(frame.url), ...evil }), true, 'seen at its lease: claimed');
    assert.equal(
      cancelled({ frame: paneFrame('blob:http://127.0.0.1:1/9f8e'), ...evil }),
      true,
      'after a blob: navigation'
    );
    assert.equal(cancelled({ frame: paneFrame('data:text/html,<p>x'), ...evil }), true, 'after a data: navigation');
    assert.equal(cancelled({ frame: paneFrame('about:blank'), ...evil }), true, 'after an about: navigation');
    assert.equal(
      cancelled({
        frame: {
          url: 'blob:http://127.0.0.1:1/other',
          frameTreeNodeId: 77,
          isDestroyed: () => false,
          parent: topFrame,
        },
        ...evil,
      }),
      false,
      'a blob: frame that was never a pane'
    );
    assert.equal(cancelled({ frame: topFrame, ...evil }), false, 'the app UI');
    const navigate = (url, over = {}) => {
      const event = { isMainFrame: false, frame: paneFrame(frame.url), url, initiator: paneFrame(frame.url), ...over };
      event.preventDefault = () => (event.prevented = true);
      network.navigate(event);
      return event.prevented === true;
    };
    assert.equal(navigate('blob:http://127.0.0.1:1/9f8e'), true);
    assert.equal(navigate('data:text/html;base64,PHA+eDwvcD4='), true);
    assert.equal(navigate('https://example.com/'), true);
    assert.equal(navigate(new URL('other.html', frame.url).href), false, 'within its lease');
    assert.equal(navigate('about:blank'), false);
    assert.equal(navigate('https://example.com/', { isMainFrame: true }), false, 'the app window itself');
    assert.equal(
      navigate('https://example.com/', { frame: { ...topFrame, frameTreeNodeId: 5 }, initiator: topFrame }),
      false,
      'a frame of no pane'
    );
    assert.deepEqual(
      problems()
        .filter((problem) => problem.kind === 'blocked-navigation')
        .map((problem) => problem.message.slice(0, 5)),
      ['blob:', 'data:', 'https']
    );
    // The app pointing the iframe elsewhere (initiator: the main frame) is its
    // own business and releases the frame; pointing it back reclaims it.
    assert.equal(navigate('file:///C:/app/paper.pdf', { initiator: topFrame }), false);
    assert.equal(cancelled({ frame: paneFrame('blob:http://127.0.0.1:1/9f8e'), ...evil }), false, 'released');
    assert.equal(navigate(frame.url, { initiator: topFrame }), false);
    assert.equal(cancelled({ frame: paneFrame('blob:http://127.0.0.1:1/9f8e'), ...evil }), true, 'reclaimed');

    minimized = true;
    await assert.rejects(annotate(), /minimized or hidden/);
    minimized = false;
    // The frame exists but the panel shows nothing (closed / other session).
    await assert.rejects(annotate(), /not on screen/);
    // Only a paired remote device shows it: the marks go to the tab state,
    // which that device draws from; nothing is injected on the desktop.
    remoteViewer = true;
    assert.match((await annotate()).text, /h1 \(drawn on the paired device showing the tab/);
    assert.deepEqual(remoteEvents.at(-1).state.tabs[0].annotations, [{ pane: 0, selector: 'h1' }]);
    minimized = true;
    assert.match((await annotate()).text, /drawn on the paired device/);
    minimized = false;
    assert.deepEqual(injected, []);
    assert.equal(REMOTE_ONLY_ANNOTATE.length > 0, true);

    // Shown on the desktop too: no change, the marks are drawn there.
    bodyShown = true;
    assert.match((await annotate()).text, /Annotations on tab v1/);
    assert.equal(injected.length, 1);
  } finally {
    service.dispose();
    cleanup();
  }
});

/** Deps whose HTML panes get page-server-shaped URLs with a fresh lease each time. */
function leaseDeps(overrides = {}) {
  let leases = 0;
  const fake = fakeDeps({
    async preparePane(target) {
      leases += 1;
      return `http://127.0.0.1:4321/${String(leases).padStart(32, '0')}/${target.target}`;
    },
    ...overrides,
  });
  return fake;
}

const OPEN_PAGE = { sessionId: 's1', action: 'open', input: { targets: ['site/index.html'] } };

test('console classification keeps only problems', () => {
  const kind = (level, message) => classifyConsole({ level, message })?.kind ?? null;
  assert.equal(kind('info', 'hello'), null);
  assert.equal(kind('debug', 'Uncaught nothing'), null);
  assert.equal(kind('error', 'Uncaught ReferenceError: foo is not defined'), 'exception');
  assert.equal(kind('error', 'Uncaught (in promise) TypeError: x'), 'rejection');
  assert.equal(
    kind(
      'error',
      "Refused to load the script 'https://x.dev/a.js' because it violates the following Content Security Policy directive"
    ),
    'csp'
  );
  assert.equal(
    kind('error', 'Failed to load resource: the server responded with a status of 404 (Not Found)'),
    null,
    'asset failures come from the network layer'
  );
  assert.equal(kind('error', 'boom'), 'console-error');
  assert.equal(kind('warning', 'careful'), 'console-warn');
});

test('problem text is localized and the list dedupes and caps', () => {
  const root = join(tmpdir(), 'proj');
  const token = 'a'.repeat(32);
  assert.equal(
    localizeProblemText(
      `GET http://127.0.0.1:4321/${token}/css/app.css failed in ${join(root, 'site', 'a.js')} and C:\\Users\\me\\key.txt`,
      [root]
    ),
    `GET css/app.css failed in ${join('site', 'a.js')} and key.txt`
  );
  assert.equal(localizeProblemText('see https://cdn.dev/lib.js:3', [root]), 'see https://cdn.dev/lib.js:3');

  const make = (message, over = {}) =>
    buildProblem({ kind: 'console-error', message, source: 'a.js', line: 1, pane: 0, ...over }, [root]);
  let list = [];
  let added = recordProblem(list, make('x'));
  assert.equal(added.added, true);
  list = added.list;
  added = recordProblem(list, make('x'));
  assert.deepEqual([added.added, added.list.length, added.list[0].count], [false, 1, 2]);
  assert.equal(list[0].count, 1, 'the earlier list is not mutated');
  assert.equal(recordProblem(list, make('x', { pane: 1 })).added, true);
  for (let index = 0; list.length < MAX_VISUALIZE_PROBLEMS; index += 1)
    list = recordProblem(list, make(`m${index}`)).list;
  const full = recordProblem(list, make('one more'));
  assert.deepEqual([full.added, full.list.length], [false, MAX_VISUALIZE_PROBLEMS]);

  const section = formatProblemsSection('v1', list, ['a.html']);
  assert.match(section, /^Page problems on tab v1 \(20\):\n- console-error: x \(a\.js:1\)\n/);
  assert.match(section, /- …and 10 more\nFix these before reporting\.$/);
  assert.equal(formatProblemsSection('v1', [], []), '');
});

test('page problems are captured per tab, reported in results, deduped, capped and reset on reload', async () => {
  const { cwd, cleanup } = workspace();
  const shown = [];
  const { deps, events, watched } = leaseDeps({ ensureShown: async (_session, tab) => shown.push(tab.id) });
  const service = createVisualizeService(deps);
  const pane = () => service.snapshot()[0].tabs.find((tab) => tab.id === 'v1').panes[0].url;
  const prefix = (url) => url.slice(0, url.indexOf('/site/') + 1);
  const problems = () => service.snapshot()[0].tabs.find((tab) => tab.id === 'v1').problems;
  const report = (over = {}) =>
    service.reportConsole({
      level: 'error',
      message: 'boom',
      sourceId: pane(),
      lineNumber: 3,
      frameUrl: pane(),
      ...over,
    });
  try {
    const opened = await service.execute({ ...OPEN_PAGE, cwd });
    assert.doesNotMatch(opened.text, /Page problems/);
    assert.equal(opened.problems, undefined);
    assert.equal(problems(), undefined);

    // Output that is not a problem, and frames that are not this tab's, are ignored.
    report({ level: 'info', message: 'hello' });
    // Chromium's benign ResizeObserver notice (a fit-to-width page, resized by the panel).
    report({ message: 'ResizeObserver loop completed with undelivered notifications.', lineNumber: 0 });
    report({ message: 'ResizeObserver loop limit exceeded', lineNumber: 0 });
    report({ frameUrl: 'http://127.0.0.1:4321/other/x.html', sourceId: 'http://127.0.0.1:4321/other/x.js' });
    assert.equal(problems(), undefined);

    const sourceId = `${prefix(pane())}site/app.js`;
    report({ message: 'Uncaught ReferenceError: foo is not defined', sourceId, lineNumber: 12 });
    const published = events.length;
    report({ message: 'Uncaught ReferenceError: foo is not defined', sourceId, lineNumber: 12 });
    report({ message: 'Uncaught ReferenceError: foo is not defined', sourceId, lineNumber: 12 });
    assert.equal(events.length, published, 'a repeat does not republish');
    report({ message: 'Uncaught (in promise) Error: nope', sourceId, lineNumber: 4 });
    report({ message: 'Refused to load the image because it violates the Content Security Policy', sourceId: pane() });
    // Network layer: a 404 of a local asset and a foreign lease's asset.
    service.reportAssetFailure(`${prefix(pane())}site/missing.css`, '404', [pane()]);
    service.reportAssetFailure(`${prefix(pane())}site/missing.css`, '404', [pane()]);
    service.reportAssetFailure(`${prefix(pane())}site/missing.css`, '404', []);
    service.reportAssetFailure(`${prefix(pane())}site/missing.css`, '404', ['http://127.0.0.1:4321/other/x.html']);
    service.reportAssetFailure('http://127.0.0.1:4321/other/x.css', '404', [pane()]);
    report({ level: 'warning', message: 'deprecated api' });
    assert.deepEqual(
      problems().map((problem) => [problem.kind, problem.source, problem.line, problem.count]),
      [
        ['exception', 'site/app.js', 12, 3],
        ['rejection', 'site/app.js', 4, 1],
        ['csp', 'site/index.html', 3, 1],
        ['asset-failed', '', 0, 2],
        ['console-warn', 'site/index.html', 3, 1],
      ]
    );
    assert.equal(events.at(-1).state.tabs[0].problems.length, 5);

    // check: only the problems, never a host-local URL.
    const checked = await service.execute({ sessionId: 's1', cwd, action: 'check', input: { tab: 'v1' } });
    assert.deepEqual(shown, ['v1']);
    assert.match(checked.text, /^Checked tab v1\.\nPage problems on tab v1 \(5\):\n/);
    assert.match(checked.text, /- exception: Uncaught ReferenceError: foo is not defined \(site\/app\.js:12\) ×3\n/);
    assert.match(checked.text, /- asset-failed: site\/missing\.css \(404\) ×2\n/);
    assert.match(checked.text, /Fix these before reporting\.$/);
    assert.doesNotMatch(checked.text, /127\.0\.0\.1/);
    assert.equal(checked.problems.length, 5);

    // Every result about the tab carries the section.
    const annotated = await service.execute({
      sessionId: 's1',
      cwd,
      action: 'annotate',
      input: { tab: 'v1', add: [{ selector: 'h1' }] },
    });
    assert.match(annotated.text, /Annotations on tab v1[\s\S]*Page problems on tab v1 \(5\)/);
    const captured = await service.execute({
      sessionId: 's1',
      cwd,
      action: 'capture',
      input: { tab: 'v1', output: 'shots/a.png' },
    });
    assert.match(captured.text, /Captured tab v1 to [\s\S]*Page problems on tab v1 \(5\)/);

    // A pane's own navigation (a page-side reload) drops its stale problems.
    service.reportNavigation(pane(), 200);
    assert.equal(problems(), undefined);
    assert.equal(events.at(-1).state.tabs[0].problems, undefined);
    service.reportNavigation(pane(), 404);
    assert.match(problems()[0].message, /HTTP 404/);

    // The cap: later distinct problems are dropped, repeats still count.
    for (let index = 0; index < MAX_VISUALIZE_PROBLEMS + 15; index += 1) report({ message: `error ${index}` });
    assert.equal(problems().length, MAX_VISUALIZE_PROBLEMS);
    assert.match(
      (await service.execute({ sessionId: 's1', cwd, action: 'check', input: { tab: 'v1' } })).text,
      /…and 10 more/
    );

    // A file change reloads the tab: problems reset, and the old lease's late
    // reports no longer count.
    const oldUrl = pane();
    [...watched.entries()].find(([path]) => path.endsWith('index.html'))[1]();
    await service.settled();
    assert.notEqual(pane(), oldUrl);
    assert.equal(problems(), undefined);
    report({ frameUrl: oldUrl, sourceId: oldUrl, message: 'late' });
    assert.equal(problems(), undefined);
    assert.equal(
      (await service.execute({ sessionId: 's1', cwd, action: 'check', input: { tab: 'v1' } })).text,
      'No page problems on tab v1.'
    );
    report({ message: 'after reload' });
    assert.equal(problems().length, 1);

    // Reopening the same page starts clean too.
    const reopened = await service.execute({ ...OPEN_PAGE, cwd });
    assert.equal(reopened.tabs[0].id, 'v1');
    assert.equal(problems(), undefined);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('open waits briefly so the first page errors ride its result; check needs an HTML tab', async () => {
  const { cwd, cleanup } = workspace();
  let url = '';
  let delays = 0;
  let service;
  const { deps } = leaseDeps({
    async preparePane(target) {
      url = `http://127.0.0.1:4321/${'1'.repeat(32)}/${target.target}`;
      return target.kind === 'html' ? url : `fake://${target.kind}`;
    },
    delay: async () => {
      delays += 1;
      if (delays === 1) {
        service.reportConsole({
          level: 'error',
          message: 'Uncaught SyntaxError: bad',
          sourceId: url,
          lineNumber: 7,
          frameUrl: url,
        });
      }
    },
  });
  service = createVisualizeService(deps);
  try {
    const opened = await service.execute({ ...OPEN_PAGE, cwd });
    assert.match(
      opened.text,
      /Showing site\/index\.html \(html\)[\s\S]*Page problems on tab v1 \(1\):\n- exception: Uncaught SyntaxError: bad \(site\/index\.html:7\)/
    );
    const picture = await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['chart.png'] } });
    assert.doesNotMatch(picture.text, /Page problems/);
    await assert.rejects(
      service.execute({ sessionId: 's1', cwd, action: 'check', input: { tab: picture.tabs[0].id } }),
      /HTML tabs only/
    );
    await assert.rejects(service.execute({ sessionId: 's1', cwd, action: 'check', input: {} }), /tab must be/);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('remote state carries page problems without host paths or page-server URLs', async () => {
  const { root, cwd, cleanup } = workspace();
  const hostEvents = [];
  const { deps } = leaseDeps({ publishHost: (event) => hostEvents.push(event) });
  const service = createVisualizeService(deps);
  try {
    await service.execute({ ...OPEN_PAGE, cwd });
    const url = service.snapshot()[0].tabs[0].panes[0].url;
    const prefix = url.slice(0, url.indexOf('/site/') + 1);
    service.reportConsole({
      level: 'error',
      message: `Failed to fetch ${prefix}data.json from ${join(cwd, 'site', 'index.html')} via C:\\Users\\me\\secret.txt`,
      sourceId: `${prefix}site/app.js`,
      lineNumber: 9,
      frameUrl: url,
    });
    const states = [
      ...hostEvents.filter((event) => event.state).map((event) => remoteVisualizeState(event.state)),
      ...service.hostSnapshot().map(remoteVisualizeState),
    ];
    const json = JSON.stringify(states);
    for (const leak of [root, realpathSync(root), cwd, '127.0.0.1', '4321', 'Users']) {
      assert.equal(json.includes(leak) || json.includes(JSON.stringify(leak).slice(1, -1)), false, `leaked ${leak}`);
    }
    const [problem] = states.at(-1).tabs[0].problems;
    assert.equal(problem.source, 'site/app.js');
    assert.match(problem.message, /^Failed to fetch data\.json from /);
    assert.match(problem.message, /secret\.txt$/);
    assert.deepEqual(Object.keys(problem).sort(), ['count', 'kind', 'line', 'message', 'pane', 'source']);
    // A state without problems stays as it was.
    assert.equal('problems' in states[0].tabs[0], false);

    // The client view also reduces whatever a host state still carries.
    const host = service.hostSnapshot()[0];
    const raw = {
      ...host,
      tabs: [
        {
          ...host.tabs[0],
          problems: [{ ...problem, message: `x ${prefix}a.css`, source: `${prefix}a.css`, path: join(cwd, 'x') }],
        },
      ],
    };
    const client = remoteVisualizeState(raw).tabs[0].problems[0];
    assert.deepEqual([client.message, client.source, 'path' in client], ['x a.css', 'a.css', false]);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('page problems follow the displayed panes: kept versions, compare layout, selection resets', async () => {
  const { root, cwd, cleanup } = workspace();
  let leases = 0;
  const { deps, events, watched } = fakeDeps({
    versions: { directory: join(root, 'app-data', 'visualize-versions') },
    ensureShown: async () => {},
    preparePane: async (target) => {
      leases += 1;
      return `http://127.0.0.1:4321/${String(leases).padStart(32, '0')}/${target.target}`;
    },
  });
  const service = createVisualizeService(deps);
  const command = (rest) => service.command({ sessionId: 's1', tabId: 'v1', ...rest });
  const tab = () => service.snapshot()[0].tabs[0];
  const report = (pane, message) =>
    service.reportConsole({ level: 'error', message, sourceId: pane.url, lineNumber: 2, frameUrl: pane.url });
  try {
    await service.execute({ ...OPEN_PAGE, cwd });
    writeFileSync(join(cwd, 'site', 'index.html'), '<h1>two</h1>');
    [...watched.entries()].find(([path]) => path.endsWith('index.html'))[1]();
    await service.settled();

    // A live error, then a kept version replaces the page: the list resets.
    report(tab().panes[0], 'live error');
    assert.equal(tab().problems.length, 1);
    await command({ action: 'version', version: 1 });
    assert.equal(tab().problems, undefined);

    // The kept page's errors are attributed to it and name the version.
    report(tab().panes[0], 'old error');
    assert.deepEqual(
      tab().problems.map((problem) => [problem.message, problem.pane, problem.version]),
      [['old error', 0, 1]]
    );
    const checked = await service.execute({ sessionId: 's1', cwd, action: 'check', input: { tab: 'v1' } });
    assert.match(checked.text, /- \[kept v1\] console-error: old error \(site\/index\.html:2\)/);

    // Compare: displayed order is kept v1, live; the layout change resets.
    await command({ action: 'version', version: 1, compare: true });
    assert.equal(tab().problems, undefined);
    assert.deepEqual(
      tab().panes.map((pane) => pane.version ?? 'live'),
      [1, 'live']
    );
    report(tab().panes[1], 'live in compare');
    report(tab().panes[0], 'kept in compare');
    assert.deepEqual(
      tab().problems.map((problem) => [problem.message, problem.pane, problem.version]),
      [
        ['live in compare', 1, undefined],
        ['kept in compare', 0, 1],
      ]
    );
    const host = service.hostSnapshot()[0].tabs[0];
    assert.deepEqual(
      host.problems.map((problem) => problem.pane),
      [1, 0]
    );
    assert.equal(remoteVisualizeState(service.hostSnapshot()[0]).tabs[0].problems[1].version, 1);
    const section = (await service.execute({ sessionId: 's1', cwd, action: 'check', input: { tab: 'v1' } })).text;
    assert.match(section, /- \[site\] console-error: live in compare/);
    assert.match(section, /- \[site kept v1\] console-error: kept in compare/);

    // A page navigation clears only its displayed pane's problems.
    service.reportNavigation(tab().panes[0].url, 200);
    assert.deepEqual(
      tab().problems.map((problem) => problem.message),
      ['live in compare']
    );

    // Back to live resets again; the live page's errors carry no version.
    await command({ action: 'version', version: null });
    assert.equal(tab().problems, undefined);
    report(tab().panes[0], 'live again');
    assert.deepEqual(
      tab().problems.map((problem) => [problem.pane, problem.version]),
      [[0, undefined]]
    );
    assert.ok(events.length > 0);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('check requests are validated', () => {
  const cwd = tmpdir();
  assert.deepEqual(parseVisualizeRequest({ sessionId: 's1', cwd, action: 'check', input: { tab: 'v2' } }).tab, 'v2');
  assert.throws(() => parseVisualizeRequest({ sessionId: 's1', cwd, action: 'check', input: {} }), /tab must be/);
  assert.throws(
    () => parseVisualizeRequest({ sessionId: 's1', cwd, action: 'zap' }),
    /annotate, capture, export, check/
  );
});

test('the overlay script carries its operation as JSON only', () => {
  const script = visualizeOverlayScript([{ selector: '"]); alert(1); //', label: '</script>' }]);
  assert.match(script, /\(\[\{"selector":"\\"\]\); alert\(1\); \/\/","label":"\\u003c\/script>"\}\]\)$/);
  assert.equal(script.includes('</script'), false);
  assert.match(script, /attachShadow/);
});

test('the visualize bridge publishes its discovery file and answers flat results', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'mixdog-visualize-bridge-'));
  const discoveryPath = join(dataDirectory, 'visualize-bridge.json');
  const { cwd, cleanup } = workspace();
  const { deps } = fakeDeps();
  const service = createVisualizeService(deps);
  const { promise: readyPromise, resolve: ready } = Promise.withResolvers();
  const server = new VisualizeBridgeServer({
    dataDirectory,
    execute: (command) => service.execute(command),
    onReady: ready,
  });
  try {
    server.start();
    await readyPromise;
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8'));
    const post = (body, token = discovery.token) =>
      fetch(`http://127.0.0.1:${discovery.port}/command`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const request = { sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } };
    assert.equal((await post(request, 'wrong')).status, 401);
    const opened = await (await post(request)).json();
    assert.equal(opened.ok, true);
    assert.equal(opened.tabs[0].id, 'v1');
    assert.equal(typeof opened.text, 'string');
    assert.equal(opened.value, undefined);
    const outside = await (await post({ ...request, input: { targets: ['../secret.html'] } })).json();
    assert.equal(outside.ok, true, 'a page outside the working directory opens');
    const failed = await (await post({ ...request, input: { targets: ['../missing.html'] } })).json();
    assert.equal(failed.ok, false);
    assert.match(failed.error, /target not found/);
  } finally {
    await server.stop();
    service.dispose();
    cleanup();
  }
  assert.equal(existsSync(discoveryPath), false);
  rmSync(dataDirectory, { recursive: true, force: true });
});

test('inspect lays the pane frames out at the requested viewport, reads only the pane frames, and puts them back', async () => {
  const { cwd, cleanup } = workspace();
  const log = [];
  let resized = 1;
  const main = { url: 'file:///app/index.html', parent: null, isDestroyed: () => false };
  const frame = {
    url: '',
    parent: main,
    isDestroyed: () => false,
    async executeJavaScript(script) {
      // Only the inspection script (the feedback script is injected here too).
      if (!/\)\.inspect\(\{/.test(script)) return true;
      log.push(['page', script.includes('.inspect({"selector":"main"})') ? 'scoped' : 'whole']);
      return { error: 'the selector matched nothing' };
    },
  };
  const nested = {
    url: '',
    parent: frame,
    isDestroyed: () => false,
    async executeJavaScript() {
      log.push(['nested']);
      return {};
    },
  };
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    isFocused: () => true,
    webContents: {
      id: 7,
      isDestroyed: () => false,
      on() {},
      session: { webRequest: { onBeforeRequest() {}, onCompleted() {}, onErrorOccurred() {} } },
      send(_channel, event) {
        const pane = event.state?.tabs[0]?.panes[0];
        if (pane) {
          frame.url = pane.url;
          nested.url = `${pane.url}nested/`;
        }
      },
      executeJavaScript: async (script) => {
        if (script.includes('elementFromPoint')) return true;
        if (!script.includes('[data-visualize-body] iframe')) return { x: 0, y: 0, width: 10, height: 10 };
        if (script.includes('setProperty')) {
          log.push(['main', 'resize', script.includes('375px') && script.includes('812px')]);
          return resized;
        }
        log.push(['main', 'restore']);
        return undefined;
      },
      mainFrame: { framesInSubtree: [main, frame, nested] },
    },
  };
  let remoteViewer = false;
  const service = createDesktopVisualize({
    window: () => window,
    invokeDesktopOperation: async () => {
      throw new Error('unused');
    },
    browserAvailable: () => true,
    remoteViewing: async () => remoteViewer,
  });
  const inspect = (input) =>
    service.execute({ sessionId: 's1', cwd, action: 'inspect', input: { tab: 'v1', ...input } });
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } });
    const result = await inspect({ viewport: { width: 375, height: 812 }, selector: 'main' });
    assert.match(result.text, /^Inspection of tab v1 at 375×812:\nsite: the selector matched nothing/);
    // Resize, read the pane frame only (not the page nested inside it), restore.
    assert.deepEqual(log, [
      ['main', 'resize', true],
      ['page', 'scoped'],
      ['main', 'restore'],
    ]);

    // Without a viewport the page is read as shown: no resizing at all.
    log.length = 0;
    await inspect({});
    assert.deepEqual(log, [['page', 'whole']]);

    // A panel that cannot resize says so, and nothing is left resized.
    log.length = 0;
    resized = 0;
    await assert.rejects(inspect({ viewport: { width: 375, height: 812 } }), /could not lay the page out at 375×812/);
    assert.deepEqual(log, [
      ['main', 'resize', true],
      ['main', 'restore'],
    ]);

    // The desktop window is the only reader: a remote-only tab says so.
    window.webContents.executeJavaScript = async () => null;
    remoteViewer = true;
    await assert.rejects(inspect({}), /shown only on a paired remote device/);
  } finally {
    service.dispose();
    cleanup();
  }
});
