import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

test('initial connection keeps its catalog read and paired recovery events issue one authoritative read', async () => {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><body><main></main></body>',
    jsdom: { url: 'https://relay.test/' },
    expose: ['navigator', 'HTMLElement'],
  });
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
    restore();
  }
});

test('a local window reads the catalog again when the core pushes its projects, after a first read that failed', async () => {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><body><main></main></body>',
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['navigator', 'HTMLElement'],
  });
  const reads = [];
  let push = () => {};
  window.mixdogDesktop = {
    sections: {
      snapshot: async () => ({ status: 'reconnecting', entries: [] }),
      subscribe: (listener) => {
        push = listener;
        return () => {};
      },
    },
    listProjects: () => {
      const request = Promise.withResolvers();
      reads.push(request);
      return request.promise;
    },
  };
  const { useAppProjectCatalog } = await import('./use-app-project-catalog.ts');
  let catalog;
  function Probe() {
    catalog = useAppProjectCatalog({ currentProject: '' });
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => reads[0].reject(new Error('The core connection is not open.')));
    assert.equal(reads.length, 1);
    // A Reconnect hands the window the core's whole store, its registry in it.
    await act(async () => {
      push({ kind: 'replace', stage: 'begin' });
      push({ kind: 'replace', stage: 'chunk', entries: [{ section: 'projects', key: null, revision: 1, value: [] }] });
      push({ kind: 'replace', stage: 'commit', epoch: 'e1' });
    });
    assert.equal(reads.length, 2);
    await act(async () => reads[1].resolve([{ path: 'p', name: 'P', alias: null }]));
    assert.equal(catalog.projects[0]?.path, 'p');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
