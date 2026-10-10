import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

/** A fresh jsdom window installed as the globals the sidebar reads; `restore`
 *  puts the previous globals back and closes the window. */
function installDom() {
  return installTestDom(null, { jsdom: { url: 'http://localhost/' }, expose: ['navigator', 'CustomEvent'] });
}

test('auxiliary sidebars omit duplicate lists while a visited Sessions surface keeps its state', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  let sessions = Array.from({ length: 100 }, (_, index) => ({
    id: `retained-${index}`,
    title: `Original ${index}`,
    preview: '',
    updatedAt: 100 - index,
    activityAt: 100 - index,
    messageCount: 1,
    cwd: '',
    classification: 'task',
    projectPath: null,
    working: false,
  }));
  const props = {
    sessionsReady: true,
    selection: { kind: 'new' },
    onNewTask() {},
    onNewStudio() {},
    onResumeSession() {},
    async onRenameSession() {},
    async onArchiveSession() {},
    async onDeleteSession() {},
  };
  const render = (open, panelActive = false) =>
    act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          ...Array.from({ length: 5 }, (_, index) =>
            React.createElement(SessionSidebar, {
              ...props,
              key: index,
              sessions,
              open: index === 0 && open,
              panelActive: index === 0 ? panelActive : true,
              panelTitle: `Panel ${index}`,
              // biome-ignore lint/correctness/noChildrenProp: props object passed through to createElement
              children: React.createElement('span', null, `Panel body ${index}`),
            })
          )
        )
      )
    );
  await render(true);
  const rows = document.querySelectorAll('.session-row[data-session-id]');
  const row = rows[0];
  const scroller = document.querySelector('.session-sidebar-sessions .session-sidebar-scroll');
  assert.equal(document.querySelectorAll('.session-sidebar-sessions').length, 1);
  assert.ok(rows.length > 0 && rows.length < sessions.length);
  assert.equal(document.querySelectorAll('.session-sidebar-panels').length, 5);
  scroller.scrollTop = 47;
  await render(false);
  await render(false, true);
  assert.equal(document.querySelector('.session-sidebar-sessions .session-sidebar-scroll'), scroller);
  assert.equal(scroller.scrollTop, 47);
  sessions = sessions.map((entry, index) => (index === 0 ? { ...entry, title: 'Updated while hidden' } : entry));
  await render(false, true);
  await render(true);
  assert.equal(document.querySelector('.session-row[data-session-id]'), row);
  assert.match(row.textContent, /Updated while hidden/);
  assert.equal(scroller.scrollTop, 47);
});

