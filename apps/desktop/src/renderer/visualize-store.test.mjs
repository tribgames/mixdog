import assert from 'node:assert/strict';
import test from 'node:test';

import { onBrowserPageRevealRequested } from './browser-page-request.ts';
import {
  allowVisualizeReveal,
  allowVisualizeScripts,
  applyVisualizeEvent,
  visualizeScriptsAllowed,
  hydrateVisualizeStates,
  subscribe,
  markVisualizePanelHidden,
  markVisualizePanelShown,
  onVisualizeRevealRequested,
  openVisualizePageLink,
  resetVisualizePanelMemory,
  reopenVisualizeTargets,
  restoreVisualizeVersion,
  revealVisualizeTab,
  resyncVisualizeStates,
  showVisualizeVersion,
  suppressVisualizeReveal,
  toggleVisualizeCompare,
  visualizeVersionPosition,
  openVisualizeHistory,
  exportVisualizeTab,
  visualizeExportPane,
  visualizeHistoryTime,
  visualizeVersionStep,
  visualizeHeaderActions,
  visualizePanesStacked,
  visualizeRevealSuppressed,
  visualizeStateFor,
  visualizeTabTooltip,
} from './visualize-store.ts';

const tab = { id: 'v1', label: 'index.html', revision: 0, panes: [] };

test('a chat card press is the user asking: it lifts the closed rule, selects and reveals', async () => {
  const sent = [];
  const revealed = [];
  const previous = globalThis.window;
  globalThis.window = { mixdogDesktop: { visualizeCommand: async (command) => sent.push(command) } };
  const stop = onVisualizeRevealRequested((sessionId) => revealed.push(sessionId));
  try {
    suppressVisualizeReveal('card-1');
    revealVisualizeTab('card-1', 'v2');
    assert.equal(visualizeRevealSuppressed('card-1'), false);
    assert.deepEqual(revealed, ['card-1']);
    suppressVisualizeReveal('card-2');
    await reopenVisualizeTargets('card-2', 'v1', ['site/index.html'], 'Home');
    assert.equal(visualizeRevealSuppressed('card-2'), false, "main's reveal of the reopen is not swallowed");
    assert.deepEqual(sent, [
      { sessionId: 'card-1', tabId: 'v2', action: 'activate' },
      { sessionId: 'card-2', tabId: 'v1', action: 'reopen', targets: ['site/index.html'], label: 'Home' },
    ]);
  } finally {
    stop();
    globalThis.window = previous;
  }
});

test('a closed panel stays closed on reloads and reopens on an agent open', () => {
  const reveals = [];
  const stop = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
  try {
    applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', tabs: [tab], active: 'v1' }, reveal: true });
    assert.equal(visualizeStateFor('s1').active, 'v1');
    assert.deepEqual(reveals, ['s1']);

    suppressVisualizeReveal('s1');
    applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', tabs: [{ ...tab, revision: 1 }], active: 'v1' } });
    assert.deepEqual(reveals, ['s1'], 'a reload of an open tab never reopens a closed panel');
    assert.equal(visualizeRevealSuppressed('s1'), true);

    applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', tabs: [tab], active: 'v1' }, reveal: true });
    assert.deepEqual(reveals, ['s1', 's1'], 'an agent open reopens a closed panel');
    assert.equal(visualizeRevealSuppressed('s1'), false);

    applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', tabs: [], active: null } });
    assert.deepEqual(visualizeStateFor('s1').tabs, []);
  } finally {
    stop();
  }
});

