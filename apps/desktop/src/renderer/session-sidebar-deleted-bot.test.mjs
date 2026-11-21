// A deleted bot's chat in Sessions → 보관됨: listed under the bot's name and
// face, restored with its bot, and deleted again only for good, after a plain
// question. The Sessions 봇 section rows carry the 봇 page's contact menu.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

/** window.mixdogDesktop with a bot catalog; every capability call recorded. */
function stubDesktop(view, agents = []) {
  const invoked = [];
  view.mixdogDesktop = {
    invokeCapability: async ({ capability, args }) => {
      invoked.push([capability, args]);
      if (capability === 'listAgents') return { value: agents };
      if (capability === 'getLeadStatus') return { value: { created: true } };
      return { value: null };
    },
    openAgentHome: async (agentId) => ({ sessionId: `sess_home_${agentId}` }),
  };
  return invoked;
}

const BOT = {
  id: 'sess_home_probe',
  title: 'Probe',
  preview: '',
  updatedAt: 1,
  activityAt: 1,
  messageCount: 2,
  cwd: '',
  classification: 'task',
  projectPath: null,
  agentHome: 'probe',
  agentDeleted: true,
  archived: true,
};

async function mountDeletedBot(t) {
  const { root, document } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const calls = [];
  const view = document.defaultView;
  const invoked = stubDesktop(view);
  // The app's themed confirm dialog (never a native window.confirm).
  view.confirm = () => assert.fail('a native confirm box must not open');
  await act(async () =>
    root.render(
      React.createElement(SessionSidebar, {
        open: true,
        sessions: [BOT],
        sessionsReady: true,
        selection: { kind: 'new' },
        workingSessionIds: new Set(),
        onNewTask() {},
        onNewStudio() {},
        onResumeSession() {},
        async onRenameSession() {},
        async onFavoriteSession() {},
        async onArchiveSession(id, archived) {
          calls.push(`archive:${id}:${archived}`);
        },
        async onDeleteSession(id) {
          calls.push(`delete:${id}`);
        },
      })
    )
  );
  await act(async () => document.querySelector('.sidebar-archived-toggle').click());
  const row = document.querySelector('.session-row[data-session-id="sess_home_probe"]');
  return { document, view, row, calls, invoked };
}

test("a deleted bot's archived chat shows the face and name the bot left", async (t) => {
  const { row } = await mountDeletedBot(t);
  assert.ok(row.querySelector('.session-row-bot-face'), 'the face the bot left');
  assert.match(row.textContent, /Probe/);
});

test("a deleted bot's archived chat restores with its bot, from the row button and from its menu", async (t) => {
  const { document, view, row, calls, invoked } = await mountDeletedBot(t);
  const restores = () => invoked.filter(([name]) => name === 'restoreAgentDefinition');
  await act(async () => row.querySelector('.session-row-restore').click());
  await settle();
  assert.deepEqual(restores(), [['restoreAgentDefinition', ['probe']]]);
  assert.deepEqual(calls, [], 'not a plain unarchive');

  await act(async () =>
    row.dispatchEvent(new view.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))
  );
  const items = [...document.querySelectorAll('[role^="menuitem"]')];
  assert.ok(items.some((el) => el.textContent === 'Delete'));
  await act(async () => items.find((el) => el.textContent === 'Restore').click());
  await settle();
  assert.equal(restores().length, 2);
  assert.deepEqual(calls, []);
});

test("a deleted bot's archived chat is deleted only for good, after a plain question", async (t) => {
  const { document, row, calls } = await mountDeletedBot(t);
  const dialog = () => document.querySelector('.settings-confirm-dialog[role="alertdialog"]');
  const press = (label) =>
    act(async () => [...dialog().querySelectorAll('button')].find((el) => el.textContent === label).click());
  await act(async () => row.querySelector('.session-row-delete').click());
  await settle();
  assert.equal(dialog().querySelector('h3').textContent, 'Delete Probe for good?');
  assert.match(
    dialog().querySelector('p').textContent,
    /^Its conversation history, its schedules and webhooks, and the bot's remaining data are deleted/
  );
  await press('Cancel');
  await settle();
  assert.equal(dialog(), null);
  assert.deepEqual(calls, [], 'declined: nothing deleted');
  await act(async () => row.querySelector('.session-row-delete').click());
  await settle();
  assert.equal(dialog().querySelector('button.danger').textContent, 'Delete', 'destructive confirm is danger-styled');
  await press('Delete');
  await settle();
  assert.equal(dialog(), null);
  assert.deepEqual(calls, ['delete:sess_home_probe']);
});

