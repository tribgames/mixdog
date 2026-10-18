import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const row = (id, extra = {}) => ({
  id,
  title: `Title ${id}`,
  preview: '',
  updatedAt: 1,
  activityAt: id.length,
  messageCount: 1,
  cwd: '',
  classification: 'task',
  projectPath: null,
  working: false,
  ...extra,
});

async function mount(t) {
  const { root, document } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const calls = [];
  await act(async () =>
    root.render(
      React.createElement(SessionSidebar, {
        open: true,
        sessions: [row('busy'), row('idle-session'), row('archived-busy', { archived: true })],
        sessionsReady: true,
        selection: { kind: 'new' },
        workingSessionIds: new Set(['busy', 'archived-busy']),
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
  return { document, calls };
}

const sessionRow = (document, id) => document.querySelector(`.session-row[data-session-id="${id}"]`);
const dialog = (document) => document.querySelector('[role="alertdialog"]');
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
const button = (scope, text) => [...scope.querySelectorAll('button')].find((el) => el.textContent === text);

async function contextMenuItem(document, id, label) {
  await act(async () =>
    sessionRow(document, id).dispatchEvent(
      new document.defaultView.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
    )
  );
  const item = [...document.querySelectorAll('[role^="menuitem"]')].find((el) => el.textContent === label);
  assert.ok(item, `${label} menu item`);
  await act(async () => item.click());
  await flush();
}

test('a busy session asks before archive by the row button and the context menu; cancel keeps it', async (t) => {
  const { document, calls } = await mount(t);
  await act(async () => sessionRow(document, 'busy').querySelector('.session-row-archive').click());
  assert.ok(dialog(document));
  assert.match(dialog(document).textContent, /work in progress/i);
  await act(async () => button(dialog(document), 'Cancel').click());
  assert.equal(dialog(document), null);
  assert.deepEqual(calls, []);

  await contextMenuItem(document, 'busy', 'Archive');
  assert.ok(dialog(document));
  assert.deepEqual(calls, []);
  await act(async () => button(dialog(document), 'Archive').click());
  assert.deepEqual(calls, ['archive:busy:true']);
});

test('a busy session asks before delete by the context menu and the archived row button', async (t) => {
  const { document, calls } = await mount(t);
  await contextMenuItem(document, 'busy', 'Delete');
  assert.ok(dialog(document));
  assert.equal(sessionRow(document, 'busy').classList.contains('confirming-delete'), false);
  await act(async () => button(dialog(document), 'Cancel').click());
  assert.deepEqual(calls, []);
  assert.ok(sessionRow(document, 'busy'));

  await contextMenuItem(document, 'busy', 'Delete');
  await act(async () => button(dialog(document), 'Delete').click());
  assert.deepEqual(calls, ['delete:busy']);

  await act(async () => document.querySelector('.sidebar-archived-toggle').click());
  await act(async () => sessionRow(document, 'archived-busy').querySelector('.session-row-delete').click());
  assert.ok(dialog(document));
  assert.deepEqual(calls, ['delete:busy']);
  await act(async () => button(dialog(document), 'Cancel').click());
  assert.deepEqual(calls, ['delete:busy']);
});

test('an idle session archives at once and keeps the inline delete confirm', async (t) => {
  const { document, calls } = await mount(t);
  await act(async () => sessionRow(document, 'idle-session').querySelector('.session-row-archive').click());
  assert.equal(dialog(document), null);
  assert.deepEqual(calls, ['archive:idle-session:true']);

  await contextMenuItem(document, 'idle-session', 'Delete');
  assert.equal(dialog(document), null);
  assert.ok(sessionRow(document, 'idle-session').classList.contains('confirming-delete'));
  assert.deepEqual(calls, ['archive:idle-session:true']);
});
