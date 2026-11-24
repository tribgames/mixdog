import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['Element', 'HTMLElement', 'Node', 'KeyboardEvent', 'MouseEvent', 'Event', 'CustomEvent', 'navigator'],
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.ResizeObserver = window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.mixdogDesktop = {};

const { usePaneWorkspace } = await import('../pane-workspace-state.ts');
const { useSidebarEntryEvents } = await import('./use-app-workbench-view-wiring.ts');

test('"Open in split pane" opens the session beside the focused pane and selects it, its title unpinned', async (t) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const activated = [];
  let workspace;
  let events;
  function Harness() {
    workspace = usePaneWorkspace(null);
    events = useSidebarEntryEvents(
      { paneWorkspace: workspace, shellPanels: {} },
      { closeSidebarForNavigation() {}, stageNewTaskProject() {} },
      { openSession: async () => {}, renameProject: async () => {} },
      {
        sidebarNewTask() {},
        openProjectSettings() {},
        // The pane chrome's activatePaneSurface: the selection follows the shown tab.
        activatePaneSurface: (selection) => activated.push(selection),
      }
    );
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  const before = workspace.focusedLeafId;

  await act(async () => events.sidebarOpenSessionInSplit('s1', 'Catalog title'));

  assert.equal(workspace.leaves.length, 2);
  assert.notEqual(workspace.focusedLeafId, before);
  assert.deepEqual(workspace.focusedLeaf.tabs, [{ kind: 'session', id: 's1' }]);
  assert.deepEqual(activated, [{ kind: 'session', id: 's1' }]);
});
