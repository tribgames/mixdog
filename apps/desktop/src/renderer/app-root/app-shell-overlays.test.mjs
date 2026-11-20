import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useState } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';
import { createExtensionsPane, createSkillsPane, settingsViewModule } from '../app-shell-components';
import { _resetBootWarmupForTest } from '../boot-warmup';
import { projectAddDialogModule } from '../first-screen-deferred';
import { studioViewModule } from '../studio-loader';
import { useAppWorkspaceWarmup } from '../use-app-boot';
import { useAppFrameBootEffects } from './app-frame-boot-effects';
import { AppSidebarDrawer } from './AppSidebarDrawer.tsx';
import { AppShellOverlays } from './AppShellOverlays.tsx';

function mountShell(t, desktop = false) {
  return installTestDom(t, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'https://mixdog.test/' },
    ...(desktop ? { globals: { navigator: { userAgent: 'Electron/43.0.0' } } } : {}),
    rootId: 'root',
    expose: [
      'navigator',
      'Node',
      'Element',
      'HTMLElement',
      'HTMLButtonElement',
      'Event',
      'CustomEvent',
      'KeyboardEvent',
      'MutationObserver',
    ],
  });
}

const defaultProps = {
  quickAccessMode: null,
  quickAccessProjectPath: '',
  quickAccessRecentFiles: [],
  workbenchCommands: [],
  openFileTab: () => {},
  setQuickAccessMode: () => {},
  tabSwitcher: null,
  focusedLeafForShortcuts: null,
  stripTitleFor: (_k, sel) => (sel.kind === 'session' ? 'Session tab' : 'Tab'),
  pendingUnsavedClose: null,
  unsavedCloseBusy: false,
  unsavedCloseError: '',
  saveAndClosePendingTab: () => {},
  discardAndClosePendingTab: () => {},
  cancelPendingTabClose: () => {},
  settingsOpen: false,
  settingsSection: null,
  setSettingsOpen: () => {},
  commandSurface: null,
  commandSurfaceSessionId: '',
  commandSurfaceLane: null,
  setCommandSurface: () => {},
  setCommandSurfaceSessionId: () => {},
  replaceWithInheritedSession: async () => {},
  onboardingOpen: false,
  setOnboardingOpen: () => {},
  updateDialogOpen: false,
  updaterState: { status: 'ready', version: '1.0.0' },
  closeDesktopUpdate: () => {},
  installDesktopUpdate: () => {},
  error: '',
  connected: true,
  setError: () => {},
  snapshot: {},
};