test('a renderer reload reopens panels that were open, never ones the user closed', async () => {
  const stored = new Map();
  const previous = globalThis.sessionStorage;
  globalThis.sessionStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
  };
  try {
    resetVisualizePanelMemory();
    markVisualizePanelShown('r-open');
    markVisualizePanelShown('r-closed');
    suppressVisualizeReveal('r-closed');
    markVisualizePanelShown('r-moved');
    markVisualizePanelHidden('r-moved');

    // The reload: in-memory state is gone, sessionStorage remains, and the
    // snapshot lands before the app shell subscribes.
    resetVisualizePanelMemory();
    assert.equal(visualizeRevealSuppressed('r-closed'), true);
    const state = (sessionId) => ({ sessionId, tabs: [{ ...tab, id: `${sessionId}-t` }], active: null });
    hydrateVisualizeStates([state('r-open'), state('r-closed'), state('r-moved'), state('r-never')]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reveals = [];
    const stop = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
    stop();
    assert.deepEqual(reveals, ['r-open']);
    assert.equal(visualizeStateFor('r-closed').tabs.length, 1, 'closed panels still keep their tabs');

    // Reopening by the user lifts the closed mark for the next reload.
    markVisualizePanelShown('r-closed');
    resetVisualizePanelMemory();
    assert.equal(visualizeRevealSuppressed('r-closed'), false);
  } finally {
    globalThis.sessionStorage = previous;
    resetVisualizePanelMemory();
  }
});

test('the header keeps only Comment and Versions inline; every toggle leads ⋯ as a checkbox', () => {
  const actions = [
    { id: 'history', checked: false, checkbox: true },
    { id: 'source', checked: true, checkbox: true },
    { id: 'versions', inline: true },
    { id: 'export-png' },
    { id: 'elements', checked: false, checkbox: true, badge: 3 },
    { id: 'tweaks', checked: false, checkbox: true },
    { id: 'comment', inline: true, checked: false },
    { id: 'zoom-bar', checked: true, checkbox: true },
  ];
  const ordered = visualizeHeaderActions(actions);
  assert.deepEqual(
    ordered.filter((action) => action.inline).map((action) => action.id),
    ['versions', 'comment']
  );
  const menu = ordered.filter((action) => !action.inline);
  assert.deepEqual(
    menu.map((action) => action.id),
    ['history', 'source', 'elements', 'tweaks', 'zoom-bar', 'export-png']
  );
  assert.equal(menu.find((action) => action.id === 'elements').badge, 3, 'the findings count rides into ⋯');
  assert.equal(menu.find((action) => action.id === 'export-png').separatorBefore, true);
  assert.equal(menu.find((action) => action.id === 'history').separatorBefore, undefined);
  assert.deepEqual(
    visualizeHeaderActions([{ id: 'export-png' }]).map((action) => action.separatorBefore),
    [undefined],
    'no separator without toggles'
  );
});

test('panes stack below two 360px columns; tooltips carry label and targets', () => {
  assert.equal(visualizePanesStacked(719, 2), true);
  assert.equal(visualizePanesStacked(720, 2), false);
  assert.equal(visualizePanesStacked(500, 3), true);
  assert.equal(visualizePanesStacked(300, 1), false, 'a single pane never stacks');
  assert.equal(visualizePanesStacked(0, 2), false, 'unmeasured bodies stay side by side');
  assert.equal(
    visualizeTabTooltip({ label: 'Compare', panes: [{ target: 'a.png' }, { target: 'b.pdf' }] }),
    'Compare\na.png\nb.pdf'
  );
});

test('a remote reconnect replaces every session with the host snapshot and reveals nothing', () => {
  const reveals = [];
  const stop = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
  try {
    applyVisualizeEvent({ sessionId: 'g1', state: { sessionId: 'g1', tabs: [tab], active: 'v1' } });
    applyVisualizeEvent({ sessionId: 'g2', state: { sessionId: 'g2', tabs: [tab], active: 'v1' } });
    const reloaded = { ...tab, revision: 4 };
    resyncVisualizeStates([
      { sessionId: 'g2', tabs: [reloaded], active: 'v1' },
      { sessionId: 'g3', tabs: [], active: null },
    ]);
    assert.deepEqual(visualizeStateFor('g1').tabs, [], 'a session closed during the gap is dropped');
    assert.equal(visualizeStateFor('g2').tabs[0].revision, 4, 'a reload missed during the gap remounts');
    assert.deepEqual(visualizeStateFor('g3').tabs, []);
    assert.deepEqual(reveals, []);
  } finally {
    stop();
  }
});

