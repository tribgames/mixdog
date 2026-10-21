import assert from 'node:assert/strict';
import test from 'node:test';

import { onBrowserPageRevealRequested } from './browser-page-request.ts';
import {
  activateVisualizeTab,
  setVisualizePanelOnScreen,
  visualizePanelOnScreen,
  visualizeUpdatedTabs,
  visualizeUpdateShows,
  applyVisualizeEvent,
  hydrateVisualizeStates,
  subscribe,
  markVisualizePanelHidden,
  markVisualizePanelShown,
  onVisualizeRevealRequested,
  openVisualizePageLink,
  resetVisualizePanelMemory,
  reopenVisualizeContent,
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
  visualizeHeldSince,
  visualizeStateFor,
  visualizeTabTooltip,
} from './visualize-store.ts';

const tab = { id: 'v1', label: 'index.html', revision: 0, panes: [] };

test('the panel on-screen state is observable so a card tile stops saying Showing once the panel closes', () => {
  let notified = 0;
  const stop = subscribe(() => {
    notified += 1;
  });
  try {
    assert.equal(visualizePanelOnScreen('tile-1'), false);
    setVisualizePanelOnScreen('tile-1', true);
    assert.equal(visualizePanelOnScreen('tile-1'), true);
    assert.equal(notified, 1);
    setVisualizePanelOnScreen('tile-1', true);
    assert.equal(notified, 1, 'no change, no notification');
    setVisualizePanelOnScreen('tile-1', false);
    assert.equal(visualizePanelOnScreen('tile-1'), false);
    assert.equal(notified, 2);
  } finally {
    stop();
  }
});

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

test('a closed panel stays closed on plain state pushes and reopens on an agent open', () => {
  const reveals = [];
  const stop = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
  try {
    applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', tabs: [tab], active: 'v1' }, reveal: true });
    assert.equal(visualizeStateFor('s1').active, 'v1');
    assert.deepEqual(reveals, ['s1']);

    suppressVisualizeReveal('s1');
    applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', tabs: [{ ...tab, revision: 1 }], active: 'v1' } });
    assert.deepEqual(reveals, ['s1'], 'a push without reveal (thumbnail, problems) never reopens a closed panel');
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
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
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

    // The reload: in-memory state is gone, localStorage remains, and the
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
    globalThis.localStorage = previous;
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
    assert.deepEqual(reveals, [], 'no version moved and no panel was remembered open: nothing is revealed');
  } finally {
    stop();
  }
});

/** A tab with kept versions 1..n. */
const versioned = (id, n) => ({
  id,
  label: id,
  revision: n,
  panes: [],
  versions: Array.from({ length: n }, (_, index) => ({ n: index + 1, at: index })),
});

function withLocalStorage() {
  const stored = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
  };
  resetVisualizePanelMemory();
  return () => {
    globalThis.localStorage = previous;
    resetVisualizePanelMemory();
  };
}

test('open policy: every open and update reveals its tab, even after the user closed the panel', () => {
  const restore = withLocalStorage();
  const sent = [];
  const previous = globalThis.window;
  globalThis.window = { mixdogDesktop: { visualizeCommand: async (command) => sent.push(command) } };
  const reveals = [];
  const stop = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
  try {
    const state = (tabs, active) => ({ sessionId: 'p1', tabs, active });
    applyVisualizeEvent({ sessionId: 'p1', state: state([versioned('v1', 1)], 'v1'), reveal: true, tab: 'v1' });
    assert.deepEqual(reveals, ['p1']);
    suppressVisualizeReveal('p1');
    // A file-change update of v1 while v2 is the active tab: main leaves the
    // active tab alone, the renderer brings v1 up and tells main.
    applyVisualizeEvent({
      sessionId: 'p1',
      state: state([versioned('v1', 2), versioned('v2', 1)], 'v2'),
      reveal: true,
      tab: 'v1',
    });
    assert.deepEqual(reveals, ['p1', 'p1'], 'an update reopens a panel the user closed');
    assert.equal(visualizeRevealSuppressed('p1'), false);
    assert.equal(visualizeStateFor('p1').active, 'v1');
    assert.deepEqual(sent, [{ sessionId: 'p1', tabId: 'v1', action: 'activate' }]);
    // A plain state push (no open, no update) reveals nothing.
    applyVisualizeEvent({ sessionId: 'p1', state: state([versioned('v1', 2), versioned('v2', 1)], 'v1') });
    assert.deepEqual(reveals, ['p1', 'p1']);
  } finally {
    stop();
    globalThis.window = previous;
    restore();
  }
});

