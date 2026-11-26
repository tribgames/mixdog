import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installPhonePaneDom } from '../test-support/phone-pane-dom.mjs';
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
  const { usePaneSideDocks } = await import('../pane-side-dock-state.ts');
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
  const { shell } = await mountShell(t, [
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

test('an ended sub-agent keeps its final transcript across a host chat switch, until its panel target goes', async (t) => {
  const { dom } = installTestDom(null, { jsdom: { url: 'https://mixdog.test/' } });
  window.mixdogDesktop = {};
  const { defaultSessionLaneStore: store } = await import('../session-lane-store.ts');
  const { useSessionPaneSurfaces } = await import('../use-session-pane-surfaces.ts');
  const { AgentSessionPanel } = await import('../AgentSessionPanel.tsx');
  store.setShownSessionIds(['sub-a', 'sub-b']);
  const frame = (sessionId, itemId) => ({
    sessionId,
    snapshot: { sessionId, items: [{ id: itemId }] },
    frameSource: 'live',
  });
  store.apply(frame('sub-a', 'a-final'));
  store.apply(frame('sub-b', 'b-live'));
  const shell = { host: 'chat-1', surfaces: null, held: undefined };
  // The dock's mount, as use-app-workbench-views: one panel keyed by its
  // sub-agent, so a host switch to another sub-agent remounts it.
  function Harness() {
    shell.surfaces = useSessionPaneSurfaces(['chat-1', 'chat-2']);
    const target = shell.surfaces.agentSessionPanels.get(shell.host);
    if (!target) return null;
    return React.createElement(AgentSessionPanel, {
      key: target.sessionId,
      target,
      active: true,
      heldLanes: shell.surfaces.heldAgentLanes,
      renderConversation: (_id, _title, held) => {
        shell.held = held;
        return null;
      },
      onOpenAsTab() {},
      onClose() {},
    });
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  const render = () => act(async () => root.render(React.createElement(Harness)));
  await render();
  t.after(async () => {
    await act(async () => root.unmount());
    store.setShownSessionIds([]);
  });
  await act(async () => shell.surfaces.showAgentSessionPanel('chat-1', { sessionId: 'sub-a', title: 'A' }));
  await act(async () => shell.surfaces.showAgentSessionPanel('chat-2', { sessionId: 'sub-b', title: 'B' }));
  await act(async () => shell.surfaces.showAgentSessionPanel('chat-1', { sessionId: 'sub-a', title: 'A' }));
  assert.equal(shell.held, null, 'live: nothing held');

  await act(async () => store.apply({ sessionId: 'sub-a', snapshot: null, frameSource: 'live', laneEnd: 'gone' }));
  assert.deepEqual(shell.held?.items, [{ id: 'a-final' }], 'ended panel shows the final transcript');

  shell.host = 'chat-2';
  await render();
  assert.equal(shell.held, null, 'chat 2 shows live B');
  shell.host = 'chat-1';
  await render();
  assert.deepEqual(shell.held?.items, [{ id: 'a-final' }], 'back on chat 1, A’s final transcript remains');

  // Fold keeps the target (and its snapshot); another view discards both.
  await act(async () => shell.surfaces.setSessionPanelView('chat-1', null, { fold: true }));
  assert.equal(shell.surfaces.heldAgentLanes.has('sub-a'), true);
  await act(async () => shell.surfaces.setSessionPanelView('chat-1', 'visualize'));
  assert.equal(shell.surfaces.heldAgentLanes.has('sub-a'), false, 'released with its panel target');
});

test('a sub-agent the dock covers and shows again is presented anew: its transcript is not painted until its rows hold their boxes', async (t) => {
  const frames = new Map();
  let frameId = 0;
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div><div id="viewport"><div id="content" style="height:100px"><div class="transcript-virtual-row" data-index="0" data-timeline-key="r0" style="top:0px"></div></div></div>',
    globals: {
      requestAnimationFrame(callback) {
        frames.set(++frameId, callback);
        return frameId;
      },
      cancelAnimationFrame(id) {
        frames.delete(id);
      },
    },
  });
  const { document } = dom.window;
  const { AgentSessionPanel } = await import('../AgentSessionPanel.tsx');
  const { usePanePresentation } = await import('../pane-presentation.ts');
  const { useTranscriptReveal } = await import('../use-transcript-reveal.ts');
  // The sub-agent's viewport at its end, its one row in view as layout reads it back.
  const viewport = { current: document.getElementById('viewport') };
  const content = { current: document.getElementById('content') };
  Object.defineProperties(viewport.current, { clientHeight: { value: 100 }, scrollHeight: { value: 100 } });
  document.querySelector('.transcript-virtual-row').getBoundingClientRect = () => ({
    height: 100,
    top: 0,
    bottom: 100,
    width: 600,
  });
  const painted = [];
  // The conversation's timeline (use-conversation-timeline.ts): revealed per visit of its pane presentation.
  function Transcript() {
    const revealed = useTranscriptReveal({
      identity: 'sub',
      visit: usePanePresentation().visit,
      enabled: true,
      draft: false,
      viewport,
      content,
      hasScrollGesture: () => false,
    });
    React.useLayoutEffect(() => {
      painted.push(revealed);
    });
    return null;
  }
  const root = createRoot(document.getElementById('root'));
  const render = (active) =>
    act(() =>
      root.render(
        React.createElement(AgentSessionPanel, {
          target: { sessionId: 'sub', title: 'Worker' },
          active,
          renderConversation: () => React.createElement(Transcript),
          onOpenAsTab() {},
          onClose() {},
        })
      )
    );
  const frame = () =>
    act(() => {
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(0);
    });
  t.after(async () => {
    await act(async () => root.unmount());
    restore();
  });
  render(true);
  frame();
  frame();
  assert.equal(painted.at(-1), true, 'entered: its rows are shown');
  // A browser or terminal in front of it, or the dock folded: the conversation stays mounted, its rows let go.
  render(false);
  painted.length = 0;
  render(true);
  assert.equal(painted[0], false, 'the commit that shows it again paints no rows still taking their boxes');
  frame();
  frame();
  assert.equal(painted.at(-1), true, 'shown once they hold them');
});

/** The real PaneConversation of sub-agent `sub` in the side panel, over the real lane store; frames, lane delivery and
 *  the panel's fold are driven by the test. `painted` gets what each commit and frame shows of the panel's transcript:
 *  nothing while it is covered, held hidden or folded away. */
async function panelOverLaneStore(t) {
  const pane = await installPhonePaneDom(t, { mobile: false });
  await (await import('../markdown-body-loader.ts')).preloadMarkdownBody();
  const { AgentSessionPanel } = await import('../AgentSessionPanel.tsx');
  const store = pane.defaultSessionLaneStore;
  const doc = pane.dom.window.document;
  pane.dom.window.mixdogDesktop = {
    invokeCapability: async () => ({
      value: { supported: true, authoritative: true, snapshotKind: 'worktree', patch: '', files: [], agents: [] },
    }),
  };
  t.after(() => {
    delete pane.dom.window.mixdogDesktop;
    store.setShownSessionIds([]);
  });
  const painted = [];
  const paint = () => {
    const panel = doc.querySelector('.agent-session-panel:not([hidden])');
    const log = panel?.querySelector('.transcript');
    const covered = Boolean(panel?.querySelector('.pane-surface-cover'));
    if (log && !covered && log.style.visibility !== 'hidden') painted.push(log.textContent);
  };
  const render = (active) =>
    act(async () =>
      pane.root.render(
        React.createElement(AgentSessionPanel, {
          target: { sessionId: 'sub', title: 'Worker' },
          active,
          renderConversation: () =>
            React.createElement(
              React.Profiler,
              { id: 'panel', onRender: paint },
              React.createElement(pane.PaneConversation, { ...pane.props('sub'), focused: false })
            ),
          onOpenAsTab() {},
          onClose() {},
        })
      )
    );
  const frames = async (count) => {
    for (let step = 0; step < count; step += 1) {
      await act(async () => {
        const due = [...pane.frames.values()];
        pane.frames.clear();
        for (const callback of due) callback(performance.now());
      });
      await act(async () => new Promise((resolve) => pane.dom.window.setTimeout(resolve, 5)));
      paint();
    }
  };
  // The dock folds: the panel stays mounted and the window no longer registers its session.
  const fold = async () => {
    await render(false);
    await act(async () => store.setShownSessionIds([]));
    await frames(4);
  };
  // Shown again: the window registers the panel's session, which waits for its first frame since.
  const unfold = async () => {
    await act(async () => store.setShownSessionIds(['sub']));
    painted.length = 0;
    await render(true);
  };
  return { store, painted, render, frames, fold, unfold, window: pane.dom.window };
}

const subAgentState = (answer) => ({
  sessionId: 'sub',
  snapshot: {
    sessionId: 'sub',
    items: [
      { kind: 'user', id: 'u1', text: 'the brief' },
      { kind: 'assistant', id: `r-${answer}`, text: `answer ${answer}` },
    ],
  },
});

test("a sub-agent the side panel shows over the state kept from before it was let go paints none of that state's rows: its first rows are its live state", async (t) => {
  const { store, painted, render, frames } = await panelOverLaneStore(t);
  // What the renderer kept of the sub-agent from before its session was let go (the panel folded, its lane hidden).
  store.apply(subAgentState('then'));
  store.setShownSessionIds(['sub']);
  await render(true);
  await frames(12);
  // The live frame lands.
  await act(async () => store.apply(subAgentState('now')));
  await frames(12);
  assert.ok(painted.length > 0, 'the panel paints its rows');
  assert.ok(painted.at(-1).includes('answer now'), `it rests on its live state: ${painted.at(-1)}`);
  assert.deepEqual(
    painted.filter((text) => text.includes('answer then')),
    [],
    'no frame paints the state kept from before'
  );
});

test('a sub-agent the folded side panel shows again is covered until its live state lands: no frame paints it empty', async (t) => {
  const { store, painted, render, frames, fold, unfold } = await panelOverLaneStore(t);
  store.setShownSessionIds(['sub']);
  store.apply(subAgentState('then'));
  await render(true);
  await frames(12);
  assert.ok(painted.at(-1)?.includes('answer then'), 'the first visit shows its live state');
  await fold();
  await unfold();
  await frames(12);
  await act(async () => store.apply(subAgentState('now')));
  await frames(12);
  assert.ok(painted.at(-1)?.includes('answer now'), `it rests on its live state: ${painted.at(-1)}`);
  assert.deepEqual(
    painted.filter((text) => !text.includes('answer now')),
    [],
    'every frame before its live rows shows its cover'
  );
});

test('a sub-agent whose read expired on an earlier visit of the side panel waits for its live state on the next', async (t) => {
  const { store, painted, render, frames, fold, unfold, window } = await panelOverLaneStore(t);
  const { TRANSCRIPT_READ_TIMEOUT_MS } = await import('../../shared/transcript-read-policy.ts');
  // The panel's read waits are expired by the test.
  const expiries = new Map();
  const { setTimeout: setTimer, clearTimeout: clearTimer } = window;
  let expiryId = 1e9;
  window.setTimeout = (callback, delay, ...rest) => {
    if (delay !== TRANSCRIPT_READ_TIMEOUT_MS) return setTimer.call(window, callback, delay, ...rest);
    expiryId += 1;
    expiries.set(expiryId, callback);
    return expiryId;
  };
  window.clearTimeout = (id) => (expiries.delete(id) ? undefined : clearTimer.call(window, id));
  t.after(() => {
    window.setTimeout = setTimer;
    window.clearTimeout = clearTimer;
  });
  // Kept from before its session was let go; shown, it waits for a frame that does not come.
  store.apply(subAgentState('then'));
  store.setShownSessionIds(['sub']);
  await render(true);
  await frames(6);
  assert.equal(expiries.size, 1, 'the visit waits for the live state');
  await act(async () => {
    for (const expire of expiries.values()) expire();
    expiries.clear();
  });
  await frames(12);
  await fold();
  await unfold();
  await frames(12);
  await act(async () => store.apply(subAgentState('now')));
  await frames(12);
  assert.ok(painted.at(-1)?.includes('answer now'), `it rests on its live state: ${painted.at(-1)}`);
  assert.deepEqual(
    painted.filter((text) => text.includes('answer then')),
    [],
    'no frame of the new visit paints the state kept from before'
  );
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

test('an open agent-session panel follows a closed sub-agent to its respawned session on the same owner and tag, while keeping unsuperseded historical sessions', async (t) => {
  const { dom } = installTestDom(null, {
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent', 'localStorage'],
  });
  let listener = () => {};
  let revision = 1;
  const entry = (value) => ({ section: 'agentPool', key: null, revision: ++revision, value });
  const lead = {
    tag: 'lead:lead-1',
    agent: 'lead',
    sessionId: 'lead-1',
    ownerSessionId: 'lead-1',
    status: 'idle',
    stage: 'idle',
    createdAt: 100,
  };
  const oldRow = {
    tag: 'fw-heavy',
    agent: 'heavy-worker',
    sessionId: 'sub-old',
    ownerSessionId: 'lead-1',
    parentSessionId: 'lead-1',
    status: 'error',
    stage: 'error',
    createdAt: 1_000,
    startedAt: 1_000,
    settledAt: 1_500,
  };
  const host = {
    sections: {
      snapshot: async () => ({ status: 'ready', entries: [entry([lead, oldRow])] }),
      subscribe: (next) => {
        listener = next;
        return () => {};
      },
    },
  };
  window.mixdogDesktop = host;
  const { sectionStoreFor } = await import('../section-store.ts');
  const { defaultSessionLaneStore: store } = await import('../session-lane-store.ts');
  const { useSessionPaneSurfaces } = await import('../use-session-pane-surfaces.ts');
  const { AgentSessionPanel } = await import('../AgentSessionPanel.tsx');
  await sectionStoreFor(host).ready();
  store.setShownSessionIds(['sub-old', 'sub-new', 'sub-new-2']);
  store.apply({
    sessionId: 'sub-old',
    snapshot: { sessionId: 'sub-old', items: [{ id: 'old-failed' }] },
    frameSource: 'live',
  });
  const shell = { surfaces: null, renderedSessionId: null, held: undefined };
  function Harness() {
    shell.surfaces = useSessionPaneSurfaces(['lead-1']);
    const target = shell.surfaces.agentSessionPanels.get('lead-1');
    if (!target) {
      shell.renderedSessionId = null;
      shell.held = undefined;
      return null;
    }
    return React.createElement(AgentSessionPanel, {
      key: target.sessionId,
      target,
      active: true,
      heldLanes: shell.surfaces.heldAgentLanes,
      renderConversation: (sessionId, _title, held) => {
        shell.renderedSessionId = sessionId;
        shell.held = held;
        return null;
      },
      onOpenAsTab() {},
      onClose() {},
    });
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => root.render(React.createElement(Harness)));
  t.after(async () => {
    await act(async () => root.unmount());
    store.setShownSessionIds([]);
  });
  const pushPool = async (rows) => {
    await act(async () => {
      listener({ kind: 'sections', changes: [{ section: 'agentPool', key: null, entry: entry(rows) }] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  // Open the failed sub-agent in the side panel, then its lane ends (frozen snapshot held).
  await act(async () => shell.surfaces.showAgentSessionPanel('lead-1', { sessionId: 'sub-old', title: 'fw-heavy' }));
  assert.equal(shell.renderedSessionId, 'sub-old');
  await act(async () => store.apply({ sessionId: 'sub-old', snapshot: null, frameSource: 'live', laneEnd: 'gone' }));
  assert.deepEqual(shell.held?.items, [{ id: 'old-failed' }]);

  // Another owner spawning the same tag or the same owner spawning another tag must not hijack the panel.
  await pushPool([
    lead,
    { ...oldRow, released: true },
    { ...oldRow, sessionId: 'other-owner-sub', ownerSessionId: 'lead-2', parentSessionId: 'lead-2', createdAt: 2_000 },
    { ...oldRow, sessionId: 'other-tag-sub', tag: 'fw-other', createdAt: 2_000 },
  ]);
  assert.equal(shell.surfaces.agentSessionPanels.get('lead-1').sessionId, 'sub-old');

  // Respawn on the same (ownerSessionId, tag) while sub-old is marked released: panel follows to sub-new immediately.
  const newRow = {
    ...oldRow,
    sessionId: 'sub-new',
    title: 'Retry build',
    status: 'running',
    stage: 'streaming',
    createdAt: 3_000,
    startedAt: 3_000,
    turnStartedAt: 3_000,
    settledAt: null,
  };
  await pushPool([lead, { ...oldRow, released: true }, newRow]);
  assert.deepEqual(shell.surfaces.agentSessionPanels.get('lead-1'), {
    sessionId: 'sub-new',
    title: 'Retry build · fw-heavy',
  });
  assert.equal(shell.renderedSessionId, 'sub-new');
  assert.equal(shell.held, null, 'does not stay pinned to the old held snapshot');
  assert.equal(shell.surfaces.heldAgentLanes.has('sub-old'), false);

  // Even when a closed session is removed from the pool completely before respawn, the remembered tag follows it.
  await pushPool([lead]);
  assert.equal(shell.surfaces.agentSessionPanels.get('lead-1').sessionId, 'sub-new');
  const thirdRow = { ...newRow, sessionId: 'sub-new-2', title: null, createdAt: 4_000, startedAt: 4_000 };
  await pushPool([lead, thirdRow]);
  assert.deepEqual(shell.surfaces.agentSessionPanels.get('lead-1'), {
    sessionId: 'sub-new-2',
    title: 'fw-heavy',
  });

  // Explicitly clicking a historical/closed session with no superseding session stays on that historical session.
  const historical = {
    ...oldRow,
    tag: 'hist-tag',
    sessionId: 'sub-hist',
    status: 'completed',
    stage: 'completed',
    released: true,
    createdAt: 500,
  };
  await pushPool([lead, thirdRow, historical]);
  await act(async () => shell.surfaces.showAgentSessionPanel('lead-1', { sessionId: 'sub-hist', title: 'hist-tag' }));
  assert.deepEqual(shell.surfaces.agentSessionPanels.get('lead-1'), {
    sessionId: 'sub-hist',
    title: 'hist-tag',
  });
  // A historical session not in the pool at all also stays open cleanly.
  await act(async () =>
    shell.surfaces.showAgentSessionPanel('lead-1', { sessionId: 'sub-ancient', title: 'Ancient run' })
  );
  assert.deepEqual(shell.surfaces.agentSessionPanels.get('lead-1'), {
    sessionId: 'sub-ancient',
    title: 'Ancient run',
  });
});

test('an open agent-session panel respects parent scope, open tabs, explicit historical clicks, and ignores progress-only pool ticks', async (t) => {
  const { dom } = installTestDom(null, {
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent', 'localStorage'],
  });
  let listener = () => {};
  let revision = 1;
  const entry = (value) => ({ section: 'agentPool', key: null, revision: ++revision, value });
  const lead = {
    tag: 'lead:lead-1',
    agent: 'lead',
    sessionId: 'lead-1',
    ownerSessionId: 'lead-1',
    status: 'idle',
    stage: 'idle',
    createdAt: 100,
  };
  const grandA1 = {
    tag: 'audit',
    agent: 'reviewer',
    sessionId: 'grand-a-1',
    ownerSessionId: 'lead-1',
    parentSessionId: 'worker-a',
    status: 'running',
    stage: 'streaming',
    createdAt: 1_000,
    startedAt: 1_000,
  };
  const grandB1 = {
    tag: 'audit',
    agent: 'reviewer',
    sessionId: 'grand-b-1',
    ownerSessionId: 'lead-1',
    parentSessionId: 'worker-b',
    status: 'running',
    stage: 'streaming',
    createdAt: 2_000,
    startedAt: 2_000,
  };
  const host = {
    sections: {
      snapshot: async () => ({ status: 'ready', entries: [entry([lead, grandA1, grandB1])] }),
      subscribe: (next) => {
        listener = next;
        return () => {};
      },
    },
  };
  window.mixdogDesktop = host;
  const { sectionStoreFor } = await import('../section-store.ts');
  const { useSessionPaneSurfaces } = await import('../use-session-pane-surfaces.ts');
  await sectionStoreFor(host).ready();
  const shell = { surfaces: null, tabs: ['lead-1', 'grand-a-tab'], renders: 0 };
  function Harness() {
    shell.renders += 1;
    shell.surfaces = useSessionPaneSurfaces(shell.tabs);
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  const render = () => act(async () => root.render(React.createElement(Harness)));
  await render();
  t.after(async () => {
    await act(async () => root.unmount());
  });
  const pushPool = async (rows) => {
    await act(async () => {
      listener({ kind: 'sections', changes: [{ section: 'agentPool', key: null, entry: entry(rows) }] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  // Open worker-a's grand-agent while live.
  await act(async () => shell.surfaces.showAgentSessionPanel('lead-1', { sessionId: 'grand-a-1', title: 'audit' }));
  assert.equal(shell.surfaces.agentSessionPanels.get('lead-1')?.sessionId, 'grand-a-1');

  // Progress-only pool ticks keep getView() identical and cause zero extra renders.
  const rendersBeforeProgress = shell.renders;
  await pushPool([
    lead,
    { ...grandA1, progressAt: 1_100, updatedAt: 1_100, toolCalls: 2, ledgerToken: 'tok-1' },
    grandB1,
  ]);
  await pushPool([
    lead,
    { ...grandA1, progressAt: 1_200, updatedAt: 1_200, toolCalls: 3, ledgerToken: 'tok-2' },
    grandB1,
  ]);
  assert.equal(shell.renders, rendersBeforeProgress, 'progress-only ticks do not re-render or reconcile');

  // Closing grand-a-1 while sibling worker-b runs the same tag must NOT hijack onto grand-b-1.
  await pushPool([lead, { ...grandA1, status: 'completed', stage: 'completed', released: true }, grandB1]);
  assert.equal(shell.surfaces.agentSessionPanels.get('lead-1')?.sessionId, 'grand-a-1');

  // Respawning grand-a onto a sessionId already open as a tab must NOT retarget and close the side panel.
  const grandATab = { ...grandA1, sessionId: 'grand-a-tab', createdAt: 3_000, startedAt: 3_000 };
  await pushPool([lead, { ...grandA1, status: 'completed', stage: 'completed', released: true }, grandB1, grandATab]);
  assert.equal(shell.surfaces.agentSessionPanels.get('lead-1')?.sessionId, 'grand-a-1');
  assert.equal(shell.surfaces.sessionPanelViews.get('lead-1'), 'agent-session');

  // Respawning grand-a onto a new non-tab session follows cleanly.
  const grandA2 = { ...grandA1, sessionId: 'grand-a-2', title: 'Retry audit', createdAt: 4_000, startedAt: 4_000 };
  await pushPool([lead, { ...grandA1, status: 'completed', stage: 'completed', released: true }, grandB1, grandA2]);
  assert.deepEqual(shell.surfaces.agentSessionPanels.get('lead-1'), {
    sessionId: 'grand-a-2',
    title: 'Retry audit · audit',
  });

  // Explicitly clicking the historical released row grand-a-1 AFTER grand-a-2 already exists stays on grand-a-1.
  await act(async () => shell.surfaces.showAgentSessionPanel('lead-1', { sessionId: 'grand-a-1', title: 'audit' }));
  assert.deepEqual(shell.surfaces.agentSessionPanels.get('lead-1'), {
    sessionId: 'grand-a-1',
    title: 'audit',
  });
  // Even if grand-a-2 is later closed and respawned as grand-a-3, the explicitly chosen historical row stays put.
  const grandA3 = { ...grandA1, sessionId: 'grand-a-3', createdAt: 5_000, startedAt: 5_000 };
  await pushPool([
    lead,
    { ...grandA1, status: 'completed', stage: 'completed', released: true },
    { ...grandA2, status: 'completed', stage: 'completed', released: true },
    grandA3,
  ]);
  assert.equal(shell.surfaces.agentSessionPanels.get('lead-1')?.sessionId, 'grand-a-1');
});

test('closing a claimed respawn tab re-reconciles agent-session panel under StrictMode so the panel follows S2', async (t) => {
  const { dom } = installTestDom(t, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'http://localhost/' },
    expose: ['CustomEvent', 'Event', 'HTMLElement', 'Node', 'localStorage'],
  });
  let listener = null;
  let revision = 0;
  const entry = (rows) => ({ section: 'agentPool', key: null, revision: ++revision, value: rows });
  const lead = { sessionId: 'lead-tab-follow', ownerSessionId: 'lead-tab-follow', agent: 'lead', status: 'idle' };
  const s1 = {
    tag: 'worker-follow',
    agent: 'worker',
    sessionId: 's1-live',
    ownerSessionId: 'lead-tab-follow',
    parentSessionId: 'lead-tab-follow',
    status: 'running',
    stage: 'streaming',
    createdAt: 1_000,
    startedAt: 1_000,
  };
  const s2 = {
    tag: 'worker-follow',
    agent: 'worker',
    sessionId: 's2-respawn',
    ownerSessionId: 'lead-tab-follow',
    parentSessionId: 'lead-tab-follow',
    title: 'Second run',
    status: 'running',
    stage: 'streaming',
    createdAt: 2_000,
    startedAt: 2_000,
  };
  const host = {
    sections: {
      snapshot: async () => ({ status: 'ready', entries: [entry([lead, s1])] }),
      subscribe: (next) => {
        listener = next;
        return () => {};
      },
    },
  };
  window.mixdogDesktop = host;
  const { sectionStoreFor } = await import('../section-store.ts');
  const { useSessionPaneSurfaces } = await import('../use-session-pane-surfaces.ts');
  await sectionStoreFor(host).ready();

  const shell = { surfaces: null, tabs: ['lead-tab-follow', 's2-respawn'] };
  function Harness({ tabs }) {
    shell.surfaces = useSessionPaneSurfaces(tabs);
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  const render = (tabs) =>
    act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Harness, { tabs }))));
  await render(shell.tabs);
  t.after(async () => {
    await act(async () => root.unmount());
  });

  await act(async () =>
    shell.surfaces.showAgentSessionPanel('lead-tab-follow', { sessionId: 's1-live', title: 'worker-follow' })
  );
  // S1 closes and S2 spawns while S2 is already open in a tab -> panel stays on S1.
  await act(async () => {
    listener({
      kind: 'sections',
      changes: [{ section: 'agentPool', key: null, entry: entry([lead, { ...s1, released: true }, s2]) }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(shell.surfaces.agentSessionPanels.get('lead-tab-follow')?.sessionId, 's1-live');

  // Closing S2's tab (with no pool event) triggers reconciliation so the panel follows S2.
  await render(['lead-tab-follow']);
  assert.deepEqual(shell.surfaces.agentSessionPanels.get('lead-tab-follow'), {
    sessionId: 's2-respawn',
    title: 'Second run · worker-follow',
  });
});
