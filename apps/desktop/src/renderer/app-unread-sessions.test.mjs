import assert from 'node:assert/strict';
import { test } from 'node:test';

import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

import {
  sessionSurfaceEngaged,
  sharedReadClearsUnread,
  shouldPublishSessionRead,
  useUnreadSessions,
} from './app-unread-sessions.ts';

const row = {
  id: 'session-a',
  preview: '',
  title: 'Task',
  updatedAt: 1,
  messageCount: 4,
  readMessageCount: 4,
  readRevision: 2,
  cwd: 'C:\\Project',
  classification: 'task',
  projectPath: null,
};

test('a read revision from the other surface clears completion-only unread', () => {
  assert.equal(sharedReadClearsUnread(row, 1), true);
  assert.equal(sharedReadClearsUnread(row, undefined), false);
  assert.equal(sharedReadClearsUnread({ ...row, messageCount: 5 }, 1), false);
});

test('visible activity publishes only when the shared cursor needs advancing', () => {
  assert.equal(shouldPublishSessionRead(row, 4, false), false);
  assert.equal(shouldPublishSessionRead(row, 5, false), true);
  assert.equal(shouldPublishSessionRead(row, 4, true), true);
});

function installDom({ visibility = 'visible', focused = true } = {}) {
  const { dom, restore } = installTestDom(null, { jsdom: { url: 'http://localhost/' }, expose: ['navigator'] });
  const state = { visibility, focused };
  Object.defineProperty(dom.window.document, 'visibilityState', {
    configurable: true,
    get: () => state.visibility,
  });
  Object.defineProperty(dom.window.document, 'hasFocus', {
    configurable: true,
    value: () => state.focused,
  });
  return {
    state,
    root: createRoot(dom.window.document.getElementById('root')),
    close: restore,
  };
}

test('engagement needs attention: a visible but unfocused surface is not reading', () => {
  const dom = installDom();
  try {
    assert.equal(sessionSurfaceEngaged(), true);
    dom.state.focused = false;
    assert.equal(sessionSurfaceEngaged(), false);
    dom.state.focused = true;
    dom.state.visibility = 'hidden';
    assert.equal(sessionSurfaceEngaged(), false);
  } finally {
    dom.close();
  }
});