async function mountWatcherMenu(t) {
  const { root, document } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const { setBotHiddenInSidebar } = await import('./sidebar-hidden-bots-store.ts');
  setBotHiddenInSidebar('watcher', false);
  t.after(() => setBotHiddenInSidebar('watcher', false));
  const view = document.defaultView;
  const invoked = stubDesktop(view, [{ id: 'watcher', custom: true, kind: 'bot', definition: { name: 'Watcher' } }]);
  view.confirm = () => assert.fail('a native confirm box must not open');
  const opened = [];
  const closedTabs = [];
  const onDeleted = (event) => closedTabs.push(event.detail.sessionId);
  view.addEventListener('mixdog:bot-deleted', onDeleted);
  t.after(() => view.removeEventListener('mixdog:bot-deleted', onDeleted));
  const render = () =>
    root.render(
      React.createElement(SessionSidebar, {
        open: true,
        sessions: [],
        sessionsReady: true,
        selection: { kind: 'new' },
        workingSessionIds: new Set(),
        onNewTask() {},
        onNewStudio() {},
        onResumeSession() {},
        onOpenAgent: (sessionId, title) => opened.push([sessionId, title]),
        async onRenameSession() {},
        async onFavoriteSession() {},
        async onArchiveSession() {},
        async onDeleteSession() {},
      })
    );
  await act(async () => render());
  await settle();
  await act(async () => render());
  const row = document.querySelector('.sidebar-agents [data-agent-contact="watcher"]');
  assert.ok(row, 'the bot is listed in the 봇 section');
  const openMenu = async (event) => {
    await act(async () => row.dispatchEvent(event));
    return [...document.querySelectorAll('[role^="menuitem"]')];
  };
  const contextMenu = () =>
    openMenu(new view.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  return { document, view, invoked, opened, closedTabs, openMenu, contextMenu };
}

const MENU_LABELS = ['View profile', 'Rename', 'Hide from list'];

test('a Sessions 봇 row menu offers profile, rename and hide-from-list; 프로필 보기 opens its chat', async (t) => {
  const { opened, contextMenu } = await mountWatcherMenu(t);
  const items = await contextMenu();
  assert.deepEqual(
    items.map((el) => el.textContent),
    MENU_LABELS
  );
  await act(async () => items[0].click());
  await settle();
  assert.deepEqual(opened, [['sess_home_watcher', 'Watcher']], '프로필 보기 opens its chat');
});

test('the Menu key opens the same Sessions 봇 row menu; no turn-off or delete lives here', async (t) => {
  const { view, openMenu } = await mountWatcherMenu(t);
  const items = await openMenu(
    new view.KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true })
  );
  assert.deepEqual(
    items.map((el) => el.textContent),
    MENU_LABELS
  );
});

test('목록에서 숨기기 drops the bot row from the sidebar only; the bot is untouched', async (t) => {
  const { document, invoked, closedTabs, contextMenu } = await mountWatcherMenu(t);
  const { sidebarHiddenBots } = await import('./sidebar-hidden-bots-store.ts');
  const items = await contextMenu();
  await act(async () => items.find((el) => el.textContent === 'Hide from list').click());
  await settle();
  assert.equal(document.querySelector('.sidebar-agents [data-agent-contact="watcher"]'), null);
  assert.deepEqual(
    invoked.filter(([name]) => name === 'deleteAgentDefinition' || name === 'setAgentRoute'),
    []
  );
  assert.deepEqual(closedTabs, []);
  assert.ok(sidebarHiddenBots().has('watcher'));
});

test('the 봇 page keeps a hidden bot and offers 사이드바에 표시, which restores the sidebar row', async (t) => {
  const { document, contextMenu } = await mountWatcherMenu(t);
  const { agentContactMenuItems } = await import('./agent-profile-actions.ts');
  const items = await contextMenu();
  await act(async () => items.find((el) => el.textContent === 'Hide from list').click());
  await settle();
  const pageItems = () =>
    agentContactMenuItems(
      { agentId: 'watcher', name: 'Watcher', mixy: false },
      {
        onOpen() {},
        onProfile() {},
      }
    );
  assert.deepEqual(
    pageItems().map((item) => item.id),
    ['agent-profile', 'agent-rename', 'agent-show-in-sidebar', 'agent-turn-off', 'agent-delete']
  );
  pageItems()
    .find((item) => item.id === 'agent-show-in-sidebar')
    .onSelect();
  await settle();
  assert.ok(document.querySelector('.sidebar-agents [data-agent-contact="watcher"]'), 'shown again');
  assert.deepEqual(
    pageItems().map((item) => item.id),
    ['agent-profile', 'agent-rename', 'agent-turn-off', 'agent-delete']
  );
});