test('the version stepper walks kept versions; the newest is live', () => {
  const versions = [
    { n: 3, at: 1 },
    { n: 5, at: 2 },
    { n: 6, at: 3 },
  ];
  assert.equal(
    visualizeVersionPosition({ versions: [{ n: 1, at: 1 }], version: null }),
    null,
    'one version: no stepper'
  );
  assert.equal(visualizeVersionPosition({}), null, 'hosts without history');
  assert.deepEqual(visualizeVersionPosition({ versions, version: null }), { shown: 6, newest: 6 });
  assert.deepEqual(visualizeVersionPosition({ versions, version: 3 }), { shown: 3, newest: 6 });
  assert.equal(visualizeVersionStep({ versions, version: null }, -1), 5);
  assert.equal(visualizeVersionStep({ versions, version: null }, 1), undefined);
  assert.equal(visualizeVersionStep({ versions, version: 5 }, 1), null, 'stepping onto the newest is live');
  assert.equal(visualizeVersionStep({ versions, version: 3 }, -1), undefined);
  assert.equal(visualizeVersionStep({ versions, version: 3 }, 1), 5);

  const sent = [];
  const previous = globalThis.window;
  globalThis.window = { mixdogDesktop: { visualizeCommand: async (command) => sent.push(command) } };
  try {
    toggleVisualizeCompare('s1', { id: 'v1', versions, version: null, panes: [] });
    toggleVisualizeCompare('s1', { id: 'v1', versions, version: 3, compare: true, panes: [] });
    showVisualizeVersion('s1', 'v1', null);
    void restoreVisualizeVersion('s1', 'v1', 3);
    void restoreVisualizeVersion('s1', 'v1', 3, ['site/style.css']);
    assert.deepEqual(sent, [
      { sessionId: 's1', tabId: 'v1', action: 'version', version: 5, compare: true },
      { sessionId: 's1', tabId: 'v1', action: 'version', version: 3 },
      { sessionId: 's1', tabId: 'v1', action: 'version', version: null },
      { sessionId: 's1', tabId: 'v1', action: 'restore', version: 3 },
      { sessionId: 's1', tabId: 'v1', action: 'restore', version: 3, assets: ['site/style.css'] },
    ]);
  } finally {
    globalThis.window = previous;
  }
});

test('a remote page that runs scripts waits for a trusted Run tap, remembered per tab', () => {
  assert.equal(visualizeScriptsAllowed('s1', 'v1'), false);
  assert.equal(allowVisualizeScripts('s1', 'v1', { isTrusted: false }), false, 'a synthetic click does not run a page');
  assert.equal(allowVisualizeScripts('s1', 'v1', {}), false);
  assert.equal(visualizeScriptsAllowed('s1', 'v1'), false);
  assert.equal(allowVisualizeScripts('s1', 'v1', { isTrusted: true }), true);
  assert.equal(visualizeScriptsAllowed('s1', 'v1'), true);
  assert.equal(visualizeScriptsAllowed('s1', 'v2'), false, 'another tab stays gated');
  assert.equal(visualizeScriptsAllowed('s2', 'v1'), false, 'another session stays gated');
});

test('there is no network toggle any more: the store exports no setter', async () => {
  const store = await import('./visualize-store.ts');
  assert.equal('setVisualizeNetwork' in store, false);
});

test('a web URL is handed to the browser panel as an agent request', () => {
  const requests = [];
  const stop = onBrowserPageRevealRequested((request) => requests.push(request));
  try {
    applyVisualizeEvent({ sessionId: 's2', openUrl: 'http://localhost:3000/' });
    assert.deepEqual(requests, [{ sessionId: 's2', url: 'http://localhost:3000/', agent: true }]);
  } finally {
    stop();
  }
});

