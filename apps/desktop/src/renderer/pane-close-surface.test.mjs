import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const script = { kind: 'file', project: '/project', rel: 'script.ts' };
const otherScript = { kind: 'file', project: '/project', rel: 'other.ts' };
const draft = { kind: 'new', draftId: 'draft-1' };

async function mountPaneWorkspace(t, calls = []) {
  const { dom, root } = installTestDom(t, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement'],
    rootId: 'root',
  });
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  let nextFrame = 1;
  const pendingFrames = new Map();
  dom.window.requestAnimationFrame = (callback) => {
    const id = nextFrame++;
    pendingFrames.set(id, callback);
    return id;
  };
  dom.window.cancelAnimationFrame = (id) => pendingFrames.delete(id);
  const host = document.getElementById('root');

  const [{ PaneWorkspace }, { createPaneLeaf }, { navigationKey }] = await Promise.all([
    import('./PaneWorkspace.tsx'),
    import('./pane-layout.ts'),
    import('./text-format.ts'),
  ]);
  const noop = () => {};
  return {
    host,
    leaf(tabs, active = tabs[0], id = 'pane-1') {
      return { ...createPaneLeaf(active, id), tabs };
    },
    async render(leaves) {
      const layout =
        leaves.length === 1
          ? leaves[0]
          : { type: 'split', direction: 'row', ratio: 0.5, first: leaves[0], second: leaves[1] };
      await act(async () =>
        root.render(
          React.createElement(PaneWorkspace, {
            workspace: {
              layout,
              leaves,
              restoredFromStorage: true,
              restorePending: false,
              focusedLeaf: leaves[0],
              focusedLeafId: leaves[0].id,
              focusLeaf: noop,
              setRatio: noop,
            },
            renderActive: () => null,
            renderFileEditors: (leaf) =>
              leaf.tabs
                .filter((selection) => selection.kind === 'file')
                .map((selection) =>
                  React.createElement(
                    'pre',
                    {
                      key: navigationKey(selection),
                      'data-editor': selection.rel,
                      'data-active': leaf.activeKey === navigationKey(selection) ? 'true' : 'false',
                    },
                    selection.rel
                  )
                ),
            renderConversation: (_selection, focused, _focusPane, leafId, _warm, visible) => {
              calls.push({ leafId, focused, visible });
              return React.createElement('section', { 'data-conversation': 'true' });
            },
            onFocusSelection: noop,
          })
        )
      );
    },
    async flushFrame() {
      await act(async () => {
        const callbacks = [...pendingFrames.values()];
        pendingFrames.clear();
        for (const callback of callbacks) callback(0);
      });
    },
  };
}

for (const { name, before, after, destination } of [
  {
    name: 'closing a script tab reveals its conversation immediately',
    before: [script, draft],
    after: [draft],
    destination: '[data-conversation]',
  },
  {
    name: 'closing the last script tab reveals the new task immediately',
    before: [script],
    after: [draft],
    destination: '[data-conversation]',
  },
  {
    name: 'closing a script tab reveals the remaining script immediately',
    before: [script, otherScript],
    after: [otherScript],
    destination: '[data-editor="other.ts"][data-active="true"]',
  },
]) {
  test(name, async (t) => {
    const view = await mountPaneWorkspace(t);
    await view.render([view.leaf(before)]);
    assert.ok(view.host.querySelector('[data-editor="script.ts"][data-active="true"]'));

    await view.render([view.leaf(after)]);
    assert.equal(view.host.querySelector('[data-editor="script.ts"]'), null);
    assert.equal(view.host.querySelector('[data-pane-surface-handoff="true"]'), null);
    assert.ok(view.host.querySelector(destination), 'the destination must not wait for an animation frame');
  });
}

test('closing a split editor pane removes its script before the next frame', async (t) => {
  const view = await mountPaneWorkspace(t);
  const remaining = view.leaf([otherScript], otherScript, 'pane-2');
  await view.render([view.leaf([script]), remaining]);
  assert.ok(view.host.querySelector('[data-editor="script.ts"]'));

  await view.render([remaining]);
  assert.equal(view.host.querySelector('[data-editor="script.ts"]'), null);
  assert.ok(view.host.querySelector('[data-editor="other.ts"][data-active="true"]'));
});

test('switching away from an open script retains its surface for one frame', async (t) => {
  const view = await mountPaneWorkspace(t);
  await view.render([view.leaf([script, draft])]);
  await view.render([view.leaf([script, draft], draft)]);
  assert.ok(
    view.host.querySelector('[data-pane-surface-handoff="true"] [data-editor="script.ts"][data-active="true"]')
  );
  assert.ok(view.host.querySelector('[data-conversation]'));

  await view.flushFrame();
  assert.equal(view.host.querySelector('[data-pane-surface-handoff="true"]'), null);
  assert.ok(view.host.querySelector('[data-editor="script.ts"][data-active="false"]'));
});

test('switching tabs keeps every open editor mounted instead of rebuilding the pane', async (t) => {
  const view = await mountPaneWorkspace(t);
  const tabs = [script, otherScript, draft];
  await view.render([view.leaf(tabs, script)]);
  const first = view.host.querySelector('[data-editor="script.ts"]');
  const second = view.host.querySelector('[data-editor="other.ts"]');
  for (const active of [otherScript, draft, script, otherScript]) {
    await view.render([view.leaf(tabs, active)]);
    // The handoff frame repaints the outgoing tab with the SAME editors.
    assert.equal(view.host.querySelector('[data-editor="script.ts"]'), first);
    assert.equal(view.host.querySelector('[data-editor="other.ts"]'), second);
    await view.flushFrame();
    assert.equal(view.host.querySelector('[data-pane-surface-handoff="true"]'), null);
    assert.equal(view.host.querySelector('[data-editor="script.ts"]'), first, 'script.ts must not remount');
    assert.equal(view.host.querySelector('[data-editor="other.ts"]'), second, 'other.ts must not remount');
  }
  assert.equal(second.dataset.active, 'true');
  assert.equal(first.dataset.active, 'false');
});

test('closing a retained script cancels its pending surface without waiting for a frame', async (t) => {
  const view = await mountPaneWorkspace(t);
  await view.render([view.leaf([script, draft])]);
  await view.render([view.leaf([script, draft], draft)]);
  assert.ok(view.host.querySelector('[data-pane-surface-handoff="true"]'));

  await view.render([view.leaf([draft])]);
  assert.equal(view.host.querySelector('[data-editor="script.ts"]'), null);
  assert.equal(view.host.querySelector('[data-pane-surface-handoff="true"]'), null);
  assert.ok(view.host.querySelector('[data-conversation]'));
});

test('a conversation parked behind a file tab is not visible; a visible split pane is, focused or not', async (t) => {
  const calls = [];
  const view = await mountPaneWorkspace(t, calls);
  const last = (leafId) => calls.filter((call) => call.leafId === leafId).at(-1);
  await view.render([view.leaf([script, draft], draft)]);
  assert.equal(last('pane-1').visible, true, 'on screen');
  await view.render([view.leaf([script, draft], script)]);
  // The outgoing frame hands off first; then the conversation is parked.
  await view.flushFrame();
  assert.equal(last('pane-1').visible, false, 'parked under the script');
  await view.render([view.leaf([script, draft], draft)]);
  assert.equal(last('pane-1').visible, true, 'shown again');
  await view.render([view.leaf([draft], draft), view.leaf([draft], draft, 'pane-2')]);
  assert.deepEqual(
    { focused: last('pane-2').focused, visible: last('pane-2').visible },
    { focused: false, visible: true },
    'an unfocused split pane still docks its approvals'
  );
});