const WATCHER_HOME = {
  id: 'sess_home_watcher',
  title: 'Watcher',
  preview: '',
  updatedAt: 1,
  activityAt: 1,
  messageCount: 2,
  readMessageCount: 2,
  cwd: '',
  classification: 'task',
  projectPath: null,
  agentHome: 'watcher',
};

async function mountHiddenWatcher(t) {
  const { root, document } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const { setBotHiddenInSidebar, sidebarHiddenBots } = await import('./sidebar-hidden-bots-store.ts');
  const { defaultSessionLaneStore } = await import('./session-lane-store.ts');
  const { publishCatalogApprovalSessions } = await import('./session-catalog-approvals.ts');
  stubDesktop(document.defaultView, [{ id: 'watcher', custom: true, kind: 'bot', definition: { name: 'Watcher' } }]);
  setBotHiddenInSidebar('watcher', true);
  t.after(() => {
    setBotHiddenInSidebar('watcher', false);
    defaultSessionLaneStore.clear();
    publishCatalogApprovalSessions([]);
  });
  const render = (unread = new Set()) =>
    act(async () =>
      root.render(
        React.createElement(SessionSidebar, {
          open: true,
          sessions: [WATCHER_HOME],
          sessionsReady: true,
          selection: { kind: 'new' },
          workingSessionIds: new Set(),
          unreadSessionIds: unread,
          onNewTask() {},
          onNewStudio() {},
          onResumeSession() {},
          async onRenameSession() {},
          async onFavoriteSession() {},
          async onArchiveSession() {},
          async onDeleteSession() {},
        })
      )
    );
  const listed = () => document.querySelector('.sidebar-agents [data-agent-contact="watcher"]') !== null;
  await render();
  await settle();
  await render();
  assert.equal(listed(), false, 'hidden and quiet: not listed');
  return { render, listed, sidebarHiddenBots, publishCatalogApprovalSessions };
}

test('a hidden bot shows again while it has unread messages, and hides again once read', async (t) => {
  const { render, listed } = await mountHiddenWatcher(t);
  await render(new Set(['sess_home_watcher']));
  assert.equal(listed(), true, 'unread brings it back');
  await render();
  assert.equal(listed(), false, 'read: hidden again');
});

test('a hidden bot shows again while it waits on the user, and hides again once answered', async (t) => {
  const { listed, sidebarHiddenBots, publishCatalogApprovalSessions } = await mountHiddenWatcher(t);
  // Its chat is open in no pane: the host catalog says it waits on the user.
  const approval = (awaitingApproval) =>
    act(async () =>
      publishCatalogApprovalSessions([{ id: 'sess_home_watcher', agentHome: 'watcher', awaitingApproval }])
    );
  await approval(true);
  assert.equal(listed(), true, 'a pending approval brings it back');
  await approval(false);
  assert.equal(listed(), false, 'answered: hidden again');
  assert.ok(sidebarHiddenBots().has('watcher'), 'the hidden flag was kept throughout');
});

test("another window's change to the hidden list is picked up, and a write keeps it", async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root' });
  const { setBotHiddenInSidebar, sidebarHiddenBots, useSidebarHiddenBots, resetSidebarHiddenBotsCache } = await import(
    './sidebar-hidden-bots-store.ts'
  );
  resetSidebarHiddenBotsCache();
  const KEY = 'mixdog.sidebarHiddenBots';
  function Probe() {
    return React.createElement('p', { id: 'probe' }, [...useSidebarHiddenBots()].sort().join(','));
  }
  await act(async () => root.render(React.createElement(Probe)));
  const shown = () => document.getElementById('probe').textContent;
  assert.equal(shown(), '');

  // The other window wrote the list and the browser fires `storage` here.
  window.localStorage.setItem(KEY, JSON.stringify(['b']));
  await act(async () => window.dispatchEvent(new window.StorageEvent('storage', { key: KEY })));
  assert.equal(shown(), 'b');
  assert.ok(sidebarHiddenBots().has('b'));

  // An unrelated key is ignored.
  window.localStorage.setItem(KEY, JSON.stringify(['b', 'c']));
  await act(async () => window.dispatchEvent(new window.StorageEvent('storage', { key: 'other' })));
  assert.equal(shown(), 'b');

  // This window hides 'a' before it has seen the other window's latest write:
  // nothing the other window stored is lost.
  await act(async () => setBotHiddenInSidebar('a', true));
  assert.equal(shown(), 'a,b,c');
  assert.deepEqual(JSON.parse(window.localStorage.getItem(KEY)).sort(), ['a', 'b', 'c']);
});

