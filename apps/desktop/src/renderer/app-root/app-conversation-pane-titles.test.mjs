import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><div id="root"></div></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
  actEnvironment: true,
});
test.after(restore);
globalThis.window.mixdogDesktop = { invokeCapability: async () => ({}) };

const { createPaneConversationRenderer } = await import('./app-conversation-pane-renderer.tsx');
const { initUiLanguage, setUiLanguagePreference } = await import('../i18n.ts');
const { useAppSessionTitle } = await import('../app-shell-session-title.ts');
const { renderToStaticMarkup } = await import('react-dom/server');
const { createRoot } = await import('react-dom/client');
const { useAppSessionActivity } = await import('./use-app-session-activity.ts');

function makeRenderer(sessions) {
  return createPaneConversationRenderer({
    conversationHandoff: null,
    resolvedDraftPrefsFor: () => ({
      projectPath: '/projects/draft',
      modelSelection: null,
      workflow: null,
      orchestrationMode: 'none',
    }),
    sessions,
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
    paneSubmitFor: () => async () => undefined,
    paneDraftSubmitFor: () => async () => undefined,
    submit: async () => undefined,
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
}

test('Korean pane titles localize app fallbacks and keep custom titles literal', async (t) => {
  setUiLanguagePreference('ko');
  await initUiLanguage();
  t.after(async () => {
    setUiLanguagePreference('en');
    await initUiLanguage();
  });
  const sessions = [
    { id: 'empty', title: '', preview: '', projectPath: '/projects/a' },
    { id: 'new-task', title: 'New task', projectPath: '/projects/a' },
    { id: 'settings', title: 'Settings', projectPath: '/projects/a' },
    { id: 'agent', title: 'Agent', projectPath: '/projects/a' },
  ];
  const renderer = makeRenderer(sessions);
  const titleOf = (selection) => renderer(selection, true, () => {}, 'leaf').props.title;

  assert.equal(titleOf({ kind: 'new' }), '새 작업');
  assert.equal(titleOf({ kind: 'session', id: 'missing' }), '제목 없는 세션');
  assert.equal(titleOf({ kind: 'session', id: 'empty' }), '제목 없는 세션');
  assert.equal(titleOf({ kind: 'session', id: 'new-task' }), 'New task');
  assert.equal(titleOf({ kind: 'session', id: 'settings' }), 'Settings');
  assert.equal(titleOf({ kind: 'session', id: 'agent' }), 'Agent');
  assert.equal(titleOf({ kind: 'session', id: 'empty', title: 'Settings' }), 'Settings');

  function Header({ selection }) {
    const { visibleSessionTitle } = useAppSessionTitle({
      navigationSelection: selection,
      sessions,
      tabs: [],
      renameSession() {},
    });
    return React.createElement('h1', null, visibleSessionTitle);
  }
  for (const [selection, expected] of [
    [{ kind: 'new' }, '새 작업'],
    [{ kind: 'session', id: 'empty' }, '제목 없는 세션'],
    [{ kind: 'session', id: 'new-task' }, 'New task'],
    [{ kind: 'session', id: 'settings' }, 'Settings'],
    [{ kind: 'session', id: 'agent' }, 'Agent'],
  ]) {
    document.body.innerHTML = renderToStaticMarkup(React.createElement(Header, { selection }));
    assert.equal(document.querySelector('h1').textContent, expected);
  }
});

test('background session refresh preserves localized fallback and custom tab titles', async (context) => {
  setUiLanguagePreference('ko');
  await initUiLanguage();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  context.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    setUiLanguagePreference('en');
    await initUiLanguage();
  });
  const sessions = [
    { id: 'empty', title: '', preview: '' },
    { id: 'new-task', title: 'New task' },
    { id: 'settings', title: 'Settings' },
    { id: 'agent', title: 'Agent' },
  ];
  let tabs = sessions.map((session) => ({
    key: session.id,
    title: session.title || '제목 없는 세션',
    selection: { kind: 'session', id: session.id },
  }));
  tabs.push({
    key: 'pinned',
    title: 'Settings',
    selection: { kind: 'session', id: 'empty', title: 'Settings' },
  });
  const setTabs = (update) => {
    tabs = update(tabs);
  };
  const refreshSessions = async () => {};
  const setSessionCatalogReady = () => {};
  function Activity({ rows }) {
    useAppSessionActivity({ sessions: rows, setTabs, refreshSessions, setSessionCatalogReady });
    return null;
  }
  for (const rows of [sessions, [...sessions]]) {
    await act(async () => root.render(React.createElement(Activity, { rows })));
    assert.deepEqual(
      tabs.map((tab) => tab.title),
      ['제목 없는 세션', 'New task', 'Settings', 'Agent', 'Settings']
    );
  }
});
