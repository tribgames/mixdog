import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { useAppUiOpenRequest } from './app-shell-ui-open-request.ts';

async function withOpenRequestHost(run) {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'about:blank' },
  });
  const opened = { surface: null, settings: null };
  function TestHarness({ request }) {
    useAppUiOpenRequest({
      uiOpenRequest: request,
      sessionId: 'session-1',
      openConversationCommandSurface: (surface) => {
        opened.surface = surface;
      },
      openSettings: (section) => {
        opened.settings = section;
      },
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  const show = (command, seq, at = Date.now()) =>
    act(async () => {
      root.render(React.createElement(TestHarness, { request: { command, seq, at } }));
    });
  try {
    await run({ show, opened });
  } finally {
    await act(async () => {
      root.unmount();
    });
    restore();
  }
}

test('useAppUiOpenRequest routes a command-surface request once per increasing seq', () =>
  withOpenRequestHost(async ({ show, opened }) => {
    await show('usage', 1);
    assert.equal(opened.surface, 'stats');
    opened.surface = null;
    await show('usage', 1);
    assert.equal(opened.surface, null, 'same seq');
    await show('usage', 0);
    assert.equal(opened.surface, null, 'smaller seq');
  }));

test('useAppUiOpenRequest ignores a request older than the TTL even with a higher seq', () =>
  withOpenRequestHost(async ({ show, opened }) => {
    await show('providers', 5, Date.now() - 30_000);
    assert.equal(opened.settings, null);
  }));

test('useAppUiOpenRequest routes a settings-row command to settings', () =>
  withOpenRequestHost(async ({ show, opened }) => {
    await show('providers', 6);
    assert.equal(opened.settings, 'providers');
  }));

test('useAppUiOpenRequest routes a setup section target without a slash command to its settings section', () =>
  withOpenRequestHost(async ({ show, opened }) => {
    await show('developer', 7);
    assert.equal(opened.settings, 'developer');
  }));

test('useAppUiOpenRequest routes split-pane session lane requests once per session sequence', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'about:blank' },
  });
  const opened = [];
  const surfaces = [];
  let laneListener = null;
  const subscribeSessionLanes = (listener) => {
    laneListener = listener;
    return () => {
      laneListener = null;
    };
  };
  function TestHarness() {
    useAppUiOpenRequest({
      uiOpenRequest: null,
      sessionId: null,
      openConversationCommandSurface: (surface, sessionId) => surfaces.push([surface, sessionId]),
      openSettings: (section) => opened.push(section),
      subscribeSessionLanes,
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  const lane = (sessionId, command, seq) =>
    act(async () => laneListener({ sessionId, snapshot: { uiOpenRequest: { command, seq, at: Date.now() } } }));
  try {
    await act(async () => root.render(React.createElement(TestHarness)));
    await lane('pane-a', 'connection', 3);
    await lane('pane-a', 'connection', 3);
    await lane('pane-b', 'doctor', 1);
    assert.deepEqual(opened, ['connection']);
    assert.deepEqual(surfaces, [['doctor', 'pane-b']]);
    await act(async () => root.unmount());
    assert.equal(laneListener, null);
  } finally {
    restore();
  }
});
