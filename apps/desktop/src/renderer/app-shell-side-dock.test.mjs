import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(trailingWhenSessionActive.props.sessionBound, true);
});

test("a session pane's Terminal toggle prefetch also warms that session's terminal, through one stable map", () => {
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
  const first = renderPaneDockStripTrailing(leaf('warm-a'), props).props.descriptors;
  const again = renderPaneDockStripTrailing(leaf('warm-a'), props).props.descriptors;
  const other = renderPaneDockStripTrailing(leaf('warm-b'), props).props.descriptors;
  assert.equal(first, again, 'the same session keeps one descriptor map across renders');
  assert.notEqual(first, other, 'each session has its own');
  assert.notEqual(first, descriptors);
  first.get('terminal').onPrefetch();
  assert.deepEqual(prefetched, ['chunk'], 'the shared prefetch still runs');
});
