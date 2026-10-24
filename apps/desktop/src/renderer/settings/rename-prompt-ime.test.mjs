import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement'],
  actEnvironment: false,
});
globalThis.React = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };

const { SettingsConfirmDialog } = await import('./capability-controls.tsx');

async function open() {
  const host = document.body.appendChild(document.createElement('main'));
  const root = createRoot(host);
  const calls = { confirmed: [], closed: 0 };
  await act(async () =>
    root.render(
      React.createElement(SettingsConfirmDialog, {
        options: {
          title: 'Rename',
          confirmLabel: 'Rename',
          input: { value: 'old', label: 'Name' },
          onConfirm: (value) => calls.confirmed.push(value),
        },
        onClose: () => {
          calls.closed += 1;
        },
      })
    )
  );
  const input = document.querySelector('.settings-confirm-layer input');
  return {
    input,
    calls,
    async key(key, init = {}) {
      await act(async () => {
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
      });
    },
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('Enter during IME composition does not confirm the rename', async () => {
  const view = await open();
  await view.key('Enter', { isComposing: true });
  await view.key('Enter', { keyCode: 229 });
  assert.deepEqual(view.calls.confirmed, []);
  assert.equal(view.calls.closed, 0);
  await view.cleanup();
});

test('Escape during IME composition does not dismiss the prompt', async () => {
  const view = await open();
  await view.key('Escape', { isComposing: true });
  await view.key('Escape', { keyCode: 229 });
  assert.equal(view.calls.closed, 0);
  await view.cleanup();
});

test('plain Enter confirms and plain Escape dismisses', async () => {
  const view = await open();
  await view.key('Enter');
  assert.deepEqual(view.calls.confirmed, ['old']);
  assert.equal(view.calls.closed, 1);
  await view.key('Escape');
  assert.equal(view.calls.closed, 2);
  await view.cleanup();
});
