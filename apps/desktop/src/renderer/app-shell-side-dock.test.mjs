import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { renderPaneDockStripTrailing } from './app-shell-side-dock.tsx';

test('renderPaneDockStripTrailing uses activeKey rather than first tab, returning null when active tab is a file', () => {
  const descriptors = new Map([['browser', { id: 'browser', label: 'Browser Use', icon: () => null }]]);

  const baseProps = {
    workbenchSideLayout: { layout: { left: [], right: [['browser']] } },
    paneSideDocks: { entryFor: () => ({ root: 'browser', open: false }) },
    sessionSurfaces: {
      sessionSideSurfaces: new Map(),
      sessionDiffs: new Map(),
      sessionPanelViews: new Map(),
      sessionSurfaceSources: new Map(),
      panelViewFronts: new Set(),
      terminalSurfaces: { prewarm: () => {} },
    },
    sideViewDescriptors: descriptors,
    selectWorkbenchSideView: () => {},
    closePaneRightRegion: () => {},
    focusLeaf: () => {},
  };

  // 1. Leaf with active file tab and background session tabs: must return null
  const leafWithActiveFile = {
    id: 'leaf-1',
    activeKey: 'file:project-a:index.ts',
    tabs: [
      { kind: 'session', id: 'session-1' },
      { kind: 'file', project: 'project-a', rel: 'index.ts' },
      { kind: 'session', id: 'session-2' },
    ],
  };

  const trailingWhenFileActive = renderPaneDockStripTrailing(leafWithActiveFile, baseProps);
  assert.equal(trailingWhenFileActive, null, 'Strip trailing should not render when active tab is file');

  // 2. Leaf with multiple sessions where second session is active: must target the second session
  const leafWithSecondSessionActive = {
    id: 'leaf-1',
    activeKey: 'session:session-2',
    tabs: [
      { kind: 'session', id: 'session-1' },
      { kind: 'session', id: 'session-2' },
    ],
  };

  const trailingWhenSessionActive = renderPaneDockStripTrailing(leafWithSecondSessionActive, baseProps);
  assert.notEqual(trailingWhenSessionActive, null, 'Strip trailing should render when active tab is session');
  // The strip hands its toggles the pane's descriptors through a render function.
  assert.equal(trailingWhenSessionActive.props.children(descriptors).props.sessionBound, true);
});

test("a session pane's Terminal toggle prefetch also warms that session's terminal, through one stable map per live pane", async (t) => {
  const { root } = installTestDom(t, { expose: ['navigator', 'HTMLElement', 'Node'], rootId: 'root' });
  const prefetched = [];
  const descriptors = new Map([
    ['terminal', { id: 'terminal', label: 'Terminal', icon: () => null, onPrefetch: () => prefetched.push('chunk') }],
  ]);
  const props = {
    workbenchSideLayout: { layout: { left: [], right: [['terminal']] } },
    paneSideDocks: { entryFor: () => ({ open: false, view: null, surface: '', diff: null }) },
    sessionSurfaces: {
      sessionSideSurfaces: new Map(),
      sessionDiffs: new Map(),
      sessionPanelViews: new Map(),
      sessionSurfaceSources: new Map(),
      panelViewFronts: new Set(),
      terminalSurfaces: { prewarm: () => {} },
    },
    sideViewDescriptors: descriptors,
    selectWorkbenchSideView: () => {},
    closePaneRightRegion: () => {},
    focusLeaf: () => {},
  };
  const leaf = (sessionId) => ({
    id: 'leaf-1',
    activeKey: `session:${sessionId}`,
    tabs: [{ kind: 'session', id: sessionId }],
  });
  // Renders the strip's toggles and records the descriptors they receive.
  const seen = [];
  const draw = (sessionId, key = 'pane') =>
    act(async () =>
      root.render(
        React.cloneElement(renderPaneDockStripTrailing(leaf(sessionId), props), {
          key,
          children: (received) => {
            seen.push(received);
            return null;
          },
        })
      )
    );
  await draw('warm-a');
  await draw('warm-a');
  assert.equal(seen.at(-1), seen[0], 'the same session keeps one descriptor map across renders');
  assert.notEqual(seen[0], descriptors);
  await draw('warm-b');
  assert.notEqual(seen.at(-1), seen[0], 'a session change builds the next map (the pane keeps only its current one)');
  seen.at(-1).get('terminal').onPrefetch();
  assert.deepEqual(prefetched, ['chunk'], 'the shared prefetch still runs');
  await act(async () => root.unmount());
});
