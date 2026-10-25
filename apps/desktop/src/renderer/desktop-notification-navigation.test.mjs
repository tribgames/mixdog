import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { focusOpenNotificationSession } from './desktop-notification-navigation.ts';
import { NOTIFICATION_JUMP_LATEST_EVENT, usePushNotificationNavigation } from './use-push-notification-navigation.ts';
import { activateTabInPaneLeaf, findPaneLeaf, paneLeaves } from './pane-layout.ts';
import { remotePairingKeys } from './remote-pairing-recovery.ts';
import { installTestDom } from './test-support/test-dom.mjs';
import { useAppFrameEntryIntake } from './app-root/app-frame-entry-intake.ts';
import { useAppFrameNavigationState } from './app-root/app-frame-navigation-state.ts';
import { agentHomeSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';

const session = (id) => ({ kind: 'session', id });
const layout = () => ({
  type: 'split',
  direction: 'row',
  ratio: 0.5,
  first: { type: 'leaf', id: 'left', tabs: [session('a')], activeKey: 'session:a' },
  second: { type: 'leaf', id: 'right', tabs: [session('b'), session('c')], activeKey: 'session:c' },
});

test('a desktop notification selects the existing tab in its own pane without adding a tab', () => {
  const workspace = {
    layout: layout(),
    focusedLeafId: 'left',
    activateTab(leafId, key) {
      this.layout = activateTabInPaneLeaf(this.layout, leafId, key);
      this.focusedLeafId = leafId;
    },
  };
  const beforeTabs = paneLeaves(workspace.layout).flatMap((leaf) => leaf.tabs);
  const surfaced = [];
  assert.equal(
    focusOpenNotificationSession(workspace, 'b', (selection) => surfaced.push(selection)),
    true
  );
  assert.equal(workspace.focusedLeafId, 'right');
  assert.equal(findPaneLeaf(workspace.layout, 'right').activeKey, 'session:b');
  assert.deepEqual(surfaced, [session('b')]);
  assert.deepEqual(
    paneLeaves(workspace.layout).flatMap((leaf) => leaf.tabs),
    beforeTabs
  );
});

test('a closed session leaves both the selected pane and its tabs untouched', () => {
  const original = layout();
  const workspace = {
    layout: original,
    activateTab() {
      assert.fail('A closed session must not select or create a tab');
    },
  };
  assert.equal(
    focusOpenNotificationSession(workspace, 'closed', () => assert.fail('A closed session must not be selected')),
    false
  );
  assert.equal(workspace.layout, original);
});

test('a desktop notification click moves the sidebar selection to the revealed session or bot chat', async (t) => {
  const { window, root } = installTestDom(t, { expose: ['navigator'], rootId: 'root' });
  Object.defineProperty(window.navigator, 'serviceWorker', { configurable: true, value: new window.EventTarget() });
  let click;
  window.mixdogDesktop = {
    onNotificationOpenSession(listener) {
      click = listener;
      return () => {
        click = undefined;
      };
    },
  };
  const bot = agentHomeSessionId('helper');
  const other = agentHomeSessionId('other');
  const workspace = {
    layout: {
      type: 'split',
      direction: 'row',
      ratio: 0.5,
      first: { type: 'leaf', id: 'left', tabs: [session('a'), session('b')], activeKey: 'session:a' },
      second: { type: 'leaf', id: 'right', tabs: [session(bot)], activeKey: `session:${bot}` },
    },
    restorePending: false,
    activateTab(leafId, key) {
      this.layout = activateTabInPaneLeaf(this.layout, leafId, key);
    },
  };
  const opened = [];
  let nav;
  function Probe() {
    nav = useAppFrameNavigationState(session('a'));
    nav.openSessionRef.current = async (id) => {
      opened.push(id);
    };
    // What the pane chrome's activatePaneSurface does with a session tab.
    nav.activatePaneSurfaceRef.current = (selection) => nav.setSelection(selection);
    useAppFrameEntryIntake({
      sessionCatalogReady: true,
      sessions: [{ id: 'a' }, { id: 'b' }, { id: bot }, { id: 'closed' }, { id: other }],
      openSessionRef: nav.openSessionRef,
      activatePaneSurfaceRef: nav.activatePaneSurfaceRef,
      navigationEpoch: nav.navigationEpoch,
      setRequestedSessionId: nav.setRequestedSessionId,
      paneWorkspace: workspace,
    });
    return null;
  }
  await act(async () => root.render(React.createElement(Probe)));
  assert.equal(nav.sidebarSelection.id, 'a');

  // A cold open of 'cold' is still loading (its requested id leads the
  // sidebar) when the click arrives: the reveal supersedes it, row and stamp.
  await act(async () => nav.setRequestedSessionId('cold'));
  assert.equal(nav.sidebarSelection.id, 'cold');
  const epoch = nav.navigationEpoch.current;

  // A session in the same pane: the row the sidebar highlights follows the tab.
  await act(async () => click('b'));
  assert.equal(findPaneLeaf(workspace.layout, 'left').activeKey, 'session:b');
  assert.deepEqual(nav.sidebarSelection, session('b'));
  assert.ok(nav.navigationEpoch.current > epoch, 'the loading open can no longer settle over the reveal');

  // A bot chat in the other pane: its bot row is the selected one.
  await act(async () => click(bot));
  assert.deepEqual(nav.sidebarSelection, session(bot));

  // A conversation with no open tab (a bot chat, room, task or sub-agent
  // session, or a closed tab) is opened through the same path as a sidebar click.
  assert.deepEqual(opened, []);
  await act(async () => click('closed'));
  assert.deepEqual(opened, ['closed']);
  await act(async () => click(other));
  assert.deepEqual(opened, ['closed', other]);
  // A deleted session (not in the catalog) opens no "Untitled session" tab.
  await act(async () => click('deleted'));
  assert.deepEqual(opened, ['closed', other]);
  assert.deepEqual(nav.sidebarSelection, session(bot));
});

async function harness(t, { url, ...initial } = {}) {
  const { window, root } = installTestDom(t, { expose: ['navigator'], rootId: 'root' });
  if (url) window.history.replaceState(null, '', url);
  const serviceWorker = new window.EventTarget();
  Object.defineProperty(window.navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
  let click;
  let subscriptions = 0;
  const opened = [];
  const selected = [];
  window.mixdogDesktop = {
    onNotificationOpenSession(listener) {
      click = listener;
      subscriptions++;
      return () => {
        click = undefined;
      };
    },
  };
  let currentLayout = layout();
  let props = {
    ready: true,
    desktopReady: true,
    openSession: (id) => opened.push(id),
    focusDesktopSession: (id) =>
      focusOpenNotificationSession(
        {
          layout: currentLayout,
          activateTab: (leafId, key) => selected.push([leafId, key]),
        },
        id,
        () => {}
      ),
    ...initial,
  };
  function Probe(input) {
    usePushNotificationNavigation(input);
    return null;
  }
  const render = async (patch = {}) => {
    props = { ...props, ...patch };
    await act(async () => root.render(React.createElement(Probe, props)));
  };
  await render();
  return {
    window,
    opened,
    selected,
    render,
    subscriptions: () => subscriptions,
    closeTabs: () => {
      currentLayout = { type: 'leaf', id: 'left', tabs: [session('a')], activeKey: 'session:a' };
    },
    click: async (id) => {
      await act(async () => click(id));
    },
    push: async (id, hostId) => {
      await act(async () =>
        serviceWorker.dispatchEvent(
          new window.MessageEvent('message', {
            data: { type: 'mixdog:open-session', sessionId: id, ...(hostId ? { hostId } : {}) },
          })
        )
      );
    },
  };
}

test('desktop IPC focuses an open session and opens a closed one once the catalog exists', async (t) => {
  const h = await harness(t, { ready: false });
  await h.click('b');
  await h.click('closed');
  assert.deepEqual(h.selected, [['right', 'session:b']]);
  assert.deepEqual(h.opened, [], 'a session that is not open waits for the catalog');
  await h.render({ ready: true });
  assert.deepEqual(h.opened, ['closed']);
  await h.click('another-closed');
  assert.deepEqual(h.opened, ['closed', 'another-closed']);
  assert.deepEqual(h.selected, [['right', 'session:b']]);
});

test('a newer click on an open tab cancels an older closed session still waiting for the catalog', async (t) => {
  const h = await harness(t, { ready: false });
  await h.click('closed');
  await h.click('b');
  assert.deepEqual(h.selected, [['right', 'session:b']]);
  await h.render({ ready: true });
  assert.deepEqual(h.opened, [], 'the older click no longer opens over the newer one');
});

test('a newer tap replaces a desktop click still waiting for pane restoration', async (t) => {
  const h = await harness(t, { desktopReady: false, ready: false });
  await h.click('b');
  await h.push('phone-session');
  await h.render({ desktopReady: true, ready: true });
  assert.deepEqual(h.selected, []);
  assert.deepEqual(h.opened, ['phone-session']);
});

test('a notification for a session the catalog no longer has opens nothing, before or after it loads', async (t) => {
  const h = await harness(t, { ready: false, hasSession: (id) => id !== 'deleted' });
  await h.click('deleted');
  await h.render({ ready: true });
  assert.deepEqual(h.opened, []);
  await h.click('deleted');
  assert.deepEqual(h.opened, []);
  await h.click('kept');
  assert.deepEqual(h.opened, ['kept']);
});

test('an early desktop click waits for pane restoration, then selects exactly once', async (t) => {
  const h = await harness(t, { desktopReady: false });
  await h.click('b');
  assert.deepEqual(h.selected, []);
  await h.render({ desktopReady: true });
  assert.deepEqual(h.selected, [['right', 'session:b']]);
  await h.render();
  assert.equal(h.selected.length, 1);
  assert.deepEqual(h.opened, []);
});

test('a tab closed before restoration completes is opened, not revealed, by a queued click', async (t) => {
  const h = await harness(t, { desktopReady: false });
  await h.click('b');
  h.closeTabs();
  await h.render({ desktopReady: true });
  assert.deepEqual(h.selected, []);
  assert.deepEqual(h.opened, ['b']);
});

test('a moved tab uses the latest focus callback without reinstalling the IPC listener', async (t) => {
  const h = await harness(t);
  const focused = [];
  await h.render({ focusDesktopSession: (id) => focused.push(id) });
  await h.click('b');
  assert.deepEqual(focused, ['b']);
  assert.deepEqual(h.selected, []);
  assert.equal(h.subscriptions(), 1);
});

test('phone push still opens its session, including a click received before catalog readiness', async (t) => {
  const h = await harness(t, { ready: false, desktopReady: false });
  await h.push('phone-session');
  assert.deepEqual(h.opened, []);
  await h.render({ ready: true });
  assert.deepEqual(h.opened, ['phone-session']);
  await h.push('another-phone-session');
  assert.deepEqual(h.opened, ['phone-session', 'another-phone-session']);
  assert.deepEqual(h.selected, []);
});

test('a tapped notification asks the pane for its latest row, after opening or focusing it', async (t) => {
  const h = await harness(t, { ready: false });
  const jumps = [];
  const onJump = (event) => jumps.push(event.detail);
  h.window.addEventListener(NOTIFICATION_JUMP_LATEST_EVENT, onJump);
  t.after(() => h.window.removeEventListener(NOTIFICATION_JUMP_LATEST_EVENT, onJump));
  // A phone tap before the catalog exists jumps only once it really opens.
  await h.push('phone-session');
  assert.deepEqual(jumps, []);
  await h.render({ ready: true });
  assert.deepEqual(jumps, ['phone-session']);
  // A desktop click on an already open tab jumps too.
  await h.click('b');
  assert.deepEqual(jumps, ['phone-session', 'b']);
});

const PC_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PC_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** Pairing material for `pcs` only; the PC this page drives may lack it. */
function hostEnvironment(pcs) {
  const origin = 'https://relay.mixdog.test';
  const stored = new Map();
  for (const deviceId of pcs) {
    const keys = remotePairingKeys(origin, deviceId);
    stored.set(keys.token, deviceId[0].repeat(64));
    stored.set(keys.e2eePublicKey, 'p'.repeat(87));
    stored.set(keys.e2eeSecret, 's'.repeat(43));
  }
  return {
    origin,
    currentHostId: PC_A,
    hostIds: [PC_B],
    storage: { getItem: (key) => stored.get(key) ?? null, setItem() {} },
  };
}

test('a tap from another paired PC switches to that PC; an unknown PC opens nothing here', async (t) => {
  const switched = [];
  const h = await harness(t, {
    ready: false,
    switchHost: (url) => switched.push(url),
    hostEnvironment: hostEnvironment([PC_A, PC_B]),
  });
  // Arrives while this PC is still booting: another PC's tap does not wait for it.
  await h.push('b-session', PC_B);
  assert.deepEqual(switched, [`/d/${PC_B}/?session=b-session&host=${PC_B}`]);
  // This PC's own tap waits for its catalog.
  await h.push('a-session', PC_A);
  assert.deepEqual(h.opened, []);
  await h.render({ ready: true });
  assert.deepEqual(h.opened, ['a-session'], 'never opened B on the PC this page drives');
  await h.push('ghost-session', 'dddddddd-4444-4444-8444-dddddddddddd');
  assert.deepEqual(h.opened, ['a-session']);
  assert.equal(switched.length, 1);
});

test('a launch for another PC switches even when this PC never becomes ready', async (t) => {
  const switched = [];
  // PC A lost its pairing material: its catalog waits forever for a credential.
  const h = await harness(t, {
    url: `/d/${PC_A}/?session=b-session&host=${PC_B}`,
    ready: false,
    switchHost: (url) => switched.push(url),
    hostEnvironment: hostEnvironment([PC_B]),
  });
  assert.deepEqual(switched, [`/d/${PC_B}/?session=b-session&host=${PC_B}`]);
  assert.deepEqual(h.opened, []);
});