test('changes made while nothing was subscribed are picked up when a subscriber attaches again', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root' });
  const { useSidebarHiddenBots, resetSidebarHiddenBotsCache } = await import('./sidebar-hidden-bots-store.ts');
  resetSidebarHiddenBotsCache();
  const KEY = 'mixdog.sidebarHiddenBots';
  window.localStorage.setItem(KEY, JSON.stringify(['a']));
  function Probe() {
    return React.createElement('p', { id: 'probe' }, [...useSidebarHiddenBots()].sort().join(','));
  }
  await act(async () => root.render(React.createElement(Probe)));
  assert.equal(document.getElementById('probe').textContent, 'a');

  await act(async () => root.render(null)); // last unsubscribe: the storage listener is gone
  window.localStorage.setItem(KEY, JSON.stringify(['a', 'z']));
  await act(async () => window.dispatchEvent(new window.StorageEvent('storage', { key: KEY })));

  await act(async () => root.render(React.createElement(Probe)));
  assert.equal(document.getElementById('probe').textContent, 'a,z', 'refreshed from storage on attach');
});

test('when storage refuses writes, the cached choices stay the base: A then B keeps both, show A stays shown', async (t) => {
  const { window } = installTestDom(t, {});
  const { setBotHiddenInSidebar, sidebarHiddenBots, resetSidebarHiddenBotsCache } = await import(
    './sidebar-hidden-bots-store.ts'
  );
  resetSidebarHiddenBotsCache();
  const KEY = 'mixdog.sidebarHiddenBots';
  const proto = window.Storage.prototype;
  const realSet = proto.setItem;
  proto.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  t.after(() => {
    proto.setItem = realSet;
  });
  setBotHiddenInSidebar('a', true);
  setBotHiddenInSidebar('b', true);
  assert.deepEqual([...sidebarHiddenBots()].sort(), ['a', 'b']);

  // Showing A while storage still refuses must not bring A back from anywhere.
  setBotHiddenInSidebar('a', false);
  assert.deepEqual([...sidebarHiddenBots()], ['b']);

  // Storage works again: the next change saves the cached choices (A stays shown).
  proto.setItem = realSet;
  setBotHiddenInSidebar('c', true);
  assert.deepEqual([...sidebarHiddenBots()].sort(), ['b', 'c']);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(KEY)).sort(), ['b', 'c']);

  // Once saved, storage is the base again: another window's change is taken.
  window.localStorage.setItem(KEY, JSON.stringify(['x']));
  setBotHiddenInSidebar('d', true);
  assert.deepEqual([...sidebarHiddenBots()].sort(), ['d', 'x']);
});

test('a Sessions 봇 row spins while its home chat is running, like a session row, and not when idle', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const { setBotHiddenInSidebar } = await import('./sidebar-hidden-bots-store.ts');
  stubDesktop(document.defaultView, [{ id: 'watcher', custom: true, kind: 'bot', definition: { name: 'Watcher' } }]);
  setBotHiddenInSidebar('watcher', false);
  const render = (session = WATCHER_HOME, working = new Set(), unread = new Set()) =>
    act(async () =>
      root.render(
        React.createElement(SessionSidebar, {
          open: true,
          sessions: [session],
          sessionsReady: true,
          selection: { kind: 'new' },
          workingSessionIds: working,
          unreadSessionIds: unread,
          onNewTask() {},
          onNewStudio() {},
          onResumeSession() {},
          async onRenameSession() {},
          async onFavoriteSession() {},
          async onArchiveSession() {},
          async onDeleteSession() {},
        })
      )
    );
  const row = () => document.querySelector('.sidebar-agents [data-agent-contact="watcher"]');
  const spinner = () => row().querySelector('.session-row-spinner');
  const dot = () => row().querySelector('.session-row-unread-dot');
  await render();
  await settle();
  await render();
  assert.ok(row());
  assert.equal(spinner(), null, 'idle: no spinner');
  assert.equal(dot(), null);

  await render(WATCHER_HOME, new Set(['sess_home_watcher']));
  assert.ok(spinner(), 'a running home chat shows the session-row spinner');
  assert.match(spinner().getAttribute('aria-label'), /Watcher is working/);

  await render({ ...WATCHER_HOME, working: true });
  assert.ok(spinner(), 'the session summary reporting it working spins too');

  await render(WATCHER_HOME, new Set(), new Set(['sess_home_watcher']));
  assert.equal(spinner(), null);
  assert.ok(dot(), 'finished and unread: the unread dot, no spinner');

  await render(WATCHER_HOME, new Set(['sess_home_watcher']), new Set(['sess_home_watcher']));
  assert.ok(spinner());
  assert.equal(dot(), null, 'one status at a time: the spinner wins over the dot');

  // A summary that says working wins over unread even when the caller's working set omits it.
  await render({ ...WATCHER_HOME, working: true }, new Set(), new Set(['sess_home_watcher']));
  assert.ok(spinner(), 'working + unread: the spinner, from the summary alone');
  assert.equal(dot(), null);

  // The glyph sits in the same trailing slot session rows use.
  assert.ok(spinner().closest('.session-row-status'), 'wrapped in .session-row-status');
  assert.ok(row().classList.contains('working'), 'a running row yields space to the spinner');
});

