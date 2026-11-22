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

test('a close handoff presents the closed session only in the cold surface, never in a warm retained one', () => {
  const renderer = createPaneConversationRenderer({
    conversationHandoff: { kind: 'close', leafId: 'leaf-1', selection: { kind: 'session', id: 'closed' } },
    resolvedDraftPrefsFor: () => ({ projectPath: '', modelSelection: null, workflow: null, orchestrationMode: 'none' }),
    sessions: [],
    registeredProjectPath: (path) => path,
    projectChromeLabel: (path) => path,
    paneSubmitFor: () => async () => undefined,
    paneDraftSubmitFor: () => async () => undefined,
    submit: async () => undefined,
    openFileTab: () => {},
    openAgentSession: () => {},
  });
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    const cold = renderer({ kind: 'session', id: 'fallback' }, true, () => {}, 'leaf-1');
    assert.equal(cold.props.handoffActive, true);
    assert.equal(cold.props.conversationProps.sessionId, 'closed');
    const warm = renderer({ kind: 'session', id: 'fallback' }, true, () => {}, 'leaf-1', true);
    assert.equal(warm.props.handoffActive, false);
    assert.equal(warm.props.conversationProps.sessionId, 'fallback');
    // The pane tells the surface whether it is on screen (not parked behind a file or utility tab).
    assert.equal(cold.props.conversationProps.surfaceVisible, true);
    const parked = renderer({ kind: 'session', id: 'fallback' }, false, () => {}, 'leaf-1', true, false);
    assert.equal(parked.props.conversationProps.surfaceVisible, false);
  } finally {
    globalThis.window = previousWindow;
  }
});

function setupPaneRenderer() {
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
  return {
    dom,
    root,
    renderer,
    baseOptions,
    tabCalls,
    dockCalls,
    counts: {
      paneSubmit: () => paneSubmitCalls,
      paneDraftSubmit: () => paneDraftSubmitCalls,
      defaultSubmit: () => defaultSubmitCalls,
    },
  };
}

test('createPaneConversationRenderer titles each pane and routes its submit by selection', async () => {
  const { root, renderer, counts } = setupPaneRenderer();

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
  const recordedPaneSubmitCalls = counts.paneSubmit();
  const recordedPaneDraftSubmitCalls = counts.paneDraftSubmit();
  const fallbackElement = renderer({ kind: 'project', path: '/projects/active' }, true, () => {}, 'leaf-1');
  assert.equal(fallbackElement.props.title, 'New task');
  assert.equal(await fallbackElement.props.conversationProps.submit(), 'defaultSubmit');
  assert.equal(counts.paneSubmit(), recordedPaneSubmitCalls);
  assert.equal(counts.paneDraftSubmit(), recordedPaneDraftSubmitCalls);
  assert.equal(counts.defaultSubmit(), 1);

  await act(async () => {
    root.unmount();
  });
});

test('a transcript file link opens in the pane side dock, else a main tab previewed per the link preference', async () => {
  const { root, renderer, baseOptions, tabCalls, dockCalls } = setupPaneRenderer();
  const sessionElement = renderer({ kind: 'session', id: 'session-123' }, true, () => {}, 'leaf-1');
  await act(async () => {
    root.render(sessionElement);
  });
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

test("a draft pane's pickers stage its own draft whether or not the pane has focus", () => {
  const { baseOptions } = setupPaneRenderer();
  const calls = [];
  const renderer = createPaneConversationRenderer({
    ...baseOptions,
    conversationSelectProject: (...args) => calls.push(['project', ...args]),
    conversationClearProject: (...args) => calls.push(['clear', ...args]),
    stageNewTaskModelSelection: (...args) => calls.push(['model', ...args]),
    stageNewTaskWorkflow: (...args) => calls.push(['workflow', ...args]),
    stageNewTaskOrchestrationMode: (...args) => calls.push(['mode', ...args]),
  });
  const props = renderer({ kind: 'new', draftId: 'draft-b' }, false, () => {}, 'leaf-2').props.conversationProps;
  props.onSelectProject('C:/p');
  props.onClearProject();
  props.onDraftModelSelection({ provider: 'p', model: 'm' });
  props.onDraftWorkflow({ id: 'w', name: 'W' });
  props.onDraftOrchestrationMode('swarm');
  assert.deepEqual(calls, [
    ['project', 'C:/p', 'draft-b'],
    ['clear', 'draft-b'],
    ['model', { provider: 'p', model: 'm' }, 'draft-b'],
    ['workflow', { id: 'w', name: 'W' }, 'draft-b'],
    ['mode', 'swarm', 'draft-b'],
  ]);
});

test("a draft pane's panel holds its pickers in the commit that shows it, and the composer drops its line", async () => {
  const { dom, root, renderer } = setupPaneRenderer();
  const { publishSessionRailSlot, draftRailOwner } = await import('../session-rail-layout.ts');
  const slot = dom.window.document.createElement('div');
  dom.window.document.body.append(slot);
  publishSessionRailSlot('leaf-1', { element: slot, sessionId: draftRailOwner('default') });
  try {
    act(() => root.render(renderer({ kind: 'new' }, true, () => {}, 'leaf-1')));
    assert.ok(slot.querySelector('[data-category="info"] button[title="Project"]'), 'the Project picker, at once');
    assert.equal(dom.window.document.querySelector('.composer-model-line-context'), null, 'no chips under the composer');
    // The draft's panel loads the session's cards; the first message's session draws them in its commit.
    await act(async () => {
      await import('../SessionRail.tsx');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    publishSessionRailSlot('leaf-1', { element: slot, sessionId: 'session-123' });
    act(() => root.render(renderer({ kind: 'session', id: 'session-123' }, true, () => {}, 'leaf-1')));
    assert.ok(slot.querySelector('.session-rail-content [data-category="info"]'), "the session's Info, at once");
  } finally {
    await act(async () => root.unmount());
    publishSessionRailSlot('leaf-1', null);
  }
});

test("only the pane's own conversation is offered the pane's session panel; one drawn in its dock is not", () => {
  const { renderer } = setupPaneRenderer();
  const own = renderer({ kind: 'session', id: 'session-123' }, true, () => {}, 'leaf-1');
  assert.equal(own.props.conversationProps.paneLeafId, 'leaf-1');
  const docked = renderer({ kind: 'session', id: 'agent-1' }, false, () => {}, 'leaf-1', false, true, null, false);
  assert.equal(docked.props.conversationProps.paneLeafId, undefined);
});
