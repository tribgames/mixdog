import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { useAppSessionTitle } from './app-shell-session-title.ts';

async function mountTitle(t) {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'about:blank' },
  });
  const state = { renamed: null, hook: null };
  const sessions = [{ id: 's1', title: 'Original Title', prompt: 'Hello' }];
  const tabs = [{ key: 'session:s1', title: 'Original Title', selection: { kind: 'session', id: 's1' } }];
  function TestHarness() {
    state.hook = useAppSessionTitle({
      navigationSelection: { kind: 'session', id: 's1' },
      sessions,
      tabs,
      renameSession: (id, title) => {
        state.renamed = { id, title };
      },
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    restore();
  });
  await act(async () => {
    root.render(React.createElement(TestHarness));
  });
  return state;
}

test('useAppSessionTitle opens the editor on the visible title and renames on commit', async (t) => {
  const state = await mountTitle(t);
  assert.equal(state.hook.visibleSessionTitle, 'Original Title');
  assert.equal(state.hook.headerTitleEditingSessionId, '');

  await act(async () => {
    state.hook.openHeaderTitleEditor();
  });
  assert.equal(state.hook.headerTitleEditingSessionId, 's1');
  assert.equal(state.hook.headerTitleDraft, 'Original Title');

  await act(async () => {
    state.hook.setHeaderTitleDraft('New Title');
  });
  await act(async () => {
    state.hook.commitHeaderTitleEditor(false);
  });
  assert.equal(state.hook.headerTitleEditingSessionId, '');
  assert.deepEqual(state.renamed, { id: 's1', title: 'New Title' });
});

test('useAppSessionTitle closes without renaming when a whitespace draft is committed on blur', async (t) => {
  const state = await mountTitle(t);
  await act(async () => {
    state.hook.openHeaderTitleEditor();
    state.hook.setHeaderTitleDraft('   ');
  });
  await act(async () => {
    state.hook.commitHeaderTitleEditor(true);
  });
  assert.equal(state.renamed, null);
  assert.equal(state.hook.headerTitleEditingSessionId, '');
});
