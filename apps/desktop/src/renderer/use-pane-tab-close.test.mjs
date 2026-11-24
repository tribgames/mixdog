import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { sideFileDirtyKey, sideFileKey } from './side-file-tabs.ts';
import { usePaneTabClose } from './use-pane-tab-close.ts';

const session = (id) => ({ kind: 'session', id });
const file = (rel) => ({ kind: 'file', project: '/p', rel });
const key = (selection) =>
  selection.kind === 'file' ? `file:${selection.project}:${selection.rel}` : `${selection.kind}:${selection.id}`;

/** The group without the tab; the active tab's close activates its nearest neighbour (closeTabInPaneLeaf). */
function withoutTab(entry, tabKey) {
  const index = entry.tabs.findIndex((tab) => key(tab) === tabKey);
  const tabs = entry.tabs.filter((tab) => key(tab) !== tabKey);
  const activeKey =
    entry.activeKey === tabKey && tabs.length ? key(tabs[Math.min(index, tabs.length - 1)]) : entry.activeKey;
  return { ...entry, tabs, activeKey };
}

/** Mounts the hook over a pane workspace the test describes and records every effect of closing a tab. */
async function mounted({ leaves, focusedLeafId = 'a', dirtyFileKeys = new Set(), docks = {} }, body) {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><body><main></main></body>',
    jsdom: { url: 'http://localhost/' },
  });
  const calls = [];
  const released = [];
  window.mixdogDesktop = { browserReleasePage: (id) => released.push(id) };
  const lastSessionStorageKey = 'last-session';
  window.localStorage.setItem(lastSessionStorageKey, 'x');
  const refs = {
    selection: { current: session('cur') },
    viewed: { current: 'cur' },
    unread: { current: 'cur' },
    handoff: { current: null },
    saveHandles: { current: new Map([['file:/p:a.ts', {}]]) },
  };
  // `leaves`/`focusedLeafId` as the last render saw them; `now()` as each
  // close left them, before the next render (usePaneWorkspace).
  const panes = { leaves, focusedLeafId };
  const paneWorkspace = {
    leaves,
    focusedLeafId,
    now: () => ({ ...panes }),
    closeTab: (leafId, tabKey) => {
      calls.push(['closeTab', leafId, tabKey]);
      panes.leaves = panes.leaves
        .map((entry) => (entry.id === leafId ? withoutTab(entry, tabKey) : entry))
        .filter((entry) => entry.tabs.length > 0);
      if (!panes.leaves.some((entry) => entry.id === panes.focusedLeafId)) {
        panes.focusedLeafId = panes.leaves[0]?.id ?? '';
      }
    },
  };
  /** The app's openSession: the session's tab becomes the focused group's active one. */
  const openSession = async (id) => {
    calls.push(['openSession', id]);
    const opened = session(id);
    const withOpened = (entry) => {
      const present = entry.tabs.some((tab) => key(tab) === key(opened));
      return { ...entry, tabs: present ? entry.tabs : [...entry.tabs, opened], activeKey: key(opened) };
    };
    panes.leaves = panes.leaves.map((entry) => (entry.id === panes.focusedLeafId ? withOpened(entry) : entry));
  };
  const root = createRoot(document.querySelector('main'));
  const control = {};
  function Harness() {
    control.hook = usePaneTabClose({
      paneWorkspace,
      paneSideDocks: { docks },
      dirtyFileKeys,
      editorSaveHandles: refs.saveHandles,
      handleFileDirty: (tabKey, dirty) => calls.push(['dirty', tabKey, dirty]),
      setTabs: (update) =>
        calls.push(['setTabs', update([{ key: 'file:/p:a.ts' }, { key: 'keep' }]).map((t) => t.key)]),
      pendingConversationHandoff: refs.handoff,
      setConversationHandoff: (handoff) => calls.push(['handoff', handoff]),
      openSession,
      navigateTab: (tab) => calls.push(['navigateTab', tab.key]),
      selectionRef: refs.selection,
      viewedSessionRef: refs.viewed,
      unreadViewedSessionRef: refs.unread,
      setSelection: (next) => calls.push(['setSelection', next.kind]),
      setRequestedSessionId: (id) => calls.push(['requestedSession', id]),
      setComposerFocusRequest: () => calls.push(['composerFocus']),
      lastSessionStorageKey,
    });
    return null;
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await body({ control, calls, released, refs, lastSessionStorageKey, panes });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
}

