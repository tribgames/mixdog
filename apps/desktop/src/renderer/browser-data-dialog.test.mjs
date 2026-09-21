import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
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

const { BrowserDataDialog } = await import('./BrowserDataDialog.tsx');

function renderDialog(api, onClose = () => {}) {
  const host = document.createElement('div');
  document.body.append(host);
  Object.defineProperty(window, 'mixdogDesktop', { configurable: true, value: api });
  const root = createRoot(host);
  act(() => {
    root.render(React.createElement(BrowserDataDialog, { open: true, onClose }));
  });
  return {
    host,
    checkboxes: () => [...host.querySelectorAll('input[type="checkbox"]')],
    button: (label) => [...host.querySelectorAll('button')].find((node) => node.textContent.includes(label)),
    text: () => host.textContent,
    destroy: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test('cache is the preselected scope and only the chosen scopes are cleared', async () => {
  let requested;
  const view = renderDialog({
    browserClearData: async (scopes) => {
      requested = scopes;
      return { cleared: scopes, errors: {} };
    },
  });
  try {
    const [cache, siteData, cookies] = view.checkboxes();
    assert.equal(cache.checked, true, 'cache costs the user nothing to lose');
    assert.equal(siteData.checked, false);
    assert.equal(cookies.checked, false, 'signing the user out is never the default');

    await act(async () => {
      cookies.click();
    });
    await act(async () => {
      view.button('Clear now').click();
    });

    assert.deepEqual(requested, ['cache', 'cookies']);
    assert.match(view.text(), /Browsing data cleared/);
  } finally {
    view.destroy();
  }
});

test('the finished dialog closes instead of rebuilding the selection form', async () => {
  let closed = 0;
  const view = renderDialog({ browserClearData: async (scopes) => ({ cleared: scopes, errors: {} }) }, () => {
    closed += 1;
  });
  try {
    await act(async () => {
      view.button('Clear now').click();
    });
    assert.match(view.text(), /Browsing data cleared/);

    await act(async () => {
      view.button('Close').click();
    });
    assert.equal(closed, 1, 'the receipt hands control back rather than reopening the form');
  } finally {
    view.destroy();
  }
});

test('a scope that failed is reported as failed instead of counting as cleared', async () => {
  const view = renderDialog({
    browserClearData: async () => ({
      cleared: [],
      errors: { cache: 'cache directory is locked' },
    }),
  });
  try {
    await act(async () => {
      view.button('Clear now').click();
    });
    assert.match(view.text(), /Some data could not be cleared/);
    assert.match(view.text(), /cache directory is locked/);
  } finally {
    view.destroy();
  }
});

test('Escape respects an in-flight clear and cleanup restores the trigger focus', async () => {
  const trigger = document.createElement('button');
  document.body.append(trigger);
  trigger.focus();
  let finish;
  let closed = 0;
  const view = renderDialog(
    {
      browserClearData: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
    () => closed++
  );
  const pressEscape = () =>
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  try {
    await act(async () => view.button('Clear now').click());
    await act(async () => pressEscape());
    assert.equal(closed, 0);
    await act(async () => finish({ cleared: ['cache'], errors: {} }));
    await act(async () => pressEscape());
    assert.equal(closed, 1);
  } finally {
    view.destroy();
    assert.equal(document.activeElement, trigger);
    trigger.remove();
  }
});
