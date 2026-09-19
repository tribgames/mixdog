import test from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createPaneConversationRenderer } from './app-conversation-pane-renderer.tsx';

test('createPaneConversationRenderer builds conversation surface with appropriate titles and props', async () => {
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

  let paneSubmitCalls = 0;
  let paneDraftSubmitCalls = 0;
  let defaultSubmitCalls = 0;

  const renderer = createPaneConversationRenderer({
    conversationHandoff: null,
    resolvedDraftPrefsFor: () => ({
      projectPath: '/projects/draft',
      modelSelection: null,
      workflow: null,
      orchestrationMode: 'none',
    }),
    sessions: [{ id: 'session-123', title: 'My Work Session', projectPath: '/projects/active' }],
    registeredProjectPath: (path) => path,
    projectChromeLabel: (path) => path.replace('/projects/', ''),
    selectedSession: undefined,
    headerTitleEditingSessionId: '',
    headerTitleDraft: '',
    headerTitleInvalid: false,
    openHeaderTitleEditor: () => {},
    setHeaderTitleDraft: () => {},
    commitHeaderTitleEditor: () => {},
    closeHeaderTitleEditor: () => {},
    paneTranscriptRendererPending: false,
    requestedSessionId: '',
    invokeResult: async () => undefined,
    errors: [],
    paneSubmitFor: (sessionId) => {
      paneSubmitCalls += 1;
      return async () => `paneSubmit:${sessionId}`;
    },
    paneDraftSubmitFor: (selection, leafId) => {
      paneDraftSubmitCalls += 1;
      return async () => `paneDraftSubmit:${selection.kind}:${leafId}`;
    },
    submit: async () => {
      defaultSubmitCalls += 1;
      return 'defaultSubmit';
    },
    applySessionLaneResult: () => {},
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
    stageNewTaskModelSelection: () => {},
    rememberSessionRouteForNextTask: () => {},
    stageNewTaskWorkflow: () => {},
    stageNewTaskOrchestrationMode: () => {},
    conversationSelectProject: () => {},
    openConversationCommandSurface: () => {},
    openFileTab: () => {},
    replaceWithInheritedSession: async () => {},
  });

  const root = createRoot(dom.window.document.getElementById('root'));

  // 1. Render draft pane
  const draftElement = renderer({ kind: 'new' }, true, () => {}, 'leaf-1');
  await act(async () => {
    root.render(draftElement);
  });
  assert.equal(draftElement.props.title, 'New task');
  assert.equal(await draftElement.props.conversationProps.submit(), 'paneDraftSubmit:new:leaf-1');

  // 2. Render session pane
  const sessionElement = renderer({ kind: 'session', id: 'session-123' }, true, () => {}, 'leaf-1');
  await act(async () => {
    root.render(sessionElement);
  });
  assert.equal(sessionElement.props.title, 'My Work Session');
  assert.equal(sessionElement.props.projectLabel, 'active');
  assert.equal(await sessionElement.props.conversationProps.submit(), 'paneSubmit:session-123');

  // 3. Pinned title takes precedence over catalog title
  const pinnedSessionElement = renderer(
    { kind: 'session', id: 'session-123', title: 'Pinned Title' },
    true,
    () => {},
    'leaf-1'
  );
  assert.equal(pinnedSessionElement.props.title, 'Pinned Title');

  // 4. Missing session falls back to 'Untitled session' and routes to session submit
  const missingSessionElement = renderer({ kind: 'session', id: 'session-missing' }, true, () => {}, 'leaf-1');
  assert.equal(missingSessionElement.props.title, 'Untitled session');
  assert.equal(await missingSessionElement.props.conversationProps.submit(), 'paneSubmit:session-missing');

  // 5. Fallback selection routes to default submit without evaluating paneSubmitFor or paneDraftSubmitFor
  const recordedPaneSubmitCalls = paneSubmitCalls;
  const recordedPaneDraftSubmitCalls = paneDraftSubmitCalls;
  const fallbackElement = renderer({ kind: 'project', path: '/projects/active' }, true, () => {}, 'leaf-1');
  assert.equal(fallbackElement.props.title, 'New task');
  assert.equal(await fallbackElement.props.conversationProps.submit(), 'defaultSubmit');
  assert.equal(paneSubmitCalls, recordedPaneSubmitCalls);
  assert.equal(paneDraftSubmitCalls, recordedPaneDraftSubmitCalls);
  assert.equal(defaultSubmitCalls, 1);

  await act(async () => {
    root.unmount();
  });
});
