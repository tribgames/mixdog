import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const script = { kind: 'file', project: '/project', rel: 'script.ts' };
const otherScript = { kind: 'file', project: '/project', rel: 'other.ts' };
const draft = { kind: 'new', draftId: 'draft-1' };

async function mountPaneWorkspace(t) {
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', {
    url: 'https://mixdog.test/',
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
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
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });

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
                  React.createElement('pre', {
                    key: navigationKey(selection),
                    'data-editor': selection.rel,
                    'data-active': leaf.activeKey === navigationKey(selection) ? 'true' : 'false',
                  }, selection.rel)
                ),
            renderConversation: () => React.createElement('section', { 'data-conversation': 'true' }),
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
