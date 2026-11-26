import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

// xterm does not load under node: the terminal tab's body is an empty pane, the portal around it the real one. Its
// import failing whenever it lands would fail whichever test is running then.
const TERMINAL_PANE_STUB =
  'export default function TerminalPane() { return null; }' +
  'export async function disposeTerminalPane() {}' +
  'export async function prewarmTerminal() { return false; }' +
  'export function terminalPaintsAtOnce() { return false; }';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './TerminalPane' && context.parentURL?.endsWith('/lazy-widgets.ts')) {
      return { url: `data:text/javascript,${encodeURIComponent(TERMINAL_PANE_STUB)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

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

async function mountPresentingWorkspace(t) {
  const { dom, root } = installTestDom(t, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement'],
    rootId: 'root',
  });
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
  const [{ PaneWorkspace }, { createPaneLeaf }, { usePanePresentation }, { navigationKey }] = await Promise.all([
    import('./PaneWorkspace.tsx'),
    import('./pane-layout.ts'),
    import('./pane-presentation.ts'),
    import('./text-format.ts'),
  ]);
  const presentations = new Map();
  function PresentingConversation({ id, focused }) {
    presentations.set(id, usePanePresentation());
    return React.createElement('section', { 'data-session': id, 'data-focused': String(focused) });
  }
  const noop = () => {};
  return {
    host,
    presentations,
    leaf(tabs, active = tabs[0], id = 'pane-1') {
      return { ...createPaneLeaf(active, id), tabs };
    },
    conversation(id) {
      return host.ownerDocument.querySelector(`[data-session="${id}"]`);
    },
    surfaceOf(id) {
      return this.conversation(id)?.closest('.conversation-persistent-surface') ?? null;
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
            renderConversation: (selection, focused) =>
              React.createElement(PresentingConversation, { id: selection.id, focused }),
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

test('switching from an open file to a preparing session holds the file handoff until ready without exposing a parked session', async (t) => {
  const sessionA = { kind: 'session', id: 'a', title: 'a' };
  const sessionB = { kind: 'session', id: 'b', title: 'b' };
  const tabs = [sessionA, script, sessionB];
  const view = await mountPresentingWorkspace(t);

  await view.render([view.leaf(tabs, sessionA)]);
  await view.render([view.leaf(tabs, script)]);
  await view.flushFrame();
  assert.ok(view.host.querySelector('[data-editor="script.ts"][data-active="true"]'));

  await view.render([view.leaf(tabs, sessionB)]);
  // Multiple frames pass while session B is still preparing: the open file must stay on top.
  await view.flushFrame();
  await view.flushFrame();
  assert.ok(
    view.host.querySelector('[data-pane-surface-handoff="true"] [data-editor="script.ts"][data-active="true"]'),
    'file handoff stays painted while incoming session prepares'
  );
  assert.equal(view.surfaceOf('b').hasAttribute('data-preparing'), true);
  assert.equal(view.surfaceOf('b').inert, true);
  assert.equal(view.surfaceOf('b').getAttribute('aria-hidden'), 'true');
  assert.equal(view.conversation('b').dataset.focused, 'false');
  assert.equal(view.surfaceOf('a').hasAttribute('data-retained'), true, 'parked session A stays hidden and retained');
  assert.equal(view.surfaceOf('a').inert, true);

  await act(async () => view.presentations.get('b').ready());
  assert.equal(view.surfaceOf('b').hasAttribute('data-preparing'), false);
  assert.equal(view.surfaceOf('b').inert, false);
  assert.equal(view.surfaceOf('b').hasAttribute('aria-hidden'), false);
  assert.equal(view.conversation('b').dataset.focused, 'true');
  assert.ok(
    view.host.querySelector('[data-pane-surface-handoff="true"] [data-editor="script.ts"][data-active="true"]'),
    'file handoff retires on the frame after B is ready so B paints behind it first'
  );

  await view.flushFrame();
  assert.equal(view.host.querySelector('[data-pane-surface-handoff="true"]'), null);
  assert.ok(view.host.querySelector('[data-editor="script.ts"][data-active="false"]'));
});

test('switching from an open file with no prior conversation holds the file handoff until ready and cancels if closed', async (t) => {
  const sessionB = { kind: 'session', id: 'b', title: 'b' };
  const view = await mountPresentingWorkspace(t);

  await view.render([view.leaf([script, sessionB], script)]);
  await view.render([view.leaf([script, sessionB], sessionB)]);
  await view.flushFrame();
  assert.ok(
    view.host.querySelector('[data-pane-surface-handoff="true"] [data-editor="script.ts"][data-active="true"]'),
    'file handoff holds even when no conversation was previously shown'
  );
  assert.equal(view.surfaceOf('b').hasAttribute('data-preparing'), true);
  assert.equal(view.presentations.get('b').preparing, true);

  // Closing the file tab while B is preparing cancels the handoff immediately and uncovers B.
  await view.render([view.leaf([sessionB], sessionB)]);
  assert.equal(view.host.querySelector('[data-editor="script.ts"]'), null);
  assert.equal(view.host.querySelector('[data-pane-surface-handoff="true"]'), null);
  assert.equal(view.surfaceOf('b').hasAttribute('data-preparing'), false);
  assert.equal(view.surfaceOf('b').inert, false);
});

test('closing an outgoing file while a new conversation prepares does not expose a parked conversation', async (t) => {
  const sessionA = { kind: 'session', id: 'a', title: 'a' };
  const sessionB = { kind: 'session', id: 'b', title: 'b' };
  const tabs = [sessionA, script, sessionB];
  const view = await mountPresentingWorkspace(t);

  await view.render([view.leaf(tabs, sessionA)]);
  await view.render([view.leaf(tabs, script)]);
  await view.flushFrame();
  assert.ok(view.host.querySelector('[data-editor="script.ts"][data-active="true"]'));

  await view.render([view.leaf(tabs, sessionB)]);
  await view.flushFrame();
  assert.ok(
    view.host.querySelector('[data-pane-surface-handoff="true"] [data-editor="script.ts"][data-active="true"]')
  );
  assert.equal(view.surfaceOf('b').hasAttribute('data-preparing'), true);
  assert.equal(view.surfaceOf('a').hasAttribute('data-retained'), true);

  // Close the outgoing file before B finishes preparing: parked A must stay
  // hidden and retained rather than being promoted back to visible.
  await view.render([view.leaf([sessionA, sessionB], sessionB)]);
  assert.equal(view.host.querySelector('[data-editor="script.ts"]'), null);
  assert.equal(view.host.querySelector('[data-pane-surface-handoff="true"]'), null);
  assert.equal(view.surfaceOf('a').hasAttribute('data-retained'), true, 'parked A stays retained and hidden');
  assert.equal(view.surfaceOf('a').inert, true);
  assert.equal(view.surfaceOf('a').getAttribute('aria-hidden'), 'true');
  assert.equal(view.surfaceOf('b').hasAttribute('data-preparing'), false, 'B uncovers directly once file closes');
  assert.equal(view.surfaceOf('b').inert, false);
  assert.equal(view.conversation('b').dataset.focused, 'true');
});

test('switching from a terminal to a preparing conversation keeps the real terminal portal rendered until retirement or tab close', async (t) => {
  const { dom, root } = installTestDom(t, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'MutationObserver'],
    rootId: 'root',
  });
  dom.window.__mixdogWindowShown = true;
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  let nextFrame = 1;
  const pendingFrames = new Map();
  dom.window.requestAnimationFrame = (callback) => {
    const id = nextFrame++;
    pendingFrames.set(id, callback);
    return id;
  };
  dom.window.cancelAnimationFrame = (id) => pendingFrames.delete(id);

  const [{ PaneWorkspace }, { createPaneLeaf }, { usePanePresentation }, { useAppPersistentPaneSurfaces }] =
    await Promise.all([
      import('./PaneWorkspace.tsx'),
      import('./pane-layout.ts'),
      import('./pane-presentation.ts'),
      import('./use-app-persistent-pane-surfaces.tsx'),
    ]);

  const terminal = { kind: 'terminal', id: 'term-1', cwd: '/project' };
  const sessionB = { kind: 'session', id: 'b', title: 'b' };
  const sessionC = { kind: 'session', id: 'c', title: 'c' };
  const presentations = new Map();
  const noop = () => {};

  function PresentingConversation({ id, focused }) {
    presentations.set(id, usePanePresentation());
    return React.createElement('section', { 'data-session': id, 'data-focused': String(focused) });
  }

  function TerminalWorkspaceHarness({ leaves }) {
    const workspace = {
      layout: leaves[0],
      leaves,
      restoredFromStorage: true,
      restorePending: false,
      focusedLeaf: leaves[0],
      focusedLeafId: leaves[0].id,
      focusLeaf: noop,
      activateTab: noop,
      updateSelection: noop,
      setRatio: noop,
    };
    const latestEditorLocation = React.useRef(null);
    const { paneFileEditors, paneUtilitySurfacePortals, paneUtilityTabs } = useAppPersistentPaneSurfaces({
      paneWorkspace: workspace,
      workbenchWorkspace: { workspace: { workspaceFile: null } },
      fileReveal: null,
      handleFileDirty: noop,
      registerEditorSaveHandle: noop,
      openFileTab: noop,
      latestEditorLocation,
      sidebarOpen: false,
      toggleSidebar: noop,
    });
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(PaneWorkspace, {
        workspace,
        renderActive: () => null,
        renderFileEditors: paneFileEditors,
        renderUtilityTabs: paneUtilityTabs,
        renderConversation: (selection, focused) =>
          React.createElement(PresentingConversation, { id: selection.id, focused }),
        onFocusSelection: noop,
      }),
      paneUtilitySurfacePortals
    );
  }

  const leaf = (tabs, active) => ({ ...createPaneLeaf(active, 'pane-1'), tabs });
  const render = async (tabs, active) => {
    await act(async () => root.render(React.createElement(TerminalWorkspaceHarness, { leaves: [leaf(tabs, active)] })));
  };
  const flushFrame = async () => {
    await act(async () => {
      const callbacks = [...pendingFrames.values()];
      pendingFrames.clear();
      for (const callback of callbacks) callback(0);
    });
  };
  const terminalGate = () => dom.window.document.querySelector('.terminal-persistent-surface .pane-surface-gate');
  const surfaceOf = (id) =>
    dom.window.document.querySelector(`[data-session="${id}"]`)?.closest('.conversation-persistent-surface') ?? null;

  await render([terminal, sessionB, sessionC], terminal);
  assert.ok(terminalGate(), 'active terminal mounts its real portal content');

  // Switch Terminal -> preparing Conversation B: the real terminal portal must
  // stay rendered while held as an outgoing handoff layer.
  await render([terminal, sessionB, sessionC], sessionB);
  await flushFrame();
  await flushFrame();
  assert.ok(
    dom.window.document.querySelector(
      '[data-pane-surface-handoff="true"] .terminal-tab-pane[data-surface-active="true"]'
    ),
    'terminal handoff slot stays painted while B prepares'
  );
  assert.ok(terminalGate(), 'real terminal portal stays rendered instead of collapsing to null while B prepares');
  assert.equal(surfaceOf('b').hasAttribute('data-preparing'), true);

  await act(async () => presentations.get('b').ready());
  assert.equal(surfaceOf('b').hasAttribute('data-preparing'), false);
  assert.ok(terminalGate(), 'terminal portal stays rendered for the final handoff frame');

  await flushFrame();
  assert.equal(dom.window.document.querySelector('[data-pane-surface-handoff="true"]'), null);
  assert.equal(terminalGate(), null, 'terminal portal releases cleanly once the handoff retires');

  // Re-activate Terminal, switch to preparing Conversation C, then close the Terminal tab.
  await render([terminal, sessionB, sessionC], terminal);
  assert.ok(terminalGate(), 'terminal portal mounts again when reselected');
  await render([terminal, sessionB, sessionC], sessionC);
  assert.ok(terminalGate(), 'terminal portal stays rendered while C prepares');
  await render([sessionB, sessionC], sessionC);
  assert.equal(dom.window.document.querySelector('[data-pane-surface-handoff="true"]'), null);
  assert.equal(terminalGate(), null, 'closing the terminal tab releases its portal immediately');
  assert.equal(surfaceOf('c').hasAttribute('data-preparing'), false);

  // Direct utility switch (Terminal -> Studio) releases the terminal portal cleanly too.
  const studio = { kind: 'studio', id: 'studio-1' };
  await render([terminal, studio], terminal);
  assert.ok(terminalGate(), 'terminal mounts when active');
  await render([terminal, studio], studio);
  assert.equal(terminalGate(), null, 'direct utility switch releases the terminal portal cleanly');
});

test('deactivating a terminal portal releases phone PTY size ownership before unmounting the terminal view', async (t) => {
  const { root } = installTestDom(t, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement'],
    rootId: 'root',
  });
  const { DeferredDeactivationGate } = await import('./use-app-persistent-pane-surfaces.tsx');

  // Mirrors TerminalPane.tsx:906 (mount effect removes from terminalViews on
  // unmount) followed by :953 (active effect releases PTY size owner only if
  // terminalViews still holds the view).
  const terminalViews = new Map();
  const events = [];
  function PhoneTerminalProbe({ id, active }) {
    React.useEffect(() => {
      terminalViews.set(id, { id });
      events.push(`mount:${id}`);
      return () => {
        terminalViews.delete(id);
        events.push(`unmount:${id}`);
      };
    }, [id]);
    React.useEffect(() => {
      if (!active) return undefined;
      events.push(`claim:${id}`);
      return () => {
        const view = terminalViews.get(id);
        if (view?.id) events.push(`release-size:${view.id}`);
        else events.push(`missed-release:${id}`);
      };
    }, [active, id]);
    return React.createElement('div', { 'data-probe-terminal': id, 'data-active': String(active) });
  }

  const render = (active) =>
    act(async () =>
      root.render(
        React.createElement(DeferredDeactivationGate, { active }, (terminalActive) =>
          React.createElement(PhoneTerminalProbe, { id: 'term-phone', active: terminalActive })
        )
      )
    );

  await render(true);
  assert.ok(document.querySelector('[data-probe-terminal="term-phone"][data-active="true"]'));
  assert.deepEqual(events, ['mount:term-phone', 'claim:term-phone']);

  // Leaving Terminal (handoff retirement or direct utility switch): active
  // cleanup must run while terminalViews still holds the view, then unmount.
  await render(false);
  assert.equal(document.querySelector('[data-probe-terminal="term-phone"]'), null, 'unmounts after deactivation');
  assert.deepEqual(events, ['mount:term-phone', 'claim:term-phone', 'release-size:term-phone', 'unmount:term-phone']);

  // Re-entering Terminal mounts and re-claims cleanly.
  await render(true);
  assert.ok(document.querySelector('[data-probe-terminal="term-phone"][data-active="true"]'));
  assert.deepEqual(events, [
    'mount:term-phone',
    'claim:term-phone',
    'release-size:term-phone',
    'unmount:term-phone',
    'mount:term-phone',
    'claim:term-phone',
  ]);
});
