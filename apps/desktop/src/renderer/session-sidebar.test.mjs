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

    const archivedHeader = archivedSection.querySelector('.sidebar-category-header');
    const press = (key) =>
      act(async () => {
        archivedHeader.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
    await press('Escape');
    assert.equal(document.querySelector('.row-overflow-menu'), null);
    await act(async () => {
      archivedHeader.dispatchEvent(
        new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 30 })
      );
    });
    assert.ok(document.querySelector('.row-overflow-menu'), 'menu opens');
    assert.ok(document.querySelector('.row-overflow-menu [data-action-id="restore-all"]'));
    await press('Escape');
    assert.equal(document.querySelector('.row-overflow-menu'), null);
    await press('ContextMenu');
    assert.ok(document.querySelector('.row-overflow-menu'));
    await press('Escape');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('registered projects list as folders above an unchanged Recent', async () => {
  const { restore } = installDom();
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const root = createRoot(document.getElementById('root'));
  const session = (id, activityAt, fields) => ({
    id,
    title: id,
    preview: '',
    updatedAt: activityAt,
    activityAt,
    messageCount: 1,
    cwd: '',
    classification: 'task',
    projectPath: null,
    working: false,
    ...fields,
  });
  const started = [];
  // A saved category order puts Recent above Projects; categories it does not
  // name keep their default places after it.
  window.localStorage.setItem('mixdog:session-sidebar-section-order', JSON.stringify(['recent', 'projects']));
  try {
    await act(async () =>
      root.render(
        React.createElement(SessionSidebar, {
          open: true,
          sessions: [
            session('alpha-cwd', 5, { cwd: 'C:\\Work\\Alpha\\' }),
            session('loose', 4, { cwd: 'D:/elsewhere' }),
            session('beta-project', 3, { projectPath: 'c:/work/beta' }),
            session('alpha-old', 1, { projectPath: 'C:/Work/Alpha' }),
          ],
          sessionsReady: true,
          projects: [
            { name: 'Beta', path: 'C:/Work/Beta', alias: null },
            { name: 'Alpha', path: 'C:/Work/Alpha', alias: 'alpha-app' },
            { name: 'Empty', path: 'C:/Work/Empty', alias: null },
          ],
          onNewProjectTask(path) {
            started.push(path);
          },
          selection: { kind: 'new' },
          onNewTask() {},
          onNewStudio() {},
          onResumeSession() {},
          async onRenameSession() {},
          async onArchiveSession() {},
          async onDeleteSession() {},
        })
      )
    );
    const ids = (node) =>
      [...node.querySelectorAll('.session-row[data-session-id]')].map((row) => row.dataset.sessionId);
    const recent = document.querySelector('section[aria-label="Recent sessions"]');
    assert.deepEqual(ids(recent), ['alpha-cwd', 'loose', 'beta-project', 'alpha-old']);
    assert.deepEqual(
      [...document.querySelectorAll('.session-sidebar-scroll > section')].map((section) =>
        section.getAttribute('aria-label')
      ),
      ['Recent sessions', 'Projects']
    );
    assert.equal(recent.querySelector('.sidebar-category-header').getAttribute('draggable'), 'true');
    // Releasing over a section's rows reorders it, and the split is the
    // target's heading: just below the heading already means "after", even
    // far above the middle of a tall section.
    const dataTransfer = { setData() {}, getData: () => '', effectAllowed: '', dropEffect: '' };
    const drag = (target, type, clientY) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { dataTransfer, clientY, clientX: 0 });
      target.dispatchEvent(event);
    };
    const dropSection = document.querySelector('section[aria-label="Projects"]');
    dropSection.getBoundingClientRect = () => ({ top: 400, bottom: 800, height: 400, left: 0, right: 0 });
    dropSection.querySelector(':scope > .sidebar-category-header').getBoundingClientRect = () => ({
      top: 400,
      bottom: 432,
      height: 32,
      left: 0,
      right: 0,
    });
    const projectFolder = dropSection.querySelector('.project-folder');
    await act(async () => {
      drag(recent.querySelector('.sidebar-category-header'), 'dragstart', 0);
      drag(projectFolder, 'dragover', 450);
    });
    assert.equal(dropSection.getAttribute('data-drop-position'), 'after');
    await act(async () => {
      drag(projectFolder, 'drop', 450);
    });
    assert.deepEqual(
      [...document.querySelectorAll('.session-sidebar-scroll > section')].map((section) =>
        section.getAttribute('aria-label')
      ),
      ['Projects', 'Recent sessions']
    );
    const projectsSection = document.querySelector('section[aria-label="Projects"]');
    const groups = () => [...projectsSection.querySelectorAll('.project-group')];
    assert.deepEqual(
      groups().map((group) => group.querySelector('.project-folder-toggle').textContent),
      ['alpha-app', 'Beta', 'Empty']
    );
    // Folders start closed; opening one shows its sessions, an empty one says so.
    assert.deepEqual(ids(projectsSection), []);
    await act(async () => {
      groups()[0].querySelector('.project-folder-toggle').click();
      groups()[2].querySelector('.project-folder-toggle').click();
    });
    assert.deepEqual(ids(groups()[0]), ['alpha-cwd', 'alpha-old']);
    assert.match(groups()[2].textContent, /No sessions/);
    assert.deepEqual(JSON.parse(window.localStorage.getItem('mixdog:session-sidebar-expanded-projects')), [
      'c:/work/alpha',
      'c:/work/empty',
    ]);
    await act(async () => {
      groups()[1].querySelector('.project-folder-new').click();
    });
    assert.deepEqual(started, ['C:/Work/Beta']);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('right-click menus offer per-target actions for sessions and project folders', async () => {
  const { restore } = installDom();
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const root = createRoot(document.getElementById('root'));
  const calls = [];
  const row = (id, fields = {}) => ({
    id,
    title: id,
    preview: '',
    updatedAt: 1,
    activityAt: 1,
    messageCount: 1,
    cwd: 'C:/Work/Alpha',
    classification: 'task',
    projectPath: null,
    working: false,
    ...fields,
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const menuLabels = () =>
    [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent);
  const choose = (label) =>
    [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
      .find((item) => item.textContent === label)
      .click();
  const rightClick = (element) =>
    element.dispatchEvent(
      new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
    );
  try {
    await act(async () =>
      root.render(
        React.createElement(SessionSidebar, {
          open: true,
          sessions: [row('live'), row('parked', { archived: true })],
          sessionsReady: true,
          projects: [{ name: 'Alpha', path: 'C:/Work/Alpha', alias: null }],
          selection: { kind: 'new' },
          onNewTask() {},
          onNewStudio() {},
          onNewProjectTask: (path) => calls.push(['new-task', path]),
          onResumeSession: (id) => calls.push(['open', id]),
          onOpenSessionInSplit: (id) => calls.push(['split', id]),
          onInheritSession: (id) => calls.push(['inherit', id]),
          onRenameProject: (path, alias) => calls.push(['rename-project', path, alias]),
          onRevealProject: (path) => calls.push(['reveal', path]),
          onOpenProjectSettings: (path) => calls.push(['settings', path]),
          async onRenameSession() {},
          async onArchiveSession(id, archived) {
            calls.push(['archive', id, archived]);
          },
          async onFavoriteSession() {},
          async onDeleteSession() {},
        })
      )
    );
    const recent = document.querySelector('section[aria-label="Recent sessions"]');
    const liveRow = recent.querySelector('.session-row[data-session-id="live"]');
    await act(async () => rightClick(liveRow));
    assert.deepEqual(menuLabels(), [
      'Open',
      'Open in split pane',
      'Rename',
      'Inherit session',
      'Add to favorites',
      'Archive',
      'Delete',
    ]);
    await act(async () => choose('Open in split pane'));
    assert.deepEqual(calls.pop(), ['split', 'live']);
    // Delete only arms the row's inline confirmation; nothing is deleted yet.
    await act(async () => rightClick(liveRow));
    await act(async () => {
      choose('Delete');
      await tick();
    });
    assert.ok(liveRow.classList.contains('confirming-delete'));
    assert.ok(liveRow.querySelector('.session-row-delete-confirm'));
    assert.equal(liveRow.querySelector('.session-row-favorite'), null);

    // Archived rows trade favorite/archive/inherit for restore.
    await act(async () => {
      document.querySelector('section[aria-label="Archived sessions"] .sidebar-heading-toggle').click();
    });
    const parkedRow = document.querySelector('.session-row[data-session-id="parked"]');
    await act(async () => rightClick(parkedRow));
    assert.deepEqual(menuLabels(), ['Open', 'Open in split pane', 'Rename', 'Restore', 'Delete']);
    await act(async () => choose('Restore'));
    assert.deepEqual(calls.pop(), ['archive', 'parked', false]);

    // Project folder menu, then an inline rename committed with Enter.
    const folder = document.querySelector('.project-folder');
    await act(async () => rightClick(folder));
    assert.deepEqual(menuLabels(), [
      'New task',
      'Expand Alpha',
      'Reveal in Explorer',
      'Copy path',
      'Rename',
      'Project settings',
    ]);
    await act(async () => choose('Project settings'));
    assert.deepEqual(calls.pop(), ['settings', 'C:/Work/Alpha']);
    await act(async () => rightClick(folder));
    await act(async () => {
      choose('Rename');
      await tick();
    });
    const input = folder.querySelector('.project-folder-rename');
    assert.ok(input);
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setValue.call(input, 'Alpha App');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    assert.deepEqual(calls.pop(), ['rename-project', 'C:/Work/Alpha', 'Alpha App']);
    assert.equal(folder.querySelector('.project-folder-rename'), null);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
