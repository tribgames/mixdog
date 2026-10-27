// A top-level session or a bot chat that finishes while its window is not
// focused takes the green done dot on the sidebar rows and the tab strip.
// The sessions come through the real catalog and unread hooks, as the app
// wires them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

const base = {
  preview: '',
  updatedAt: 1,
  activityAt: 1,
  cwd: '',
  classification: 'task',
  projectPath: null,
};
const SESSION = { ...base, id: 'sess_top', title: 'Top level', messageCount: 1 };
const HOME = { ...base, id: 'sess_home_watcher', title: 'Watcher', messageCount: 1, agentHome: 'watcher' };

test('a top-level session and a bot chat that finish while unfocused take the done dot on sidebar rows and tabs', async (t) => {
  const { root, document, window } = installTestDom(t, {
    rootId: 'root',
    expose: ['HTMLElement', 'CustomEvent', 'navigator'],
  });
  window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
  window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
  globalThis.ResizeObserver = window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  let focused = false;
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
  let push = () => {};
  let pushPool = () => {};
  window.mixdogDesktop = {
    invokeCapability: async ({ capability }) =>
      capability === 'listAgents'
        ? { value: [{ id: 'watcher', custom: true, kind: 'bot', definition: { name: 'Watcher' } }] }
        : { value: null },
    listSessions: async () => [],
    subscribeSessions: (listener) => {
      push = listener;
      return () => {};
    },
    listAgentPool: async () => [],
    subscribeAgentPool: (listener) => {
      pushPool = listener;
      return () => {};
    },
    markSessionRead: async () => true,
  };
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const { WorkspaceTabStrip } = await import('./WorkspaceTabStrip.tsx');
  const { useSessionCatalog } = await import('./app-session-catalog.ts');
  const { useUnreadSessions } = await import('./app-unread-sessions.ts');
  const { setBotHiddenInSidebar } = await import('./sidebar-hidden-bots-store.ts');
  setBotHiddenInSidebar('watcher', false);

  const viewed = { current: '' };
  const noop = () => {};
  const asyncNoop = async () => {};
  function App() {
    const viewedSessionRef = viewed;
    const { unreadSessionIds, reconcileUnreadSessions } = useUnreadSessions({ viewedSessionRef });
    const { sessions } = useSessionCatalog(reconcileUnreadSessions);
    const working = new Set(sessions.filter((session) => session.working).map((session) => session.id));
    const tab = { key: `session:${SESSION.id}`, title: SESSION.title, selection: { kind: 'session', id: SESSION.id } };
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(SessionSidebar, {
        open: true,
        sessions,
        sessionsReady: true,
        selection: { kind: 'new' },
        workingSessionIds: working,
        unreadSessionIds,
        onNewTask: noop,
        onNewStudio: noop,
        onResumeSession: noop,
        onRenameSession: asyncNoop,
        onFavoriteSession: asyncNoop,
        onArchiveSession: asyncNoop,
        onDeleteSession: asyncNoop,
      }),
      React.createElement(WorkspaceTabStrip, {
        tabs: [tab],
        activeKey: 'none',
        workingSessionIds: working,
        unreadSessionIds,
        onSelectTab: noop,
        onCloseTab: noop,
        onReorderTab: noop,
        onNewTask: noop,
      })
    );
  }
  await act(async () => root.render(React.createElement(App)));
  await settle();

  const sessionRow = () => document.querySelector(`.session-row[data-session-id="${SESSION.id}"]`);
  const botRow = () => document.querySelector('.sidebar-agents [data-agent-contact="watcher"]');
  const tabCell = () => document.querySelector(`.workspace-tab[data-tab-key="session:${SESSION.id}"]`);
  const turn = (working, messageCount) =>
    act(async () =>
      push([
        { ...SESSION, messageCount, ...(working ? { working: true } : {}) },
        { ...HOME, messageCount, ...(working ? { working: true } : {}) },
      ])
    );

  await turn(false, 1);
  await turn(true, 1);
  assert.ok(sessionRow().querySelector('.session-row-spinner'), 'running: the session row spins');
  assert.ok(botRow().querySelector('.session-row-spinner'), 'running: the bot row spins');
  await turn(false, 3);
  assert.ok(sessionRow().querySelector('.session-row-unread-dot'), 'the session row shows the done dot');
  assert.ok(botRow().querySelector('.session-row-unread-dot'), 'the bot row shows the done dot');
  assert.ok(tabCell().querySelector('.workspace-tab-unread-dot'), 'the tab shows the done dot');

  // Variant: the final push settles the turn before the message count moves.
  await act(async () => push([]));
  await turn(true, 3);
  await turn(false, 3);
  assert.ok(sessionRow().querySelector('.session-row-unread-dot'), 'completion alone: session row dot');
  assert.ok(botRow().querySelector('.session-row-unread-dot'), 'completion alone: bot row dot');

  // Variant: the window is focused on another session.
  focused = true;
  viewed.current = 'someone-else';
  await act(async () => push([]));
  await turn(true, 3);
  await turn(false, 4);
  assert.ok(sessionRow().querySelector('.session-row-unread-dot'), 'focused elsewhere: session row dot');
  assert.ok(botRow().querySelector('.session-row-unread-dot'), 'focused elsewhere: bot row dot');
  focused = false;

  // Variant: a finished lead run sits in the agent pool.
  await act(async () => push([]));
  await turn(true, 3);
  await act(async () =>
    pushPool([
      {
        tag: 'lead',
        sessionId: SESSION.id,
        ownerSessionId: SESSION.id,
        agent: 'lead',
        status: 'completed',
        stage: 'done',
      },
      { tag: 'lead2', sessionId: HOME.id, ownerSessionId: HOME.id, agent: 'lead', status: 'completed', stage: 'done' },
    ])
  );
  await turn(false, 5);
  assert.ok(sessionRow().querySelector('.session-row-unread-dot'), 'pool row: session row dot');
  assert.ok(botRow().querySelector('.session-row-unread-dot'), 'pool row: bot row dot');
});