test('open policy: a tab the user picked on a shown panel holds; the other tab is marked updated', () => {
  const restore = withLocalStorage();
  const sent = [];
  const previous = globalThis.window;
  globalThis.window = { mixdogDesktop: { visualizeCommand: async (command) => sent.push(command) } };
  const reveals = [];
  const stop = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
  try {
    const tabs = (n) => [versioned('v1', 1), versioned('v2', n)];
    applyVisualizeEvent({ sessionId: 'k1', state: { sessionId: 'k1', tabs: tabs(1), active: 'v2' } });
    setVisualizePanelOnScreen('k1', true);
    activateVisualizeTab('k1', 'v1');
    sent.length = 0;
    // The agent opens v2 again: main made it active; the user's v1 stays.
    applyVisualizeEvent({
      sessionId: 'k1',
      state: { sessionId: 'k1', tabs: tabs(2), active: 'v2' },
      reveal: true,
      tab: 'v2',
    });
    assert.deepEqual(reveals, []);
    assert.equal(visualizeStateFor('k1').active, 'v1');
    assert.deepEqual(sent, [{ sessionId: 'k1', tabId: 'v1', action: 'activate' }]);
    assert.deepEqual([...visualizeUpdatedTabs('k1')], ['v2']);
    // An update of the picked tab itself shows as usual.
    applyVisualizeEvent({
      sessionId: 'k1',
      state: { sessionId: 'k1', tabs: tabs(2), active: 'v1' },
      reveal: true,
      tab: 'v1',
    });
    assert.deepEqual(reveals, ['k1']);
    // Once the panel leaves the screen the pick no longer holds.
    activateVisualizeTab('k1', 'v1');
    setVisualizePanelOnScreen('k1', false);
    applyVisualizeEvent({
      sessionId: 'k1',
      state: { sessionId: 'k1', tabs: tabs(3), active: 'v2' },
      reveal: true,
      tab: 'v2',
    });
    assert.deepEqual(reveals, ['k1', 'k1']);
    assert.equal(visualizeStateFor('k1').active, 'v2');
    assert.equal(visualizeUpdatedTabs('k1').has('v2'), false, 'viewing a tab clears its mark');
    assert.equal(visualizeUpdateShows({ tabs: tabs(1) }, 'v2', true, 'gone'), true, 'a closed pick holds nothing');
  } finally {
    stop();
    globalThis.window = previous;
    restore();
  }
});

test('a content update lands in place: no activation, no reveal, a dot on a background tab until viewed', () => {
  const restore = withLocalStorage();
  const sent = [];
  const previous = globalThis.window;
  globalThis.window = { mixdogDesktop: { visualizeCommand: async (command) => sent.push(command) } };
  const reveals = [];
  const stop = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
  try {
    const tabs = (n) => [versioned('v1', n), versioned('v2', 1)];
    applyVisualizeEvent({ sessionId: 'u1', state: { sessionId: 'u1', tabs: tabs(1), active: 'v2' } });
    // v1 changed on disk while v2 is the active tab.
    applyVisualizeEvent({ sessionId: 'u1', state: { sessionId: 'u1', tabs: tabs(2), active: 'v2' }, updated: 'v1' });
    assert.deepEqual(reveals, [], 'the panel is not revealed');
    assert.deepEqual(sent, [], 'no tab is activated');
    assert.equal(visualizeStateFor('u1').active, 'v2');
    assert.equal(visualizeStateFor('u1').tabs[0].versions.at(-1).n, 2, 'the tab content is updated');
    assert.deepEqual([...visualizeUpdatedTabs('u1')], ['v1']);
    // The active tab updating in place wears no dot.
    applyVisualizeEvent({ sessionId: 'u1', state: { sessionId: 'u1', tabs: tabs(3), active: 'v2' }, updated: 'v2' });
    assert.deepEqual([...visualizeUpdatedTabs('u1')], ['v1']);
    // Viewing the tab clears its dot.
    activateVisualizeTab('u1', 'v1');
    assert.equal(visualizeUpdatedTabs('u1').has('v1'), false);
    // An open still reveals.
    applyVisualizeEvent({
      sessionId: 'u1',
      state: { sessionId: 'u1', tabs: tabs(3), active: 'v1' },
      reveal: true,
      tab: 'v1',
    });
    assert.deepEqual(reveals, ['u1']);
  } finally {
    stop();
    globalThis.window = previous;
    restore();
  }
});

