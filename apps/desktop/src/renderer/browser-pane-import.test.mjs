import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://mixdog.test/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};

const { BrowserImportDialog } = await import('./BrowserImportDialog.tsx');
const {
  scheduleBrowserForegroundRepaint,
  watchBrowserForegroundReturns,
} = await import('./browser-foreground-lifecycle.ts');
const {
  browserAutoFitZoom,
  browserViewportEmulation,
  readBrowserViewportPreset,
  resolveBrowserViewportPreset,
  writeBrowserViewportPreset,
} = await import('./browser-viewport-mode.ts');
const { default: RemoteBrowserPane } = await import('./RemoteBrowserPane.tsx');

test('Browser viewport presets expose responsive fill and exact device frames', () => {
  assert.deepEqual(resolveBrowserViewportPreset('responsive'), {
    id: 'responsive',
    label: 'Auto · Fit to pane',
    width: null,
    height: null,
    deviceScaleFactor: 1,
    mobile: false,
    touch: false,
    userAgent: null,
  });
  const iphone = resolveBrowserViewportPreset('phone-390');
  assert.deepEqual({
    id: iphone.id,
    label: iphone.label,
    width: iphone.width,
    height: iphone.height,
  }, {
    id: 'phone-390',
    label: 'Phone · 390×844',
    width: 390,
    height: 844,
  });
  // Retired device-named ids keep their size class.
  assert.equal(resolveBrowserViewportPreset('iphone-14').id, 'phone-390');
  assert.equal(resolveBrowserViewportPreset('pixel-7').id, 'phone-412');
  assert.deepEqual(browserViewportEmulation(iphone), {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent: iphone.userAgent,
  });
  assert.match(iphone.userAgent, /iPhone/);
  assert.equal(browserAutoFitZoom(720), 0.5);
  assert.equal(browserAutoFitZoom(1440), 1);
  assert.equal(resolveBrowserViewportPreset('unknown').id, 'responsive');
});

test('Browser viewport choice persists per session and fails closed to responsive', () => {
  window.localStorage.clear();
  assert.equal(readBrowserViewportPreset(window.localStorage, 'alpha').id, 'responsive');

  writeBrowserViewportPreset(window.localStorage, 'alpha', 'phone-412');
  assert.equal(readBrowserViewportPreset(window.localStorage, 'alpha').id, 'phone-412');
  assert.equal(readBrowserViewportPreset(window.localStorage, 'beta').id, 'responsive');

  window.localStorage.setItem('mixdog.browser-viewport.v1:alpha', 'invalid-device');
  assert.equal(readBrowserViewportPreset(window.localStorage, 'alpha').id, 'responsive');
});

test('Browser Use refreshes on visible foreground returns and detaches cleanly', () => {
  const returnWindow = new dom.window.EventTarget();
  const returnDocument = new dom.window.EventTarget();
  let visibilityState = 'visible';
  Object.defineProperty(returnDocument, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  });
  let reports = 0;
  const dispose = watchBrowserForegroundReturns(
    returnWindow,
    returnDocument,
    () => { reports += 1; },
  );

  returnWindow.dispatchEvent(new dom.window.Event('focus'));
  returnWindow.dispatchEvent(new dom.window.Event('pageshow'));
  assert.equal(reports, 2);

  visibilityState = 'hidden';
  returnDocument.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.equal(reports, 2);

  visibilityState = 'visible';
  returnDocument.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.equal(reports, 3);

  dispose();
  returnWindow.dispatchEvent(new dom.window.Event('focus'));
  assert.equal(reports, 3);
});

test('Browser Use repaints after the foreground dock layout settles', () => {
  let nextFrame = 0;
  const frames = new Map();
  const frameWindow = {
    requestAnimationFrame(callback) {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame(frame) {
      frames.delete(frame);
    },
  };
  let reports = 0;
  const dispose = scheduleBrowserForegroundRepaint(frameWindow, () => {
    reports += 1;
  });

  const layoutFrame = frames.get(1);
  frames.delete(1);
  layoutFrame(0);
  assert.equal(reports, 0);
  const paintFrame = frames.get(2);
  frames.delete(2);
  paintFrame(0);
  assert.equal(reports, 1);
  dispose();
  assert.equal(frames.size, 0);
});

function chromeSource({
  passwords = false,
  cookies = true,
  history = false,
} = {}) {
  return {
    id: 'chrome',
    name: 'Google Chrome',
    profiles: [{ id: 'Default', name: '재영', accountEmail: 'owner@example.test' }],
    supports: { passwords, cookies, history },
    supportReasons: {
      ...(!passwords ? { passwords: 'Password import unavailable in this build.' } : {}),
      ...(!cookies ? { cookies: 'Cookie import unavailable in this build.' } : {}),
    },
  };
}

function renderDialog(api) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  window.mixdogDesktop = api;
  return {
    host,
    root,
    render: (open = true, onClose = () => {}) => act(async () => {
      root.render(React.createElement(BrowserImportDialog, { open, onClose }));
    }),
  };
}

