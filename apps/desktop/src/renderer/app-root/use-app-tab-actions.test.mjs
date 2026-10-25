import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';
import { useAppTabActions } from './use-app-tab-actions.ts';

test('useAppTabActions manages utility, studio, terminal, and diff tab opening', async () => {
  const { dom } = installTestDom(null, {
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
  });

  const tabs = [];
  const setTabs = (update) => {
    const next = typeof update === 'function' ? update(tabs) : update;
    tabs.length = 0;
    tabs.push(...next);
  };

  const focusedSelections = [];
  let terminalSelected = false;

  const paneWorkspace = {
    leaves: [{ id: 'leaf-1', tabs: [{ kind: 'session', id: 's1' }], activeTabKey: 'session:s1' }],
    focusedLeafId: 'leaf-1',
    focusedLeaf: { id: 'leaf-1', tabs: [{ kind: 'session', id: 's1' }], activeTabKey: 'session:s1' },
    focusLeaf: (_id) => {},
    openInFocused: (sel) => {
      focusedSelections.push(sel);
    },
    splitFocused: () => {},
  };

  let hookResult = null;

  function TestHarness() {
    hookResult = useAppTabActions({
      paneWorkspace,
      setTabs,
      closeSidebarPanels: () => {},
      setSessionSideSurface: (_id, surface) => {
        if (surface === 'terminal') terminalSelected = true;
      },
      paneSideDocks: {
        select: () => {},
        temporarySelect: () => {},
      },
      sessionPaneSurfaces: {
        browserSurfaces: new Map(),
        pendingBrowserAutoReveal: { current: new Set() },
        browserAutoRevealSuppressed: { current: new Set() },
        pendingDockReveals: { current: new Map() },
        dockRevealTick: 0,
        queueDockReveal() {},
        showSessionSurface() {},
      },
      openFileTab: () => {},
      openSession: async () => {},
      activeProjectPath: '/p',
    });
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(TestHarness));
  });

  assert.notEqual(hookResult, null);

  // 1. openTerminalTab for a session leaf sets terminal side surface
  hookResult.openTerminalTab('leaf-1');
  assert.equal(terminalSelected, true);

  // 2. openDiffTab adds diff tab and opens in focused pane
  hookResult.openDiffTab('/repo', '\\src\\index.ts', { source: 'working' });
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].selection.kind, 'diff');
  assert.equal(tabs[0].selection.rel, 'src/index.ts');
  assert.equal(focusedSelections.length, 1);
  assert.equal(focusedSelections[0].kind, 'diff');

  await act(async () => {
    root.unmount();
  });
});

/** The real session surfaces and pane docks under useAppTabActions, over one
 *  pane whose tabs and shown tab the test sets. */