test('the fixed launcher rows lead the session list and open a task or a Studio tab', async () => {
  const { dom, restore } = installDom();

  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const root = createRoot(document.getElementById('root'));
  const calls = [];
  try {
    await act(async () =>
      root.render(
        React.createElement(SessionSidebar, {
          open: true,
          sessions: [
            {
              id: 'recent-one',
              title: 'recent-one',
              preview: '',
              updatedAt: 1,
              activityAt: 1,
              messageCount: 1,
              cwd: '',
              classification: 'task',
              projectPath: null,
              working: false,
            },
          ],
          sessionsReady: true,
          selection: { kind: 'new' },
          onNewTask() {
            calls.push('task');
          },
          onNewStudio() {
            calls.push('studio');
          },
          onResumeSession() {},
          async onRenameSession() {},
          async onArchiveSession() {},
          async onDeleteSession() {},
        })
      )
    );
    const launchers = document.querySelector('nav[aria-label="New"]');
    const recentSection = document.querySelector('section[aria-label="Recent sessions"]');
    assert.ok(launchers);
    assert.ok(recentSection);
    assert.ok(
      launchers.compareDocumentPosition(recentSection) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      'the launcher rows sit above the Recent list'
    );
    // Fixed means OUTSIDE the scroller: only the lists scroll, so the
    // launchers can never slide away or let rows show through above them.
    const scroller = recentSection.closest('.session-sidebar-scroll');
    assert.ok(scroller, 'the Recent list lives in the scroller');
    assert.equal(launchers.closest('.session-sidebar-scroll'), null, 'the launcher rows stay outside the scroller');
    assert.equal(launchers.parentElement, scroller.parentElement, 'launchers and scroller share the Sessions surface');
    const [taskRow, studioRow] = launchers.querySelectorAll('button');
    assert.equal(taskRow?.textContent, 'New task');
    assert.equal(studioRow?.textContent, 'New Studio');
    await act(async () => {
      taskRow.click();
    });
    await act(async () => {
      studioRow.click();
    });
    assert.deepEqual(calls, ['task', 'studio']);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('native sidebar drag preserves the existing session title in the pane selection', async () => {
  const { dom, restore } = installDom();

  const [{ SessionSidebar }, { currentPaneDrag }] = await Promise.all([
    import('./session-sidebar.tsx'),
    import('./pane-drag-session.ts'),
  ]);
  const root = createRoot(document.getElementById('root'));
  const session = {
    id: 'named-session',
    title: 'Existing display title',
    preview: 'Original prompt',
    updatedAt: 1,
    activityAt: 1,
    messageCount: 1,
    cwd: '',
    classification: 'task',
    projectPath: null,
    working: false,
  };
  const transferData = new Map();
  const dataTransfer = {
    effectAllowed: 'none',
    dropEffect: 'none',
    setData(type, value) {
      transferData.set(type, value);
    },
    getData(type) {
      return transferData.get(type) ?? '';
    },
    setDragImage() {},
  };
  const dragEvent = (type) => {
    const event = new dom.window.Event(type, {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    return event;
  };

  try {
    await act(async () =>
      root.render(
        React.createElement(SessionSidebar, {
          open: true,
          sessions: [session],
          sessionsReady: true,
          selection: { kind: 'new' },
          onNewTask() {},
          onResumeSession() {},
          async onRenameSession() {},
          async onArchiveSession() {},
          async onDeleteSession() {},
        })
      )
    );
    const row = document.querySelector('[data-session-id="named-session"]');
    assert.ok(row);

    await act(async () => {
      row.dispatchEvent(dragEvent('dragstart'));
    });

    assert.deepEqual(currentPaneDrag()?.selection, {
      kind: 'session',
      id: 'named-session',
      title: 'Existing display title',
    });
    assert.equal(dataTransfer.getData('text/plain'), 'Existing display title');

    await act(async () => {
      row.dispatchEvent(dragEvent('dragend'));
    });
    assert.equal(currentPaneDrag(), null);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('double-clicking a captured session row starts rename without action-button spillover', async () => {
  const { dom, restore } = installDom();

  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const root = createRoot(document.getElementById('root'));
  const session = {
    id: 'rename-session',
    title: 'Rename me',
    preview: 'Original prompt',
    updatedAt: 1,
    activityAt: 1,
    messageCount: 1,
    cwd: '',
    classification: 'task',
    projectPath: null,
    working: false,
  };

  try {
    await act(async () =>
      root.render(
        React.createElement(SessionSidebar, {
          open: true,
          sessions: [session],
          sessionsReady: true,
          selection: { kind: 'new' },
          onNewTask() {},
          onResumeSession() {},
          async onRenameSession() {},
          async onArchiveSession() {},
          async onDeleteSession() {},
        })
      )
    );
    const row = document.querySelector('[data-session-id="rename-session"]');
    const action = row?.querySelector('.session-row-action');
    const input = row?.querySelector('.session-title-input');
    assert.ok(row);
    assert.ok(action);
    assert.ok(input);

    await act(async () => {
      action.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, button: 0 }));
    });
    assert.equal(input.disabled, true);

    await act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, button: 0 }));
    });
    assert.equal(input.disabled, false);
    assert.equal(document.activeElement, input);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('the Recent actions menu archives recent sessions and confirms archived deletion', async () => {
  const { restore } = installDom();

  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const root = createRoot(document.getElementById('root'));
  const session = (id, archived = false, extra = {}) => ({
    id,
    title: id,
    preview: '',
    updatedAt: 1,
    activityAt: 1,
    messageCount: 1,
    cwd: '',
    classification: 'task',
    projectPath: null,
    working: false,
    archived,
    ...extra,
  });
  const archivedCalls = [];
  const deletedCalls = [];

  try {
    await act(async () =>
      root.render(
        React.createElement(SessionSidebar, {
          open: true,
          sessions: [
            session('automation-one', false, { sourceType: 'schedule', sourceName: 'Nightly' }),
            session('recent-one'),
            session('recent-two'),
            session('archived-one', true),
          ],
          sessionsReady: true,
          unreadSessionIds: new Set(['automation-one', 'recent-one']),
          selection: { kind: 'new' },
          onNewTask() {},
          onResumeSession() {},
          async onRenameSession() {},
          async onArchiveSession(id, archived) {
            archivedCalls.push([id, archived]);
          },
          async onDeleteSession(id) {
            deletedCalls.push(id);
          },
        })
      )
    );

    const automationSection = document.querySelector('.sidebar-automations');
    const recentSection = document.querySelector('section[aria-label="Recent sessions"]');
    const archivedSection = document.querySelector('.sidebar-archived');
    const automationTrigger = automationSection?.querySelector('.row-overflow-trigger');
    const recentTrigger = recentSection?.querySelector('.row-overflow-trigger');
    const archivedTrigger = archivedSection?.querySelector('.row-overflow-trigger');
    assert.ok(automationTrigger);
    assert.ok(recentTrigger);
    assert.ok(archivedTrigger);

    await act(async () => automationTrigger.click());
    const archiveAll = document.querySelector('[data-action-id="archive-all"]');
    assert.ok(archiveAll);
    await act(async () => {
      archiveAll.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(archivedCalls, [['automation-one', true]]);

    await act(async () => recentTrigger.click());
    const archiveAllRecent = document.querySelector('[data-action-id="archive-all"]');
    assert.ok(archiveAllRecent);
    await act(async () => {
      archiveAllRecent.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(archivedCalls, [
      ['automation-one', true],
      ['recent-one', true],
      ['recent-two', true],
    ]);

    await act(async () => archivedTrigger.click());
    const restoreAll = document.querySelector('[data-action-id="restore-all"]');
    assert.ok(restoreAll);
    await act(async () => {
      restoreAll.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(archivedCalls.at(-1), ['archived-one', false]);

    await act(async () => archivedTrigger.click());
    const deleteAll = document.querySelector('[data-action-id="delete-all-archived"]');
    assert.ok(deleteAll);
    await act(async () => deleteAll.click());
    assert.deepEqual(deletedCalls, []);
    const confirmDelete = document.querySelector('[data-action-id="confirm-delete-all-archived"]');
    assert.ok(confirmDelete);
    await act(async () => {
      confirmDelete.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(deletedCalls, ['archived-one']);

    const automationToggle = automationSection.querySelector('.sidebar-heading-toggle');
    const recentToggle = recentSection.querySelector('.sidebar-heading-toggle');
    await act(async () => {
      automationToggle.click();
      recentToggle.click();
    });
    assert.ok(automationSection.querySelector('.sidebar-heading-dot'));
    assert.ok(recentSection.querySelector('.sidebar-heading-dot'));
    assert.equal(automationSection.querySelector('.row-overflow-trigger'), null);
    assert.equal(recentSection.querySelector('.row-overflow-trigger'), null);
    assert.ok(archivedSection.querySelector('.row-overflow-trigger'));
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