test('AppShellOverlays renders tab switcher, unsaved dialog, and update dialog under given conditions', async (t) => {
  const { dom, root } = mountShell(t);
  const container = dom.window.document.getElementById('root');

  // 1. Initially no tab switcher or unsaved dialog
  await act(async () => {
    root.render(React.createElement(AppShellOverlays, defaultProps));
  });
  assert.equal(container.querySelector('.workspace-tab-switcher'), null);
  assert.equal(container.querySelector('.unsaved-changes-dialog'), null);

  // 2. Tab switcher rendered when provided
  const tabSwitcherProps = {
    ...defaultProps,
    tabSwitcher: { keys: ['session:s1', 'session:s2'], index: 0 },
    focusedLeafForShortcuts: {
      id: 'leaf1',
      tabs: [
        { kind: 'session', id: 's1' },
        { kind: 'session', id: 's2' },
      ],
      activeTabKey: 'session:s1',
    },
  };
  await act(async () => {
    root.render(React.createElement(AppShellOverlays, tabSwitcherProps));
  });
  const switcher = container.querySelector('.workspace-tab-switcher');
  assert.notEqual(switcher, null);
  const options = container.querySelectorAll('.workspace-tab-switcher [role="option"]');
  assert.equal(options.length, 2);
  assert.equal(options[0].getAttribute('aria-selected'), 'true');
  assert.equal(options[1].getAttribute('aria-selected'), 'false');

  // 3. Unsaved changes dialog rendered when pending
  await import('../WorkbenchOverlays.tsx');
  const unsavedProps = {
    ...defaultProps,
    pendingUnsavedClose: {
      tab: {
        key: 'file:/path/test.ts',
        title: '● test.ts',
        selection: { kind: 'file', project: '/p', rel: 'test.ts' },
      },
    },
  };
  await act(async () => {
    root.render(React.createElement(AppShellOverlays, unsavedProps));
  });
  // Allow lazy microtask to resolve
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.match(dom.window.document.body.textContent || '', /test\.ts/);

  // 4. Update dialog rendered when update ready
  const updateProps = {
    ...defaultProps,
    updateDialogOpen: true,
    updaterState: { status: 'ready', version: '2.0.0' },
  };
  await act(async () => {
    root.render(React.createElement(AppShellOverlays, updateProps));
  });
  assert.match(dom.window.document.body.textContent || '', /2\.0\.0/);

  // 5. Command surfaces retain their DOM while closed and can open a session-scoped view.
  await import('../CommandSurface.tsx');

  // 5a. Non-session surface ('doctor') renders and stays mounted (inert, hidden) when closed
  const doctorProps = {
    ...defaultProps,
    commandSurface: 'doctor',
    commandSurfaceSessionId: '',
  };
  await act(async () => {
    root.render(React.createElement(AppShellOverlays, doctorProps));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  const openDoctorSurface = dom.window.document.querySelector('[data-surface="doctor"]');
  assert.notEqual(openDoctorSurface, null, 'Doctor surface should be mounted in the DOM');
  assert.equal(openDoctorSurface.closest('.mixdog-settings-layer')?.getAttribute('data-surface-active'), 'true');
  assert.equal(openDoctorSurface.closest('.mixdog-settings-layer')?.hasAttribute('inert'), false);

  // Close doctor surface (commandSurface: null). It must stay retained in mountedCommandSurfaces, but inactive & inert
  const closedDoctorProps = {
    ...defaultProps,
    commandSurface: null,
    commandSurfaceSessionId: '',
  };
  await act(async () => {
    root.render(React.createElement(AppShellOverlays, closedDoctorProps));
  });
  const retainedDoctorSurface = dom.window.document.querySelector('[data-surface="doctor"]');
  assert.notEqual(retainedDoctorSurface, null, 'Doctor surface should remain mounted when closed');
  assert.equal(retainedDoctorSurface, openDoctorSurface, 'Closing must preserve the mounted surface');
  assert.equal(retainedDoctorSurface.closest('.mixdog-settings-layer')?.getAttribute('data-surface-active'), 'false');
  assert.equal(retainedDoctorSurface.closest('.mixdog-settings-layer')?.hasAttribute('inert'), true);

  // 5b. Session-scoped surface ('context') renders as the active view.
  const contextSessionProps = {
    ...defaultProps,
    commandSurface: 'context',
    commandSurfaceSessionId: 'sess-abc',
    commandSurfaceLane: { toasts: [] },
  };
  await act(async () => {
    root.render(React.createElement(AppShellOverlays, contextSessionProps));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  const contextSurface = dom.window.document.querySelector('[data-surface="context"]');
  assert.notEqual(contextSurface, null, 'Context surface should be mounted');
  assert.equal(contextSurface.closest('.mixdog-settings-layer')?.getAttribute('data-surface-active'), 'true');
});

const noop = () => {};
const noSessions = [];
const emptyWorkspace = { focusedLeafId: '', leaves: [] };
const railViews = ['sessions', 'extensions', 'skills'];
const ExtensionsPane = createExtensionsPane();
const SkillsPane = createSkillsPane();
const drawerProps = {
  // A restored open sidebar must not count as opening Settings.
  sidebarOpen: true,
  sidebarMotion: 'instant',
  openSidebar: noop,
  applySidebarOpen: noop,
  onboardingActive: false,
  closeSidebarForNavigation: noop,
  updaterState: defaultProps.updaterState,
  openDesktopUpdate: noop,
  setCommandSurface: noop,
  workbenchSideLayout: { layout: { left: railViews.map((id) => [id]), right: [] } },
  sideViewDescriptors: new Map(railViews.map((id) => [id, { id, label: id, icon: () => null }])),
  moveWorkbenchSideGroup: noop,
  moveWorkbenchSideView: noop,
  sidebarDiff: null,
  closeSidebarDiff: noop,
  openFileTab: noop,
};

function SettingsShell() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeView, setActiveView] = useState('sessions');
  const [mountedSidebarPanels, setMountedSidebarPanels] = useState(() => new Set());
  const mountSidebarPanel = React.useCallback(
    (id) => setMountedSidebarPanels((mounted) => new Set([...mounted, id])),
    []
  );
  useAppFrameBootEffects(true, noop);
  useAppWorkspaceWarmup({
    ready: true,
    workspace: emptyWorkspace,
    sessions: noSessions,
    mountSidebarPanel,
    trackSidebarPanelModule: noop,
  });
  const openSettings = () => setSettingsOpen(true);
  const renderWorkbenchSideView = (_side, id, active) => {
    if (!active && !mountedSidebarPanels.has(id)) return null;
    if (id === 'extensions')
      return React.createElement(ExtensionsPane, { active, section: 'plugins', onSectionChange: noop });
    if (id === 'skills') return React.createElement(SkillsPane, { active });
    return null;
  };
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(AppSidebarDrawer, {
      ...drawerProps,
      activeSideViews: { left: activeView, right: null },
      selectWorkbenchSideView: (id) => setActiveView(id),
      mountedSidebarPanels,
      renderWorkbenchSideView,
      settingsOpen,
      setSettingsOpen,
      openSettings,
    }),
    React.createElement(AppShellOverlays, { ...defaultProps, settingsOpen, setSettingsOpen, openSettings })
  );
}

test('desktop Settings and hidden rail panes wait for a request and stay mounted for warm reopen', {
  timeout: 10_000,
}, async (t) => {
  const { window, document, root } = mountShell(t, true);
  const reads = t.mock.fn(async (requests) => requests.map(() => ({ ok: true, value: null })));
  const compactionReads = () =>
    reads.mock.calls
      .flatMap(({ arguments: [requests] }) => requests)
      .filter(({ capability }) => capability === 'getCompactionSettings').length;
  window.mixdogDesktop = {
    getSnapshot: async () => ({}),
    readActivityRailPins: async () => null,
    subscribeActivityRailPins: () => noop,
    readCapabilities: reads,
  };
  const loads = t.mock.method(settingsViewModule, 'load');
  const idle = [];
  let wake;
  const enqueue = (callback) => {
    idle.push(callback);
    wake?.();
    wake = undefined;
    return idle.length;
  };
  _resetBootWarmupForTest({ requestIdleCallback: enqueue, setTimeout: enqueue, clearTimeout: noop });
  t.after(() => _resetBootWarmupForTest());

  await act(async () => root.render(React.createElement(SettingsShell)));
  await act(async () => {
    while (!window.__mixdogBootWarmupDrained) {
      if (!idle.length) {
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
      idle.shift()();
    }
  });
  const extensionPane = document.querySelector('.extensions-pane:not(.skills-pane)');
  const skillsPane = document.querySelector('.skills-pane');
  assert.equal(extensionPane?.dataset.surfaceActive, 'false', 'workspace warmup mounted hidden Extensions');
  assert.equal(skillsPane?.dataset.surfaceActive, 'false', 'workspace warmup mounted hidden Skills');
  assert.equal(studioViewModule.peek(), null, 'an unopened Studio tab stays cold after desktop idle');
  assert.equal(projectAddDialogModule.peek(), null, 'an unopened Add Project dialog stays cold after desktop idle');
  const dialog = () => document.querySelector('.mixdog-settings-layer:has(.mixdog-settings-v2)');
  const gear = document.querySelector('.sidebar-settings-button');
  await act(async () => gear.focus());
  assert.equal(loads.mock.callCount(), 0, 'closed startup must not request the Settings chunk');
  assert.equal(compactionReads(), 0, 'closed startup must not sweep Settings capabilities');
  assert.equal(dialog(), null);

  const railButton = (id) => document.querySelector(`.activity-rail-navigation button[data-side-view="${id}"]`);
  for (const [id, pane] of [
    ['extensions', extensionPane],
    ['skills', skillsPane],
  ]) {
    const button = railButton(id);
    const beforeOpen = compactionReads();
    await act(async () => button.click());
    assert.equal(pane.dataset.surfaceActive, 'true');
    assert.ok(compactionReads() > beforeOpen, `${id} reads on activation`);
    const beforeClose = compactionReads();
    await act(async () => railButton('sessions').click());
    assert.equal(pane.dataset.surfaceActive, 'false');
    assert.equal(compactionReads(), beforeClose, `${id} does not read while hidden`);
    await act(async () => button.click());
    assert.equal(pane.dataset.surfaceActive, 'true', `${id} reopens the same pane`);
    await act(async () => railButton('sessions').click());
  }

  const beforeSettings = compactionReads();
  await act(async () => {
    gear.click();
    assert.ok(loads.mock.calls[0], 'the first Settings request starts loading');
    await loads.mock.calls[0].result;
  });
  const firstDialog = dialog();
  assert.equal(firstDialog?.getAttribute('data-surface-active'), 'true');
  assert.ok(compactionReads() > beforeSettings, 'the Settings capability sweep runs on first open');

  await act(async () => firstDialog.querySelector('button[aria-label="Close settings"]').click());
  assert.equal(dialog(), firstDialog);
  assert.equal(firstDialog.getAttribute('data-surface-active'), 'false');
  assert.ok(firstDialog.hasAttribute('inert'));
  const firstOpenLoads = loads.mock.callCount();
  await act(async () => gear.click());
  assert.equal(dialog(), firstDialog);
  assert.equal(firstDialog.getAttribute('data-surface-active'), 'true');
  assert.equal(loads.mock.callCount(), firstOpenLoads);
});