async function mountShell(t, { tabs, active, host = {} }) {
  const { dom } = installTestDom(null, {
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent', 'localStorage'],
  });
  window.mixdogDesktop = host;
  const { useSessionPaneSurfaces } = await import('../use-session-pane-surfaces.ts');
  const { usePaneSideDocks } = await import('../pane-side-dock.tsx');
  const { sessionSideDockEntryForSession } = await import('../session-side-surface-policy.ts');
  const { agentPoolStore, refreshAgentPool } = await import('../agent-activity-model.ts');
  await refreshAgentPool(agentPoolStore(host));
  const shell = { surfaces: null, docks: null, activeId: active };
  const leaf = () => ({
    id: 'leaf-1',
    tabs: tabs.map((id) => ({ kind: 'session', id })),
    activeKey: `session:${shell.activeId}`,
  });
  function Harness() {
    shell.surfaces = useSessionPaneSurfaces();
    shell.docks = usePaneSideDocks({
      leafIds: ['leaf-1'],
      groups: [['session-diff'], ['visualize'], ['browser'], ['terminal']],
      sessionOf: () => shell.activeId,
    });
    const current = leaf();
    useAppTabActions({
      paneWorkspace: {
        leaves: [current],
        focusedLeafId: 'leaf-1',
        focusedLeaf: current,
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
      openSession: async () => {},
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
  const shown = (sessionId) =>
    sessionSideDockEntryForSession(
      shell.docks.entryFor('leaf-1'),
      sessionId,
      shell.surfaces.sessionSideSurfaces.get(sessionId) ?? null,
      null,
      shell.surfaces.sessionPanelViews.get(sessionId) ?? null,
      shell.surfaces.panelViewFronts.has(sessionId)
    );
  const show = async (sessionId) => {
    shell.activeId = sessionId;
    await render();
  };
  return { shell, shown, show };
}

test('a visualize open keeps the browser behind it and never writes the Routines tile preference', async (t) => {
  const { agentHomeSessionId } = await import('../../../../../src/runtime/agent/orchestrator/session/agent-home.mjs');
  const { readRoutinesTilePreference } = await import('../routines-tile.ts');
  const { revealVisualizeTab } = await import('../visualize-store.ts');
  const home = agentHomeSessionId('watcher');
  assert.ok(home);
  const { shell, shown } = await mountShell(t, { tabs: [home], active: home });
  await act(async () => shell.surfaces.setSessionSideSurface(home, 'browser'));
  assert.equal(shown(home).surface, 'browser');
  await act(async () => revealVisualizeTab(home, 'v1'));
  // The latest open is in front; the browser stays the session's surface.
  assert.equal(shell.surfaces.sessionSideSurfaces.get(home), 'browser');
  assert.equal(shown(home).surface, '');
  assert.equal(shown(home).view, 'visualize');
  assert.equal(readRoutinesTilePreference(), null, 'an agent open leaves the tile preference unset');
  // A later browser open takes the front back.
  await act(async () => shell.surfaces.setSessionSideSurface(home, 'browser'));
  assert.equal(shown(home).surface, 'browser');
  assert.equal(shell.surfaces.sessionPanelViews.get(home), 'visualize');
});

test('a reveal for a background tab takes effect on return, in front of its own file tab', async (t) => {
  const { revealSessionTerminalTab } = await import('../terminal-command-request.ts');
  const { shell, shown, show } = await mountShell(t, { tabs: ['s1', 's2'], active: 's1' });
  await act(async () => shell.docks.openFile('leaf-1', '/p', 'a.ts'));
  assert.equal(shown('s1').surface, 'file');
  await show('s2');
  await act(async () => revealSessionTerminalTab('s1'));
  assert.equal(shown('s2').surface === 'terminal', false, 'another tab is not touched');
  await show('s1');
  assert.equal(shown('s1').surface, 'terminal');
  assert.equal(shown('s1').open, true);
});

test('a sub-agent terminal opens in the dock of the conversation that owns it, with its line there', async (t) => {
  const { revealSessionTerminalTab } = await import('../terminal-command-request.ts');
  const { sessionSurfaceSessionFor } = await import('../session-side-surface-policy.ts');
  const { useChildSurfacePeeks } = await import('../child-surface-peeks.tsx');
  const pool = [{ sessionId: 'sub-1', parentSessionId: 'lead', ownerSessionId: 'lead', title: '시장 조사', tag: 'w1' }];
  const { shell, shown } = await mountShell(t, {
    tabs: ['lead'],
    active: 'lead',
    host: { listAgentPool: async () => pool },
  });
  let peeks = [];
  function Peeks() {
    peeks = useChildSurfacePeeks('lead');
    return null;
  }
  const peekHost = document.createElement('div');
  document.body.append(peekHost);
  const peekRoot = createRoot(peekHost);
  await act(async () => peekRoot.render(React.createElement(Peeks)));
  t.after(async () => act(async () => peekRoot.unmount()));
  await act(async () => revealSessionTerminalTab('sub-1'));
  assert.equal(shown('lead').surface, 'terminal');
  assert.equal(sessionSurfaceSessionFor(shell.surfaces.sessionSurfaceSources, 'lead', 'terminal'), 'sub-1');
  assert.equal(peeks.length, 1);
  assert.equal(peeks[0].childSessionId, 'sub-1');
  assert.equal(peeks[0].childName, '시장 조사');
  assert.equal(peeks[0].surface, 'terminal');
});

test("a session's last visualize tab closing clears its visualize view", async (t) => {
  const { applyVisualizeEvent, revealVisualizeTab } = await import('../visualize-store.ts');
  const { shell, shown } = await mountShell(t, {
    tabs: ['vz'],
    active: 'vz',
    host: { onVisualizeChanged: () => () => {} },
  });
  const tab = { id: 'v1', label: 'index.html', kind: 'html', panes: [], versions: [{ n: 1 }] };
  await act(async () => applyVisualizeEvent({ sessionId: 'vz', state: { sessionId: 'vz', tabs: [tab], active: 'v1' } }));
  await act(async () => revealVisualizeTab('vz', 'v1'));
  assert.equal(shell.surfaces.sessionPanelViews.get('vz'), 'visualize');
  await act(async () =>
    applyVisualizeEvent({ sessionId: 'vz', state: { sessionId: 'vz', tabs: [], active: null, history: [] } })
  );
  assert.equal(shell.surfaces.sessionPanelViews.has('vz'), false);
  assert.equal(shown('vz').open, false, 'no empty frame stays');
});
