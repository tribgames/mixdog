import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Event', 'Node', 'Element'],
  actEnvironment: false,
});
test.after(restore);
const { createRoot } = await import('react-dom/client');
const { useRemoteHostImageUrl } = await import('./local-image-preview.ts');
const { notifyMediaSessionChanged } = await import('./remote-file-preview.ts');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test('a mounted remote image preview resolves its URL again when the media session changes', async (t) => {
  window.mixdogRemoteServer = 'https://host.test';
  let session = 1;
  window.mixdogDesktop = {
    resolveLocalPaths: async () => [{ projectPath: '/p', relPath: 'a.png', accessToken: null }],
    previewProjectFile: async () => ({ url: `https://host.test/media?sid=${session}` }),
  };
  t.after(() => {
    delete window.mixdogRemoteServer;
    delete window.mixdogDesktop;
  });
  let url = '';
  function Probe() {
    url = useRemoteHostImageUrl('/abs/a.png');
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
  });
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  await act(async () => root.render(React.createElement(Probe)));
  await settle();
  assert.equal(url, 'https://host.test/media?sid=1');
  session = 2;
  await act(async () => notifyMediaSessionChanged());
  await settle();
  assert.equal(url, 'https://host.test/media?sid=2');
});
