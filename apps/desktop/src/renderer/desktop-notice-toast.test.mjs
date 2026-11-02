import assert from 'node:assert/strict';
import test from 'node:test';

test('a notice from main shows as one toast that says what to do', async () => {
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'CustomEvent', 'MutationObserver'],
  });
  let notify = null;
  dom.window.mixdogDesktop = {
    subscribeDesktopNotices: (listener) => {
      notify = listener;
      return () => {
        notify = null;
      };
    },
  };
  const { DesktopToastRegion } = await import('./desktop-toasts.tsx');
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () =>
      root.render(React.createElement(DesktopToastRegion, { toasts: [], bridgeError: '', onDismissBridgeError() {} }))
    );
    assert.equal(typeof notify, 'function', 'the region subscribes to notices');
    await act(async () =>
      notify({ key: 'connector-sign-in:Gmail', code: 'connector-sign-in-expired', params: { name: 'Gmail' } })
    );
    const toasts = document.querySelectorAll('.mx-toast');
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].textContent, /Gmail needs you to sign in again\. Reconnect it in Connectors\./);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
  assert.equal(notify, null, 'unmounting unsubscribes');
});
