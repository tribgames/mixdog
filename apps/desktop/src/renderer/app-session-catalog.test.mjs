import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { useSessionCatalog } from './app-session-catalog.ts';
import { useSessionGlance } from './session-glance-store.ts';
import { writeCachedSessionCatalog } from './session-catalog-cache.ts';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
});
after(() => dom.window.close());

test('rename, its identical server ack, and a rollback each publish the session glance', async (t) => {
  window.localStorage.clear();
  const base = { id: 's1', title: 'Old', preview: 'p', archived: false };
  writeCachedSessionCatalog([base]);
  window.mixdogDesktop = {};
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let catalog;
  let glance;
  function Harness() {
    catalog = useSessionCatalog(() => {});
    glance = useSessionGlance('s1');
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window.mixdogDesktop;
  });
  const retitle = (title) => (rows) => rows.map((row) => (row.id === 's1' ? { ...row, title } : row));
  assert.equal(glance.title, 'Old');
  await act(async () => catalog.setSessions(retitle('New')));
  assert.equal(glance.title, 'New');
  await act(async () => catalog.setSessions(retitle('New')));
  assert.equal(glance.title, 'New');
  await act(async () => catalog.setSessions(retitle('Old')));
  assert.equal(glance.title, 'Old');
});
