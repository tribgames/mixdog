import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useComposerFocus } from './use-composer-focus.ts';

async function withComposerFocusHarness(run) {
  const dom = new JSDOM("<!doctype html><body><input id='user'><main></main></body>", { url: 'https://mixdog.test/' });
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Electron', maxTouchPoints: 0 },
  });
  window.mixdogDesktop = {};
  window.matchMedia = () => ({ matches: false });
  dom.window.HTMLElement.prototype.attachEvent = () => {};
  dom.window.HTMLElement.prototype.detachEvent = () => {};
  const windowFocus = { current: true };
  document.hasFocus = () => windowFocus.current;
  const root = createRoot(document.querySelector('main'));
  function Harness(props) {
    const textarea = useRef(null);
    useComposerFocus({ textarea, ...props });
    return React.createElement('textarea', { ref: textarea });
  }
  const render = async (props) => {
    await act(async () => {
      root.render(React.createElement(Harness, props));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  };
  const restoreWindowFocus = () => window.dispatchEvent(new dom.window.Event('focus'));
  try {
    await run({ render, windowFocus, restoreWindowFocus, user: document.getElementById('user') });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, saved);
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
  }
}

const props = (overrides) => ({ paneActive: true, transitioning: false, focusRequest: 3, ...overrides });

test('window restoration leaves another input focused until the composer is asked for', async () => {
  await withComposerFocusHarness(async ({ render, windowFocus, restoreWindowFocus, user }) => {
    user.focus();
    await render(props({ paneActive: false, focusRequest: 1 }));
    assert.equal(document.activeElement, user);
    await render(props({ focusRequest: 1 }));
    assert.equal(document.activeElement, user);
    windowFocus.current = false;
    await render(props({ focusRequest: 2 }));
    assert.equal(document.activeElement, user);
    windowFocus.current = true;
    restoreWindowFocus();
    await render(props({ focusRequest: 2 }));
    assert.equal(document.activeElement, user);
  });
});

test('a new focus request focuses the composer, and window restoration returns focus to it', async () => {
  await withComposerFocusHarness(async ({ render, restoreWindowFocus, user }) => {
    user.focus();
    await render(props({ focusRequest: 2 }));
    await render(props());
    assert.equal(document.activeElement.tagName, 'TEXTAREA');
    const composer = document.activeElement;
    composer.blur();
    restoreWindowFocus();
    await render(props());
    assert.equal(document.activeElement, composer);
  });
});

test('window restoration does not focus the composer behind an open modal dialog', async () => {
  await withComposerFocusHarness(async ({ render, restoreWindowFocus }) => {
    await render(props());
    document.activeElement.blur();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    restoreWindowFocus();
    await render(props());
    assert.equal(document.activeElement, document.body);
  });
});

test('window restoration does not focus the composer of an inactive pane', async () => {
  await withComposerFocusHarness(async ({ render, restoreWindowFocus }) => {
    await render(props());
    document.activeElement.blur();
    await render(props({ paneActive: false }));
    restoreWindowFocus();
    await render(props({ paneActive: false }));
    assert.equal(document.activeElement, document.body);
  });
});

test('window restoration does not focus the composer while its pane is transitioning', async () => {
  await withComposerFocusHarness(async ({ render, restoreWindowFocus }) => {
    await render(props());
    document.activeElement.blur();
    await render(props({ transitioning: true }));
    restoreWindowFocus();
    await render(props({ transitioning: true }));
    assert.equal(document.activeElement, document.body);
  });
});
