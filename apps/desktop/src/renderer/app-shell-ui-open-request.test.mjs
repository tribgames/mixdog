import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { useAppUiOpenRequest } from './app-shell-ui-open-request.ts';

test('useAppUiOpenRequest handles sequence increasing, deduplication, TTL, and settings routing', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'about:blank' },
  });

  let openedCommandSurface = null;
  let openedSettings = null;

  function TestHarness({ request, sessionId }) {
    useAppUiOpenRequest({
      uiOpenRequest: request,
      sessionId,
      openConversationCommandSurface: (surface) => {
        openedCommandSurface = surface;
      },
      openSettings: (section) => {
        openedSettings = section;
      },
    });
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  try {
    // 1. Initial valid command surface request (raw command name without slash, e.g. "usage")
    await act(async () => {
      root.render(
        React.createElement(TestHarness, {
          request: { command: 'usage', seq: 1, at: Date.now() },
          sessionId: 'session-1',
        })
      );
    });
    assert.equal(openedCommandSurface, 'stats');
    openedCommandSurface = null;

    // 2. Same seq: must not trigger again
    await act(async () => {
      root.render(
        React.createElement(TestHarness, {
          request: { command: 'usage', seq: 1, at: Date.now() },
          sessionId: 'session-1',
        })
      );
    });
    assert.equal(openedCommandSurface, null);

    // 3. Smaller seq: ignored
    await act(async () => {
      root.render(
        React.createElement(TestHarness, {
          request: { command: 'usage', seq: 0, at: Date.now() },
          sessionId: 'session-1',
        })
      );
    });
    assert.equal(openedCommandSurface, null);

    // 4. Stale TTL (>15s): ignored even with higher seq
    await act(async () => {
      root.render(
        React.createElement(TestHarness, {
          request: { command: 'providers', seq: 5, at: Date.now() - 30_000 },
          sessionId: 'session-1',
        })
      );
    });
    assert.equal(openedSettings, null);

    // 5. Valid higher seq with settingsRow command: routes to settings
    await act(async () => {
      root.render(
        React.createElement(TestHarness, {
          request: { command: 'providers', seq: 6, at: Date.now() },
          sessionId: 'session-1',
        })
      );
    });
    assert.equal(openedSettings, 'providers');

    // 6. Setup section target without a slash command routes to its settings section
    await act(async () => {
      root.render(
        React.createElement(TestHarness, {
          request: { command: 'developer', seq: 7, at: Date.now() },
          sessionId: 'session-1',
        })
      );
    });
    assert.equal(openedSettings, 'developer');
  } finally {
    await act(async () => {
      root.unmount();
    });
    restore();
  }
});

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
