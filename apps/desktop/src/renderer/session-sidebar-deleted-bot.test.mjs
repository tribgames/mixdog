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

test("a deleted bot's archived chat: its face and name, restored with its bot, a second delete only for good", async (t) => {
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
  assert.ok(row.querySelector('.session-row-bot-face'), 'the face the bot left');
  assert.match(row.textContent, /Probe/);

  // 복원 restores the bot itself (the host brings its chat out of 보관됨).
  await act(async () => row.querySelector('.session-row-restore').click());
  await settle();
  assert.deepEqual(
    invoked.filter(([name]) => name === 'restoreAgentDefinition'),
    [['restoreAgentDefinition', ['probe']]]
  );
  assert.deepEqual(calls, [], 'not a plain unarchive');

  const dialog = () => document.querySelector('.settings-confirm-dialog[role="alertdialog"]');
  const press = (label) =>
    act(async () => [...dialog().querySelectorAll('button')].find((el) => el.textContent === label).click());
  await act(async () => row.querySelector('.session-row-delete').click());
  await settle();
  assert.equal(dialog().querySelector('h3').textContent, 'Delete Probe for good?');
  assert.match(
    dialog().querySelector('p').textContent,
    /^Its conversation history and the bot's remaining data are deleted/
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

  // Its menu restores it too.
  await act(async () =>
    row.dispatchEvent(new view.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))
  );
  const items = [...document.querySelectorAll('[role^="menuitem"]')];
  assert.ok(items.some((el) => el.textContent === 'Delete'));
  await act(async () => items.find((el) => el.textContent === 'Restore').click());
  await settle();
  assert.equal(invoked.filter(([name]) => name === 'restoreAgentDefinition').length, 2);
  assert.deepEqual(calls, ['delete:sess_home_probe']);
});

test('a Sessions 봇 row opens the 봇 page contact menu: profile, off, and the archiving delete', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const { SessionSidebar } = await import('./session-sidebar.tsx');
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
  let items = await openMenu(
    new view.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
  );
  assert.deepEqual(
    items.map((el) => el.textContent),
    ['View profile', 'Turn off', 'Delete']
  );
  await act(async () => items[0].click());
  await settle();
  assert.deepEqual(opened, [['sess_home_watcher', 'Watcher']], '프로필 보기 opens its chat');

  // The Menu key opens the same menu; 삭제 asks the archive question.
  items = await openMenu(new view.KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
  await act(async () => items.find((el) => el.textContent === 'Delete').click());
  await settle();
  const dialog = document.querySelector('.settings-confirm-dialog[role="alertdialog"]');
  assert.equal(dialog.querySelector('h3').textContent, 'Delete Watcher?');
  assert.match(
    dialog.querySelector('p').textContent,
    /^The bot is archived with its chat, and all its routines stop\./
  );
  await act(async () => dialog.querySelector('button.danger').click());
  await settle();
  assert.equal(document.querySelector('.settings-confirm-dialog'), null);
  assert.deepEqual(
    invoked.filter(([name]) => name === 'deleteAgentDefinition'),
    [['deleteAgentDefinition', ['watcher']]]
  );
  assert.deepEqual(closedTabs, ['sess_home_watcher'], 'its open tabs close');
});
