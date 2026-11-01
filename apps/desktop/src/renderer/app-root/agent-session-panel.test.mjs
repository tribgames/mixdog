import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';
import { useAppTabActions } from './use-app-tab-actions.ts';

/** Real session surfaces and pane docks under useAppTabActions, over panes
 *  whose tabs the test sets. */
async function mountShell(t, panes) {
  const { dom } = installTestDom(null, {
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent', 'localStorage'],
  });
  window.mixdogDesktop = {};
  const { useSessionPaneSurfaces } = await import('../use-session-pane-surfaces.ts');
  const { usePaneSideDocks } = await import('../pane-side-dock.tsx');
  const shell = { surfaces: null, docks: null, actions: null, panes, focused: 0, opened: [], commits: [] };
  const leaves = () =>
    shell.panes.map(({ id, tabs, active }) => ({
      id,
      tabs: tabs.map((tabId) => ({ kind: 'session', id: tabId })),
      activeKey: `session:${active}`,
    }));
  function Harness() {
    const current = leaves();
    shell.surfaces = useSessionPaneSurfaces(current.flatMap((leaf) => leaf.tabs.map((tab) => tab.id)));
    const surfaces = shell.surfaces;
    // Every commit: which sessions are tabs and which a panel would mount.
    React.useLayoutEffect(() => {
      shell.commits.push({
        tabs: current.flatMap((leaf) => leaf.tabs.map((tab) => tab.id)),
        panels: [...surfaces.agentSessionPanels]
          .filter(([host]) => surfaces.sessionPanelViews.get(host) === 'agent-session')
          .map(([, target]) => target.sessionId),
      });
    });
    const focusedLeaf = current[shell.focused];
    shell.docks = usePaneSideDocks({
      leafIds: current.map((leaf) => leaf.id),
      groups: [['session-diff'], ['visualize'], ['agent-session']],
      sessionOf: (leafId) => shell.panes.find((pane) => pane.id === leafId)?.active ?? '',
    });
    shell.actions = useAppTabActions({
      paneWorkspace: {
        leaves: current,
        focusedLeafId: focusedLeaf.id,
        focusedLeaf,
        focusLeaf() {},
        openInFocused() {},
        splitFocused() {},
      },
      setTabs() {},
      closeSidebarPanels() {},
      setSessionSideSurface: shell.surfaces.setSessionSideSurface,
      paneSideDocks: shell.docks,
      closePaneRightRegion() {},
      sessionPaneSurfaces: { ...shell.surfaces, browserSurfaces: { ensure() {} } },
      openFileTab() {},
      openSession: async (sessionId, _force, title) => {
        shell.opened.push({ sessionId, title });
      },
      activeProjectPath: '/p',
      openQuickOpen() {},
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  const render = () => act(async () => root.render(React.createElement(Harness)));
  await render();
  t.after(async () => {
    await act(async () => root.unmount());
  });
  return { shell, render };
}

test('an agent row opens its session in the chat side panel and another row swaps it', async (t) => {
  const { shell } = await mountShell(t, [{ id: 'leaf-1', tabs: ['lead'], active: 'lead' }]);
  await act(async () => shell.actions.dockPeekAgentSession('sub-1', 'Worker', 'lead'));
  assert.equal(shell.surfaces.sessionPanelViews.get('lead'), 'agent-session');
  assert.deepEqual(shell.surfaces.agentSessionPanels.get('lead'), { sessionId: 'sub-1', title: 'Worker' });
  assert.equal(shell.docks.entryFor('leaf-1').view, 'agent-session');
  assert.equal(shell.opened.length, 0, 'the chat stays; nothing opens as a tab');
  const panels = shell.surfaces.agentSessionPanels;
  await act(async () => shell.actions.dockPeekAgentSession('sub-1', 'Worker', 'lead'));
  assert.equal(shell.surfaces.agentSessionPanels, panels, 'the session already shown is kept');
  await act(async () => shell.actions.dockPeekAgentSession('sub-2', 'Reviewer', 'lead'));
  assert.equal(shell.surfaces.agentSessionPanels.get('lead').sessionId, 'sub-2');
});

test('"Open in tab" moves the panel session to a tab', async (t) => {
  const { shell } = await mountShell(t, [{ id: 'leaf-1', tabs: ['lead'], active: 'lead' }]);
  await act(async () => shell.actions.dockPeekAgentSession('sub-1', 'Worker', 'lead'));
  await act(async () => shell.actions.openAgentSessionPanelAsTab('lead'));
  assert.deepEqual(shell.opened, [{ sessionId: 'sub-1', title: 'Worker' }]);
  assert.equal(shell.surfaces.sessionPanelViews.has('lead'), false);
  assert.equal(shell.surfaces.agentSessionPanels.has('lead'), false);
});

test('a session already open in a pane is revealed there, never mounted in the panel', async (t) => {
  const { shell, render } = await mountShell(t, [
    { id: 'leaf-1', tabs: ['lead'], active: 'lead' },
    { id: 'leaf-2', tabs: ['other', 'sub-1'], active: 'other' },
  ]);
  await act(async () => shell.actions.dockPeekAgentSession('sub-1', 'Worker', 'lead'));
  assert.deepEqual(shell.opened, [{ sessionId: 'sub-1', title: 'Worker' }]);
  assert.equal(shell.surfaces.agentSessionPanels.size, 0);
});

test('a panel session that becomes a tab is never mounted in both in any commit', async (t) => {
  const { shell, render } = await mountShell(t, [
    { id: 'leaf-1', tabs: ['lead'], active: 'lead' },
    { id: 'leaf-2', tabs: ['other'], active: 'other' },
  ]);
  await act(async () => shell.actions.dockPeekAgentSession('sub-2', 'Reviewer', 'lead'));
  assert.equal(shell.surfaces.agentSessionPanels.get('lead').sessionId, 'sub-2');
  assert.equal(shell.docks.entryFor('leaf-1').view, 'agent-session');
  shell.commits.length = 0;
  shell.panes[1].tabs.push('sub-2');
  await render();
  assert.ok(shell.commits.length > 0);
  for (const commit of shell.commits) {
    assert.ok(
      !(commit.tabs.includes('sub-2') && commit.panels.includes('sub-2')),
      `mounted twice in a commit: ${JSON.stringify(commit)}`
    );
  }
  assert.equal(shell.surfaces.agentSessionPanels.has('lead'), false);
  assert.equal(shell.surfaces.sessionPanelViews.has('lead'), false);
});

test('opening a sub-agent beside another chat moves it there: one panel host', async (t) => {
  const { shell, render } = await mountShell(t, [
    { id: 'leaf-1', tabs: ['a'], active: 'a' },
    { id: 'leaf-2', tabs: ['b'], active: 'b' },
  ]);
  // Its owner is on no pane: the focused chat hosts it.
  await act(async () => shell.actions.dockPeekAgentSession('sub', 'Worker', 'offscreen-owner'));
  assert.equal(shell.surfaces.agentSessionPanels.get('a').sessionId, 'sub');
  shell.focused = 1;
  await render();
  shell.commits.length = 0;
  await act(async () => shell.actions.dockPeekAgentSession('sub', 'Worker', 'offscreen-owner'));
  assert.deepEqual([...shell.surfaces.agentSessionPanels.keys()], ['b']);
  assert.equal(shell.surfaces.sessionPanelViews.get('b'), 'agent-session');
  assert.equal(shell.surfaces.sessionPanelViews.has('a'), false);
  for (const commit of shell.commits) {
    assert.ok(commit.panels.filter((id) => id === 'sub').length <= 1, JSON.stringify(commit));
  }
});

test('the panel view and its session are kept per chat', async (t) => {
  const { shell, render } = await mountShell(t, [{ id: 'leaf-1', tabs: ['a', 'b'], active: 'a' }]);
  await act(async () => shell.actions.dockPeekAgentSession('sub-a', 'A worker', 'a'));
  shell.panes[0].active = 'b';
  await render();
  await act(async () => shell.actions.dockPeekAgentSession('sub-b', 'B worker', 'b'));
  shell.panes[0].active = 'a';
  await render();
  assert.equal(shell.surfaces.sessionPanelViews.get('a'), 'agent-session');
  assert.equal(shell.surfaces.agentSessionPanels.get('a').sessionId, 'sub-a');
  assert.equal(shell.surfaces.agentSessionPanels.get('b').sessionId, 'sub-b');
  // Another dock view replaces it as before.
  await act(async () => shell.surfaces.setSessionPanelView('a', 'visualize'));
  assert.equal(shell.surfaces.agentSessionPanels.has('a'), false);
});

test('an ended sub-agent stays read-only from the panel’s own copy, and a fresh frame makes it live again', async (t) => {
  const { dom } = installTestDom(null, { jsdom: { url: 'https://mixdog.test/' } });
  const { createSessionLaneStore } = await import('../session-lane-store.ts');
  const { useHeldSessionLane } = await import('../AgentSessionPanel.tsx');
  const store = createSessionLaneStore({ decorator: { decorate: (snapshot) => snapshot, clear() {} } });
  store.setShownSessionIds(['sub']);
  const frame = (revision) => ({
    sessionId: 'sub',
    snapshot: { sessionId: 'sub', items: [{ id: `r${revision}` }], toolApproval: { id: 'ap', tool: 'shell' } },
    frameSource: 'live',
  });
  store.apply(frame(10));
  const seen = { held: undefined };
  function Probe() {
    seen.held = useHeldSessionLane('sub', store);
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => root.render(React.createElement(Probe)));
  t.after(async () => {
    await act(async () => root.unmount());
  });
  assert.equal(seen.held, null, 'live: no held copy, the composer is enabled');

  await act(async () => store.apply({ sessionId: 'sub', snapshot: null, frameSource: 'live', laneEnd: 'gone' }));
  assert.deepEqual(seen.held?.items, [{ id: 'r10' }], 'the last transcript is kept');
  assert.equal(store.get('sub'), null, 'the shared store is not written');
  assert.equal(store.liveSessionIds().has('sub'), false);
  assert.equal(store.approvalSessionIds().has('sub'), false);

  await act(async () => store.apply(frame(11)));
  assert.equal(seen.held, null, 'a fresh live frame ends read-only');
});
