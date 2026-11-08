import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { readHostMainRoute } from './draft-pane-prefs-store.ts';
import { announceSetupChange, subscribeSetupChanges } from './setup-change-refresh.ts';
import {
  listPresetsShared,
  loadSidebarReferences,
  readSidebarReference,
  resetSidebarReferenceCache,
} from './sidebar-reference-cache.ts';
import { leadRouteFrom, useLeadMainRoute } from './workflows-main-route.ts';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'about:blank' },
  expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
  actEnvironment: false,
});

function fakeApi() {
  const calls = [];
  return {
    calls,
    async invokeCapability({ capability }) {
      calls.push(capability);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (capability === 'listWorkflows') return { value: [{ id: 'solo', name: 'Solo' }] };
      return { value: [{ id: 'workflow-lead', provider: 'p', model: 'm' }], snapshot: { model: 'm', provider: 'p' } };
    },
  };
}

// Workflows are a pushed section (desktop-services.md §15 P13): a read is the section store, never a daemon call.
function pushedWorkflowsApi() {
  const api = fakeApi();
  api.snapshots = 0;
  api.sections = {
    async snapshot() {
      api.snapshots += 1;
      return {
        status: 'connected',
        entries: [{ section: 'workflows', key: null, revision: 1, value: [{ id: 'solo', name: 'Solo' }] }],
      };
    },
    subscribe: () => () => undefined,
  };
  return api;
}

test('concurrent workflow pickers share one read of the pushed workflows section', async () => {
  resetSidebarReferenceCache();
  const api = pushedWorkflowsApi();
  await Promise.all(Array.from({ length: 12 }, () => loadSidebarReferences(api, ['workflows'])));
  // The store folding its first snapshot is itself a section change, which invalidates the key the load raced; the
  // next load is answered from the store that already holds the section.
  await loadSidebarReferences(api, ['workflows']);
  assert.deepEqual(api.calls, [], 'no listWorkflows daemon call');
  assert.equal(api.snapshots, 1);
  assert.equal(readSidebarReference('workflows').length, 1);
});

test('N workflow pickers mounting together read the pushed workflows section once and call no daemon', async () => {
  resetSidebarReferenceCache();
  const { WorkflowSelect } = await import('./model-controls.tsx');
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
    actEnvironment: false,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const api = pushedWorkflowsApi();
  dom.window.mixdogDesktop = api;
  globalThis.window = dom.window;
  const picker = (key) =>
    React.createElement(WorkflowSelect, {
      key,
      disabled: false,
      invokeResult: async (action) => action(),
      applySnapshot: () => {},
    });
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(React.Fragment, null, ...Array.from({ length: 8 }, (_, i) => picker(i))))
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.deepEqual(api.calls, []);
  assert.equal(api.snapshots, 1);
  await act(async () => root.unmount());
});

test('concurrent preset readers share one listPresets call', async () => {
  const api = fakeApi();
  await Promise.all(Array.from({ length: 12 }, () => listPresetsShared(api)));
  assert.deepEqual(api.calls, ['listPresets']);
  await listPresetsShared(api);
  assert.equal(api.calls.length, 2, 'a settled read is not cached: a later read asks again');
});

test('overlapping preset reads are coalesced per host: A, B, A makes one call each', async () => {
  const hostA = fakeApi();
  const hostB = fakeApi();
  const reads = [listPresetsShared(hostA), listPresetsShared(hostB), listPresetsShared(hostA)];
  await Promise.all(reads);
  assert.deepEqual(hostA.calls, ['listPresets']);
  assert.deepEqual(hostB.calls, ['listPresets']);
  await listPresetsShared(hostA);
  assert.equal(hostA.calls.length, 2, 'a settled entry was deleted, so a later read asks again');
});