test('resume: a remote client back from a gap restores an open panel and shows what changed meanwhile', async () => {
  const restore = withLocalStorage();
  const reveals = [];
  const previous = globalThis.window;
  globalThis.window = { mixdogDesktop: { visualizeCommand: async () => undefined } };
  try {
    applyVisualizeEvent({ sessionId: 'm1', state: { sessionId: 'm1', tabs: [versioned('v1', 1)], active: 'v1' } });
    applyVisualizeEvent({ sessionId: 'm2', state: { sessionId: 'm2', tabs: [versioned('v1', 1)], active: 'v1' } });
    applyVisualizeEvent({ sessionId: 'm3', state: { sessionId: 'm3', tabs: [versioned('v1', 1)], active: 'v1' } });
    markVisualizePanelShown('m1');
    markVisualizePanelShown('m3');
    suppressVisualizeReveal('m3');
    // The page was discarded in the background: memory comes back from
    // localStorage, not from the (lost) in-memory sets.
    resetVisualizePanelMemory();
    const stop = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
    try {
      resyncVisualizeStates([
        { sessionId: 'm1', tabs: [versioned('v1', 1)], active: 'v1' },
        { sessionId: 'm2', tabs: [versioned('v1', 1), versioned('v2', 1)], active: 'v2' },
        { sessionId: 'm3', tabs: [versioned('v1', 1)], active: 'v1' },
      ]);
      assert.deepEqual(reveals, [], 'the reveal waits a turn for the shell');
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.deepEqual(reveals.sort(), ['m1', 'm2'], 'm1 was open; m2 got a tab during the gap; m3 was closed');
      assert.equal(visualizeStateFor('m2').active, 'v2');
    } finally {
      stop();
    }
  } finally {
    globalThis.window = previous;
    restore();
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

test('a held (mid-turn) push leaves the panel as it is; the turn end shows it', () => {
  const reveals = [];
  const stop = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
  try {
    const shown = { sessionId: 'turn', tabs: [tab], active: 'v1' };
    applyVisualizeEvent({ sessionId: 'turn', state: shown });
    const before = visualizeStateFor('turn');
    const edited = { ...tab, revision: 1 };
    const opened = { id: 'v2', label: 'b.html', revision: 0, panes: [] };
    const held = { sessionId: 'turn', tabs: [edited, opened], active: 'v1' };

    applyVisualizeEvent({ sessionId: 'turn', state: held, held: true, heldSince: 500, updated: 'v1' });
    assert.equal(visualizeStateFor('turn'), before, 'the panel keeps its state: nothing reloads');
    assert.equal(visualizeHeldSince('turn'), 500, 'cards of opens since the turn started wait');
    assert.deepEqual(reveals, [], 'nothing opens mid-turn');

    // Every emit at the turn's end that already shows the hold lifted carries the final state.
    const seen = [];
    const unsubscribe = subscribe(() =>
      seen.push([
        visualizeHeldSince('turn'),
        visualizeStateFor('turn')
          .tabs.map((entry) => entry.id)
          .join(),
      ])
    );
    applyVisualizeEvent({ sessionId: 'turn', state: { ...held, active: 'v2' }, reveal: true, tab: 'v2' });
    unsubscribe();
    assert.deepEqual(
      seen.filter(([since]) => since === null).map(([, ids]) => ids),
      seen.filter(([since]) => since === null).map(() => 'v1,v2'),
      'no reader sees the hold lifted with the state from before the turn'
    );
    assert.ok(seen.length > 0);
    assert.equal(visualizeStateFor('turn').active, 'v2');
    assert.equal(visualizeStateFor('turn').tabs[0].revision, 1);
    assert.equal(visualizeHeldSince('turn'), null, 'the hold is gone');
    assert.deepEqual(reveals, ['turn'], 'the turn end reveals once');
  } finally {
    stop();
  }
});

test('the turn end lifts the hold even when its final state changes nothing', () => {
  const shown = { sessionId: 'same', tabs: [tab], active: 'v1' };
  applyVisualizeEvent({ sessionId: 'same', state: shown });
  applyVisualizeEvent({ sessionId: 'same', state: shown, held: true, heldSince: 1 });
  let emits = 0;
  const unsubscribe = subscribe(() => {
    emits += 1;
  });
  applyVisualizeEvent({ sessionId: 'same', state: shown });
  unsubscribe();
  assert.equal(visualizeHeldSince('same'), null);
  assert.ok(emits >= 1, 'cards hear that the turn ended');
});

/** A tab showing `target`, with kept versions 1..n. */
const fileTab = (id, target, n) => ({
  ...versioned(id, n),
  label: target,
  panes: [{ kind: 'html', label: target, target, url: '' }],
});

/** Runs `body` as a phone (412 px, touch, iPhone UA) whose host records commands in `sent`. */
async function asPhone(body) {
  const restore = withLocalStorage();
  const sent = [];
  const reveals = [];
  const previousWindow = globalThis.window;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let failNext = false;
  globalThis.window = {
    innerWidth: 412,
    matchMedia: () => ({ matches: true }),
    mixdogDesktop: {
      visualizeCommand: async (command) => {
        sent.push(command);
        if (failNext) {
          failNext = false;
          throw new Error('refused');
        }
        return {};
      },
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile', maxTouchPoints: 5 },
  });
  const stop = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
  try {
    resetVisualizePanelMemory();
    await body({ sent, reveals, failOnce: () => (failNext = true) });
  } finally {
    stop();
    globalThis.window = previousWindow;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
    restore();
  }
}

const open = (sessionId, tabs, active, tab = active) =>
  applyVisualizeEvent({ sessionId, state: { sessionId, tabs, active }, reveal: true, tab });

test('phone: agent opens and updates never show the panel or move its selection; others wear the dot', () =>
  asPhone(({ sent, reveals }) => {
    open('ph', [versioned('v1', 1)], 'v1');
    assert.deepEqual(reveals, []);
    assert.deepEqual(
      visualizeStateFor('ph').tabs.map((t) => t.id),
      ['v1'],
      'the tab exists for the card'
    );
    // A second page (main made it active) and an update of the first.
    open('ph', [versioned('v1', 1), versioned('v2', 1)], 'v2');
    open('ph', [versioned('v1', 2), versioned('v2', 1)], 'v2', 'v1');
    // A plain file-change push with main's active elsewhere keeps it too.
    applyVisualizeEvent({
      sessionId: 'ph',
      state: { sessionId: 'ph', tabs: [versioned('v1', 2), versioned('v2', 2)], active: 'v2' },
      updated: 'v2',
    });
    assert.deepEqual(reveals, []);
    assert.equal(visualizeStateFor('ph').active, 'v1', 'the local selection stays');
    assert.equal(visualizeStateFor('ph').tabs[0].versions.at(-1).n, 2, 'the newest state is kept');
    assert.deepEqual([...visualizeUpdatedTabs('ph')], ['v2']);
    assert.deepEqual(sent, [], 'nothing is activated on the host');
    // The user taps v2's tile: the panel opens on it.
    revealVisualizeTab('ph', 'v2');
    assert.deepEqual(reveals, ['ph']);
    assert.equal(visualizeStateFor('ph').active, 'v2');
    assert.equal(visualizeUpdatedTabs('ph').has('v2'), false);
    // Panel open: an update of the shown tab lands in place on it.
    setVisualizePanelOnScreen('ph', true);
    open('ph', [versioned('v1', 2), versioned('v2', 3)], 'v2');
    assert.equal(visualizeStateFor('ph').active, 'v2');
    assert.equal(visualizeStateFor('ph').tabs[1].versions.at(-1).n, 3);
  }));

test('phone: a reconnect resync neither shows the panel nor moves the selection', () =>
  asPhone(async ({ reveals }) => {
    open('rs', [versioned('v1', 1), versioned('v2', 1)], 'v1');
    resyncVisualizeStates([{ sessionId: 'rs', tabs: [versioned('v1', 1), versioned('v2', 2)], active: 'v2' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(reveals, []);
    assert.equal(visualizeStateFor('rs').active, 'v1');
    assert.deepEqual([...visualizeUpdatedTabs('rs')], ['v2']);
  }));

test('phone: a tap on a closed tile opens the panel only for the open of exactly that target', () =>
  asPhone(async ({ sent, reveals, failOnce }) => {
    open('ro', [fileTab('v1', 'a.html', 1)], 'v1');
    await reopenVisualizeTargets('ro', 'v9', ['c.html']);
    assert.equal(sent.at(-1).action, 'reopen');
    // An unrelated agent open does not consume it.
    open('ro', [fileTab('v1', 'a.html', 1), fileTab('v2', 'b.html', 1)], 'v2');
    assert.deepEqual(reveals, []);
    // The reopened tab (a new id) does, once.
    open('ro', [fileTab('v1', 'a.html', 1), fileTab('v2', 'b.html', 1), fileTab('v3', 'c.html', 1)], 'v3');
    assert.deepEqual(reveals, ['ro']);
    assert.equal(visualizeStateFor('ro').active, 'v3');
    open('ro', [fileTab('v1', 'a.html', 1), fileTab('v2', 'b.html', 1), fileTab('v3', 'c.html', 2)], 'v3');
    assert.deepEqual(reveals, ['ro'], 'the next open of it does not');

    // A target already live is shown at once; nothing is sent or kept.
    reveals.length = 0;
    sent.length = 0;
    await reopenVisualizeTargets('ro', 'v8', ['b.html']);
    assert.deepEqual(reveals, ['ro']);
    assert.equal(visualizeStateFor('ro').active, 'v2');
    assert.ok(!sent.some((command) => command.action === 'reopen'));

    // A failed request leaves nothing behind.
    reveals.length = 0;
    failOnce();
    await assert.rejects(reopenVisualizeTargets('ro', 'v7', ['d.html']), /refused/);
    open('ro', [fileTab('v2', 'b.html', 1), fileTab('v4', 'd.html', 1)], 'v4');
    assert.deepEqual(reveals, []);

    // An expired one neither.
    const realNow = Date.now;
    try {
      await reopenVisualizeTargets('ro', 'v6', ['e.html']);
      Date.now = () => realNow() + 16_000;
      open('ro', [fileTab('v2', 'b.html', 1), fileTab('v5', 'e.html', 1)], 'v5');
      assert.deepEqual(reveals, []);
    } finally {
      Date.now = realNow;
    }
  }));

test('phone: All visuals opens a live entry at once and waits only for a closed one', () =>
  asPhone(async ({ sent, reveals }) => {
    const history = [
      { id: 'h-live', label: 'a.html', kind: 'html', versions: 1, at: 1, open: true },
      { id: 'h-closed', label: 'flow', kind: 'mermaid', versions: 1, at: 0, open: false },
    ];
    applyVisualizeEvent({
      sessionId: 'hv',
      state: { sessionId: 'hv', tabs: [fileTab('v1', 'a.html', 1)], active: 'v1', history },
    });
    await openVisualizeHistory('hv', 'h-live');
    assert.deepEqual(reveals, ['hv'], 'shown without waiting for a reveal');
    assert.deepEqual(sent.at(-1), { sessionId: 'hv', tabId: '', action: 'history', entry: 'h-live' });
    // Nothing waits: a later agent open of a.html stays closed.
    const withHistory = (tabs, active) =>
      applyVisualizeEvent({
        sessionId: 'hv',
        state: { sessionId: 'hv', tabs, active, history },
        reveal: true,
        tab: active,
      });
    withHistory([fileTab('v1', 'a.html', 2)], 'v1');
    assert.deepEqual(reveals, ['hv']);
    await openVisualizeHistory('hv', 'h-closed');
    withHistory([fileTab('v1', 'a.html', 2), { ...versioned('v2', 1), label: 'flow' }], 'v2');
    assert.deepEqual(reveals, ['hv', 'hv']);
  }));

test('phone: two untitled diagrams are told apart by their source, like the host does', () =>
  asPhone(async ({ sent, reveals }) => {
    const a = { kind: 'mermaid', source: 'graph TD; A-->B' };
    const b = { kind: 'mermaid', source: 'graph TD; C-->D' };
    const inlineTab = (id, content) => ({
      ...versioned(id, 1),
      label: 'Mermaid diagram',
      panes: [{ kind: 'inline', label: 'Mermaid diagram', target: 'inline mermaid', url: '', inline: content }],
    });
    open('in', [inlineTab('v1', a)], 'v1');
    // B is closed: tapping it asks the host to reopen it, not A.
    await reopenVisualizeContent('in', 'v2', b);
    assert.deepEqual(reveals, []);
    assert.deepEqual(sent.at(-1), {
      sessionId: 'in',
      tabId: 'v2',
      action: 'reopen',
      targets: [],
      content: b,
    });
    // An update of A does not answer it; the reopened B does.
    open('in', [inlineTab('v1', a)], 'v1');
    assert.deepEqual(reveals, []);
    open('in', [inlineTab('v1', a), inlineTab('v3', b)], 'v3');
    assert.deepEqual(reveals, ['in']);
    assert.equal(visualizeStateFor('in').active, 'v3');
    // A live untitled diagram with the same source is shown at once.
    sent.length = 0;
    await reopenVisualizeContent('in', 'v9', { ...a });
    assert.deepEqual(reveals, ['in', 'in']);
    assert.equal(visualizeStateFor('in').active, 'v1');
    assert.ok(!sent.some((command) => command.action === 'reopen'));
  }));
