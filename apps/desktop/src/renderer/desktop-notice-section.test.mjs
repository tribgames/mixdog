import assert from 'node:assert/strict';
import test from 'node:test';

// The core raises a desktop notice as an entry of the `notice` section (key = notice key) and removes it when its
// condition is over. The toast region shows one toast per standing key, and again only after the key left and came back.
test('a notice section entry shows as one toast until it is withdrawn and raised again', async () => {
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { installSectionStore } = await import('./section-store.ts');
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'CustomEvent', 'MutationObserver'],
  });
  dom.window.mixdogDesktop = {};
  const entry = (revision, value) => ({ section: 'notice', key: 'secret-storage', revision, value });
  const storage = { key: 'secret-storage', code: 'secret-storage-failed', params: {} };
  let push = null;
  const store = installSectionStore({
    snapshot: async () => ({ status: 'ready', entries: [entry(1, storage)] }),
    subscribe: (listener) => {
      push = listener;
      return () => {
        push = null;
      };
    },
  });
  const raised = [];
  dom.window.addEventListener('mixdog:desktop-toast', (event) => raised.push(event.detail));
  const change = (next) => act(async () => push({ kind: 'sections', changes: [{ section: 'notice', key: 'secret-storage', entry: next }] }));
  const { DesktopToastRegion } = await import('./desktop-toasts.tsx');
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => {
      root.render(React.createElement(DesktopToastRegion, { toasts: [], bridgeError: '', onDismissBridgeError() {} }));
      await store.ready();
    });
    assert.equal(raised.length, 1, 'the standing notice of the snapshot shows once');
    assert.match(raised[0].text, /secure storage is not working/);
    assert.equal(raised[0].groupKey, 'secret-storage');

    await change(entry(2, storage));
    assert.equal(raised.length, 1, 'the same key standing again shows nothing new');

    await change(null);
    await change(entry(3, storage));
    assert.equal(raised.length, 2, 'withdrawn and raised again, it shows again');

    await change(entry(4, { key: 'secret-storage', code: 'not-a-known-code', params: {} }));
    assert.equal(raised.length, 2, 'a notice with an unknown code is not shown');
  } finally {
    await act(async () => root.unmount());
    store.dispose();
    restore();
  }
});