for (const order of ['old then new', 'new then old']) {
  test(`a read that predates a setup change never overwrites the refresh (${order})`, async () => {
    resetSidebarReferenceCache();
    const pending = [];
    const api = {
      getSnapshot: async () => ({}),
      invokeCapability: ({ capability }) =>
        new Promise((resolve, reject) => pending.push({ capability, resolve, reject })),
    };
    const lead = (model) => ({ value: [{ id: 'workflow-lead', provider: 'p', model }] });
    const { dom } = installTestDom(null, {
      html: '<!doctype html><html><body><div id="root"></div></body></html>',
      jsdom: { url: 'about:blank' },
      expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
      actEnvironment: false,
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    let shown = null;
    function Harness() {
      shown = useLeadMainRoute(true, api)[0];
      return null;
    }
    const root = createRoot(dom.window.document.getElementById('root'));
    const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(pending.length, 1, 'mount starts the first read');
    await act(async () => announceSetupChange('save_preset'));
    assert.equal(pending.length, 2, 'the setup change starts exactly one new request');
    const [oldRead, newRead] = pending;
    const settle = order === 'old then new' ? [oldRead, newRead] : [newRead, oldRead];
    for (const read of settle) {
      read.resolve(lead(read === oldRead ? 'old-model' : 'new-model'));
      await flush();
    }
    assert.equal(shown.model, 'new-model');
    await act(async () => root.unmount());
  });
}

for (const failure of ['rejects', 'never settles']) {
  test(`a newer read that ${failure} does not suppress the older successful read`, async () => {
    resetSidebarReferenceCache();
    const pending = [];
    const api = {
      getSnapshot: async () => ({}),
      invokeCapability: ({ capability }) =>
        new Promise((resolve, reject) => pending.push({ capability, resolve, reject })),
    };
    const { dom } = installTestDom(null, {
      html: '<!doctype html><html><body><div id="root"></div></body></html>',
      jsdom: { url: 'about:blank' },
      expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
      actEnvironment: false,
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    let shown = null;
    function Harness() {
      shown = useLeadMainRoute(true, api)[0];
      return null;
    }
    const root = createRoot(dom.window.document.getElementById('root'));
    const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => announceSetupChange('save_preset'));
    assert.equal(pending.length, 2);
    const [oldRead, newRead] = pending;
    if (failure === 'rejects') newRead.reject(new Error('daemon unavailable'));
    await flush();
    oldRead.resolve({ value: [{ id: 'workflow-lead', provider: 'p', model: 'old-model' }] });
    await flush();
    assert.equal(shown.model, 'old-model');
    await act(async () => root.unmount());
  });
}

test('a first preset read that fails shows the host route until a full read lands', async () => {
  resetSidebarReferenceCache();
  const pending = [];
  const api = {
    getSnapshot: async () => ({ provider: 'p', model: 'host-model' }),
    invokeCapability: ({ capability }) =>
      new Promise((resolve, reject) => pending.push({ capability, resolve, reject })),
  };
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
    actEnvironment: false,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let shown = null;
  function Harness() {
    shown = useLeadMainRoute(true, api)[0];
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  await act(async () => root.render(React.createElement(Harness)));
  pending[0].reject(new Error('daemon unavailable'));
  await flush();
  assert.equal(shown.model, 'host-model', 'the host route stands in for the failed preset read');
  await act(async () => announceSetupChange('save_preset'));
  pending[1].resolve({ value: [{ id: 'workflow-lead', provider: 'p', model: 'lead-model' }] });
  await flush();
  assert.equal(shown.model, 'lead-model');
  await act(async () => root.unmount());
});

test('one setup notification refreshes presets once for every subscriber', async () => {
  const api = fakeApi();
  const refreshes = [];
  const readers = [
    () => refreshes.push(readHostMainRoute(api)),
    () => refreshes.push(listPresetsShared(api).then((result) => leadRouteFrom({}, result?.value))),
  ];
  const unsubscribe = readers.map((reader) => subscribeSetupChanges(reader));
  try {
    const stale = listPresetsShared(api); // a read already in flight when the change lands
    announceSetupChange('settings_changed');
    await Promise.all([stale, ...refreshes]);
    assert.deepEqual(api.calls, ['listPresets', 'listPresets'], 'the stale read plus exactly one refresh');
  } finally {
    for (const off of unsubscribe) off();
  }
});
