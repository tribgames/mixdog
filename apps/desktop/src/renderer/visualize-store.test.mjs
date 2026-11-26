import assert from 'node:assert/strict';
import test from 'node:test';

import { onBrowserPageRevealRequested } from './browser-page-request.ts';
import { _runIdleReclaimForTest } from './idle-reclaim.ts';
import { enforceRendererCacheBudget, registerBudgetedCache, totalBudgetedChars } from './renderer-cache-budget.ts';
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
  suppressVisualizeReveal,
  toggleVisualizeCompare,
  visualizeVersionPosition,
  openVisualizeHistory,
  onVisualizeEmptied,
  openTurnPreviews,
  requestVisualizeVersion,
  exportVisualizeTab,
  visualizeExportPane,
  visualizeHistoryTime,
  visualizeVersionStep,
  visualizeHeaderActions,
  visualizePanesStacked,
  visualizeRevealSuppressed,
  visualizeHeldCalls,
  visualizeHeldSince,
  visualizeStateFor,
  isVisualizeStateRehydrating,
  useVisualizeAvailable,
  useVisualizeState,
  visualizeTabTooltip,
  releaseVisualizeSession,
} from './visualize-store.ts';
import { setVisualizeTweakDefs, visualizePaneTweaks, resetVisualizeTweakStore } from './visualize-tweaks-store.ts';
import {
  proposeVisualizeChoice,
  visualizeChoiceProposal,
  visualizeProposalKey,
  resetVisualizeChoiceProposals,
} from './visualize-feedback-gate.ts';

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

function withPickHarness(run) {
  const restore = withLocalStorage();
  const sent = [];
  const previous = globalThis.window;
  globalThis.window = { mixdogDesktop: { visualizeCommand: async (command) => sent.push(command) } };
  const reveals = [];
  const stop = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
  try {
    run({ sent, reveals });
  } finally {
    stop();
    globalThis.window = previous;
    restore();
  }
}

const pickTabs = (n) => [versioned('v1', 1), versioned('v2', n)];
const pickState = (n, active) => ({ sessionId: 'k1', tabs: pickTabs(n), active });

function pickV1OnShownPanel(sent) {
  applyVisualizeEvent({ sessionId: 'k1', state: pickState(1, 'v2') });
  setVisualizePanelOnScreen('k1', true);
  activateVisualizeTab('k1', 'v1');
  sent.length = 0;
}

test('open policy: a tab the user picked on a shown panel holds against an agent open of another tab', () => {
  withPickHarness(({ sent, reveals }) => {
    pickV1OnShownPanel(sent);
    applyVisualizeEvent({ sessionId: 'k1', state: pickState(2, 'v2'), reveal: true, tab: 'v2' });
    assert.deepEqual(reveals, []);
    assert.equal(visualizeStateFor('k1').active, 'v1');
    assert.deepEqual(sent, [{ sessionId: 'k1', tabId: 'v1', action: 'activate' }]);
    assert.deepEqual([...visualizeUpdatedTabs('k1')], ['v2']);
  });
});

test('open policy: an update of the picked tab itself shows as usual', () => {
  withPickHarness(({ sent, reveals }) => {
    pickV1OnShownPanel(sent);
    applyVisualizeEvent({ sessionId: 'k1', state: pickState(2, 'v1'), reveal: true, tab: 'v1' });
    assert.deepEqual(reveals, ['k1']);
  });
});

test('open policy: once the panel leaves the screen the pick no longer holds', () => {
  withPickHarness(({ sent, reveals }) => {
    pickV1OnShownPanel(sent);
    setVisualizePanelOnScreen('k1', false);
    applyVisualizeEvent({ sessionId: 'k1', state: pickState(3, 'v2'), reveal: true, tab: 'v2' });
    assert.deepEqual(reveals, ['k1']);
    assert.equal(visualizeStateFor('k1').active, 'v2');
    assert.equal(visualizeUpdatedTabs('k1').has('v2'), false, 'viewing a tab clears its mark');
  });
});