test('a Sessions 봇 row shows the amber triangle, with a digit from 2 waiting sessions, not a spinner', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const { setBotHiddenInSidebar } = await import('./sidebar-hidden-bots-store.ts');
  const { publishCatalogApprovalSessions } = await import('./session-catalog-approvals.ts');
  stubDesktop(document.defaultView, [{ id: 'watcher', custom: true, kind: 'bot', definition: { name: 'Watcher' } }]);
  setBotHiddenInSidebar('watcher', false);
  t.after(() => publishCatalogApprovalSessions([]));
  const task = { ...WATCHER_HOME, id: 'task-1', agentHome: undefined, taskAgent: 'watcher', taskFrom: 'home' };
  const render = (sessions) =>
    act(async () =>
      root.render(
        React.createElement(SessionSidebar, {
          open: true,
          sessions,
          sessionsReady: true,
          selection: { kind: 'new' },
          workingSessionIds: new Set(),
          unreadSessionIds: new Set(),
          onNewTask() {},
          onNewStudio() {},
          onResumeSession() {},
          async onRenameSession() {},
          async onFavoriteSession() {},
          async onArchiveSession() {},
          async onDeleteSession() {},
        })
      )
    );
  const row = () => document.querySelector('.sidebar-agents [data-agent-contact="watcher"]');
  const glyph = () => row().querySelector('.session-row-attention[data-status="needs-you"]');
  const task2 = { ...task, id: 'task-2' };
  // The home waits too: that is the tasks' docked copy, not a third approval.
  const waiting = [
    { ...WATCHER_HOME, working: true, awaitingApproval: true },
    { ...task, working: true, awaitingApproval: true },
    { ...task2, working: true, awaitingApproval: true },
  ];
  publishCatalogApprovalSessions(waiting);
  await render(waiting);
  await settle();
  await render(waiting);
  assert.ok(glyph(), 'the warning triangle');
  assert.equal(glyph().querySelector('.session-attention-count').textContent, '2');
  assert.match(glyph().getAttribute('aria-label'), /Watcher · (Waiting for approval \(2\)|승인 대기 2건)/);
  assert.equal(row().querySelector('.session-row-spinner'), null, 'the triangle replaces the spinner');

  const one = [waiting[0], waiting[1], { ...task2, working: true }];
  publishCatalogApprovalSessions(one);
  await render(one);
  assert.ok(glyph());
  assert.equal(glyph().querySelector('.session-attention-count'), null, 'one waiting: no digit');
  assert.match(glyph().getAttribute('aria-label'), /^Watcher · (Waiting for approval|승인 대기)$/);

  publishCatalogApprovalSessions([]);
  await render([WATCHER_HOME, task, task2]);
  assert.equal(glyph(), null, 'answered: the triangle is gone');
});

test('deleting a bot also forgets its hidden flag', async (t) => {
  installTestDom(t, { expose: ['CustomEvent'] });
  const { deleteAgent } = await import('./agent-profile-actions.ts');
  const { setBotHiddenInSidebar, sidebarHiddenBots } = await import('./sidebar-hidden-bots-store.ts');
  setBotHiddenInSidebar('watcher', true);
  setBotHiddenInSidebar('other', true);
  t.after(() => {
    setBotHiddenInSidebar('other', false);
    setBotHiddenInSidebar('watcher', false);
  });
  const deps = { api: { invokeCapability: async () => ({ value: null }) }, confirm: () => true };
  assert.equal(await deleteAgent({ ...deps, confirm: () => false }, 'watcher', 'Watcher'), false);
  assert.ok(sidebarHiddenBots().has('watcher'), 'declined: still hidden');
  assert.equal(await deleteAgent(deps, 'watcher', 'Watcher'), true);
  assert.equal(sidebarHiddenBots().has('watcher'), false);
  assert.ok(sidebarHiddenBots().has('other'), 'other bots keep their flag');
});
