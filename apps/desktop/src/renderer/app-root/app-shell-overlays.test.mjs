import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { AppShellOverlays } from './AppShellOverlays.tsx';

test('AppShellOverlays renders tab switcher, unsaved dialog, and update dialog under given conditions', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  for (const key of [
    'window',
    'document',
    'navigator',
    'Node',
    'Element',
    'HTMLElement',
    'HTMLButtonElement',
    'Event',
    'CustomEvent',
    'KeyboardEvent',
  ]) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
    settingsMounted: { current: false },
    settingsPrewarmed: false,
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
    updaterState: { status: 'idle', version: '1.0.0' },
    closeDesktopUpdate: () => {},
    installDesktopUpdate: () => {},
    error: '',
    connected: true,
    setError: () => {},
    snapshot: {},
  };

  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);

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

  await act(async () => {
    root.unmount();
  });
});
