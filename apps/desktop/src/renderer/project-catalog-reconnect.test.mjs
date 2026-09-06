import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

test('initial connection keeps its catalog read and paired recovery events issue one authoritative read', async () => {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { url: 'https://relay.test/' });
  const saved = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const reads = [];
  window.mixdogDesktop = {
    listProjects: () => {
      const request = Promise.withResolvers();
      reads.push(request);
      return request.promise;
    },
  };
  const { useAppProjectCatalog } = await import('./use-app-project-catalog.ts');
  const { setRemoteConnectionState } = await import('./remote-connection-state.ts');
  let catalog;
  function Probe() {
    catalog = useAppProjectCatalog({ currentProject: '' });
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Probe)));
    assert.equal(reads.length, 1);
    await act(async () => {
      setRemoteConnectionState('connecting');
      setRemoteConnectionState('connected');
      reads[0].resolve([{ path: 'initial', name: 'Initial', alias: null }]);
    });
    assert.equal(catalog.projects[0]?.path, 'initial');
    await act(async () => {
      window.dispatchEvent(new window.Event('mixdog:remote-state-gap'));
      window.dispatchEvent(new window.Event('mixdog:remote-reconnected'));
    });
    assert.equal(reads.length, 2);
    await act(async () => reads[1].resolve([]));
    assert.deepEqual(catalog.projects, []);
    assert.equal(catalog.projectCatalogValidated, true);
    await act(async () => setRemoteConnectionState('reconnecting'));
    assert.equal(catalog.projectCatalogValidated, false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
