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

async function mountDoneDotApp(t) {
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
  const state = { focused: false };
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => state.focused });
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

  return {
    state,
    viewed,
    sessionRow,
    botRow,
    tabCell,
    turn,
    clear: () => act(async () => push([])),
    pushPool: (rows) => act(async () => pushPool(rows)),
  };
}

test('a turn that finishes while unfocused takes the done dot on the session row, bot row and tab', async (t) => {
  const { sessionRow, botRow, tabCell, turn } = await mountDoneDotApp(t);
  await turn(false, 1);
  await turn(true, 1);
  assert.ok(sessionRow().querySelector('.session-row-spinner'), 'running: the session row spins');
  assert.ok(botRow().querySelector('.session-row-spinner'), 'running: the bot row spins');
  await turn(false, 3);
  assert.ok(sessionRow().querySelector('.session-row-unread-dot'), 'the session row shows the done dot');
  assert.ok(botRow().querySelector('.session-row-unread-dot'), 'the bot row shows the done dot');
  assert.ok(tabCell().querySelector('.workspace-tab-unread-dot'), 'the tab shows the done dot');
});

test('a final push that settles the turn before the message count moves still takes the done dot', async (t) => {
  const { sessionRow, botRow, turn, clear } = await mountDoneDotApp(t);
  await turn(false, 1);
  await turn(true, 1);
  await turn(false, 3);
  await clear();
  await turn(true, 3);
  await turn(false, 3);
  assert.ok(sessionRow().querySelector('.session-row-unread-dot'), 'completion alone: session row dot');
  assert.ok(botRow().querySelector('.session-row-unread-dot'), 'completion alone: bot row dot');
});

test('a turn that finishes while the window is focused on another session takes the done dot', async (t) => {
  const { state, viewed, sessionRow, botRow, turn, clear } = await mountDoneDotApp(t);
  await turn(false, 1);
  await turn(true, 1);
  await turn(false, 3);
  state.focused = true;
  viewed.current = 'someone-else';
  await clear();
  await turn(true, 3);
  await turn(false, 4);
  assert.ok(sessionRow().querySelector('.session-row-unread-dot'), 'focused elsewhere: session row dot');
  assert.ok(botRow().querySelector('.session-row-unread-dot'), 'focused elsewhere: bot row dot');
});

test('a finished lead run in the agent pool takes the done dot', async (t) => {
  const { sessionRow, botRow, turn, clear, pushPool } = await mountDoneDotApp(t);
  await turn(false, 1);
  await turn(true, 1);
  await turn(false, 3);
  await clear();
  await turn(true, 3);
  await pushPool([
    {
      tag: 'lead',
      sessionId: SESSION.id,
      ownerSessionId: SESSION.id,
      agent: 'lead',
      status: 'completed',
      stage: 'done',
    },
    { tag: 'lead2', sessionId: HOME.id, ownerSessionId: HOME.id, agent: 'lead', status: 'completed', stage: 'done' },
  ]);
  await turn(false, 5);
  assert.ok(sessionRow().querySelector('.session-row-unread-dot'), 'pool row: session row dot');
  assert.ok(botRow().querySelector('.session-row-unread-dot'), 'pool row: bot row dot');
});
