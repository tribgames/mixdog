import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { renderPaneDockStripTrailing } from './app-shell-side-dock.tsx';

test('renderPaneDockStripTrailing uses activeKey rather than first tab, returning null when active tab is a file', () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const descriptors = new Map([['browser', { id: 'browser', label: 'Browser Use', icon: () => null }]]);

  const baseProps = {
    workbenchSideLayout: { layout: { left: [], right: [['browser']] } },
    paneSideDocks: { entryFor: () => ({ root: 'browser', open: false }) },
    sessionSurfaces: {
      sessionSideSurfaces: new Map(),
      sessionDiffs: new Map(),
      sessionPanelViews: new Map(),
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
