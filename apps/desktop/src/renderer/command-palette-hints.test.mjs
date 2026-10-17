// The command palette's shortcut keys show on desktop and are absent on the
// phone surface; rendered, not shape-checked.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['Node', 'HTMLElement', 'HTMLInputElement', 'Event', 'KeyboardEvent'],
});
after(restore);
globalThis.React = React;

const { createRoot } = await import('react-dom/client');
const { WorkbenchQuickAccess } = await import('./WorkbenchOverlays.tsx');

test('command palette shortcut hints show on desktop and are hidden on the phone surface', async (t) => {
  const root = document.documentElement;
  t.after(() => root.removeAttribute('data-mixdog-mobile-tabs'));
  const render = async () => {
    const host = document.createElement('main');
    document.body.append(host);
    const reactRoot = createRoot(host);
    await act(async () =>
      reactRoot.render(
        React.createElement(WorkbenchQuickAccess, {
          mode: 'commands',
          projectPath: 'C:/demo',
          recentFiles: [],
          commands: [{ id: 'x', category: 'View', label: 'Toggle Sidebar', shortcut: 'Ctrl+B', run() {} }],
          onOpenFile() {},
          onClose() {},
        })
      )
    );
    const hints = [...document.querySelectorAll('kbd')].map((node) => node.textContent);
    await act(async () => reactRoot.unmount());
    host.remove();
    return hints;
  };

  assert.deepEqual(await render(), ['Ctrl+B']);
  root.setAttribute('data-mixdog-mobile-tabs', '');
  assert.deepEqual(await render(), []);
});