test('a link the user clicks in a pane opens like a chat web link; a script-posted one opens nothing', (t) => {
  const requests = [];
  const external = [];
  const stop = onBrowserPageRevealRequested((request) => requests.push(request));
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousWindow = globalThis.window;
  const activation = { isActive: false };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userActivation: activation } });
  globalThis.window = { mixdogDesktop: { openExternal: async (url) => external.push(url) } };
  t.after(() => {
    stop();
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    globalThis.window = previousWindow;
  });
  openVisualizePageLink('s3', 'https://example.com/');
  assert.deepEqual(requests, [], 'no user activation');
  activation.isActive = true;
  openVisualizePageLink('s3', 'https://example.com/');
  assert.deepEqual(requests, [{ sessionId: 's3', url: 'https://example.com/' }]);
  // Ctrl/Cmd-click, or no browser pane to reveal: the system browser takes it.
  openVisualizePageLink('s3', 'https://example.net/', true);
  stop();
  openVisualizePageLink('s3', 'https://example.org/');
  assert.deepEqual(requests.length, 1);
  assert.deepEqual(external, ['https://example.net/', 'https://example.org/']);
});

test('a session with nothing open keeps its "All visuals" list; a bare empty state drops', () => {
  const history = [{ id: 'h1', label: 'Flow', kind: 'mermaid', versions: 2, at: 1, open: false }];
  applyVisualizeEvent({ sessionId: 'h-1', state: { sessionId: 'h-1', tabs: [], active: null, history } });
  assert.deepEqual(visualizeStateFor('h-1').history, history);
  applyVisualizeEvent({ sessionId: 'h-1', state: { sessionId: 'h-1', tabs: [], active: null } });
  assert.deepEqual(visualizeStateFor('h-1').tabs, []);
  assert.equal(visualizeStateFor('h-1').history, undefined);
  resyncVisualizeStates([{ sessionId: 'h-2', tabs: [], active: null, history }]);
  assert.equal(visualizeStateFor('h-2').history.length, 1);
});

test('picking a list entry is a plain panel command that lifts the closed rule', async () => {
  const sent = [];
  const previous = globalThis.window;
  globalThis.window = { mixdogDesktop: { visualizeCommand: async (command) => void sent.push(command) } };
  try {
    suppressVisualizeReveal('h-3');
    await openVisualizeHistory('h-3', 'abc');
    assert.equal(visualizeRevealSuppressed('h-3'), false);
    assert.deepEqual(sent, [{ sessionId: 'h-3', tabId: '', action: 'history', entry: 'abc' }]);
  } finally {
    globalThis.window = previous;
  }
});

test('export sends the pane and returns where the file went', async () => {
  const sent = [];
  const previous = globalThis.window;
  globalThis.window = {
    mixdogDesktop: {
      visualizeCommand: async (command) => {
        sent.push(command);
        return command.format === 'project' ? { path: 'design/mockups/a/a.svg', openable: true } : undefined;
      },
    },
  };
  try {
    assert.deepEqual(await exportVisualizeTab('s', 'v1', 'project', 1), {
      path: 'design/mockups/a/a.svg',
      openable: true,
    });
    assert.equal(await exportVisualizeTab('s', 'v1', 'png', 0), undefined);
    assert.deepEqual(sent, [
      { sessionId: 's', tabId: 'v1', action: 'export', format: 'project', pane: 1 },
      { sessionId: 's', tabId: 'v1', action: 'export', format: 'png', pane: 0 },
    ]);
  } finally {
    globalThis.window = previous;
  }
});

const richTab = (id, thumbnail) => ({
  id,
  label: id,
  revision: 1,
  panes: [{ kind: 'html', label: 'a.html', target: 'a.html', url: `http://x/${id}/a.html` }],
  problems: [{ kind: 'exception', message: 'boom', source: 'a.html', line: 1, count: 1, pane: 0 }],
  versions: [{ n: 1, at: 1 }],
  ...(thumbnail ? { thumbnail } : {}),
});
// Fresh deep copies, as an event arriving over IPC would carry.
const fresh = (value) => JSON.parse(JSON.stringify(value));

