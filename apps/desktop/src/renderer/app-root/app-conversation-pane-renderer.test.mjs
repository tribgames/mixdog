import test from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';
import { createPaneConversationRenderer, paneSideDockLinkRoutes } from './app-conversation-pane-renderer.tsx';
import { setLinkPreview } from '../link-preview-preference.ts';
import { isRemoteHostRenderer } from '../remote-ui-projection.ts';

test('the phone/web (remote) renderer routes file, folder, diff and jobs links into the pane side dock', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { mixdogRemoteServer: 'wss://relay.example' };
  try {
    assert.equal(isRemoteHostRenderer(), true);
    const calls = [];
    const record =
      (name) =>
      (...args) =>
        calls.push([name, ...args]);
    const handlers = {
      openFileInSideDock: record('file'),
      openFolderInSideDock: record('folder'),
      openSessionDiffInSideDock: record('diff'),
      openPreviewToSide: record('preview'),
    };
    const routes = paneSideDockLinkRoutes([['session-diff'], ['terminal']], handlers);
    assert.deepEqual(routes, handlers, 'a remote renderer with a right layout offers every side-dock route');
    const tabCalls = [];
    let focused = 0;
    const renderer = createPaneConversationRenderer({
      conversationHandoff: null,
      resolvedDraftPrefsFor: () => ({
        projectPath: '',
        modelSelection: null,
        workflow: null,
        orchestrationMode: 'none',
      }),
      sessions: [{ id: 's1', title: 'S', projectPath: '/p' }],
      registeredProjectPath: (path) => path,
      projectChromeLabel: (path) => path,
      paneSubmitFor: () => async () => undefined,
      paneDraftSubmitFor: () => async () => undefined,
      submit: async () => undefined,
      openFileTab: (...args) => tabCalls.push(args),
      openAgentSession: () => {},
      ...routes,
    });
    const props = renderer({ kind: 'session', id: 's1' }, true, () => (focused += 1), 'leaf-9').props.conversationProps;
    props.onOpenFile('/p', 'src/a.ts', 3);
    props.onOpenFolder('/p', 'src');
    props.onOpenSessionDiff();
    assert.deepEqual(calls, [
      ['file', 'leaf-9', '/p', 'src/a.ts', 3, undefined],
      ['folder', 'leaf-9', '/p', 'src'],
      ['diff', 'leaf-9'],
    ]);
    assert.deepEqual(tabCalls, [], 'no main tab opens: the editor lives in the side dock');
    assert.equal(focused, 3);

    // No right side layout: no side-dock routes, so folder/diff/jobs links are
    // not offered and files keep opening main tabs.
    assert.deepEqual(paneSideDockLinkRoutes([], handlers), {});
  } finally {
    globalThis.window = previousWindow;
  }
});

test('createPaneConversationRenderer builds conversation surface with appropriate titles and props', async () => {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'HTMLElement', 'Element', 'Event', 'CustomEvent', 'MutationObserver'],
    actEnvironment: false,
  });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
  dom.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  // The composer island reads the reduced-motion preference.
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.window.mixdogDesktop = {
    invokeCapability: async () => ({}),
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  let paneSubmitCalls = 0;
  let paneDraftSubmitCalls = 0;
  let defaultSubmitCalls = 0;

  const tabCalls = [];
  const dockCalls = [];
  const baseOptions = {
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
    openFileTab: (...args) => tabCalls.push(args),
    replaceWithInheritedSession: async () => {},
  };
  const renderer = createPaneConversationRenderer({
    ...baseOptions,
    openFileInSideDock: (...args) => dockCalls.push(args),
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

  // 6. A transcript file link opens in that pane's side dock, not a main tab.
  sessionElement.props.conversationProps.onOpenFile('C:/p', 'src/a.ts', 7, 'tok');
  assert.deepEqual(dockCalls, [['leaf-1', 'C:/p', 'src/a.ts', 7, 'tok']]);
  assert.deepEqual(tabCalls, []);
  // Without a side dock the link keeps opening a main tab.
  const noDock = createPaneConversationRenderer(baseOptions)(
    { kind: 'session', id: 'session-123' },
    true,
    () => {},
    'leaf-1'
  );
  noDock.props.conversationProps.onOpenFile('C:/p', 'src/a.ts', 7);
  // Link preview ON (default): the main tab is the preview one.
  assert.deepEqual(tabCalls, [['C:/p', 'src/a.ts', 7, undefined, true, 'preview']]);
  // Link preview OFF: every link pins its main tab.
  setLinkPreview(false);
  try {
    noDock.props.conversationProps.onOpenFile('C:/p', 'src/b.ts', 2);
  } finally {
    setLinkPreview(true);
  }
  assert.deepEqual(tabCalls.at(-1), ['C:/p', 'src/b.ts', 2, undefined, true, 'pinned']);

  await act(async () => {
    root.unmount();
  });
});
