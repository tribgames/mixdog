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
  const [
    { PaneWorkspace },
    { createPaneLeaf },
    { useSurfaceActive },
    { useComposerExternalDraft },
    { ConversationReleaseContext, useConversationReleaseHold },
  ] = await Promise.all([
    import('./PaneWorkspace.tsx'),
    import('./pane-layout.ts'),
    import('./surface-activity.ts'),
    import('./use-composer-external-draft.ts'),
    import('./conversation-release.ts'),
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
  // Sessions whose conversation says it holds unfinished work, and each one's gate.
  const unfinished = new Set();
  const gates = new Map();
  function Conversation({ id, focused }) {
    renders.set(id, (renders.get(id) ?? 0) + 1);
    gates.set(id, React.useContext(ConversationReleaseContext));
    useConversationReleaseHold(() => unfinished.has(id));
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
    unfinished,
    /** The session's conversation finished its work: its part re-asks, as a commit would. */
    finish: (id) =>
      act(async () => {
        unfinished.delete(id);
        gates.get(id)?.changed();
      }),
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

test('an idle window gives back its retained conversations and keeps the shown one', async (t) => {
  const view = await mountPhoneWorkspace(t, { phone: false });
  const { _runIdleReclaimForTest } = await import('./idle-reclaim.ts');
  const tabs = [A, B, C];
  for (const active of [A, B, C]) {
    await view.render(tabs, active);
    await view.flushFrame();
  }
  assert.deepEqual(view.mountedSessions(), ['a', 'b', 'c']);
  const shown = view.conversation('c');

  await act(async () => _runIdleReclaimForTest());
  assert.deepEqual(view.mountedSessions(), ['c'], 'the retained sessions unmount');
  assert.equal(view.conversation('c'), shown, 'the shown session is not remounted');

  await view.render(tabs, A);
  await view.flushFrame();
  assert.deepEqual(view.mountedSessions(), ['a', 'c'], 'switching on retains again');
});

test('a retained conversation holding unfinished work stays through idle until it is done', async (t) => {
  const view = await mountPhoneWorkspace(t, { phone: false });
  const { _runIdleReclaimForTest } = await import('./idle-reclaim.ts');
  const tabs = [A, B, C];
  for (const active of [A, B, C]) {
    await view.render(tabs, active);
    await view.flushFrame();
  }
  view.unfinished.add('a');
  await act(async () => _runIdleReclaimForTest());
  assert.deepEqual(view.mountedSessions(), ['a', 'c'], 'the idle one goes, the one holding work stays');
  await view.finish('a');
  assert.deepEqual(view.mountedSessions(), ['c'], 'released once it says it may be');
});

test('a held conversation shown again before it finishes is not released afterwards', async (t) => {
  const view = await mountPhoneWorkspace(t, { phone: false });
  const { _runIdleReclaimForTest } = await import('./idle-reclaim.ts');
  const tabs = [A, B];
  for (const active of [A, B]) {
    await view.render(tabs, active);
    await view.flushFrame();
  }
  view.unfinished.add('a');
  await act(async () => _runIdleReclaimForTest());
  await view.render(tabs, A);
  await view.render(tabs, B);
  await view.finish('a');
  assert.deepEqual(view.mountedSessions(), ['a', 'b'], 'the pending release ended when it was shown');
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
  await view.renderLayout(
    { type: 'split', direction: 'row', ratio: 0.5, first: left, second: right },
    [left, right],
    right
  );
  await view.flushFrame();
  view.workspaceCalls.length = 0;
  await act(async () => sendTextToComposer('hello'));
  assert.deepEqual(view.workspaceCalls, [], 'already on screen: nothing to bring forward');
  assert.equal(view.drafts.get('b'), 'hello');
  assert.equal(view.drafts.get('a'), '');
});

test('a phone keeps the outgoing session painted while the incoming session prepares', async (t) => {
  const { dom, root } = installTestDom(t, {
    html: '<!doctype html><html data-mixdog-mobile-tabs><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'MutationObserver'],
    rootId: 'root',
  });
  Object.defineProperty(dom.window.navigator, 'userAgent', { configurable: true, get: () => PHONE_UA });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const [{ PaneWorkspace }, { createPaneLeaf }, { usePanePresentation }] = await Promise.all([
    import('./PaneWorkspace.tsx'),
    import('./pane-layout.ts'),
    import('./pane-presentation.ts'),
  ]);
  const presentations = new Map();
  function HandoverConversation({ id, focused }) {
    presentations.set(id, usePanePresentation());
    return React.createElement('section', { 'data-session': id, 'data-focused': String(focused) });
  }
  const render = async (active) => {
    const leaf = { ...createPaneLeaf(active, 'pane-1'), tabs: [A, B] };
    await act(async () =>
      root.render(
        React.createElement(PaneWorkspace, {
          workspace: {
            layout: leaf,
            leaves: [leaf],
            restoredFromStorage: true,
            restorePending: false,
            focusedLeaf: leaf,
            focusedLeafId: leaf.id,
            focusLeaf: () => {},
            activateTab: () => {},
            setRatio: () => {},
          },
          renderActive: () => null,
          renderConversation: (selection, focused) =>
            React.createElement(HandoverConversation, { id: selection.id, focused }),
          onFocusSelection: () => {},
        })
      )
    );
  };
  const conversationOf = (id) => dom.window.document.querySelector(`[data-session="${id}"]`);
  const surfaceOf = (id) => conversationOf(id)?.closest('.conversation-persistent-surface') ?? null;

  await render(A);
  assert.equal(surfaceOf('a').hasAttribute('data-preparing'), false);
  assert.equal(surfaceOf('a').hasAttribute('data-retained'), false);
  assert.equal(surfaceOf('a').hasAttribute('aria-hidden'), false);
  assert.equal(conversationOf('a').dataset.focused, 'true');

  await render(B);
  assert.equal(surfaceOf('a').hasAttribute('data-retained'), false, 'outgoing session stays painted while B prepares');
  assert.equal(surfaceOf('a').inert, true, 'outgoing session takes no input during handover');
  assert.equal(surfaceOf('a').hasAttribute('aria-hidden'), false, 'outgoing session stays visible to AT while painted');
  assert.equal(surfaceOf('b').hasAttribute('data-preparing'), true, 'incoming session prepares unseen behind A');
  assert.equal(surfaceOf('b').inert, true, 'preparing session cannot take focus while invisible');
  assert.equal(surfaceOf('b').getAttribute('aria-hidden'), 'true', 'preparing session is hidden from AT');
  assert.equal(conversationOf('b').dataset.focused, 'false', 'preparing session is not focused while invisible');
  assert.equal(presentations.get('b').preparing, true);

  await act(async () => presentations.get('b').ready());
  assert.equal(surfaceOf('a').hasAttribute('data-retained'), true, 'outgoing hides once incoming is ready');
  assert.equal(surfaceOf('a').getAttribute('aria-hidden'), 'true', 'retained outgoing session is hidden from AT');
  assert.equal(surfaceOf('b').hasAttribute('data-preparing'), false, 'incoming presents atomically');
  assert.equal(surfaceOf('b').inert, false);
  assert.equal(surfaceOf('b').hasAttribute('aria-hidden'), false, 'presented incoming session clears aria-hidden');
  assert.equal(conversationOf('b').dataset.focused, 'true', 'presented incoming session becomes focused');
});

test('desktop-theme synchronizes explicit and system Mixdog theme backing colors to Android and iOS shells', async (t) => {
  const { dom } = installTestDom(t, { actEnvironment: false });
  let osDark = false;
  dom.window.matchMedia = (query) => ({
    matches: query === '(prefers-color-scheme: dark)' ? osDark : !osDark,
    addEventListener() {},
    removeEventListener() {},
  });
  const androidMessages = [];
  const iosMessages = [];
  dom.window.MixdogNativeTheme = {
    postMessage(message) {
      androidMessages.push(JSON.parse(message));
    },
  };
  dom.window.webkit = {
    messageHandlers: {
      mixdogTheme: {
        postMessage(payload) {
          iosMessages.push(payload);
        },
      },
    },
  };
  const theme = await import('./desktop-theme.ts');

  // Explicit Dark on a light phone must override OS DayNight / userInterfaceStyle.
  theme.setDesktopThemePreference('dark');
  assert.deepEqual(androidMessages.at(-1), { surface: '#111111', band: '#181818', followSystem: false });
  assert.deepEqual(iosMessages.at(-1), { surface: '#111111', band: '#181818', followSystem: false });

  // Explicit White (or adopted host White theme) on a dark phone locks native backing to light.
  osDark = true;
  theme.adoptHostThemePreference('white');
  assert.deepEqual(androidMessages.at(-1), { surface: '#fcfcfc', band: '#f7f7f7', followSystem: false });
  assert.deepEqual(iosMessages.at(-1), { surface: '#fcfcfc', band: '#f7f7f7', followSystem: false });

  // System preference restores OS DayNight / dynamic UIColor tracking.
  theme.setDesktopThemePreference('system');
  assert.deepEqual(androidMessages.at(-1), { surface: '#111111', band: '#181818', followSystem: true });
  assert.deepEqual(iosMessages.at(-1), { surface: '#111111', band: '#181818', followSystem: true });
});

test('desktop-theme synchronizes custom JSON theme surface and band colors across dark theme switches', async (t) => {
  const { dom } = installTestDom(t, { actEnvironment: false });
  let osDark = true;
  dom.window.matchMedia = (query) => ({
    matches: query === '(prefers-color-scheme: dark)' ? osDark : !osDark,
    addEventListener() {},
    removeEventListener() {},
  });
  const androidMessages = [];
  const iosMessages = [];
  dom.window.MixdogNativeTheme = {
    postMessage(message) {
      androidMessages.push(JSON.parse(message));
    },
  };
  dom.window.webkit = {
    messageHandlers: {
      mixdogTheme: {
        postMessage(payload) {
          iosMessages.push(payload);
        },
      },
    },
  };
  const [theme, userTheme] = await Promise.all([import('./desktop-theme.ts'), import('./appearance/user-theme.ts')]);
  theme.setDesktopThemePreference('dark');
  userTheme.applyStoredUserTheme();

  const midnight = userTheme.importUserTheme(
    JSON.stringify({
      name: 'Midnight',
      appearance: 'dark',
      roles: { background: '#0d1117', sidebar: '#161b22' },
    })
  );
  assert.equal(midnight.ok, true);
  assert.deepEqual(androidMessages.at(-1), { surface: '#0d1117', band: '#161b22', followSystem: false });
  assert.deepEqual(iosMessages.at(-1), { surface: '#0d1117', band: '#161b22', followSystem: false });

  // Switching to a second dark custom theme must send its distinct surface & band colors.
  const tokyo = userTheme.importUserTheme(
    JSON.stringify({
      name: 'Tokyo',
      appearance: 'dark',
      roles: { background: '#1a1b26', sidebar: '#24283b' },
    })
  );
  assert.equal(tokyo.ok, true);
  assert.deepEqual(androidMessages.at(-1), { surface: '#1a1b26', band: '#24283b', followSystem: false });
  assert.deepEqual(iosMessages.at(-1), { surface: '#1a1b26', band: '#24283b', followSystem: false });

  // Switching back to the first dark theme sends its pair again.
  userTheme.setActiveUserTheme(midnight.id);
  assert.deepEqual(androidMessages.at(-1), { surface: '#0d1117', band: '#161b22', followSystem: false });
  assert.deepEqual(iosMessages.at(-1), { surface: '#0d1117', band: '#161b22', followSystem: false });

  // A dual-appearance custom theme under System still sends concrete custom colors (never built-in DayNight).
  const dual = userTheme.importUserTheme(
    JSON.stringify({
      name: 'Dual',
      roles: {
        background: { dark: '#10141c', light: '#faf6ef' },
        sidebar: { dark: '#181e29', light: '#efe9dc' },
      },
    })
  );
  assert.equal(dual.ok, true);
  theme.setDesktopThemePreference('system');
  assert.deepEqual(androidMessages.at(-1), { surface: '#10141c', band: '#181e29', followSystem: false });
  assert.deepEqual(iosMessages.at(-1), { surface: '#10141c', band: '#181e29', followSystem: false });

  osDark = false;
  theme.applyDesktopThemePreference('system');
  assert.deepEqual(androidMessages.at(-1), { surface: '#faf6ef', band: '#efe9dc', followSystem: false });
  assert.deepEqual(iosMessages.at(-1), { surface: '#faf6ef', band: '#efe9dc', followSystem: false });

  // Turning off the custom theme restores built-in System tracking.
  userTheme.setActiveUserTheme(null);
  assert.deepEqual(androidMessages.at(-1), { surface: '#fcfcfc', band: '#f7f7f7', followSystem: true });
  assert.deepEqual(iosMessages.at(-1), { surface: '#fcfcfc', band: '#f7f7f7', followSystem: true });
});

test('translucent sidebar composites over resolved background and skin selection resyncs native bridges', async (t) => {
  const { dom } = installTestDom(t, { actEnvironment: false });
  dom.window.matchMedia = (query) => ({
    matches: query === '(prefers-color-scheme: dark)',
    addEventListener() {},
    removeEventListener() {},
  });
  const androidMessages = [];
  const iosMessages = [];
  dom.window.MixdogNativeTheme = {
    postMessage(message) {
      androidMessages.push(JSON.parse(message));
    },
  };
  dom.window.webkit = {
    messageHandlers: {
      mixdogTheme: {
        postMessage(payload) {
          iosMessages.push(payload);
        },
      },
    },
  };
  const [theme, userTheme, skin] = await Promise.all([
    import('./desktop-theme.ts'),
    import('./appearance/user-theme.ts'),
    import('./desktop-skin.ts'),
  ]);
  theme.setDesktopThemePreference('dark');
  userTheme.applyStoredUserTheme();
  skin.applyStoredSkin();

  // Translucent sidebar (#0000ff80) over red background (#ff0000) must composite
  // over resolved background (#7f0080), not black (#000080).
  const crimson = userTheme.importUserTheme(
    JSON.stringify({
      name: 'Crimson',
      appearance: 'dark',
      roles: { background: '#ff0000', sidebar: '#0000ff80' },
    })
  );
  assert.equal(crimson.ok, true);
  assert.deepEqual(androidMessages.at(-1), { surface: '#ff0000', band: '#7f0080', followSystem: false });
  assert.deepEqual(iosMessages.at(-1), { surface: '#ff0000', band: '#7f0080', followSystem: false });

  // Selecting a skin overrides custom JSON background/sidebar tokens and must
  // immediately notify both native bridges with the updated built-in backing.
  const androidCountBeforeSkin = androidMessages.length;
  const iosCountBeforeSkin = iosMessages.length;
  skin.setSkin('glass-flow');
  assert.ok(androidMessages.length > androidCountBeforeSkin, 'selecting a skin notifies Android bridge');
  assert.ok(iosMessages.length > iosCountBeforeSkin, 'selecting a skin notifies iOS bridge');
  assert.deepEqual(androidMessages.at(-1), { surface: '#111111', band: '#181818', followSystem: false });
  assert.deepEqual(iosMessages.at(-1), { surface: '#111111', band: '#181818', followSystem: false });

  // Clearing the skin restores the active JSON theme's backing colors immediately.
  skin.setSkin('none');
  assert.deepEqual(androidMessages.at(-1), { surface: '#ff0000', band: '#7f0080', followSystem: false });
  assert.deepEqual(iosMessages.at(-1), { surface: '#ff0000', band: '#7f0080', followSystem: false });
});
