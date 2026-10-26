// The project picker of the Schedules editor classifies "No project" from the
// host's task workspace, which can arrive after the editor opened: the picker
// follows it, the user's own pick survives it, and an untouched save writes
// the stored cwd back unchanged.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent'],
  globals: {
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  },
});
globalThis.FormData = window.FormData;
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.defineProperty(window.navigator, 'userAgent', {
  configurable: true,
  value: `${window.navigator.userAgent} Electron/38.0.0`,
});

const { resetSidebarReferenceCache, updateSidebarReference } = await import('./sidebar-reference-cache.ts');
const { SchedulesPane } = await import('./SchedulesView.tsx');

const INTERNAL = 'C:\\Users\\u\\AppData\\Roaming\\mixdog-desktop\\workspace\\unclassified';

/** Mount the pane over one schedule stored in the task workspace; the host's
 *  workspace answer is held until `resolveWorkspace()`. */
async function mountPane(t) {
  resetSidebarReferenceCache();
  updateSidebarReference('channelSetup', {
    schedules: [{ name: 'daily', whenCron: '0 9 * * *', instructions: 'Report', enabled: true, owner: 'lead', cwd: INTERNAL }],
    webhooks: [],
  });
  updateSidebarReference('projects', [{ path: '/repos/alpha', name: 'alpha', alias: '' }]);
  updateSidebarReference('agents', []);
  const saves = [];
  let resolveWorkspace;
  const workspace = new Promise((resolve) => {
    resolveWorkspace = () => resolve(INTERNAL);
  });
  const api = {
    getTaskWorkspace: () => workspace,
    invokeCapability(request) {
      if (request.capability === 'getLeadStatus') return Promise.resolve({ value: { created: true } });
      if (request.capability === 'saveSchedule') {
        saves.push(request.args[0]);
        return Promise.resolve({ value: {} });
      }
      return new Promise(() => {});
    },
  };
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
    resetSidebarReferenceCache();
  });
  await act(async () => root.render(React.createElement(SchedulesPane, { api, active: true })));
  await act(async () => document.querySelector('.routines-open').click());
  return {
    saves,
    resolveWorkspace: () => act(async () => resolveWorkspace()),
    shown: () => document.querySelector('[aria-label="Schedule project"] .mx-select-value').textContent,
    save: () =>
      act(async () =>
        document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
      ),
  };
}

test('an editor opened before the workspace answers shows No project once it arrives, and saves the stored cwd', async (t) => {
  const pane = await mountPane(t);
  assert.equal(pane.shown(), INTERNAL, 'unknown workspace: nothing is guessed');
  await pane.resolveWorkspace();
  assert.equal(pane.shown(), 'No project');
  await pane.save();
  assert.equal(pane.saves.length, 1);
  assert.equal(pane.saves[0].cwd, INTERNAL, 'an untouched draft writes its cwd back unchanged');
});

test('a project picked before the workspace answers survives it', async (t) => {
  const pane = await mountPane(t);
  await act(async () => document.querySelector('[aria-label="Schedule project"]').click());
  const alpha = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.trim() === 'alpha');
  await act(async () => alpha.click());
  await pane.resolveWorkspace();
  assert.equal(pane.shown(), 'alpha');
  await pane.save();
  assert.equal(pane.saves[0].cwd, '/repos/alpha');
});

test('choosing No project saves without a cwd', async (t) => {
  const pane = await mountPane(t);
  await pane.resolveWorkspace();
  await act(async () => document.querySelector('[aria-label="Schedule project"]').click());
  const none = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.trim() === 'No project');
  await act(async () => none.click());
  await pane.save();
  assert.equal(Object.hasOwn(pane.saves[0], 'cwd'), false);
});