test('open policy: a pick of a closed tab holds nothing', () => {
  assert.equal(visualizeUpdateShows({ tabs: pickTabs(1) }, 'v2', true, 'gone'), true);
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

  // When live content was not kept as a version (`liveUnkept: true`), even a 1-version tab has a stepper,
  // and stepping back from live lands on the newest kept version rather than skipping it.
  const single = [{ n: 1, at: 1 }];
  assert.deepEqual(visualizeVersionPosition({ versions: single, version: null, liveUnkept: true }), {
    shown: null,
    newest: 1,
  });
  assert.equal(visualizeVersionStep({ versions: single, version: null, liveUnkept: true }, -1), 1);
  assert.equal(visualizeVersionStep({ versions: single, version: null, liveUnkept: true }, 1), undefined);
  assert.equal(visualizeVersionStep({ versions: single, version: 1, liveUnkept: true }, 1), null);
  assert.deepEqual(visualizeVersionPosition({ versions, version: null, liveUnkept: true }), {
    shown: null,
    newest: 6,
  });
  assert.equal(visualizeVersionStep({ versions, version: null, liveUnkept: true }, -1), 6);
  assert.equal(visualizeVersionStep({ versions, version: 5, liveUnkept: true }, 1), 6);
  assert.equal(visualizeVersionStep({ versions, version: 6, liveUnkept: true }, 1), null);

  const sent = [];
  const previous = globalThis.window;
  globalThis.window = { mixdogDesktop: { visualizeCommand: async (command) => sent.push(command) } };
  try {
    toggleVisualizeCompare('s1', { id: 'v1', versions, version: null, panes: [] });
    toggleVisualizeCompare('s1', { id: 'v1', versions: single, version: null, liveUnkept: true, panes: [] });
    toggleVisualizeCompare('s1', { id: 'v1', versions, version: null, liveUnkept: true, panes: [] });
    toggleVisualizeCompare('s1', { id: 'v1', versions, version: 3, compare: true, panes: [] });
    void requestVisualizeVersion('s1', 'v1', null);
    void restoreVisualizeVersion('s1', 'v1', 3);
    void restoreVisualizeVersion('s1', 'v1', 3, ['site/style.css']);
    assert.deepEqual(sent, [
      { sessionId: 's1', tabId: 'v1', action: 'version', version: 5, compare: true },
      { sessionId: 's1', tabId: 'v1', action: 'version', version: 1, compare: true },
      { sessionId: 's1', tabId: 'v1', action: 'version', version: 6, compare: true },
      { sessionId: 's1', tabId: 'v1', action: 'version', version: 3 },
      { sessionId: 's1', tabId: 'v1', action: 'version', version: null },
      { sessionId: 's1', tabId: 'v1', action: 'restore', version: 3 },
      { sessionId: 's1', tabId: 'v1', action: 'restore', version: 3, assets: ['site/style.css'] },
    ]);
  } finally {
    globalThis.window = previous;
  }
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

test('a held (mid-turn) push carries what the session shows and leaves the panel as it is; the turn end shows the turn’s work', () => {
  const reveals = [];
  const stop = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
  try {
    const shown = { sessionId: 'turn', tabs: [tab], active: 'v1' };
    applyVisualizeEvent({ sessionId: 'turn', state: shown });
    const before = visualizeStateFor('turn');
    const edited = { ...tab, revision: 1 };
    const opened = { id: 'v2', label: 'b.html', revision: 0, panes: [] };
    const held = { sessionId: 'turn', tabs: [edited, opened], active: 'v1' };

    // The host keeps the turn's work: its event marks the changed tab and carries the state from before the turn.
    applyVisualizeEvent({ sessionId: 'turn', state: shown, held: true, heldSince: 500, updated: 'v1' });
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

test('the end of a turn whose successor already runs shows that turn’s result and keeps the session held', () => {
  const reveals = [];
  const stop = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
  try {
    const opened = { id: 'v2', label: 'b.html', revision: 0, panes: [] };
    const first = { sessionId: 'chain', tabs: [tab], active: 'v1' };
    const shows = () => [
      visualizeHeldSince('chain'),
      visualizeStateFor('chain').active,
      visualizeStateFor('chain').tabs.map((entry) => `${entry.id}@${entry.revision}`),
    ];
    applyVisualizeEvent({ sessionId: 'chain', state: first });
    applyVisualizeEvent({ sessionId: 'chain', state: first, held: true, heldSince: 100 });
    // The first turn opened v2 and ends while the second already runs.
    const second = { sessionId: 'chain', tabs: [tab, opened], active: 'v2' };
    applyVisualizeEvent({ sessionId: 'chain', state: second, held: true, heldSince: 200, reveal: true, tab: 'v2' });
    assert.deepEqual(shows(), [200, 'v2', ['v1@0', 'v2@0']], 'its tab shows, cards since the second turn’s start wait');
    assert.deepEqual(reveals, ['chain']);
    // The second turn only changed v1 and ends while a third runs: nothing is revealed, the change shows.
    const third = { sessionId: 'chain', tabs: [{ ...tab, revision: 1 }, opened], active: 'v2' };
    applyVisualizeEvent({ sessionId: 'chain', state: third, held: true, heldSince: 300 });
    assert.deepEqual(shows(), [300, 'v2', ['v1@1', 'v2@0']]);
    assert.deepEqual(reveals, ['chain']);
    applyVisualizeEvent({ sessionId: 'chain', state: third });
    assert.deepEqual(shows(), [null, 'v2', ['v1@1', 'v2@0']], 'the last turn’s end lifts the hold');
  } finally {
    stop();
  }
});

test('a snapshot read is authoritative about holds: a held session shows the state it carries, a release it shows is released', () => {
  const shown = { sessionId: 'away', tabs: [tab], active: 'v1' };
  applyVisualizeEvent({ sessionId: 'away', state: shown });
  const middle = { ...shown, tabs: [tab, { id: 'v2', label: 'b.html', revision: 0, panes: [] }] };
  applyVisualizeEvent({ sessionId: 'away', state: shown, held: true, heldSince: 70 });
  const before = visualizeStateFor('away');
  // A re-read during the ongoing turn (a wake, a resync hint, a recovered part sequence): still held, nothing shown of the turn.
  resyncVisualizeStates([{ ...shown, held: true, heldSince: 70 }]);
  assert.equal(visualizeHeldSince('away'), 70, 'the turn is still held');
  assert.equal(visualizeStateFor('away'), before, 'what the session shows is unchanged');
  // That turn's end was missed while away and the next one already runs: the read carries its result, still held.
  resyncVisualizeStates([{ ...middle, held: true, heldSince: 90 }]);
  assert.equal(visualizeHeldSince('away'), 90);
  assert.deepEqual(
    visualizeStateFor('away').tabs.map((entry) => entry.id),
    ['v1', 'v2'],
    'the result of the last ended turn shows'
  );
  // The release was missed while away: the core's current state is not held.
  resyncVisualizeStates([{ ...middle, active: 'v2' }]);
  assert.equal(visualizeHeldSince('away'), null, 'a state that does not say held is not held');
  assert.deepEqual(
    visualizeStateFor('away').tabs.map((entry) => entry.id),
    ['v1', 'v2']
  );
});

test('the initial read applies holds as a re-read does: a held session shows the state it carries, and a snapshot that introduces a hold notifies', () => {
  const shown = { sessionId: 'boot', tabs: [tab], active: 'v1' };
  const seen = [];
  const unsubscribe = subscribe(() => seen.push(visualizeHeldSince('boot')));
  // The first read of a window that loads during a held turn: the result of the last turn that ended, held.
  hydrateVisualizeStates([{ ...shown, held: true, heldSince: 9 }]);
  assert.equal(visualizeHeldSince('boot'), 9);
  assert.equal(visualizeStateFor('boot').tabs.length, 1, 'what the session shows is displayed');
  assert.deepEqual(seen, [9], 'subscribers were told of the hold');
  // A re-read that still says held keeps it; one that says released releases it.
  resyncVisualizeStates([{ ...shown, held: true, heldSince: 9 }]);
  assert.equal(visualizeHeldSince('boot'), 9);
  assert.equal(visualizeStateFor('boot').tabs.length, 1);
  resyncVisualizeStates([shown]);
  unsubscribe();
  assert.equal(visualizeHeldSince('boot'), null);
  assert.equal(visualizeStateFor('boot').tabs.length, 1);
  // A re-read that introduces a hold on a displayed session notifies, though nothing was held before.
  const notes = [];
  const stop = subscribe(() => notes.push(visualizeHeldSince('boot')));
  resyncVisualizeStates([{ ...shown, held: true, heldSince: 11 }]);
  stop();
  assert.deepEqual(notes, [11]);
  resyncVisualizeStates([]);
});

test('a snapshot read is a complete replacement: a session it does not list (its last tab closed) is cleared', () => {
  const emptied = [];
  const stop = onVisualizeEmptied((id) => emptied.push(id));
  try {
    applyVisualizeEvent({ sessionId: 'gone', state: { sessionId: 'gone', tabs: [tab], active: 'v1' } });
    assert.ok(visualizeStateFor('gone'));
    resyncVisualizeStates([]);
    assert.equal(visualizeStateFor('gone').tabs.length, 0, 'the phone does not keep the session');
    assert.ok(emptied.includes('gone'), 'and the panel it showed is cleared');
  } finally {
    stop();
  }
});

test('a wake on a connection that stayed up and a reconnect both end in a read that releases the turn', async () => {
  const states = [{ sessionId: 'wake', tabs: [tab], active: 'v1' }];
  const previousWindow = globalThis.window;
  const listeners = new Map();
  let reads = 0;
  globalThis.window = {
    mixdogDesktop: {
      onVisualizeChanged: () => () => undefined,
      visualizeState: async () => {
        reads++;
        return states;
      },
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: () => undefined,
  };
  try {
    const stop = subscribe(() => undefined);
    stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const event of ['mixdog:remote-state-gap', 'mixdog:remote-reconnected']) {
      applyVisualizeEvent({ sessionId: 'wake', state: states[0], held: true, heldSince: 5 });
      assert.equal(visualizeHeldSince('wake'), 5);
      const before = reads;
      listeners.get(event)();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(reads, before + 1, `${event} re-reads the state`);
      assert.equal(visualizeHeldSince('wake'), null, `${event}: the turn is released`);
    }
  } finally {
    globalThis.window = previousWindow;
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

/** Runs `body` on the desktop with a host that records commands in `sent`. */
async function onDesktop(body, command = async () => ({})) {
  const restore = withLocalStorage();
  const sent = [];
  const reveals = [];
  const previous = globalThis.window;
  globalThis.window = {
    mixdogDesktop: {
      visualizeCommand: async (request) => {
        sent.push(request);
        return command(request);
      },
    },
  };
  const stop = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
  try {
    await body({ sent, reveals });
  } finally {
    stop();
    globalThis.window = previous;
    restore();
  }
}

test("a user's pick does not outlast a turn: the turn's own open shows at its end", () =>
  onDesktop(({ reveals }) => {
    const tabs = (n) => [versioned('v1', 1), versioned('v2', n)];
    applyVisualizeEvent({ sessionId: 'pk', state: { sessionId: 'pk', tabs: tabs(1), active: 'v2' } });
    setVisualizePanelOnScreen('pk', true);
    activateVisualizeTab('pk', 'v1');
    // A turn starts and opens v2 again; its end reveals it over the pick.
    applyVisualizeEvent({ sessionId: 'pk', state: { sessionId: 'pk', tabs: tabs(2), active: 'v1' }, held: true });
    applyVisualizeEvent({
      sessionId: 'pk',
      state: { sessionId: 'pk', tabs: tabs(2), active: 'v2' },
      reveal: true,
      tab: 'v2',
    });
    assert.deepEqual(reveals, ['pk']);
    assert.equal(visualizeStateFor('pk').active, 'v2');
    assert.equal(visualizeUpdatedTabs('pk').has('v2'), false);
    // A pick made during a turn ends with that turn too.
    applyVisualizeEvent({ sessionId: 'pk', state: { sessionId: 'pk', tabs: tabs(3), active: 'v2' }, held: true });
    activateVisualizeTab('pk', 'v1');
    applyVisualizeEvent({
      sessionId: 'pk',
      state: { sessionId: 'pk', tabs: tabs(3), active: 'v2' },
      reveal: true,
      tab: 'v2',
    });
    assert.deepEqual(reveals, ['pk', 'pk']);
    assert.equal(visualizeStateFor('pk').active, 'v2');
    setVisualizePanelOnScreen('pk', false);
  }));

test("a turn's previews open behind the agent's own opens without taking the panel", () =>
  onDesktop(async ({ sent, reveals }) => {
    const page = (id, target) => ({ ...versioned(id, 1), panes: [{ kind: 'html', label: target, target, url: '' }] });
    // The turn's end showed the agent's own open, v1.
    applyVisualizeEvent({
      sessionId: 'tp',
      state: { sessionId: 'tp', tabs: [page('v1', 'a.html')], active: 'v1' },
      reveal: true,
      tab: 'v1',
    });
    assert.deepEqual(reveals, ['tp']);
    setVisualizePanelOnScreen('tp', true);
    await openTurnPreviews('tp', ['b.html'], { reveal: false });
    assert.deepEqual(sent.at(-1), { sessionId: 'tp', tabId: 'preview', action: 'reopen', targets: ['b.html'] });
    // Main's open of the preview made it active and asks to reveal it.
    applyVisualizeEvent({
      sessionId: 'tp',
      state: { sessionId: 'tp', tabs: [page('v1', 'a.html'), page('v2', 'b.html')], active: 'v2' },
      reveal: true,
      tab: 'v2',
    });
    assert.deepEqual(reveals, ['tp'], 'no reveal for the preview');
    assert.equal(visualizeStateFor('tp').active, 'v1', "the panel stays on the agent's tab");
    assert.deepEqual(sent.at(-1), { sessionId: 'tp', tabId: 'v1', action: 'activate' }, 'main is told');
    assert.deepEqual([...visualizeUpdatedTabs('tp')], ['v2'], 'the preview wears the dot');
    // A turn with no agent opens still shows its previews.
    await openTurnPreviews('tp', ['c.html']);
    applyVisualizeEvent({
      sessionId: 'tp',
      state: {
        sessionId: 'tp',
        tabs: [page('v1', 'a.html'), page('v2', 'b.html'), page('v3', 'c.html')],
        active: 'v3',
      },
      reveal: true,
      tab: 'v3',
    });
    assert.deepEqual(reveals, ['tp', 'tp']);
    assert.equal(visualizeStateFor('tp').active, 'v3');
    setVisualizePanelOnScreen('tp', false);
  }));

test('the shell hears when a session loses its last tab, wherever its panel is', () => {
  const emptied = [];
  const stop = onVisualizeEmptied((sessionId) => emptied.push(sessionId));
  try {
    applyVisualizeEvent({ sessionId: 'em', state: { sessionId: 'em', tabs: [tab], active: 'v1' } });
    applyVisualizeEvent({ sessionId: 'em', state: { sessionId: 'em', tabs: [{ ...tab, revision: 2 }], active: 'v1' } });
    assert.deepEqual(emptied, []);
    // Closed while the panel is off screen, the history kept.
    const history = [{ id: 'h1', label: 'index.html', kind: 'html', versions: 1, at: 1, open: false }];
    applyVisualizeEvent({ sessionId: 'em', state: { sessionId: 'em', tabs: [], active: null, history } });
    assert.deepEqual(emptied, ['em']);
    applyVisualizeEvent({ sessionId: 'em', state: { sessionId: 'em', tabs: [], active: null } });
    assert.deepEqual(emptied, ['em'], 'once per emptying');
  } finally {
    stop();
  }
});

test("a version the host cannot show is the caller's to report", () =>
  onDesktop(
    async ({ sent }) => {
      await assert.rejects(requestVisualizeVersion('vr', 'v1', 3), /no version 3/);
      assert.deepEqual(sent.at(-1), { sessionId: 'vr', tabId: 'v1', action: 'version', version: 3 });
      // So is a Compare it refuses (the panel's notice shows both).
      await assert.rejects(
        toggleVisualizeCompare('vr', { id: 'v1', versions: [], version: 3, panes: [] }),
        /no version 3/
      );
    },
    async (request) => {
      if (request.action === 'version') throw new Error('tab v1 has no version 3');
      return {};
    }
  ));

test('a closed pane or tab and a deleted session release their tweaks and confirm bars', () => {
  resetVisualizePanelMemory();
  resetVisualizeTweakStore();
  resetVisualizeChoiceProposals();
  const block = JSON.stringify([
    { id: 'size', type: 'range', var: '--size', min: 10, max: 20, step: 2, unit: 'px', default: 14 },
  ]);
  const withPanes = (count) => ({
    sessionId: 'rel-1',
    active: 'a',
    tabs: [{ id: 'a', label: 'a', revision: 0, panes: Array.from({ length: count }, () => ({ kind: 'html' })) }],
  });
  const seed = () => {
    for (const pane of [0, 1]) {
      setVisualizeTweakDefs('rel-1', 'a', pane, block);
      proposeVisualizeChoice(
        visualizeProposalKey('rel-1', 'a', pane),
        { sessionId: 'rel-1', choice: {}, reset() {} },
        pane * 1000
      );
    }
  };
  applyVisualizeEvent({ sessionId: 'rel-1', state: withPanes(2) });
  seed();
  applyVisualizeEvent({ sessionId: 'rel-1', state: withPanes(1) });
  assert.equal(visualizePaneTweaks('rel-1', 'a', 1).length, 0, 'the closed pane released its tweaks');
  assert.equal(visualizeChoiceProposal(visualizeProposalKey('rel-1', 'a', 1)), null);
  assert.equal(visualizePaneTweaks('rel-1', 'a', 0).length, 1, 'the open pane keeps them');
  applyVisualizeEvent({ sessionId: 'rel-1', state: { sessionId: 'rel-1', active: null, tabs: [] } });
  assert.equal(visualizePaneTweaks('rel-1', 'a', 0).length, 0, 'the closed tab released its tweaks');
  assert.equal(visualizeChoiceProposal(visualizeProposalKey('rel-1', 'a', 0)), null);

  applyVisualizeEvent({ sessionId: 'rel-2', state: { ...withPanes(1), sessionId: 'rel-2' } });
  setVisualizeTweakDefs('rel-2', 'a', 0, block);
  setVisualizePanelOnScreen('rel-2', true);
  releaseVisualizeSession('rel-2');
  assert.equal(visualizeStateFor('rel-2').tabs.length, 0, 'the deleted session shows nothing');
  assert.equal(visualizePaneTweaks('rel-2', 'a', 0).length, 0);
  assert.equal(visualizePanelOnScreen('rel-2'), false);
});

test('off-screen visualize states count in the shared cache budget, release on trim/idle without emptying, and rehydrate when shown', () =>
  onDesktop(async () => {
    resetVisualizePanelMemory();
    const emptied = [];
    const stopEmptied = onVisualizeEmptied((sessionId) => emptied.push(sessionId));
    const inlineHtml = (tag) => `<div>${tag}${'x'.repeat(120_000)}</div>`;
    const makeState = (sessionId) => ({
      sessionId,
      active: 'v1',
      tabs: [
        {
          id: 'v1',
          label: `${sessionId}.html`,
          revision: 1,
          panes: [
            { kind: 'html', target: '', inline: { kind: 'html', source: inlineHtml(sessionId), title: sessionId } },
          ],
        },
      ],
    });
    const shownState = makeState('vis-shown');
    const hiddenState = makeState('vis-hidden');
    let stateReads = 0;
    window.mixdogDesktop.visualizeState = async () => {
      stateReads += 1;
      return [shownState, hiddenState];
    };
    try {
      const before = totalBudgetedChars();
      setVisualizePanelOnScreen('vis-shown', true);
      applyVisualizeEvent({ sessionId: 'vis-shown', state: shownState });
      applyVisualizeEvent({ sessionId: 'vis-hidden', state: hiddenState });
      assert.ok(totalBudgetedChars() - before >= 240_000, 'inline HTML sources count in the shared budget');

      enforceRendererCacheBudget(0);
      assert.equal(visualizeStateFor('vis-shown').tabs.length, 1, 'on-screen session stays pinned');
      assert.equal(visualizeStateFor('vis-hidden').tabs.length, 0, 'off-screen session is evicted by budget trim');
      assert.deepEqual(emptied, [], 'cache eviction must not close the shell panel via onVisualizeEmptied');

      // Showing the evicted session re-hydrates it from main.
      setVisualizePanelOnScreen('vis-hidden', true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(stateReads, 1);
      assert.equal(visualizeStateFor('vis-hidden').tabs.length, 1, 're-hydrated once shown again');

      // Moving it off screen and running idle reclaim releases it again.
      setVisualizePanelOnScreen('vis-hidden', false);
      _runIdleReclaimForTest();
      assert.equal(visualizeStateFor('vis-hidden').tabs.length, 0, 'idle reclaim releases off-screen visualize state');
      assert.equal(visualizeStateFor('vis-shown').tabs.length, 1, 'idle reclaim keeps on-screen visualize state');
      assert.deepEqual(emptied, []);
    } finally {
      stopEmptied();
      releaseVisualizeSession('vis-shown');
      releaseVisualizeSession('vis-hidden');
    }
  }));

test('heldCalls stays clean across eviction rehydration, session release, reset, and same-ms handoff', () =>
  onDesktop(async () => {
    resetVisualizePanelMemory();
    const makeTab = (id) => ({
      id,
      label: `${id}.html`,
      revision: 1,
      panes: [
        { kind: 'html', target: '', inline: { kind: 'html', source: `<p>${'x'.repeat(120_000)}</p>`, title: id } },
      ],
    });
    const baseState = { sessionId: 'hc-1', active: 'v1', tabs: [makeTab('v1')] };
    window.mixdogDesktop.visualizeState = async () => [
      { ...baseState, held: true, heldSince: 1_000, heldCalls: ['call-1'] },
    ];
    try {
      applyVisualizeEvent({
        sessionId: 'hc-1',
        state: baseState,
        held: true,
        heldSince: 1_000,
        heldCalls: ['call-1'],
      });
      assert.deepEqual([...(visualizeHeldCalls('hc-1') ?? [])], ['call-1']);

      // Same-ms back-to-back handoff with no opens in the next turn clears heldCalls immediately.
      applyVisualizeEvent({
        sessionId: 'hc-1',
        state: baseState,
        held: true,
        heldSince: 1_000,
        heldCalls: [],
      });
      assert.equal(visualizeHeldCalls('hc-1'), null, 'same-ms handoff with empty heldCalls clears prior calls');

      // Remote-style same-ms event omitting empty heldCalls also clears prior calls.
      applyVisualizeEvent({
        sessionId: 'hc-1',
        state: baseState,
        held: true,
        heldSince: 1_000,
        heldCalls: ['call-1'],
      });
      applyVisualizeEvent({
        sessionId: 'hc-1',
        state: baseState,
        held: true,
        heldSince: 1_000,
      });
      assert.equal(visualizeHeldCalls('hc-1'), null, 'same-ms held event without heldCalls clears prior calls');

      // Eviction + rehydration strips heldCalls from cached VisualizeSessionState so shareSession stays clean.
      applyVisualizeEvent({
        sessionId: 'hc-1',
        state: baseState,
        held: true,
        heldSince: 1_000,
        heldCalls: ['call-1'],
      });
      enforceRendererCacheBudget(0);
      assert.equal(visualizeStateFor('hc-1').tabs.length, 0, 'evicted while off screen');
      setVisualizePanelOnScreen('hc-1', true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const rehydrated = visualizeStateFor('hc-1');
      assert.equal(rehydrated.tabs.length, 1);
      assert.equal('heldCalls' in rehydrated, false, 'rehydrateEvicted strips heldCalls from cached state');
      assert.equal('held' in rehydrated, false);
      assert.equal('heldSince' in rehydrated, false);

      // releaseVisualizeSession deletes the session entry from heldCalls.
      releaseVisualizeSession('hc-1');
      assert.equal(visualizeHeldCalls('hc-1'), null, 'releaseVisualizeSession clears heldCalls for the session');

      // resetVisualizePanelMemory clears heldCalls across all sessions.
      applyVisualizeEvent({
        sessionId: 'hc-2',
        state: { ...baseState, sessionId: 'hc-2' },
        held: true,
        heldSince: 2_000,
        heldCalls: ['call-2'],
      });
      assert.deepEqual([...(visualizeHeldCalls('hc-2') ?? [])], ['call-2']);
      resetVisualizePanelMemory();
      assert.equal(visualizeHeldCalls('hc-2'), null, 'resetVisualizePanelMemory clears heldCalls');
    } finally {
      releaseVisualizeSession('hc-1');
      releaseVisualizeSession('hc-2');
    }
  }));

test('rehydrateEvicted preserves goneOpens while rehydrating, restores held metadata, and recovers after IPC failure', () =>
  onDesktop(async () => {
    resetVisualizePanelMemory();
    const makeTab = (id) => ({
      id,
      label: `${id}.html`,
      revision: 1,
      panes: [
        { kind: 'html', target: '', inline: { kind: 'html', source: `<p>${'x'.repeat(120_000)}</p>`, title: id } },
      ],
    });
    const baseState = {
      sessionId: 'reh-1',
      active: 'v1',
      tabs: [makeTab('v1')],
      goneOpens: [{ tab: 'v-old', call: 'o-old' }],
    };
    let mode = 'fail';
    let calls = 0;
    window.mixdogDesktop.visualizeState = async () => {
      calls += 1;
      if (mode === 'fail') throw new Error('ipc failed');
      return [{ ...baseState, held: true, heldSince: 4_200, heldCalls: ['call-a', 'call-b'] }];
    };
    try {
      applyVisualizeEvent({ sessionId: 'reh-1', state: baseState });
      enforceRendererCacheBudget(0);

      // Evicted placeholder preserves goneOpens and distinguishes rehydrating from EMPTY.
      assert.equal(isVisualizeStateRehydrating('reh-1'), true);
      assert.deepEqual(visualizeStateFor('reh-1').goneOpens, baseState.goneOpens);
      assert.equal(visualizeStateFor('reh-1').tabs.length, 0);

      // Failed IPC clears stuck rehydrating state instead of stranding the session.
      setVisualizePanelOnScreen('reh-1', true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(calls, 1);
      assert.equal(isVisualizeStateRehydrating('reh-1'), false, 'failed IPC unblocks rehydrating state');

      // Retrying once IPC recovers restores tabs AND held/heldSince/heldCalls metadata.
      mode = 'ok';
      setVisualizePanelOnScreen('reh-1', true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(calls, 2);
      assert.equal(isVisualizeStateRehydrating('reh-1'), false);
      assert.equal(visualizeStateFor('reh-1').tabs.length, 1);
      assert.equal(visualizeHeldSince('reh-1'), 4_200, 'rehydrateEvicted restores heldSince');
      assert.deepEqual(
        [...(visualizeHeldCalls('reh-1') ?? [])],
        ['call-a', 'call-b'],
        'rehydrateEvicted restores heldCalls'
      );
    } finally {
      releaseVisualizeSession('reh-1');
    }
  }));

test('bounded LRU retains recently active useVisualizeState sessions across transient hidden activity unmounts', async (t) => {
  const React = await import('react');
  const { act } = React;
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const { SurfaceActiveContext } = await import('./surface-activity.ts');
  const { dom, root } = installTestDom(t, { rootId: 'root' });
  dom.window.mixdogDesktop = {};
  resetVisualizePanelMemory();
  const makeState = (sessionId) => ({
    sessionId,
    active: 'v1',
    tabs: [
      {
        id: 'v1',
        label: `${sessionId}.html`,
        revision: 1,
        panes: [
          {
            kind: 'html',
            target: '',
            inline: { kind: 'html', source: `<p>${'z'.repeat(120_000)}</p>`, title: sessionId },
          },
        ],
      },
    ],
  });
  const ids = ['lru-1', 'lru-2', 'lru-3', 'lru-4', 'lru-5'];
  for (const id of ids) applyVisualizeEvent({ sessionId: id, state: makeState(id) });

  function Reader({ sessionId }) {
    useVisualizeState(sessionId);
    return null;
  }
  const visit = async (sessionId) => {
    await act(async () =>
      root.render(
        React.createElement(SurfaceActiveContext.Provider, { value: true }, React.createElement(Reader, { sessionId }))
      )
    );
    // Simulate <Activity mode="hidden"> flipping SurfaceActiveContext to false.
    await act(async () =>
      root.render(
        React.createElement(SurfaceActiveContext.Provider, { value: false }, React.createElement(Reader, { sessionId }))
      )
    );
  };

  try {
    // Visit lru-1 and hide it: stays retained in bounded LRU across budget trim.
    await visit('lru-1');
    enforceRendererCacheBudget(0);
    assert.equal(visualizeStateFor('lru-1').tabs.length, 1, 'recently hidden session stays retained in LRU');

    // Re-populate and visit 4 more sessions so lru-1 falls off the 4-session LRU cap.
    for (const id of ids.slice(1)) {
      applyVisualizeEvent({ sessionId: id, state: makeState(id) });
      await visit(id);
    }
    enforceRendererCacheBudget(0);
    assert.equal(visualizeStateFor('lru-1').tabs.length, 0, 'oldest session past LRU cap is evicted');
    assert.equal(visualizeStateFor('lru-5').tabs.length, 1, 'most recently hidden session stays retained');
  } finally {
    await act(async () => root.unmount());
    for (const id of ids) releaseVisualizeSession(id);
    resetVisualizePanelMemory();
  }
});

test('switching from an evicted session to another while visualizeState rejects still rehydrates the newly active session', () =>
  onDesktop(async () => {
    resetVisualizePanelMemory();
    const makeState = (sessionId) => ({
      sessionId,
      active: 'v1',
      tabs: [
        {
          id: 'v1',
          label: `${sessionId}.html`,
          revision: 1,
          panes: [
            {
              kind: 'html',
              target: '',
              inline: { kind: 'html', source: `<p>${'r'.repeat(120_000)}</p>`, title: sessionId },
            },
          ],
        },
      ],
    });
    const s1 = makeState('reh-sw-1');
    const s2 = makeState('reh-sw-2');
    let calls = 0;
    let rejectFirst;
    window.mixdogDesktop.visualizeState = () => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_, reject) => {
          rejectFirst = reject;
        });
      }
      return Promise.resolve([s1, s2]);
    };
    try {
      applyVisualizeEvent({ sessionId: s1.sessionId, state: s1 });
      applyVisualizeEvent({ sessionId: s2.sessionId, state: s2 });
      enforceRendererCacheBudget(0);
      assert.equal(isVisualizeStateRehydrating(s1.sessionId), true);
      assert.equal(isVisualizeStateRehydrating(s2.sessionId), true);

      // Start rehydration for S1, then switch to S2 while the IPC call is still pending.
      setVisualizePanelOnScreen(s1.sessionId, true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(calls, 1);
      setVisualizePanelOnScreen(s1.sessionId, false);
      setVisualizePanelOnScreen(s2.sessionId, true);

      // Rejecting S1's in-flight request must immediately rehydrate active S2.
      rejectFirst(new Error('transient ipc failure'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(calls, 2);
      assert.equal(isVisualizeStateRehydrating(s2.sessionId), false);
      assert.equal(visualizeStateFor(s2.sessionId).tabs.length, 1);
    } finally {
      releaseVisualizeSession(s1.sessionId);
      releaseVisualizeSession(s2.sessionId);
      resetVisualizePanelMemory();
    }
  }));

test('delivering an empty applyVisualizeEvent to an evicted session notifies subscribers and clears rehydrating state', () =>
  onDesktop(() => {
    resetVisualizePanelMemory();
    const state = {
      sessionId: 'evict-empty-1',
      active: 'v1',
      tabs: [
        {
          id: 'v1',
          label: 'evict.html',
          revision: 1,
          panes: [
            {
              kind: 'html',
              target: '',
              inline: { kind: 'html', source: `<p>${'e'.repeat(120_000)}</p>`, title: 'evict' },
            },
          ],
        },
      ],
      goneOpens: [{ tab: 'v-gone', call: 'c-gone' }],
    };
    let notifications = 0;
    const emptied = [];
    const stopSub = subscribe(() => {
      notifications += 1;
    });
    const stopEmptied = onVisualizeEmptied((sessionId) => emptied.push(sessionId));
    try {
      applyVisualizeEvent({ sessionId: state.sessionId, state });
      enforceRendererCacheBudget(0);
      assert.equal(isVisualizeStateRehydrating(state.sessionId), true);
      assert.deepEqual(visualizeStateFor(state.sessionId).goneOpens, state.goneOpens);

      notifications = 0;
      emptied.length = 0;
      applyVisualizeEvent({
        sessionId: state.sessionId,
        state: { sessionId: state.sessionId, active: null, tabs: [], history: [] },
      });
      assert.ok(notifications > 0, 'store subscribers must be notified when an evicted session becomes empty');
      assert.equal(isVisualizeStateRehydrating(state.sessionId), false);
      assert.equal(visualizeStateFor(state.sessionId).goneOpens, undefined);
      assert.deepEqual(emptied, [state.sessionId]);
    } finally {
      stopSub();
      stopEmptied();
      releaseVisualizeSession(state.sessionId);
      resetVisualizePanelMemory();
    }
  }));

test('unmounting deleted or empty useVisualizeState readers does not pollute the bounded recent-reader LRU', async (t) => {
  const React = await import('react');
  const { act } = React;
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const { SurfaceActiveContext } = await import('./surface-activity.ts');
  const { dom, root } = installTestDom(t, { rootId: 'root' });
  dom.window.mixdogDesktop = {};
  resetVisualizePanelMemory();
  const makeState = (sessionId) => ({
    sessionId,
    active: 'v1',
    tabs: [
      {
        id: 'v1',
        label: `${sessionId}.html`,
        revision: 1,
        panes: [
          {
            kind: 'html',
            target: '',
            inline: { kind: 'html', source: `<p>${'u'.repeat(120_000)}</p>`, title: sessionId },
          },
        ],
      },
    ],
  });
  const keepIds = ['lru-keep-1', 'lru-keep-2', 'lru-keep-3', 'lru-keep-4'];
  const deletedId = 'lru-deleted';
  function Reader({ sessionId }) {
    useVisualizeState(sessionId);
    return null;
  }
  const renderReader = async (sessionId, active = true) => {
    await act(async () =>
      root.render(
        sessionId
          ? React.createElement(
              SurfaceActiveContext.Provider,
              { value: active },
              React.createElement(Reader, { sessionId })
            )
          : null
      )
    );
  };

  try {
    // Fill 3 of the 4 LRU slots with live visualize sessions.
    for (const id of keepIds.slice(0, 3)) {
      applyVisualizeEvent({ sessionId: id, state: makeState(id) });
      await renderReader(id, true);
      await renderReader(id, false);
    }

    // Release a mounted visualize session before unmount: unmount must not re-insert it into the LRU.
    applyVisualizeEvent({ sessionId: deletedId, state: makeState(deletedId) });
    await renderReader(deletedId, true);
    await act(async () => {
      releaseVisualizeSession(deletedId);
    });
    await renderReader(null);

    // Visiting a 4th live session must fit without evicting lru-keep-1 (proving deletedId stayed out of the LRU).
    applyVisualizeEvent({ sessionId: keepIds[3], state: makeState(keepIds[3]) });
    await renderReader(keepIds[3], true);
    await renderReader(keepIds[3], false);

    // Mount and unmount readers for empty sessions (no visualize state): must not consume LRU slots.
    for (const emptyId of ['lru-empty-1', 'lru-empty-2']) {
      await renderReader(emptyId, true);
      await renderReader(null);
    }

    enforceRendererCacheBudget(0);
    for (const id of keepIds) {
      assert.equal(visualizeStateFor(id).tabs.length, 1, `${id} must stay pinned in the 4-slot LRU`);
    }
  } finally {
    await act(async () => root.unmount());
    for (const id of [...keepIds, deletedId]) releaseVisualizeSession(id);
    resetVisualizePanelMemory();
  }
});

test('exhausting rehydration retries keeps the evicted session recoverable on a later visit until the host confirms empty', (t) =>
  onDesktop(async () => {
    resetVisualizePanelMemory();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const flushMicrotasks = async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    };
    const state = {
      sessionId: 'reh-exhaust-1',
      active: 'v1',
      tabs: [
        {
          id: 'v1',
          label: 'exhaust.html',
          revision: 1,
          panes: [
            {
              kind: 'html',
              target: '',
              inline: { kind: 'html', source: `<p>${'x'.repeat(120_000)}</p>`, title: 'exhaust' },
            },
          ],
        },
      ],
    };
    let calls = 0;
    let hostSnapshot = [state];
    window.mixdogDesktop.visualizeState = () => {
      calls += 1;
      if (calls <= 3) return Promise.reject(new Error(`transient ipc failure ${calls}`));
      return Promise.resolve(hostSnapshot);
    };
    try {
      applyVisualizeEvent({ sessionId: state.sessionId, state });
      enforceRendererCacheBudget(0);
      assert.equal(isVisualizeStateRehydrating(state.sessionId), true);

      // Initial attempt + 2 automatic retries all fail.
      setVisualizePanelOnScreen(state.sessionId, true);
      await flushMicrotasks();
      assert.equal(calls, 1);
      assert.equal(isVisualizeStateRehydrating(state.sessionId), false);

      t.mock.timers.tick(1_500);
      await flushMicrotasks();
      assert.equal(calls, 2);

      t.mock.timers.tick(1_500);
      await flushMicrotasks();
      assert.equal(calls, 3);
      assert.equal(isVisualizeStateRehydrating(state.sessionId), false);

      // No further automatic retries after exhausting REHYDRATE_MAX_RETRIES.
      t.mock.timers.tick(5_000);
      await flushMicrotasks();
      assert.equal(calls, 3, 'automatic retries stop once exhausted');

      // Revisiting the session later retries rehydration and restores the tabs.
      setVisualizePanelOnScreen(state.sessionId, false);
      setVisualizePanelOnScreen(state.sessionId, true);
      await flushMicrotasks();
      assert.equal(calls, 4, 'revisiting after exhausted retries attempts rehydration again');
      assert.equal(visualizeStateFor(state.sessionId).tabs.length, 1);
      assert.equal(isVisualizeStateRehydrating(state.sessionId), false);

      // Evict again; once the host explicitly confirms empty state, the eviction entry is cleared.
      setVisualizePanelOnScreen(state.sessionId, false);
      enforceRendererCacheBudget(0);
      hostSnapshot = [];
      setVisualizePanelOnScreen(state.sessionId, true);
      await flushMicrotasks();
      assert.equal(calls, 5);
      assert.equal(visualizeStateFor(state.sessionId).tabs.length, 0);

      setVisualizePanelOnScreen(state.sessionId, false);
      setVisualizePanelOnScreen(state.sessionId, true);
      await flushMicrotasks();
      assert.equal(calls, 5, 'once host confirms empty, later visits do not re-trigger rehydration');
    } finally {
      releaseVisualizeSession(state.sessionId);
      resetVisualizePanelMemory();
    }
  }));

test('stale rehydration snapshot reconciles only targeted eviction entries and preserves newer sessions', () =>
  onDesktop(async () => {
    resetVisualizePanelMemory();
    const makeState = (sessionId, label = `${sessionId}.html`) => ({
      sessionId,
      active: 'v1',
      tabs: [
        {
          id: 'v1',
          label,
          revision: 1,
          panes: [
            {
              kind: 'html',
              target: '',
              inline: { kind: 'html', source: `<p>${'s'.repeat(120_000)}</p>`, title: label },
            },
          ],
        },
      ],
    });
    const stateA = makeState('reh-stale-a', 'a.html');
    const stateB = makeState('reh-stale-b', 'b.html');
    const stateA2 = makeState('reh-stale-a', 'a-v2.html');
    const resolvers = [];
    window.mixdogDesktop.visualizeState = () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      });
    const emptied = [];
    const stopEmptied = onVisualizeEmptied((sessionId) => emptied.push(sessionId));
    try {
      // B is created, evicted, and visited while A's read is in flight.
      applyVisualizeEvent({ sessionId: stateA.sessionId, state: stateA });
      enforceRendererCacheBudget(0);
      setVisualizePanelOnScreen(stateA.sessionId, true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(resolvers.length, 1);

      applyVisualizeEvent({ sessionId: stateB.sessionId, state: stateB });
      enforceRendererCacheBudget(0);
      setVisualizePanelOnScreen(stateB.sessionId, true);
      assert.equal(isVisualizeStateRehydrating(stateB.sessionId), true);

      // Stale reply for A omits B: B must stay evicted and immediately trigger a fresh read.
      resolvers.shift()([stateA]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(visualizeStateFor(stateA.sessionId).tabs.length, 1);
      assert.equal(isVisualizeStateRehydrating(stateB.sessionId), true);
      assert.equal(resolvers.length, 1, 'newer session B triggers its own read instead of being erased');
      assert.deepEqual(emptied, []);

      resolvers.shift()([stateA, stateB]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(visualizeStateFor(stateB.sessionId).tabs.length, 1);
      assert.equal(isVisualizeStateRehydrating(stateB.sessionId), false);

      // A itself gets a newer event and re-eviction while its older read is in flight.
      setVisualizePanelOnScreen(stateA.sessionId, false);
      setVisualizePanelOnScreen(stateB.sessionId, false);
      enforceRendererCacheBudget(0);
      setVisualizePanelOnScreen(stateA.sessionId, true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(resolvers.length, 1);

      // While old read is in flight, A receives v2, leaves screen, gets evicted again, and is visited again.
      applyVisualizeEvent({ sessionId: stateA.sessionId, state: stateA2 });
      setVisualizePanelOnScreen(stateA.sessionId, false);
      enforceRendererCacheBudget(0);
      setVisualizePanelOnScreen(stateA.sessionId, true);

      // Resolving the stale read as empty must NOT erase A's newer eviction entry or notify emptied.
      resolvers.shift()([]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(emptied, []);
      assert.equal(isVisualizeStateRehydrating(stateA.sessionId), true);
      assert.equal(resolvers.length, 1, 'newer eviction generation for A schedules a fresh read');

      resolvers.shift()([stateA2]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(visualizeStateFor(stateA.sessionId).tabs[0]?.label, 'a-v2.html');
    } finally {
      stopEmptied();
      releaseVisualizeSession(stateA.sessionId);
      releaseVisualizeSession(stateB.sessionId);
      resetVisualizePanelMemory();
    }
  }));

test('host-confirmed empty state notifies subscribers, availability, and emptied listeners on reconnect and rehydration', async (t) => {
  const React = await import('react');
  const { act } = React;
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const { dom, root } = installTestDom(t, { rootId: 'root' });
  dom.window.mixdogDesktop = {
    visualizeState: async () => [],
  };
  resetVisualizePanelMemory();
  resetVisualizeTweakStore();
  resetVisualizeChoiceProposals();
  const makeState = (sessionId) => ({
    sessionId,
    active: 'v1',
    tabs: [
      {
        id: 'v1',
        label: `${sessionId}.html`,
        revision: 1,
        panes: [
          {
            kind: 'html',
            target: '',
            inline: { kind: 'html', source: `<p>${'c'.repeat(120_000)}</p>`, title: sessionId },
          },
        ],
      },
    ],
  });
  let available = null;
  function AvailabilityProbe() {
    available = useVisualizeAvailable();
    return null;
  }
  let notifications = 0;
  const emptied = [];
  const stopSub = subscribe(() => {
    notifications += 1;
  });
  const stopEmptied = onVisualizeEmptied((sessionId) => emptied.push(sessionId));
  try {
    await act(async () => root.render(React.createElement(AvailabilityProbe)));
    assert.equal(available, false);

    // Reconnect clears evicted session when resident states and holds are unchanged.
    const tweakJson = JSON.stringify([
      { id: 'accent', label: 'Accent', type: 'color', var: '--accent', default: '#3366ff' },
    ]);
    const s1 = makeState('empty-resync-1');
    await act(async () => {
      applyVisualizeEvent({ sessionId: s1.sessionId, state: s1 });
      setVisualizeTweakDefs(s1.sessionId, 'v1', 0, tweakJson);
      proposeVisualizeChoice(visualizeProposalKey(s1.sessionId, 'v1', 0), { kind: 'choice', id: 'p1', label: 'Pick' });
      enforceRendererCacheBudget(0);
    });
    assert.equal(available, true);
    assert.equal(isVisualizeStateRehydrating(s1.sessionId), true);
    assert.equal(visualizePaneTweaks(s1.sessionId, 'v1', 0).length, 1, 'tweaks populated before reconnect cleanup');
    assert.ok(
      visualizeChoiceProposal(visualizeProposalKey(s1.sessionId, 'v1', 0)),
      'proposal populated before cleanup'
    );

    notifications = 0;
    emptied.length = 0;
    await act(async () => {
      resyncVisualizeStates([]);
    });
    assert.ok(notifications > 0, 'reconnect clearing evicted sessions must notify subscribers');
    assert.equal(available, false, 'useVisualizeAvailable must update to false');
    assert.equal(isVisualizeStateRehydrating(s1.sessionId), false);
    assert.deepEqual(emptied, [s1.sessionId], 'reconnect clearing evicted tabs must emit emptied notification');
    assert.deepEqual(visualizePaneTweaks(s1.sessionId, 'v1', 0), []);
    assert.equal(visualizeChoiceProposal(visualizeProposalKey(s1.sessionId, 'v1', 0)), null);

    // Rehydration of an absent evicted session notifies emptied and clears tweaks/proposals.
    const s2 = makeState('empty-rehydrate-1');
    await act(async () => {
      applyVisualizeEvent({ sessionId: s2.sessionId, state: s2 });
      setVisualizeTweakDefs(s2.sessionId, 'v1', 0, tweakJson);
      proposeVisualizeChoice(visualizeProposalKey(s2.sessionId, 'v1', 0), { kind: 'choice', id: 'p2', label: 'Pick' });
      enforceRendererCacheBudget(0);
    });
    assert.equal(available, true);
    assert.equal(visualizePaneTweaks(s2.sessionId, 'v1', 0).length, 1, 'tweaks populated before rehydration cleanup');
    assert.ok(
      visualizeChoiceProposal(visualizeProposalKey(s2.sessionId, 'v1', 0)),
      'proposal populated before cleanup'
    );

    notifications = 0;
    emptied.length = 0;
    await act(async () => {
      setVisualizePanelOnScreen(s2.sessionId, true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(notifications > 0, 'rehydration confirming absent session must notify subscribers');
    assert.equal(available, false, 'useVisualizeAvailable must clear after absent rehydration');
    assert.equal(isVisualizeStateRehydrating(s2.sessionId), false);
    assert.deepEqual(emptied, [s2.sessionId], 'absent rehydration must emit emptied notification for shell cleanup');
    assert.deepEqual(visualizePaneTweaks(s2.sessionId, 'v1', 0), []);
    assert.equal(visualizeChoiceProposal(visualizeProposalKey(s2.sessionId, 'v1', 0)), null);
  } finally {
    stopSub();
    stopEmptied();
    await act(async () => root.unmount());
    releaseVisualizeSession('empty-resync-1');
    releaseVisualizeSession('empty-rehydrate-1');
    resetVisualizeTweakStore();
    resetVisualizeChoiceProposals();
    resetVisualizePanelMemory();
  }
});

test('reconnect budget trimming does not suppress a missed-tab reveal', () =>
  onDesktop(async () => {
    resetVisualizePanelMemory();
    const reveals = [];
    const stopReveal = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
    // Hold 24M pinned chars in another cache so any unpinned visualize state past the 6M reserve triggers trimming.
    const unregisterPressure = registerBudgetedCache({
      name: 'test-resync-pressure',
      chars: () => 24 * 1024 * 1024,
      pinned: () => 24 * 1024 * 1024,
      trim: () => {},
    });
    const heavyPayload = 'm'.repeat(7 * 1024 * 1024);
    const sessionId = 'resync-budget-reveal';
    const v1 = {
      ...versioned('v1', 1),
      panes: [{ kind: 'html', target: '', inline: { kind: 'html', source: heavyPayload, title: 'v1' } }],
    };
    const v2 = {
      ...versioned('v2', 1),
      panes: [{ kind: 'html', target: '', inline: { kind: 'html', source: heavyPayload, title: 'v2' } }],
    };
    try {
      applyVisualizeEvent({ sessionId, state: { sessionId, tabs: [v1], active: 'v1' } });
      enforceRendererCacheBudget();
      assert.equal(isVisualizeStateRehydrating(sessionId), true, 'off-screen heavy session is evicted under pressure');

      reveals.length = 0;
      resyncVisualizeStates([{ sessionId, tabs: [v1, v2], active: 'v2' }]);
      assert.deepEqual(reveals, [], 'reveal still waits a turn for the shell');
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(reveals, [sessionId], 'missed-tab reveal must fire even under cache budget pressure');
      assert.equal(isVisualizeStateRehydrating(sessionId), true, 'unpinned session trims back to budget after replay');
    } finally {
      unregisterPressure();
      stopReveal();
      releaseVisualizeSession(sessionId);
      resetVisualizePanelMemory();
    }
  }));

test('startup hydration skips already-evicted sessions instead of overwriting them with stale startup state', async () => {
  const restore = withLocalStorage();
  const reveals = [];
  const stopReveal = onVisualizeRevealRequested((sessionId) => reveals.push(sessionId));
  const evictedId = 'hyd-evict-1';
  const freshId = 'hyd-fresh-1';
  const newerGoneOpens = [{ tab: 'v-new', call: 'c-new' }];
  const newerState = {
    sessionId: evictedId,
    active: 'v2',
    tabs: [
      {
        id: 'v2',
        label: 'newer.html',
        revision: 2,
        panes: [
          {
            kind: 'html',
            target: '',
            inline: { kind: 'html', source: `<p>${'h'.repeat(120_000)}</p>`, title: 'newer' },
          },
        ],
      },
    ],
    goneOpens: newerGoneOpens,
  };
  const staleStartupState = {
    sessionId: evictedId,
    active: 'v1',
    tabs: [{ id: 'v1', label: 'stale.html', revision: 1, panes: [] }],
    held: true,
    heldSince: 123,
  };
  const freshStartupState = {
    sessionId: freshId,
    active: 'v1',
    tabs: [{ id: 'v1', label: 'fresh.html', revision: 1, panes: [] }],
  };
  try {
    markVisualizePanelShown(evictedId);
    applyVisualizeEvent({ sessionId: evictedId, state: newerState });
    enforceRendererCacheBudget(0);
    assert.equal(isVisualizeStateRehydrating(evictedId), true);
    assert.deepEqual(visualizeStateFor(evictedId).goneOpens, newerGoneOpens);

    hydrateVisualizeStates([staleStartupState, freshStartupState]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(isVisualizeStateRehydrating(evictedId), true, 'evicted session remains evicted, not overwritten');
    assert.equal(visualizeStateFor(evictedId).tabs.length, 0, 'stale startup tabs do not overwrite evicted entry');
    assert.deepEqual(visualizeStateFor(evictedId).goneOpens, newerGoneOpens, 'newer placeholder goneOpens preserved');
    assert.equal(visualizeHeldSince(evictedId), null, 'stale startup held state does not overwrite evicted session');
    assert.deepEqual(reveals, [], 'stale startup snapshot does not queue reveal for already-evicted session');
    assert.equal(visualizeStateFor(freshId).tabs.length, 1, 'unseen session in startup snapshot hydrates normally');
  } finally {
    stopReveal();
    releaseVisualizeSession(evictedId);
    releaseVisualizeSession(freshId);
    restore();
  }
});

test('rehydration reply with zero tabs and retained history cleans up evicted state even after the user navigates away', () =>
  onDesktop(async () => {
    resetVisualizePanelMemory();
    resetVisualizeTweakStore();
    resetVisualizeChoiceProposals();
    const sessionId = 'reh-zero-tabs-history';
    const tweakJson = JSON.stringify([
      { id: 'accent', label: 'Accent', type: 'color', var: '--accent', default: '#22aa88' },
    ]);
    const initialState = {
      sessionId,
      active: 'v1',
      tabs: [
        {
          id: 'v1',
          label: 'old.html',
          revision: 1,
          panes: [
            {
              kind: 'html',
              target: '',
              inline: { kind: 'html', source: `<p>${'z'.repeat(120_000)}</p>`, title: 'old' },
            },
          ],
        },
      ],
    };
    const history = [{ id: 'h1', label: 'old.html', kind: 'html', versions: 1, at: 10, open: false }];
    let resolveRead;
    window.mixdogDesktop.visualizeState = () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      });
    const emptied = [];
    const stopEmptied = onVisualizeEmptied((id) => emptied.push(id));
    try {
      applyVisualizeEvent({ sessionId, state: initialState });
      setVisualizeTweakDefs(sessionId, 'v1', 0, tweakJson);
      proposeVisualizeChoice(visualizeProposalKey(sessionId, 'v1', 0), { kind: 'choice', id: 'p1', label: 'Pick' });
      assert.equal(visualizePaneTweaks(sessionId, 'v1', 0).length, 1);
      assert.ok(visualizeChoiceProposal(visualizeProposalKey(sessionId, 'v1', 0)));

      enforceRendererCacheBudget(0);
      assert.equal(isVisualizeStateRehydrating(sessionId), true);

      // Start rehydration, then navigate away before the host replies.
      setVisualizePanelOnScreen(sessionId, true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      setVisualizePanelOnScreen(sessionId, false);

      resolveRead([{ sessionId, active: null, tabs: [], history }]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(isVisualizeStateRehydrating(sessionId), false, 'rehydrating clears even while inactive');
      assert.deepEqual(emptied, [sessionId], 'emptied notification fires for zero-tab + history reply');
      assert.deepEqual(visualizePaneTweaks(sessionId, 'v1', 0), [], 'tweaks released');
      assert.equal(visualizeChoiceProposal(visualizeProposalKey(sessionId, 'v1', 0)), null, 'proposals released');
      assert.deepEqual(visualizeStateFor(sessionId).tabs, []);
      assert.deepEqual(visualizeStateFor(sessionId).history, history, 'retained history is preserved');
    } finally {
      stopEmptied();
      releaseVisualizeSession(sessionId);
      resetVisualizeTweakStore();
      resetVisualizeChoiceProposals();
      resetVisualizePanelMemory();
    }
  }));

test('leaving a transcript reader after a transient failure preserves remaining retry budget for return', async (t) => {
  const React = await import('react');
  const { act } = React;
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const { SurfaceActiveContext } = await import('./surface-activity.ts');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flushMicrotasks = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  const { dom, root } = installTestDom(t, { rootId: 'root' });
  resetVisualizePanelMemory();
  const makeState = (sessionId) => ({
    sessionId,
    active: 'v1',
    tabs: [
      {
        id: 'v1',
        label: `${sessionId}.html`,
        revision: 1,
        panes: [
          {
            kind: 'html',
            target: '',
            inline: { kind: 'html', source: `<p>${'t'.repeat(120_000)}</p>`, title: sessionId },
          },
        ],
      },
    ],
  });
  const s1 = makeState('reh-leave-after-fail');
  const s2 = makeState('reh-leave-inflight');
  let calls = 0;
  let shouldFail = true;
  let rejectInFlight;
  let mode = 'immediate';
  dom.window.mixdogDesktop = {
    visualizeState: () => {
      calls += 1;
      if (mode === 'deferred') {
        return new Promise((_, reject) => {
          rejectInFlight = reject;
        });
      }
      if (shouldFail) return Promise.reject(new Error(`transient failure ${calls}`));
      return Promise.resolve([s1, s2]);
    },
  };
  function Reader({ sessionId }) {
    useVisualizeState(sessionId);
    return null;
  }
  const renderReader = async (sessionId, active) => {
    await act(async () => {
      root.render(
        sessionId
          ? React.createElement(
              SurfaceActiveContext.Provider,
              { value: active },
              React.createElement(Reader, { sessionId })
            )
          : null
      );
      await flushMicrotasks();
    });
  };
  try {
    // Case A: reader leaves after failure, before retry timer fires.
    applyVisualizeEvent({ sessionId: s1.sessionId, state: s1 });
    enforceRendererCacheBudget(0);
    await renderReader(s1.sessionId, true);
    assert.equal(calls, 1);

    await renderReader(s1.sessionId, false);
    await act(async () => {
      t.mock.timers.tick(1_500);
      await flushMicrotasks();
    });
    assert.equal(calls, 1, 'inactive reader does not issue IPC when retry timer fires');

    shouldFail = false;
    await renderReader(s1.sessionId, true);
    assert.equal(calls, 2, 'returning to transcript resumes remaining retry budget immediately');
    assert.equal(visualizeStateFor(s1.sessionId).tabs.length, 1);
    assert.equal(isVisualizeStateRehydrating(s1.sessionId), false);

    // Case B: reader leaves while attempt 1 is still in flight, before it rejects.
    await renderReader(null, false);
    applyVisualizeEvent({ sessionId: s2.sessionId, state: s2 });
    enforceRendererCacheBudget(0);
    mode = 'deferred';
    await renderReader(s2.sessionId, true);
    assert.equal(calls, 3);

    await renderReader(s2.sessionId, false);
    await act(async () => {
      rejectInFlight(new Error('in-flight transient failure'));
      await flushMicrotasks();
      t.mock.timers.tick(1_500);
      await flushMicrotasks();
    });
    assert.equal(calls, 3, 'inactive reader still does not issue IPC on timer');

    mode = 'immediate';
    shouldFail = false;
    await renderReader(s2.sessionId, true);
    assert.equal(calls, 4, 'returning after in-flight failure resumes remaining retry budget');
    assert.equal(visualizeStateFor(s2.sessionId).tabs.length, 1);
  } finally {
    await act(async () => root.unmount());
    releaseVisualizeSession(s1.sessionId);
    releaseVisualizeSession(s2.sessionId);
    resetVisualizePanelMemory();
  }
});

test('genuine panel visit during the last automatic retry resets the retry budget', async (t) => {
  const React = await import('react');
  const { act } = React;
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const { SurfaceActiveContext } = await import('./surface-activity.ts');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flushMicrotasks = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  const { dom, root } = installTestDom(t, { rootId: 'root' });
  resetVisualizePanelMemory();
  const sessionId = 'reh-visit-during-last-retry';
  const state = {
    sessionId,
    active: 'v1',
    tabs: [
      {
        id: 'v1',
        label: 'panel.html',
        revision: 1,
        panes: [
          {
            kind: 'html',
            target: '',
            inline: { kind: 'html', source: `<p>${'p'.repeat(120_000)}</p>`, title: 'panel' },
          },
        ],
      },
    ],
  };
  let calls = 0;
  let rejectThird;
  dom.window.mixdogDesktop = {
    visualizeState: () => {
      calls += 1;
      if (calls <= 2) return Promise.reject(new Error(`ipc failure ${calls}`));
      if (calls === 3) {
        return new Promise((_, reject) => {
          rejectThird = reject;
        });
      }
      return Promise.resolve([state]);
    },
  };
  function Reader() {
    useVisualizeState(sessionId);
    return null;
  }
  try {
    applyVisualizeEvent({ sessionId, state });
    enforceRendererCacheBudget(0);

    // Attempt 1 and attempt 2 fail; tick triggers attempt 3 (the last automatic retry, retries === 2, failed === false).
    await act(async () => {
      root.render(React.createElement(SurfaceActiveContext.Provider, { value: true }, React.createElement(Reader)));
      await flushMicrotasks();
    });
    assert.equal(calls, 1);

    await act(async () => {
      t.mock.timers.tick(1_500);
      await flushMicrotasks();
    });
    assert.equal(calls, 2);

    await act(async () => {
      t.mock.timers.tick(1_500);
      await flushMicrotasks();
    });
    assert.equal(calls, 3, 'last automatic retry is now in flight');
    assert.equal(isVisualizeStateRehydrating(sessionId), true);

    // User genuinely opens the panel while attempt 3 is in flight, then attempt 3 fails.
    await act(async () => {
      setVisualizePanelOnScreen(sessionId, true);
      rejectThird(new Error('last automatic retry failed'));
      await flushMicrotasks();
    });

    // Fresh budget from the panel visit schedules attempt 4 and recovers the session.
    await act(async () => {
      t.mock.timers.tick(1_500);
      await flushMicrotasks();
    });
    assert.equal(calls, 4, 'panel visit during last automatic retry grants a fresh retry attempt');
    assert.equal(visualizeStateFor(sessionId).tabs.length, 1);
    assert.equal(isVisualizeStateRehydrating(sessionId), false);
  } finally {
    await act(async () => root.unmount());
    releaseVisualizeSession(sessionId);
    resetVisualizePanelMemory();
  }
});

test('reconnect resync prunes absent resident sessions from the recent-reader LRU', async (t) => {
  const React = await import('react');
  const { act } = React;
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const { SurfaceActiveContext } = await import('./surface-activity.ts');
  const { dom, root } = installTestDom(t, { rootId: 'root' });
  dom.window.mixdogDesktop = {};
  resetVisualizePanelMemory();
  const makeState = (sessionId) => ({
    sessionId,
    active: 'v1',
    tabs: [
      {
        id: 'v1',
        label: `${sessionId}.html`,
        revision: 1,
        panes: [
          {
            kind: 'html',
            target: '',
            inline: { kind: 'html', source: `<p>${'l'.repeat(120_000)}</p>`, title: sessionId },
          },
        ],
      },
    ],
  });
  const kept = ['resync-lru-1', 'resync-lru-2', 'resync-lru-3'];
  const gone = 'resync-lru-gone';
  const fourth = 'resync-lru-4';
  function Reader({ sessionId }) {
    useVisualizeState(sessionId);
    return null;
  }
  const visitAndHide = async (sessionId) => {
    await act(async () =>
      root.render(
        React.createElement(SurfaceActiveContext.Provider, { value: true }, React.createElement(Reader, { sessionId }))
      )
    );
    await act(async () =>
      root.render(
        React.createElement(SurfaceActiveContext.Provider, { value: false }, React.createElement(Reader, { sessionId }))
      )
    );
  };
  try {
    // Fill all 4 LRU slots with 3 kept sessions and 1 resident session that will disappear on reconnect.
    for (const id of [...kept, gone]) {
      applyVisualizeEvent({ sessionId: id, state: makeState(id) });
      await visitAndHide(id);
    }

    // Reconnect snapshot omits `gone`: its slot in the 4-entry recent-reader LRU must be pruned.
    await act(async () => {
      resyncVisualizeStates(kept.map((id) => makeState(id)));
    });

    // Visiting a 4th live session must fit in the 4-slot LRU without evicting `resync-lru-1`.
    await act(async () => {
      applyVisualizeEvent({ sessionId: fourth, state: makeState(fourth) });
    });
    await visitAndHide(fourth);

    await act(async () => {
      enforceRendererCacheBudget(0);
    });
    for (const id of [...kept, fourth]) {
      assert.equal(
        visualizeStateFor(id).tabs.length,
        1,
        `${id} stays pinned because absent resident session was pruned`
      );
    }
  } finally {
    await act(async () => root.unmount());
    for (const id of [...kept, gone, fourth]) releaseVisualizeSession(id);
    resetVisualizePanelMemory();
  }
});

test('shrinking a 2-pane compare tab while evicted prunes pane-1 tweaks and proposals on both rehydration and reconnect', () =>
  onDesktop(async () => {
    resetVisualizePanelMemory();
    resetVisualizeTweakStore();
    resetVisualizeChoiceProposals();
    const tweakJson = JSON.stringify([
      { id: 'accent', label: 'Accent', type: 'color', var: '--accent', default: '#3366ff' },
    ]);
    const pane = (label) => ({
      kind: 'html',
      target: '',
      inline: { kind: 'html', source: `<p>${'p'.repeat(120_000)}</p>`, title: label },
    });
    const makeCompareState = (sessionId, paneCount) => ({
      sessionId,
      active: 'v1',
      tabs: [
        {
          id: 'v1',
          label: 'compare.html',
          revision: paneCount === 2 ? 1 : 2,
          compare: paneCount === 2,
          panes: paneCount === 2 ? [pane('old'), pane('live')] : [pane('live')],
        },
      ],
    });
    const rehydrateId = 'prune-compare-rehydrate';
    const resyncId = 'prune-compare-resync';
    const seedAndEvict = (sessionId) => {
      applyVisualizeEvent({ sessionId, state: makeCompareState(sessionId, 2) });
      setVisualizeTweakDefs(sessionId, 'v1', 0, tweakJson);
      setVisualizeTweakDefs(sessionId, 'v1', 1, tweakJson);
      proposeVisualizeChoice(
        visualizeProposalKey(sessionId, 'v1', 0),
        { sessionId, choice: { kind: 'choice', id: 'p0', label: 'Pane 0' }, reset() {} },
        1_000
      );
      proposeVisualizeChoice(
        visualizeProposalKey(sessionId, 'v1', 1),
        { sessionId, choice: { kind: 'choice', id: 'p1', label: 'Pane 1' }, reset() {} },
        1_000
      );
      assert.equal(visualizePaneTweaks(sessionId, 'v1', 0).length, 1);
      assert.equal(visualizePaneTweaks(sessionId, 'v1', 1).length, 1);
      assert.ok(visualizeChoiceProposal(visualizeProposalKey(sessionId, 'v1', 0)));
      assert.ok(visualizeChoiceProposal(visualizeProposalKey(sessionId, 'v1', 1)));
      enforceRendererCacheBudget(0);
      assert.equal(isVisualizeStateRehydrating(sessionId), true);
    };
    window.mixdogDesktop.visualizeState = async () => [makeCompareState(rehydrateId, 1)];
    try {
      // Case A: shrunk while evicted, then rehydrated on panel visit.
      seedAndEvict(rehydrateId);
      setVisualizePanelOnScreen(rehydrateId, true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(visualizeStateFor(rehydrateId).tabs[0]?.panes.length, 1);
      assert.equal(visualizePaneTweaks(rehydrateId, 'v1', 0).length, 1, 'pane 0 tweaks survive rehydration');
      assert.deepEqual(visualizePaneTweaks(rehydrateId, 'v1', 1), [], 'pane 1 tweaks pruned on rehydration');
      assert.ok(
        visualizeChoiceProposal(visualizeProposalKey(rehydrateId, 'v1', 0)),
        'pane 0 proposal survives rehydration'
      );
      assert.equal(
        visualizeChoiceProposal(visualizeProposalKey(rehydrateId, 'v1', 1)),
        null,
        'pane 1 proposal pruned on rehydration'
      );

      // Case B: shrunk while evicted, then reconciled via reconnect resync.
      setVisualizePanelOnScreen(rehydrateId, false);
      seedAndEvict(resyncId);
      resyncVisualizeStates([makeCompareState(resyncId, 1)]);
      assert.equal(visualizeStateFor(resyncId).tabs[0]?.panes.length, 1);
      assert.equal(visualizePaneTweaks(resyncId, 'v1', 0).length, 1, 'pane 0 tweaks survive reconnect');
      assert.deepEqual(visualizePaneTweaks(resyncId, 'v1', 1), [], 'pane 1 tweaks pruned on reconnect');
      assert.ok(visualizeChoiceProposal(visualizeProposalKey(resyncId, 'v1', 0)), 'pane 0 proposal survives reconnect');
      assert.equal(
        visualizeChoiceProposal(visualizeProposalKey(resyncId, 'v1', 1)),
        null,
        'pane 1 proposal pruned on reconnect'
      );
    } finally {
      releaseVisualizeSession(rehydrateId);
      releaseVisualizeSession(resyncId);
      resetVisualizeTweakStore();
      resetVisualizeChoiceProposals();
      resetVisualizePanelMemory();
    }
  }));

test('removing a tab while evicted prunes its tweaks and proposals on a live update when another tab survives', () =>
  onDesktop(() => {
    resetVisualizePanelMemory();
    resetVisualizeTweakStore();
    resetVisualizeChoiceProposals();
    const sessionId = 'prune-live-after-evict';
    const tweakJson = JSON.stringify([
      { id: 'accent', label: 'Accent', type: 'color', var: '--accent', default: '#ff6600' },
    ]);
    const makeTab = (id) => ({
      id,
      label: `${id}.html`,
      revision: 1,
      panes: [
        {
          kind: 'html',
          target: '',
          inline: { kind: 'html', source: `<p>${'l'.repeat(120_000)}</p>`, title: id },
        },
      ],
    });
    const tabKeep = makeTab('v-keep');
    const tabDrop = makeTab('v-drop');
    try {
      applyVisualizeEvent({
        sessionId,
        state: { sessionId, active: 'v-keep', tabs: [tabKeep, tabDrop] },
      });
      setVisualizeTweakDefs(sessionId, 'v-keep', 0, tweakJson);
      setVisualizeTweakDefs(sessionId, 'v-drop', 0, tweakJson);
      proposeVisualizeChoice(
        visualizeProposalKey(sessionId, 'v-keep', 0),
        { sessionId, choice: { kind: 'choice', id: 'keep', label: 'Keep' }, reset() {} },
        1_000
      );
      proposeVisualizeChoice(
        visualizeProposalKey(sessionId, 'v-drop', 0),
        { sessionId, choice: { kind: 'choice', id: 'drop', label: 'Drop' }, reset() {} },
        1_000
      );
      assert.equal(visualizePaneTweaks(sessionId, 'v-keep', 0).length, 1);
      assert.equal(visualizePaneTweaks(sessionId, 'v-drop', 0).length, 1);
      assert.ok(visualizeChoiceProposal(visualizeProposalKey(sessionId, 'v-keep', 0)));
      assert.ok(visualizeChoiceProposal(visualizeProposalKey(sessionId, 'v-drop', 0)));

      enforceRendererCacheBudget(0);
      assert.equal(isVisualizeStateRehydrating(sessionId), true);

      // Live update lands after eviction with only `v-keep` surviving.
      applyVisualizeEvent({
        sessionId,
        state: { sessionId, active: 'v-keep', tabs: [tabKeep] },
      });
      assert.equal(isVisualizeStateRehydrating(sessionId), false);
      assert.equal(visualizePaneTweaks(sessionId, 'v-keep', 0).length, 1, 'surviving tab tweaks remain');
      assert.deepEqual(visualizePaneTweaks(sessionId, 'v-drop', 0), [], 'removed tab tweaks pruned after eviction');
      assert.ok(visualizeChoiceProposal(visualizeProposalKey(sessionId, 'v-keep', 0)), 'surviving tab proposal stays');
      assert.equal(
        visualizeChoiceProposal(visualizeProposalKey(sessionId, 'v-drop', 0)),
        null,
        'removed tab proposal pruned after eviction'
      );
    } finally {
      releaseVisualizeSession(sessionId);
      resetVisualizeTweakStore();
      resetVisualizeChoiceProposals();
      resetVisualizePanelMemory();
    }
  }));

test('switching away during rehydration still prunes stale pane tweaks and proposals while keeping session evicted', () =>
  onDesktop(async () => {
    resetVisualizePanelMemory();
    resetVisualizeTweakStore();
    resetVisualizeChoiceProposals();
    const sessionId = 'prune-inactive-rehydrate';
    const tweakJson = JSON.stringify([
      { id: 'accent', label: 'Accent', type: 'color', var: '--accent', default: '#3366ff' },
    ]);
    const pane = (label) => ({
      kind: 'html',
      target: '',
      inline: { kind: 'html', source: `<p>${'i'.repeat(120_000)}</p>`, title: label },
    });
    const makeCompareState = (paneCount) => ({
      sessionId,
      active: 'v1',
      tabs: [
        {
          id: 'v1',
          label: 'compare.html',
          revision: paneCount === 2 ? 1 : 2,
          compare: paneCount === 2,
          panes: paneCount === 2 ? [pane('old'), pane('live')] : [pane('live')],
        },
      ],
    });
    let resolveRead;
    window.mixdogDesktop.visualizeState = () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      });
    try {
      applyVisualizeEvent({ sessionId, state: makeCompareState(2) });
      setVisualizeTweakDefs(sessionId, 'v1', 0, tweakJson);
      setVisualizeTweakDefs(sessionId, 'v1', 1, tweakJson);
      proposeVisualizeChoice(
        visualizeProposalKey(sessionId, 'v1', 0),
        { sessionId, choice: { kind: 'choice', id: 'p0', label: 'Pane 0' }, reset() {} },
        1_000
      );
      proposeVisualizeChoice(
        visualizeProposalKey(sessionId, 'v1', 1),
        { sessionId, choice: { kind: 'choice', id: 'p1', label: 'Pane 1' }, reset() {} },
        1_000
      );
      assert.equal(visualizePaneTweaks(sessionId, 'v1', 0).length, 1);
      assert.equal(visualizePaneTweaks(sessionId, 'v1', 1).length, 1);
      assert.ok(visualizeChoiceProposal(visualizeProposalKey(sessionId, 'v1', 0)));
      assert.ok(visualizeChoiceProposal(visualizeProposalKey(sessionId, 'v1', 1)));

      enforceRendererCacheBudget(0);
      assert.equal(isVisualizeStateRehydrating(sessionId), true);

      // Start rehydration, then switch away before the host replies with the shrunk 1-pane tab.
      setVisualizePanelOnScreen(sessionId, true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      setVisualizePanelOnScreen(sessionId, false);

      resolveRead([makeCompareState(1)]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(isVisualizeStateRehydrating(sessionId), true, 'off-screen session stays evicted');
      assert.equal(visualizeStateFor(sessionId).tabs.length, 0, 'off-screen session does not become resident');
      assert.equal(visualizePaneTweaks(sessionId, 'v1', 0).length, 1, 'pane 0 tweaks survive');
      assert.deepEqual(visualizePaneTweaks(sessionId, 'v1', 1), [], 'pane 1 tweaks pruned despite switching away');
      assert.ok(visualizeChoiceProposal(visualizeProposalKey(sessionId, 'v1', 0)), 'pane 0 proposal survives');
      assert.equal(
        visualizeChoiceProposal(visualizeProposalKey(sessionId, 'v1', 1)),
        null,
        'pane 1 proposal pruned despite switching away'
      );
    } finally {
      releaseVisualizeSession(sessionId);
      resetVisualizeTweakStore();
      resetVisualizeChoiceProposals();
      resetVisualizePanelMemory();
    }
  }));

test('phone: post-eviction live updates, reconnect, and rehydration preserve local active tab selection', async (t) => {
  const heavyTab = (id, version) => ({
    ...versioned(id, version),
    panes: [
      {
        kind: 'html',
        target: '',
        inline: { kind: 'html', source: `<p>${'m'.repeat(120_000)}</p>`, title: id },
      },
    ],
  });

  // Cases A & B: live update (plain + reveal) and reconnect resync after eviction.
  await asPhone(async ({ sent, reveals }) => {
    const liveId = 'ph-evict-live';
    const resyncId = 'ph-evict-resync';
    try {
      // Case A1: plain live update after eviction keeps v1 active and marks v2 updated.
      open(liveId, [heavyTab('v1', 1), heavyTab('v2', 1)], 'v1');
      enforceRendererCacheBudget(0);
      assert.equal(isVisualizeStateRehydrating(liveId), true);

      applyVisualizeEvent({
        sessionId: liveId,
        state: { sessionId: liveId, tabs: [heavyTab('v1', 1), heavyTab('v2', 2)], active: 'v2' },
        updated: 'v2',
      });
      assert.deepEqual(reveals, []);
      assert.equal(visualizeStateFor(liveId).active, 'v1', 'plain live update after eviction keeps local v1');
      assert.deepEqual([...visualizeUpdatedTabs(liveId)], ['v2']);
      assert.deepEqual(sent, []);

      // Case A2: reveal live update after eviction also keeps v1 active and marks v2 updated.
      enforceRendererCacheBudget(0);
      assert.equal(isVisualizeStateRehydrating(liveId), true);
      open(liveId, [heavyTab('v1', 1), heavyTab('v2', 3)], 'v2');
      assert.deepEqual(reveals, []);
      assert.equal(visualizeStateFor(liveId).active, 'v1', 'reveal live update after eviction keeps local v1');
      assert.deepEqual([...visualizeUpdatedTabs(liveId)], ['v2']);

      // Case B: reconnect resync after eviction keeps v1 active and marks v2 updated without revealing.
      open(resyncId, [heavyTab('v1', 1), heavyTab('v2', 1)], 'v1');
      enforceRendererCacheBudget(0);
      assert.equal(isVisualizeStateRehydrating(resyncId), true);

      resyncVisualizeStates([{ sessionId: resyncId, tabs: [heavyTab('v1', 1), heavyTab('v2', 2)], active: 'v2' }]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(reveals, []);
      assert.equal(visualizeStateFor(resyncId).active, 'v1', 'reconnect after eviction keeps local v1');
      assert.deepEqual([...visualizeUpdatedTabs(resyncId)], ['v2']);
    } finally {
      releaseVisualizeSession(liveId);
      releaseVisualizeSession(resyncId);
    }
  });

  // Case C: rehydration triggered by a transcript reader while phone panel stays closed preserves v1.
  const React = await import('react');
  const { act } = React;
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const { SurfaceActiveContext } = await import('./surface-activity.ts');
  const { dom, root } = installTestDom(t, { rootId: 'root' });
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const rehydrateId = 'ph-evict-rehydrate';
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 390 });
  dom.window.matchMedia = () => ({ matches: true });
  dom.window.mixdogDesktop = {
    visualizeState: async () => [
      { sessionId: rehydrateId, tabs: [heavyTab('v1', 1), heavyTab('v2', 2)], active: 'v2' },
    ],
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile', maxTouchPoints: 5 },
  });
  function Reader() {
    useVisualizeState(rehydrateId);
    return null;
  }
  try {
    resetVisualizePanelMemory();
    open(rehydrateId, [heavyTab('v1', 1), heavyTab('v2', 1)], 'v1');
    enforceRendererCacheBudget(0);
    assert.equal(isVisualizeStateRehydrating(rehydrateId), true);

    await act(async () => {
      root.render(React.createElement(SurfaceActiveContext.Provider, { value: true }, React.createElement(Reader)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(isVisualizeStateRehydrating(rehydrateId), false);
    assert.equal(visualizeStateFor(rehydrateId).active, 'v1', 'rehydration while phone panel is closed keeps local v1');
  } finally {
    await act(async () => root.unmount());
    releaseVisualizeSession(rehydrateId);
    resetVisualizePanelMemory();
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
  }
});
