import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const session = (id) => ({ kind: 'session', id, title: id });

test("a tab dragged out of a pane mid hand-over: each pane's panel is drawn by exactly one conversation of its own", async (t) => {
  const { document, root } = installTestDom(t, {
    rootId: 'root',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'MutationObserver'],
  });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const [
    { PaneWorkspace },
    { createPaneLeaf },
    { usePanePresentation },
    { useSurfaceActive },
    { PaneHandOverContext, publishSessionRailSlot, sessionRailPlace, useSessionRailSlot },
    { createPortal },
  ] = await Promise.all([
    import('./PaneWorkspace.tsx'),
    import('./pane-layout.ts'),
    import('./pane-presentation.ts'),
    import('./surface-activity.ts'),
    import('./session-rail-layout.ts'),
    import('react-dom'),
  ]);
  const [S, T, U] = ['s', 't', 'u'].map(session);
  const panels = { P: document.createElement('aside'), M: document.createElement('aside') };
  document.body.append(panels.P, panels.M);
  t.after(() => {
    publishSessionRailSlot('P', null);
    publishSessionRailSlot('M', null);
  });
  const presentations = new Map();
  /** A pane's conversation drawing its pane's panel where sessionRailPlace puts it, as the composer dock does. */
  function Conversation({ id, leafId }) {
    presentations.set(id, usePanePresentation());
    const place = sessionRailPlace(useSessionRailSlot(leafId), {
      sessionId: id,
      onScreen: useSurfaceActive(),
      handOver: React.useContext(PaneHandOverContext),
    });
    return place.host ? createPortal(React.createElement('i', { 'data-panel': id }), place.host) : null;
  }
  const drawn = (pane) => [...panels[pane].querySelectorAll('[data-panel]')].map((node) => node.dataset.panel).sort();
  const crowded = [];
  const observer = new MutationObserver(() => {
    for (const pane of ['P', 'M']) if (drawn(pane).length > 1) crowded.push(`${pane}: ${drawn(pane)}`);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  t.after(() => observer.disconnect());
  const noop = () => {};
  const render = (pTabs, pActive, mTabs, mActive) =>
    act(async () => {
      const first = { ...createPaneLeaf(pActive, 'P'), tabs: pTabs };
      const second = { ...createPaneLeaf(mActive, 'M'), tabs: mTabs };
      // The panel names the tab in front of its pane (SessionRailCard).
      publishSessionRailSlot('P', { element: panels.P, sessionId: pActive.id, draftId: '' });
      publishSessionRailSlot('M', { element: panels.M, sessionId: mActive.id, draftId: '' });
      root.render(
        React.createElement(PaneWorkspace, {
          workspace: {
            layout: { type: 'split', direction: 'row', ratio: 0.5, first, second },
            leaves: [first, second],
            restoredFromStorage: true,
            restorePending: false,
            focusedLeaf: second,
            focusedLeafId: 'M',
            focusLeaf: noop,
            activateTab: noop,
            setRatio: noop,
          },
          renderActive: () => null,
          renderConversation: (selection, _focused, _focusPane, leafId) =>
            React.createElement(Conversation, { id: selection.id, leafId }),
          onFocusSelection: noop,
        })
      );
    });
  const ready = (id) => act(async () => presentations.get(id).ready());

  await render([S, T], S, [U], U);
  await ready('s');
  await ready('u');
  assert.deepEqual([drawn('P'), drawn('M')], [['s'], ['u']]);

  // S's tab is dragged into M: P falls back to its cold tab T, M hands over from U to S.
  await render([T], T, [U, S], S);
  await ready('s');
  assert.deepEqual([drawn('P'), drawn('M')], [['t'], ['s']], 'P draws T: S went with its tab');

  // While T is still loading, U is clicked in M.
  await render([T], T, [U, S], U);
  assert.deepEqual([drawn('P'), drawn('M')], [['t'], ['s']], 'M keeps S until U can be shown');
  await ready('u');
  assert.deepEqual([drawn('P'), drawn('M')], [['t'], ['u']]);
  await ready('t');
  assert.deepEqual([drawn('P'), drawn('M')], [['t'], ['u']]);
  assert.deepEqual(crowded, [], 'no commit has two conversations in one panel');
});