const leaf = (id, selections, active) => ({ id, tabs: selections, activeKey: key(active ?? selections[0]) });
const tabOf = (selection) => ({ key: key(selection), title: '', selection });

test('closing a background file tab releases it and its editor handle without changing the shown tab', async () => {
  const a = file('a.ts');
  const b = file('b.ts');
  await mounted({ leaves: [leaf('a', [a, b], b)] }, async ({ control, calls, refs }) => {
    await act(async () => control.hook.closeTab('a', tabOf(a)));
    assert.deepEqual(calls, [
      ['dirty', 'file:/p:a.ts', false],
      ['setTabs', ['keep']],
      ['closeTab', 'a', 'file:/p:a.ts'],
    ]);
    assert.equal(refs.saveHandles.current.has('file:/p:a.ts'), false);
  });
});

test('closing a tab that another group also shows only closes it in this group', async () => {
  const a = file('a.ts');
  const b = file('b.ts');
  await mounted({ leaves: [leaf('a', [a, b], b), leaf('c', [a])] }, async ({ control, calls, refs }) => {
    await act(async () => control.hook.closeTab('a', tabOf(a)));
    assert.deepEqual(calls, [['closeTab', 'a', 'file:/p:a.ts']]);
    assert.equal(refs.saveHandles.current.has('file:/p:a.ts'), true);
  });
});

test('closing a dirty file tab queues the unsaved-close dialog instead of closing', async () => {
  const a = file('a.ts');
  const b = file('b.ts');
  await mounted(
    { leaves: [leaf('a', [a, b], b)], dirtyFileKeys: new Set(['file:/p:a.ts']) },
    async ({ control, calls }) => {
      await act(async () => control.hook.closeTab('a', tabOf(a)));
      assert.deepEqual(calls, []);
      assert.equal(control.hook.pendingUnsavedClose.tab.key, 'file:/p:a.ts');
    }
  );
});

test('closing a background browser tab releases its page', async () => {
  const a = file('a.ts');
  const browser = { kind: 'browser', id: 'w1' };
  await mounted({ leaves: [leaf('a', [a, browser], a)] }, async ({ control, released }) => {
    await act(async () => control.hook.closeTab('a', tabOf(browser)));
    assert.deepEqual(released, ['w1']);
  });
});

test('closing the active file tab closes it and navigates to the next tab of its group', async () => {
  const a = file('a.ts');
  const b = file('b.ts');
  await mounted({ leaves: [leaf('a', [a, b], a)] }, async ({ control, calls }) => {
    await act(async () => control.hook.closeTab('a', tabOf(a)));
    assert.deepEqual(calls.slice(-2), [
      ['closeTab', 'a', 'file:/p:a.ts'],
      ['navigateTab', 'file:/p:b.ts'],
    ]);
  });
});

test('closing the last tab of a group falls back to the active tab of another group', async () => {
  const a = file('a.ts');
  const b = file('b.ts');
  await mounted({ leaves: [leaf('a', [a]), leaf('c', [a, b], b)] }, async ({ control, calls }) => {
    await act(async () => control.hook.closeTab('a', tabOf(a)));
    assert.deepEqual(calls.at(-1), ['navigateTab', 'file:/p:b.ts']);
  });
});

