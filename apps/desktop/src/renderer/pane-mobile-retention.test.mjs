import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const session = (id) => ({ kind: 'session', id, title: id });
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map(session);

async function mountPhoneWorkspace(t, { phone = true } = {}) {
  const { dom, root } = installTestDom(t, {
    html: `<!doctype html><html${phone ? ' data-mixdog-mobile-tabs' : ''}><body><main id="root"></main></body></html>`,
    expose: ['navigator', 'Element', 'HTMLElement', 'MutationObserver'],
    rootId: 'root',
  });
  if (phone) Object.defineProperty(dom.window.navigator, 'userAgent', { configurable: true, get: () => PHONE_UA });
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
  const [{ PaneWorkspace }, { createPaneLeaf }, { useSurfaceActive }, { useComposerExternalDraft }] =
    await Promise.all([
      import('./PaneWorkspace.tsx'),
      import('./pane-layout.ts'),
      import('./surface-activity.ts'),
      import('./use-composer-external-draft.ts'),
    ]);
  const noop = () => {};
  // Each conversation's draft, and what the workspace was asked to show.
  const drafts = new Map();
  const workspaceCalls = [];
  const renders = new Map();
  // Every mounted Conversation, attached to the document or not.
  const live = new Set();
  // Which conversations heard a window key: the composer's window listeners
  // (dictation, cards, menus) bind only while their conversation is shown.
  const heardKeys = [];
  function Conversation({ id, focused }) {
    renders.set(id, (renders.get(id) ?? 0) + 1);
    React.useLayoutEffect(() => {
      live.add(id);
      return () => live.delete(id);
    }, [id]);
    const shown = useSurfaceActive();
    React.useEffect(() => {
      if (!shown) return undefined;
      const hear = (event) => heardKeys.push(`${id}:${event.key}`);
      window.addEventListener('keydown', hear, true);
      return () => window.removeEventListener('keydown', hear, true);
    }, [id, shown]);
    // The composer's own intake of text sent to "the composer": `focused` is
    // what the app passes as paneActive.
    const [draft, setDraft] = React.useState('');
    const draftRef = React.useRef('');
    const textarea = React.useRef(null);
    const historyNavigation = React.useRef({ index: -1, seed: '' });
    useComposerExternalDraft({
      draftRef,
      setDraft,
      textarea,
      historyNavigation,
      attachFiles: async () => {},
      shareActive: focused,
    });
    drafts.set(id, draft);
    return React.createElement(
      'section',
      { 'data-session': id, 'data-focused': String(focused) },
      React.createElement('textarea', { 'data-composer': id, ref: textarea })
    );
  }
  const leafOf = (id, tabs, active) => ({ ...createPaneLeaf(active, id), tabs });
  return {
    host,
    renders,
    leafOf,
    drafts,
    workspaceCalls,
    async pressKey(key) {
      heardKeys.length = 0;
      await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key })));
      return [...heardKeys];
    },
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
              focusLeaf: (leafId) => workspaceCalls.push(['focusLeaf', leafId]),
              activateTab: (leafId, key) => workspaceCalls.push(['activateTab', leafId, key]),
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
  assert.equal(view.host.ownerDocument.querySelector('.transcript-skeleton'), null, 'no pane-sized skeleton');
  assert.ok(view.conversation('a'), 'the conversation mounts in the opening commit');
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
  assert.ok(view.conversation('d'), 'a cold session on a reused owner mounts in the switch commit');
  assert.equal(view.host.ownerDocument.querySelector('.transcript-skeleton'), null, 'and paints no skeleton');
  assert.equal(view.conversation('a'), first, 'the retained sessions are not remounted');
  await view.flushFrame();
  assert.ok(view.conversation('d'));
  assert.deepEqual(view.mountedSessions(), ['a', 'c', 'd']);
  assert.equal(view.host.ownerDocument.querySelectorAll('.conversation-persistent-surface').length, 3);

  // A closed tab is not kept.
  await view.render([A, B, D], D);
  assert.deepEqual(view.mountedSessions(), ['a', 'd']);
});

