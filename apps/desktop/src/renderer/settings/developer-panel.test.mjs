import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Event'],
  actEnvironment: false,
});
globalThis.React = React;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };

const { DeveloperPanel } = await import('./developer-panel.tsx');

const WARNING = 'Using this provider through OAuth carries a high risk of penalties such as account restrictions.';
const view = {
  sections: [
    {
      id: 'approvals',
      label: 'Approvals',
      options: [
        {
          id: 'allowAllActions',
          label: 'Allow all actions',
          description: 'd',
          warning: 'Skips approvals.',
          enabled: false,
        },
      ],
    },
    {
      id: 'providers',
      label: 'Providers',
      options: [
        {
          id: 'cursorOAuth',
          label: 'Cursor',
          description: 'd',
          warning: WARNING,
          provider: 'cursor-oauth',
          enabled: false,
        },
      ],
    },
  ],
};

async function toggle(label) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const runs = [];
  const confirms = [];
  const context = {
    api: {},
    data: { developer: view },
    snapshot: null,
    pending: '',
    run: async (capability, args) => {
      runs.push([capability, args]);
      return view;
    },
    confirm: (options) => confirms.push(options),
    notice() {},
  };
  try {
    await act(async () => root.render(React.createElement(DeveloperPanel, context)));
    await act(async () => document.querySelector(`input[aria-label="${label}"]`).click());
    return { runs, confirms };
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}

test('Allow all actions is turned on without an in-app confirmation: the desktop host confirms it', async () => {
  const { runs, confirms } = await toggle('Allow all actions');
  assert.deepEqual(confirms, []);
  assert.deepEqual(runs, [['setDeveloperOption', ['allowAllActions', true]]]);
});

test('another warned option still asks in-app before it turns on', async () => {
  const { runs, confirms } = await toggle('Cursor');
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].description, WARNING);
  assert.deepEqual(runs, [], 'nothing is set until the confirmation is accepted');
  confirms[0].onConfirm();
  assert.deepEqual(runs, [['setDeveloperOption', ['cursorOAuth', true]]]);
});
