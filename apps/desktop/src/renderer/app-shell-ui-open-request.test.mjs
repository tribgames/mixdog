import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useAppUiOpenRequest } from './app-shell-ui-open-request.ts';

test('useAppUiOpenRequest handles sequence increasing, deduplication, TTL, and settings routing', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
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
    assert.equal(openedCommandSurface, 'usage');
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
