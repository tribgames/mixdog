import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const session = (id) => ({ kind: 'session', id, title: id });
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map(session);

async function mountPhoneWorkspace(t) {
  const { dom, root } = installTestDom(t, {
    html: '<!doctype html><html data-mixdog-mobile-tabs><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'MutationObserver'],
    rootId: 'root',
  });
  Object.defineProperty(dom.window.navigator, 'userAgent', { configurable: true, get: () => PHONE_UA });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  let nextFrame = 1;
  const pendingFrames = new Map();
  dom.window.requestAnimationFrame = (callback) => {
    const id = nextFrame++;
    pendingFrames.set(id, callback);
    return id;
  };
  dom.window.cancelAnimationFrame = (id) => pendingFrames.delete(id);
  const host = document.getElementById('root');
  const [{ PaneWorkspace }, { createPaneLeaf }] = await Promise.all([
    import('./PaneWorkspace.tsx'),
    import('./pane-layout.ts'),
  ]);
  const noop = () => {};
  const renders = new Map();
  // Every mounted Conversation, attached to the document or not.
  const live = new Set();
  function Conversation({ id, focused }) {
    renders.set(id, (renders.get(id) ?? 0) + 1);
    React.useLayoutEffect(() => {
      live.add(id);
      return () => live.delete(id);
    }, [id]);
    return React.createElement('section', { 'data-session': id, 'data-focused': String(focused) });
  }
  const leafOf = (id, tabs, active) => ({ ...createPaneLeaf(active, id), tabs });
  return {
    host,
    renders,
    leafOf,
    liveSessions: () => [...live].sort(),
    async render(tabs, active) {
      const leaf = leafOf('pane-1', tabs, active);
      await this.renderLayout(leaf, [leaf], leaf);
    },
    async renderLayout(layout, leaves, focusedLeaf) {
      await act(async () =>
        root.render(
          React.createElement(PaneWorkspace, {
            workspace: {
              layout,
              leaves,
              restoredFromStorage: true,
              restorePending: false,
              focusedLeaf,
              focusedLeafId: focusedLeaf.id,
              focusLeaf: noop,
              setRatio: noop,
            },
            renderActive: () => null,
            // A fresh props object every render, like the app's pane renderer.
            renderConversation: (selection, focused) =>
              React.createElement(Conversation, { id: selection.id, focused, onOpen: () => {} }),
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
    conversation(id) {
      return host.ownerDocument.querySelector(`[data-session="${id}"]`);
    },
    surfaceOf(id) {
      return this.conversation(id)?.closest('.conversation-persistent-surface') ?? null;
    },
    mountedSessions() {
      return [...host.ownerDocument.querySelectorAll('[data-session]')].map((node) => node.dataset.session).sort();
    },
  };
}

test('a phone keeps its recent sessions mounted and switches back by visibility alone', async (t) => {
  const view = await mountPhoneWorkspace(t);
  const tabs = [A, B, C, D];
  await view.render(tabs, A);
  assert.ok(view.host.ownerDocument.querySelector('.transcript-skeleton'), 'the skeleton paints in the opening frame');
  assert.equal(view.conversation('a'), null, 'the conversation mounts in the next frame');
  await view.flushFrame();
  const first = view.conversation('a');
  assert.ok(first);

  await view.render(tabs, B);
  await view.flushFrame();
  assert.equal(view.conversation('a'), first, 'the previous session stays mounted');
  assert.equal(view.surfaceOf('a').hasAttribute('data-retained'), true);
  assert.equal(view.surfaceOf('a').inert, true);
  assert.equal(first.dataset.focused, 'false');
  assert.equal(view.conversation('b').dataset.focused, 'true');

  const rendersOfA = view.renders.get('a');
  await view.render(tabs, B);
  assert.equal(view.renders.get('a'), rendersOfA, 'a retained session is not re-rendered by workspace renders');

  await view.render(tabs, A);
  assert.equal(view.conversation('a'), first, 'switching back reuses the mounted conversation');
  assert.equal(view.surfaceOf('a').hasAttribute('data-retained'), false);
  assert.equal(view.surfaceOf('a').inert, false);
  assert.equal(first.dataset.focused, 'true');
  assert.equal(view.surfaceOf('b').hasAttribute('data-retained'), true);
  assert.equal(view.host.ownerDocument.querySelector('.transcript-skeleton'), null, 'no skeleton on a warm switch');

  // Memory stays bounded: the shown session plus the two most recent ones.
  await view.render(tabs, C);
  await view.flushFrame();
  // The pool is full: D reuses the owner B gave up, and still opens cold.
  await view.render(tabs, D);
  assert.equal(view.conversation('d'), null, 'a cold session on a reused owner mounts in the next frame');
  assert.ok(view.host.ownerDocument.querySelector('.transcript-skeleton'), 'and paints its skeleton first');
  assert.equal(view.conversation('a'), first, 'the retained sessions are not remounted');
  await view.flushFrame();
  assert.ok(view.conversation('d'));
  assert.deepEqual(view.mountedSessions(), ['a', 'c', 'd']);
  assert.equal(view.host.ownerDocument.querySelectorAll('.conversation-persistent-surface').length, 3);

  // A closed tab is not kept.
  await view.render([A, B, D], D);
  assert.deepEqual(view.mountedSessions(), ['a', 'd']);
});

test('a phone session whose lane is already loaded mounts in the opening frame, with no skeleton', async (t) => {
  const view = await mountPhoneWorkspace(t);
  const { defaultSessionLaneStore } = await import('./session-lane-store.ts');
  t.after(() => defaultSessionLaneStore.clear());
  defaultSessionLaneStore.apply({ sessionId: 'b', snapshot: { sessionId: 'b', items: [{ id: 'r1', kind: 'user' }] } });
  await view.render([A, B], A);
  await view.flushFrame();
  await view.render([A, B], B);
  assert.ok(view.conversation('b'), 'the cached rows mount in the tap commit');
  assert.equal(view.host.ownerDocument.querySelector('.transcript-skeleton'), null, 'no skeleton frame first');
});

test('a phone keeps two hidden sessions in total, however many panes it has', async (t) => {
  const view = await mountPhoneWorkspace(t);
  const [E] = ['e'].map(session);
  const show = async (first, second, focused) => {
    const layout = { type: 'split', direction: 'row', ratio: 0.5, first, second };
    await view.renderLayout(layout, [first, second], focused);
    await view.flushFrame();
  };
  const one = (active) => view.leafOf('pane-1', [A, B, C], active);
  const two = (active) => view.leafOf('pane-2', [D, E], active);
  await show(one(A), two(D), one(A));
  await show(one(B), two(D), one(B));
  await show(one(C), two(D), one(C));
  await show(one(C), two(E), two(E));
  // Each pane's active session (C, E) plus two retained ones overall (D, B):
  // a per-pane budget would also have kept A.
  assert.deepEqual(view.liveSessions(), ['b', 'c', 'd', 'e']);
});
