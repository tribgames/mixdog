import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { usePaneTabClose } from './use-pane-tab-close.ts';

const session = (id) => ({ kind: 'session', id });
const file = (rel) => ({ kind: 'file', project: '/p', rel });
const key = (selection) =>
  selection.kind === 'file' ? `file:${selection.project}:${selection.rel}` : `${selection.kind}:${selection.id}`;

/** Mounts the hook over a pane workspace the test describes and records every effect of closing a tab. */
async function mounted({ leaves, focusedLeafId = 'a', dirtyFileKeys = new Set() }, body) {
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
  const paneWorkspace = {
    leaves,
    focusedLeafId,
    closeTab: (leafId, tabKey) => calls.push(['closeTab', leafId, tabKey]),
  };
  const root = createRoot(document.querySelector('main'));
  const control = {};
  function Harness() {
    control.hook = usePaneTabClose({
      paneWorkspace,
      dirtyFileKeys,
      editorSaveHandles: refs.saveHandles,
      handleFileDirty: (tabKey, dirty) => calls.push(['dirty', tabKey, dirty]),
      setTabs: (update) =>
        calls.push(['setTabs', update([{ key: 'file:/p:a.ts' }, { key: 'keep' }]).map((t) => t.key)]),
      pendingConversationHandoff: refs.handoff,
      setConversationHandoff: (handoff) => calls.push(['handoff', handoff]),
      openSession: async (id) => calls.push(['openSession', id]),
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
    await body({ control, calls, released, refs, lastSessionStorageKey });
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

test('closing an active non-conversation tab onto a conversation focuses the composer', async () => {
  const s1 = session('s1');
  const a = file('a.ts');
  await mounted({ leaves: [leaf('a', [a, s1], a)] }, async ({ control, calls }) => {
    await act(async () => control.hook.closeTab('a', tabOf(a)));
    assert.deepEqual(calls.slice(-2), [['navigateTab', 'session:s1'], ['composerFocus']]);
  });
});