test('closing the active session with another session next hands the conversation off and opens that session', async () => {
  const s1 = session('s1');
  const s2 = session('s2');
  await mounted({ leaves: [leaf('a', [s1, s2], s1)] }, async ({ control, calls, refs }) => {
    await act(async () => control.hook.closeTab('a', tabOf(s1)));
    const handoff = { kind: 'close', leafId: 'a', selection: s1 };
    assert.deepEqual(refs.handoff.current, handoff);
    assert.deepEqual(calls, [
      ['handoff', handoff],
      ['setTabs', ['file:/p:a.ts', 'keep']],
      ['closeTab', 'a', 'session:s1'],
      ['openSession', 's2'],
    ]);
  });
});

test('closing the only tab resets to a new task and forgets the last session', async () => {
  const s1 = session('s1');
  await mounted({ leaves: [leaf('a', [s1])] }, async ({ control, calls, refs, lastSessionStorageKey }) => {
    await act(async () => control.hook.closeTab('a', tabOf(s1)));
    assert.deepEqual(calls.slice(-3), [
      ['closeTab', 'a', 'session:s1'],
      ['setSelection', 'new'],
      ['requestedSession', ''],
    ]);
    assert.deepEqual(refs.selection.current, { kind: 'new' });
    assert.equal(refs.viewed.current, '');
    assert.equal(refs.unread.current, '');
    assert.equal(window.localStorage.getItem(lastSessionStorageKey), null);
  });
});

test('Close Others closes each tab against the groups the close before it left', async () => {
  const [a, b, c] = ['a', 'b', 'c'].map(session);
  for (const active of [c, b]) {
    await mounted({ leaves: [leaf('a', [a, b, c], active)] }, async ({ control, calls, panes }) => {
      // The tab menu closes every other tab in one handler, before any re-render.
      const { closeTab } = control.hook;
      await act(async () => {
        for (const other of [b, c]) closeTab('a', tabOf(other));
      });
      assert.deepEqual(
        panes.leaves.map((entry) => entry.tabs.map(key)),
        [['session:a']]
      );
      assert.deepEqual(calls.filter(([kind]) => kind === 'openSession').at(-1), ['openSession', 'a']);
    });
  }
});

test('closing a session first confirms the unsaved side-dock files that would go with it', async () => {
  const s1 = session('s1');
  const s2 = session('s2');
  const sideFile = { project: '/p', rel: 'notes.md' };
  const dirtyKey = sideFileDirtyKey(sideFile);
  const docks = {
    a: {
      open: true,
      view: null,
      surface: 'file',
      diff: null,
      owner: 's1',
      files: [sideFile],
      activeFile: sideFileKey(sideFile),
    },
  };
  // The pane's other tab cannot show s1's files; a split pane that closes with its last tab drops its whole dock.
  for (const leaves of [[leaf('a', [s1, s2], s1)], [leaf('a', [s1]), leaf('b', [s2])]]) {
    await mounted({ leaves, docks, dirtyFileKeys: new Set([dirtyKey]) }, async ({ control, calls }) => {
      await act(async () => control.hook.closeTab('a', tabOf(s1)));
      assert.deepEqual(calls, []);
      assert.equal(control.hook.pendingUnsavedClose.tab.key, dirtyKey);
      await act(async () => control.hook.discardAndClosePendingTab());
      assert.deepEqual(calls[0], ['dirty', dirtyKey, false]);
      assert.ok(
        calls.some(([kind, leafId, tabKey]) => kind === 'closeTab' && leafId === 'a' && tabKey === 'session:s1')
      );
      assert.equal(control.hook.pendingUnsavedClose, null);
    });
  }
});

test('closing an active non-conversation tab onto a conversation focuses the composer', async () => {
  const s1 = session('s1');
  const a = file('a.ts');
  await mounted({ leaves: [leaf('a', [a, s1], a)] }, async ({ control, calls }) => {
    await act(async () => control.hook.closeTab('a', tabOf(a)));
    assert.deepEqual(calls.slice(-2), [['navigateTab', 'session:s1'], ['composerFocus']]);
  });
});