test('cookie-only import exposes approval and sends only the selected data', async () => {
  let request;
  const view = renderDialog({
    browserProfileImportSources: async () => [chromeSource()],
    onBrowserProfileImportProgress: () => () => {},
    browserProfileImportStart: async (input) => {
      request = input;
      return {
        jobId: input.jobId,
        counts: { passwords: 0, cookies: 1, history: 0 },
        errors: {},
      };
    },
  });

  try {
    await view.render();
    const approval = document.querySelector('.browser-import-admin input');
    const importButton = document.querySelector('.browser-import-primary');
    assert.ok(approval, 'cookie import must expose administrator approval');
    assert.ok(importButton);
    assert.equal(importButton.disabled, true);

    await act(async () => approval.click());
    assert.equal(importButton.disabled, false);
    await act(async () => importButton.click());

    assert.deepEqual(request.items, ['cookies']);
    assert.equal(request.administratorApproved, true);
    assert.match(document.querySelector('[role="dialog"]').textContent, /Browser data imported/);
  } finally {
    await act(async () => view.root.unmount());
    view.host.remove();
  }
});

test('import dialog starts only one job when submit is activated twice', async () => {
  let starts = 0;
  let finish;
  const view = renderDialog({
    browserProfileImportSources: async () => [chromeSource({ cookies: false, history: true })],
    onBrowserProfileImportProgress: () => () => {},
    browserProfileImportStart: async (input) => {
      starts += 1;
      return await new Promise((resolve) => {
        finish = () => resolve({
          jobId: input.jobId,
          counts: { passwords: 0, cookies: 0, history: 1 },
          errors: {},
        });
      });
    },
  });

  try {
    await view.render();
    const importButton = document.querySelector('.browser-import-primary');
    assert.ok(importButton);
    await act(async () => {
      importButton.click();
      importButton.click();
    });
    assert.equal(starts, 1);
    await act(async () => finish());
  } finally {
    await act(async () => view.root.unmount());
    view.host.remove();
  }
});

test('import dialog closes with Escape and restores the trigger focus', async () => {
  window.mixdogDesktop = {
    browserProfileImportSources: async () => [chromeSource({ cookies: false, history: true })],
    onBrowserProfileImportProgress: () => () => {},
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);

  function Harness() {
    const [open, setOpen] = useState(false);
    return React.createElement(React.Fragment, null,
      React.createElement('button', {
        id: 'import-trigger',
        type: 'button',
        onClick: () => setOpen(true),
      }, '열기'),
      React.createElement(BrowserImportDialog, {
        open,
        onClose: () => setOpen(false),
      }),
    );
  }

  try {
    await act(async () => root.render(React.createElement(Harness)));
    const trigger = document.querySelector('#import-trigger');
    trigger.focus();
    await act(async () => trigger.click());
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.match(
      document.querySelector('[role="dialog"]').textContent,
      /Cookie import unavailable in this build/,
    );

    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, trigger);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('remote Browser Use renders a frame and forwards reload, tap, and page text', async () => {
  const controls = [];
  window.mixdogDesktop = {
    remoteBrowserFrame: async (sessionId) => {
      assert.equal(sessionId, 'browser-remote-session');
      return {
      frameId: 'frame-1',
      url: 'https://example.test/',
      title: 'Remote fixture',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      width: 100,
      height: 50,
      image: { mimeType: 'image/jpeg', data: 'AA==' },
      };
    },
    remoteBrowserControl: async (sessionId, input) => {
      controls.push({ sessionId, input });
    },
    openExternal: async () => {},
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);

  try {
    await act(async () => {
      root.render(React.createElement(RemoteBrowserPane, {
        sessionId: 'browser-remote-session',
        active: true,
        foreground: true,
      }));
    });
    const image = document.querySelector('.browser-remote-content img');
    assert.ok(image);
    image.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 200,
      bottom: 100,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON() {},
    });

    const reload = document.querySelector('button[aria-label="Reload"]');
    assert.ok(reload);
    await act(async () => reload.click());
    assert.deepEqual(controls.at(-1), {
      sessionId: 'browser-remote-session',
      input: { type: 'reload' },
    });

    const content = document.querySelector('.browser-remote-content');
    content.setPointerCapture = () => {};
    const pointer = (type) => {
      const event = new window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: 50,
        clientY: 25,
      });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      return event;
    };
    await act(async () => {
      content.dispatchEvent(pointer('pointerdown'));
      content.dispatchEvent(pointer('pointerup'));
    });
    assert.deepEqual(controls.at(-1), {
      sessionId: 'browser-remote-session',
      input: {
        type: 'tap',
        frameId: 'frame-1',
        x: 25,
        y: 12.5,
      },
    });

    const keyboard = document.querySelector('button[aria-label="Type on page"]');
    assert.equal(keyboard.getAttribute('aria-pressed'), 'false');
    await act(async () => keyboard.click());
    assert.equal(keyboard.getAttribute('aria-pressed'), 'true');
    const pageInput = document.querySelector('.browser-remote-keyboard input');
    pageInput.value = 'A';
    await act(async () => {
      pageInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.deepEqual(controls.at(-1), {
      sessionId: 'browser-remote-session',
      input: {
        type: 'text',
        frameId: 'frame-1',
        text: 'A',
      },
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