test('an event that changes only another tab keeps every unchanged tab object', () => {
  const first = { sessionId: 'share', tabs: [richTab('a', 'data:image/png;base64,AAAA'), richTab('b')], active: 'a' };
  applyVisualizeEvent({ sessionId: 'share', state: fresh(first) });
  const before = visualizeStateFor('share');
  const next = fresh(first);
  next.tabs[1].thumbnail = 'data:image/png;base64,BBBB';
  applyVisualizeEvent({ sessionId: 'share', state: next });
  const after = visualizeStateFor('share');
  assert.notEqual(after, before);
  assert.equal(after.tabs[0], before.tabs[0], 'the untouched tab keeps its identity');
  assert.equal(after.tabs[0].panes, before.tabs[0].panes);
  assert.notEqual(after.tabs[1], before.tabs[1]);
  assert.equal(after.tabs[1].panes, before.tabs[1].panes, 'unchanged parts of the changed tab are reused too');
  assert.equal(after.tabs[1].problems, before.tabs[1].problems);
  assert.equal(after.tabs[1].thumbnail, 'data:image/png;base64,BBBB');

  // Reordered tabs still match by id.
  const reordered = fresh(next);
  reordered.tabs.reverse();
  applyVisualizeEvent({ sessionId: 'share', state: reordered });
  assert.equal(visualizeStateFor('share').tabs[0], after.tabs[1]);
  assert.equal(visualizeStateFor('share').tabs[1], after.tabs[0]);
});

test('an identical event or snapshot notifies nobody; a real change notifies once', () => {
  const state = {
    sessionId: 'quiet',
    tabs: [richTab('a')],
    active: 'a',
    history: [{ id: 'h', label: 'a', kind: 'html', versions: 1, at: 1, open: true }],
  };
  applyVisualizeEvent({ sessionId: 'quiet', state: fresh(state) });
  // A snapshot of the host replaces every session: leave only this one.
  resyncVisualizeStates([fresh(state)]);
  let calls = 0;
  const stop = subscribe(() => {
    calls += 1;
  });
  try {
    applyVisualizeEvent({ sessionId: 'quiet', state: fresh(state) });
    resyncVisualizeStates([fresh(state)]);
    hydrateVisualizeStates([fresh(state)]);
    assert.equal(calls, 0);
    const kept = visualizeStateFor('quiet');

    applyVisualizeEvent({ sessionId: 'quiet', state: { ...fresh(state), active: null } });
    assert.equal(calls, 1);
    assert.equal(visualizeStateFor('quiet').tabs, kept.tabs);

    // Closing the last tab of a session without history drops it, once.
    applyVisualizeEvent({ sessionId: 'gone', state: { sessionId: 'gone', tabs: [], active: null } });
    assert.equal(calls, 1, 'dropping a session that was never stored changes nothing');
    applyVisualizeEvent({ sessionId: 'quiet', state: { sessionId: 'quiet', tabs: [], active: null } });
    assert.equal(calls, 2);
  } finally {
    stop();
  }
});

test('export acts on the live pane while comparing, else the first; list times are short', () => {
  assert.equal(visualizeExportPane({ panes: [{}, {}] }), 0);
  assert.equal(visualizeExportPane({ compare: true, panes: [{}, {}, {}, {}] }), 3);
  assert.equal(visualizeExportPane({ compare: true, panes: [] }), 0);
  const noon = new Date(2025, 5, 10, 12, 30).getTime();
  const sameDay = visualizeHistoryTime(noon, new Date(2025, 5, 10, 18, 0).getTime());
  const otherDay = visualizeHistoryTime(noon, new Date(2025, 5, 12, 9, 0).getTime());
  assert.ok(otherDay.length > sameDay.length && otherDay.endsWith(sameDay), `${otherDay} vs ${sameDay}`);
});
