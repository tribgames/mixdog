import assert from 'node:assert/strict';
import test from 'node:test';

test('a notice the core withdraws takes its toast with it', async () => {
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'CustomEvent', 'MutationObserver'],
  });
  let push = null;
  dom.window.mixdogDesktop = {
    sections: {
      snapshot: async () => ({ status: 'ready', entries: [] }),
      subscribe: (listener) => {
        push = listener;
        return () => {
          push = null;
        };
      },
    },
  };
  const key = 'conversation-save:session-a';
  const entry = {
    section: 'notice',
    key,
    revision: 1,
    value: { key, code: 'conversation-save-failed', params: { session: 'session-a' } },
  };
  const { sectionStoreFor } = await import('./section-store.ts');
  await sectionStoreFor(dom.window.mixdogDesktop).ready();
  const { DesktopToastRegion } = await import('./desktop-toasts.tsx');
  const root = createRoot(document.getElementById('root'));
  const region = () => React.createElement(DesktopToastRegion, { toasts: [], bridgeError: '', onDismissBridgeError() {} });
  try {
    await act(async () => root.render(region()));
    await act(async () => push({ kind: 'sections', changes: [{ section: 'notice', key, entry }] }));
    assert.equal(document.querySelectorAll('.mx-toast').length, 1, 'the raised notice shows');
    await act(async () => push({ kind: 'sections', changes: [{ section: 'notice', key, entry: null }] }));
    assert.equal(document.querySelectorAll('.mx-toast').length, 0, 'the withdrawn notice leaves with its toast');
    await act(async () => root.render(null));
    await act(async () => root.render(region()));
    assert.equal(document.querySelectorAll('.mx-toast').length, 0, 'the resolved warning is not replayed on remount');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
