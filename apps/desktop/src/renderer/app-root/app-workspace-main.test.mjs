import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { AppWorkspaceMain } from './AppWorkspaceMain.tsx';

test('AppWorkspaceMain renders PaneWorkspace with conversation header and controls', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'CustomEvent']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
  dom.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.window.mixdogDesktop = {
    invokeCapability: async () => ({}),
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const paneWorkspace = {
    leaves: [{ id: 'leaf-1', tabs: [{ kind: 'session', id: 's1' }], activeTabKey: 'session:s1' }],
    focusedLeafId: 'leaf-1',
    focusedLeaf: { id: 'leaf-1', tabs: [{ kind: 'session', id: 's1' }], activeTabKey: 'session:s1' },
    layout: { type: 'leaf', id: 'leaf-1' },
    focusLeaf: () => {},
    activateTab: () => {},
    setPaneWorkspace: () => {},
  };

  const props = {
    navigationSelection: { kind: 'session', id: 's1' },
    visibleSessionTitle: 'Active Task Header',
    selectedSession: undefined,
    headerTitleEditingSessionId: '',
    headerTitleDraft: '',
    headerTitleInvalid: false,
    openHeaderTitleEditor: () => {},
    setHeaderTitleDraft: () => {},
    commitHeaderTitleEditor: () => {},
    closeHeaderTitleEditor: () => {},
    activeProjectLabel: 'demo-app',
    transcriptRendererPending: false,
    invokeResult: async () => undefined,
    errors: [],
    submit: async () => {},
    applySnapshot: () => {},
    composerFocusRequest: 0,
    conversationNewTask: () => {},
    conversationClearToNewTask: () => {},
    conversationClearProject: () => {},
    conversationResumeSession: () => {},
    openSidebar: () => {},
    conversationOpenProjects: () => {},
    openSettings: () => {},
    projects: [],
    selection: { kind: 'session', id: 's1' },
    newTaskModelSelection: null,
    newTaskWorkflow: null,
    newTaskOrchestrationMode: 'none',
    stageNewTaskModelSelection: () => {},
    rememberSessionRouteForNextTask: () => {},
    stageNewTaskWorkflow: () => {},
    stageNewTaskOrchestrationMode: () => {},
    activeProjectPath: '/p',
    conversationSelectProject: () => {},
    openFileTab: () => {},
    openConversationCommandSurface: () => {},
    paneWorkspace,
    observedAgentSessionIds: [],
    paneStripFor: () => null,
    paneConversationSurface: () => React.createElement('div', { className: 'mock-conv' }),
    paneFileEditors: null,
    paneUtilityTabs: null,
    renderPaneSideDock: () => null,
    renderPaneProblems: () => null,
    activatePaneSurface: () => {},
    openDroppedPaths: async () => {},
  };

  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(AppWorkspaceMain, props));
  });

  const conv = dom.window.document.querySelector('.mock-conv');
  assert.notEqual(conv, null);

  await act(async () => {
    root.unmount();
  });
});