// User: 세션 들어갈 때 화면이 튄다. A desktop session switch remounted the
// pane's one Conversation (keyed transcript, entry cover) on every switch.
test('a desktop pane keeps its recent sessions mounted and switches back by visibility alone', async (t) => {
  const view = await mountPhoneWorkspace(t, { phone: false });
  const tabs = [A, B, C, D];
  await view.render(tabs, A);
  await view.flushFrame();
  const first = view.conversation('a');
  assert.ok(first);
  const textarea = first.querySelector('textarea');

  await view.render(tabs, B);
  await view.flushFrame();
  assert.equal(view.conversation('a'), first, 'the previous session stays mounted');
  assert.equal(view.surfaceOf('a').hasAttribute('data-retained'), true, 'hidden, not torn down');
  assert.equal(view.surfaceOf('a').inert, true);
  assert.deepEqual(await view.pressKey('Enter'), ['b:Enter'], 'the hidden session hears no key');

  const mountedBefore = view.liveSessions();
  await view.render(tabs, A);
  assert.equal(view.conversation('a'), first, 'switching back reuses the mounted conversation');
  assert.equal(first.querySelector('textarea'), textarea, 'its composer is the same element');
  assert.deepEqual(view.liveSessions(), mountedBefore, 'nothing mounted or unmounted by the switch');
  assert.equal(view.surfaceOf('a').hasAttribute('data-retained'), false);
  assert.equal(first.dataset.focused, 'true');
  assert.equal(view.host.ownerDocument.querySelector('.transcript-skeleton'), null, 'no skeleton on a warm switch');
  assert.deepEqual(await view.pressKey('Escape'), ['a:Escape'], 'shown again, it listens again; B no longer does');

  // Bounded: the shown session plus the two most recent ones.
  await view.render(tabs, C);
  await view.flushFrame();
  await view.render(tabs, D);
  await view.flushFrame();
  assert.deepEqual(view.mountedSessions(), ['a', 'c', 'd']);
  assert.equal(view.host.ownerDocument.querySelectorAll('.conversation-persistent-surface').length, 3);
});

test('a phone keeps the real composer mounted through a conversation entry and a cold switch', async (t) => {
  const view = await mountPhoneWorkspace(t);
  const doc = view.host.ownerDocument;
  const composers = () => [...doc.querySelectorAll('[data-composer]')];
  await view.render([A, B], A);
  assert.equal(composers().length, 1, 'the entry commit already holds the real composer');
  assert.equal(doc.querySelector('.transcript-skeleton-composer'), null, 'no fake composer bar');
  const first = view.conversation('a').querySelector('[data-composer]');
  await view.render([A, B], B);
  assert.ok(view.conversation('b').querySelector('[data-composer]'), 'a cold switch mounts the composer at once');
  assert.equal(doc.querySelector('.transcript-skeleton-composer'), null, 'no fake composer bar');
  assert.ok(first.isConnected, 'the previous composer stays mounted');
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

// Settings → compose with the conversation parked behind a file tab: the text
// must land once, in the conversation the user is brought back to, never in a
// retained (switched-away) session and never nowhere.
test('text sent to the composer lands once, in the parked conversation brought to the front', async (t) => {
  const view = await mountPhoneWorkspace(t, { phone: false });
  const [{ sendTextToComposer, takeComposerText }, { navigationKey }] = await Promise.all([
    import('./composer-text-inbox.ts'),
    import('./text-format.ts'),
  ]);
  t.after(() => takeComposerText());
  const file = { kind: 'file', project: '/project', rel: 'notes.md' };
  const tabs = [A, B, file];
  await view.render(tabs, A);
  await view.flushFrame();
  await view.render(tabs, B);
  await view.flushFrame();
  // A file tab parks B; A is a retained session switch.
  await view.render(tabs, file);
  await view.flushFrame();
  assert.equal(view.surfaceOf('a').hasAttribute('data-retained'), true);

  view.workspaceCalls.length = 0;
  await act(async () => sendTextToComposer('fix the build'));
  assert.deepEqual(
    view.workspaceCalls,
    [['activateTab', 'pane-1', navigationKey(B)]],
    'the parked conversation is brought to the front'
  );
  // The app shows it: its composer takes the waiting text.
  await view.render(tabs, B);
  await view.flushFrame();
  assert.equal(view.drafts.get('b'), 'fix the build');
  assert.equal(view.drafts.get('a'), '', 'the retained session gets nothing');
  assert.deepEqual(takeComposerText(), [], 'nothing left waiting, nothing to deliver twice');
  await view.render(tabs, A);
  assert.equal(view.drafts.get('a'), '', 'not on a later switch either');
});

test('text sent to the composer lands only in the focused pane when both panes show a conversation', async (t) => {
  const view = await mountPhoneWorkspace(t, { phone: false });
  const { sendTextToComposer, takeComposerText } = await import('./composer-text-inbox.ts');
  t.after(() => takeComposerText());
  const left = view.leafOf('pane-1', [A], A);
  const right = view.leafOf('pane-2', [B], B);
  await view.renderLayout({ type: 'split', direction: 'row', ratio: 0.5, first: left, second: right }, [left, right], right);
  await view.flushFrame();
  view.workspaceCalls.length = 0;
  await act(async () => sendTextToComposer('hello'));
  assert.deepEqual(view.workspaceCalls, [], 'already on screen: nothing to bring forward');
  assert.equal(view.drafts.get('b'), 'hello');
  assert.equal(view.drafts.get('a'), '');
});
