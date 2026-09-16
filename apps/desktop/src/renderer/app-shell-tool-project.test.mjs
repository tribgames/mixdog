import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useAppToolProject, LAST_PROJECT_KEY } from './app-shell-tool-project.ts';

test('useAppToolProject tracks active tool project, allows override, and persists to localStorage', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://mixdog.test/',
  });
  const prior = new Map(
    ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );

  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, { configurable: true, value });

  let hookResult;
  function TestHarness({ navSel, overridePath }) {
    const res = useAppToolProject({
      navigationSelection: navSel,
      focusedPaneSelection: null,
      selectedSessionProjectPath: 'C:/Project/alpha',
      newTaskProjectPath: '',
      effectiveDraftProjectPath: (p) => p || '',
      registeredProjectPath: (p) => p || '',
      preferredDraftProjectPath: '',
      projects: [
        { path: 'C:/Project/alpha', name: 'Alpha', alias: 'Alpha-Project' },
        { path: 'C:/Project/beta', name: 'Beta' },
      ],
    });
    hookResult = res;
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  try {
    await act(async () => {
      root.render(
        React.createElement(TestHarness, {
          navSel: { kind: 'session', id: 's1' },
        })
      );
    });

    assert.equal(hookResult.activeProjectPath, 'C:/Project/alpha');
    assert.equal(hookResult.toolProjectPath, 'C:/Project/alpha');
    assert.equal(hookResult.activeProjectLabel, 'Alpha-Project');

    // Explicitly select project override
    await act(async () => {
      hookResult.selectToolProject('C:/Project/beta');
    });

    assert.equal(hookResult.toolProjectPath, 'C:/Project/beta');
    assert.equal(dom.window.localStorage.getItem(LAST_PROJECT_KEY), 'C:/Project/beta');
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