test('a turn that completes behind another app stays unread until focus returns', async () => {
  const dom = installDom({ focused: false });
  const api = {};
  const working = { ...row, id: 'lead-a', messageCount: 1, readMessageCount: 0, working: true };
  const settled = { ...working, working: false };
  function Harness() {
    const viewedSessionRef = useRef('lead-a');
    Object.assign(api, useUnreadSessions({ viewedSessionRef }));
    return React.createElement('div', null, [...api.unreadSessionIds].join(','));
  }
  const marks = () => document.querySelector('#root div').textContent;
  try {
    await act(async () => dom.root.render(React.createElement(Harness)));
    // The turn runs, then settles, while the window sits behind another app.
    await act(async () => api.reconcileUnreadSessions([working]));
    await act(async () => api.reconcileUnreadSessions([settled]));
    assert.equal(marks(), 'lead-a');
    // Merely coming back on screen is still not reading it.
    await act(async () => api.consumeUnread('lead-a', [settled]));
    assert.equal(marks(), 'lead-a');

    dom.state.focused = true;
    await act(async () => api.consumeUnread('lead-a', [settled]));
    assert.equal(marks(), '');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("a bot's delegated session takes no completion dot; the bot's own chat still does", async () => {
  const dom = installDom({ focused: false });
  const api = {};
  const task = { ...row, id: 'task-a', messageCount: 1, readMessageCount: 0, working: true, taskAgent: 'agent-1' };
  const home = { ...row, id: 'home-1', messageCount: 1, readMessageCount: 0, working: true };
  function Harness() {
    const viewedSessionRef = useRef('');
    Object.assign(api, useUnreadSessions({ viewedSessionRef }));
    return React.createElement('div', null, [...api.unreadSessionIds].join(','));
  }
  const marks = () => document.querySelector('#root div').textContent;
  try {
    await act(async () => dom.root.render(React.createElement(Harness)));
    await act(async () => api.reconcileUnreadSessions([task, home]));
    await act(async () =>
      api.reconcileUnreadSessions([
        { ...task, working: false, messageCount: 3 },
        { ...home, working: false, messageCount: 3 },
      ])
    );
    assert.equal(marks(), 'home-1');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('while the user reads a bot chat, a coding session that finishes takes the dot; the tasks that bot made do not', async () => {
  const dom = installDom();
  const api = {};
  const home = { ...row, id: 'mixy-home', messageCount: 2, readMessageCount: 2, agentHome: 'mixy' };
  const coding = { ...row, id: 'coding', messageCount: 2, readMessageCount: 2, working: true };
  const task = { ...coding, id: 'task-cache', taskAgent: 'mixy', taskFrom: 'home' };
  function Harness() {
    const viewedSessionRef = useRef('mixy-home');
    Object.assign(api, useUnreadSessions({ viewedSessionRef }));
    return React.createElement('div', null, [...api.unreadSessionIds].join(','));
  }
  const marks = () => document.querySelector('#root div').textContent;
  try {
    await act(async () => dom.root.render(React.createElement(Harness)));
    await act(async () => api.reconcileUnreadSessions([home, coding, task]));
    // Both finish while the focused window shows Mixy's chat, where the task reports back.
    const settled = (session) => ({ ...session, working: false, messageCount: 5 });
    await act(async () => api.reconcileUnreadSessions([settled(home), settled(coding), settled(task)]));
    assert.equal(marks(), 'coding');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("a delegated session's descendants (via the desktop projection) take no completion dot; a user's /inherit continuation does", async () => {
  const { desktopSessionSummaries } = await import('../main/desktop-state.ts');
  const raw = (id, extra) => ({
    id,
    cwd: 'C:\\work',
    preview: id,
    messageCount: 1,
    desktopSession: { classification: 'project', projectPath: 'C:\\work' },
    ...extra,
  });
  const project = (working, count) =>
    desktopSessionSummaries([
      raw('task-a', { owner: 'user', sourceType: 'lead', sourceName: 'agent:bot@home', working, messageCount: count }),
      raw('kid', { owner: 'agent', visibility: 'agent-only', parentSessionId: 'task-a', working, messageCount: count }),
      raw('grandkid', {
        owner: 'agent',
        visibility: 'agent-only',
        parentSessionId: 'kid',
        ownerSessionId: 'task-a',
        working,
        messageCount: count,
      }),
      raw('cont', { owner: 'user', sourceType: 'lead', inheritedFromSessionId: 'task-a', working, messageCount: count }),
    ]);
  const dom = installDom({ focused: false });
  const api = {};
  function Harness() {
    const viewedSessionRef = useRef('');
    Object.assign(api, useUnreadSessions({ viewedSessionRef }));
    return React.createElement('div', null, [...api.unreadSessionIds].join(','));
  }
  const marks = () => document.querySelector('#root div').textContent;
  try {
    await act(async () => dom.root.render(React.createElement(Harness)));
    await act(async () => api.reconcileUnreadSessions(project(true, 1)));
    await act(async () => api.reconcileUnreadSessions(project(false, 3)));
    assert.equal(marks(), 'cont');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("a bot chat's turn answered by a reaction alone leaves no unread dot; its next reply does", async () => {
  const dom = installDom({ focused: false });
  const api = {};
  // Two messages so far: the user's, then the bot's reply (place 2).
  const home = { ...row, id: 'home-1', messageCount: 2, readMessageCount: 2, incomingTail: [2], working: false };
  function Harness() {
    const viewedSessionRef = useRef('');
    Object.assign(api, useUnreadSessions({ viewedSessionRef }));
    return React.createElement('div', null, [...api.unreadSessionIds].join(','));
  }
  const marks = () => document.querySelector('#root div').textContent;
  try {
    await act(async () => dom.root.render(React.createElement(Harness)));
    await act(async () => api.reconcileUnreadSessions([home]));
    // The user writes "고마워" from the phone; the bot reacts and says nothing:
    // the count grows (the prompt, the tool round, the empty end), no message arrived.
    await act(async () => api.reconcileUnreadSessions([{ ...home, working: true, messageCount: 3 }]));
    await act(async () => api.reconcileUnreadSessions([{ ...home, messageCount: 5 }]));
    assert.equal(marks(), '');
    // A real reply later is unread as ever.
    await act(async () => api.reconcileUnreadSessions([{ ...home, messageCount: 7, incomingTail: [2, 7] }]));
    assert.equal(marks(), 'home-1');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

// The split layout of the report: coding sessions in the focused left pane, a
// bot chat ('비서') open as the right pane's tab.
function SplitHarness({ api, screen, focusTick, sessions, useScreenSessions, useUnreadViewedSession }) {
  useScreenSessions(screen);
  const viewedSessionRef = useRef('');
  const unreadViewedSessionRef = useRef('');
  const screenSessionIdsRef = useRef([]);
  const unread = useUnreadSessions({ viewedSessionRef: unreadViewedSessionRef, screenSessionIdsRef });
  Object.assign(api, unread);
  useUnreadViewedSession({
    navigationSelection: { kind: 'session', id: 'main' },
    requestedSessionId: '',
    sidebarOpen: false,
    dockOpen: false,
    bottomPanelOpen: false,
    settingsOpen: false,
    sessions,
    windowFocusTick: focusTick,
    viewedSessionRef,
    unreadViewedSessionRef,
    screenSessionIdsRef,
    consumeUnread: unread.consumeUnread,
  });
  return React.createElement('div', null, [...unread.unreadSessionIds].join(','));
}

async function splitSetup({ focused }) {
  const dom = installDom({ focused });
  const { useScreenSessions } = await import('./use-visible-sessions.ts');
  const { useUnreadViewedSession } = await import('./app-root/use-unread-viewed-session.ts');
  const reads = [];
  window.mixdogDesktop = { markSessionRead: (...args) => void reads.push(args) };
  const api = {};
  const render = (props) =>
    act(async () =>
      dom.root.render(React.createElement(SplitHarness, { api, useScreenSessions, useUnreadViewedSession, ...props }))
    );
  const marks = () => document.querySelector('#root div').textContent;
  return { dom, api, reads, render, marks };
}

test('every pane of a split is on screen; a single-pane carousel shows only the focused one', async () => {
  const { createPaneLeaf, paneScreenSessionIds } = await import('./pane-layout.ts');
  const leaves = [
    createPaneLeaf({ kind: 'session', id: 'main', title: '' }, 'left'),
    createPaneLeaf({ kind: 'session', id: 'bot-home', title: '' }, 'right'),
  ];
  assert.deepEqual(paneScreenSessionIds(leaves, 'left', false), ['main', 'bot-home']);
  assert.deepEqual(paneScreenSessionIds(leaves, 'left', true), ['main']);
  assert.deepEqual(paneScreenSessionIds(leaves, 'right', true), ['bot-home']);
});

const main = { ...row, id: 'main', messageCount: 2, readMessageCount: 2 };
const side = { ...row, id: 'bot-home', messageCount: 2, readMessageCount: 2 };

test('a reply landing in a chat open in the side pane of the focused window is read as it arrives', async () => {
  const { dom, api, reads, render, marks } = await splitSetup({ focused: true });
  try {
    await render({ screen: ['main', 'bot-home'], focusTick: 0, sessions: [main, side] });
    await act(async () => api.reconcileUnreadSessions([main, side]));
    await act(async () => api.reconcileUnreadSessions([main, { ...side, messageCount: 4 }]));
    assert.equal(marks(), '', 'no dot for a reply the user is looking at');
    assert.deepEqual(
      reads.filter(([id]) => id === 'bot-home'),
      [['bot-home', 4, false]]
    );
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('a side pane chat that got unread behind another app clears when focus returns; a hidden pane keeps it', async () => {
  const { dom, api, reads, render, marks } = await splitSetup({ focused: false });
  try {
    await render({ screen: ['main', 'bot-home'], focusTick: 0, sessions: [main, side] });
    await act(async () => api.reconcileUnreadSessions([main, side]));
    const replied = [main, { ...side, messageCount: 4 }];
    await act(async () => api.reconcileUnreadSessions(replied));
    assert.equal(marks(), 'bot-home', 'an unfocused window is not reading');
    // Focus returns, but the side pane is hidden (single-pane carousel).
    dom.state.focused = true;
    await render({ screen: ['main'], focusTick: 1, sessions: replied });
    await act(async () => api.reconcileUnreadSessions([main, { ...side, messageCount: 5 }]));
    assert.equal(marks(), 'bot-home', 'a hidden pane does not mark read');
    assert.equal(
      reads.some(([id]) => id === 'bot-home'),
      false
    );
    // The pane is shown again: its chat is read.
    await render({ screen: ['main', 'bot-home'], focusTick: 1, sessions: [main, { ...side, messageCount: 5 }] });
    assert.equal(marks(), '');
    assert.deepEqual(
      reads.find(([id]) => id === 'bot-home'),
      ['bot-home', 5, true]
    );
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("a reply read to its end in the bot overlay clears the chat's unread mark (sidebar dot, Bots badge)", async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DesktopSessionMetadata } = await import('../main/desktop-session-metadata.ts');
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-pet-read-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const metadata = new DesktopSessionMetadata(() => dir);
  await metadata.load();
  const dom = installDom();
  const api = {};
  // The user looks at another chat while Mixy's reply lands.
  function Harness() {
    const viewedSessionRef = useRef('other');
    Object.assign(api, useUnreadSessions({ viewedSessionRef }));
    return React.createElement('div', null, [...api.unreadSessionIds].join(','));
  }
  const marks = () => document.querySelector('#root div').textContent;
  const mixy = { ...row, id: 'mixy-home', messageCount: 2, readMessageCount: 2, readRevision: 1 };
  const catalog = (count) => metadata.withReadCursors([{ ...mixy, messageCount: count }]);
  try {
    await metadata.markRead('mixy-home', 2, false);
    await act(async () => dom.root.render(React.createElement(Harness)));
    await act(async () => api.reconcileUnreadSessions(catalog(2)));
    await act(async () => api.reconcileUnreadSessions(catalog(4)));
    assert.equal(marks(), 'mixy-home', 'a new reply: unread');
    // Closed in the overlay before its last page: nothing is recorded; still unread.
    await act(async () => api.reconcileUnreadSessions(catalog(4)));
    assert.equal(marks(), 'mixy-home');
    // Its last page shown: main's markRead (the overlay's deps.markRead) and the catalog push.
    await metadata.markRead('mixy-home', 4, true);
    await act(async () => api.reconcileUnreadSessions(catalog(4)));
    assert.equal(marks(), '', 'read in the overlay: cleared in the app');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});
