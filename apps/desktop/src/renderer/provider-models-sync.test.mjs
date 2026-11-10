import assert from 'node:assert/strict';
import test from 'node:test';
import { readProviderModelsChange } from '../shared/provider-models.ts';
import { subscribeModelCatalogInvalidation } from './model-catalog-cache.ts';
import { sectionStoreFor } from './section-store.ts';
import { toolModulesSource } from './test-support/test-dom.mjs';
import { settle, withPhoneApi } from './test-support/phone-api-rig.mjs';
import {
  PROVIDER_MODELS_INSTANCE_ID,
  invalidateSidebarReferenceForMutation,
  resetSidebarReferenceCache,
  subscribeProviderModelsSync,
  loadSidebarReferences,
  readSidebarReference,
} from './sidebar-reference-cache.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The window's store has folded its first snapshot. That fold invalidates the keys that follow a section, which
 *  would drop a read already in flight; a mounted window reads once the store is up. */
const storeUp = (api) => sectionStoreFor(api).ready();

function fakeHost() {
  const listeners = new Set();
  const notified = [];
  return {
    notified,
    emit: (change) => {
      for (const listener of listeners) listener(change);
    },
    api: {
      notifyProviderModelsChanged: (origin) => notified.push(origin),
      subscribeProviderModelsChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

test('a local provider mutation notifies main once with this renderer instance id', () => {
  resetSidebarReferenceCache();
  const host = fakeHost();
  globalThis.window = { mixdogDesktop: host.api };
  try {
    invalidateSidebarReferenceForMutation('forgetProviderAuth');
    assert.deepEqual(host.notified, [PROVIDER_MODELS_INSTANCE_ID]);
    invalidateSidebarReferenceForMutation('saveSchedule');
    assert.equal(host.notified.length, 1, 'non-provider mutations never notify');
    // Custom-provider edits reach peer windows like save/remove do.
    for (const mutation of ['saveCustomProvider', 'removeCustomProvider', 'updateCustomProviderModel']) {
      assert.equal(invalidateSidebarReferenceForMutation(mutation), true, mutation);
    }
    assert.equal(host.notified.length, 4);
  } finally {
    delete globalThis.window;
  }
});

test('a peer notification reloads pickers without echoing; own echo is ignored', async () => {
  resetSidebarReferenceCache();
  const host = fakeHost();
  globalThis.window = { mixdogDesktop: host.api };
  let woke = 0;
  const unwatch = subscribeModelCatalogInvalidation(() => {
    woke += 1;
  });
  const unsubscribe = subscribeProviderModelsSync(host.api);
  try {
    host.emit({ origin: PROVIDER_MODELS_INSTANCE_ID });
    await tick();
    assert.equal(woke, 0, 'own echo does not reload a second time');

    host.emit({ origin: 'another-window' });
    await tick();
    assert.equal(woke, 1, 'peer change invalidates the shared catalog');
    assert.deepEqual(host.notified, [], 'receipt never notifies main again');
  } finally {
    unsubscribe();
    unwatch();
    delete globalThis.window;
  }
});

// Node's version of this test (b6f10295a) read the call and the pushed frames off a fake relay socket. On the phone the call is handed to the
// adapter that owns the name and the pushed event reaches the listener sets through that adapter; the router and the table are the real ones.
test('notify uses the remote method path and subscribers hear the change until they unsubscribe', async () => {
  await withPhoneApi({ notifyProviderModelsChanged: () => undefined }, async ({ ctx, api, calls }) => {
    const received = [];
    const unsubscribe = api.subscribeProviderModelsChanged((change) => received.push(change));
    api.notifyProviderModelsChanged('phone-1');
    await settle();
    // Node remote-shim-api.ts:479 -- `fire('notifyProviderModelsChanged', [origin])`: the same method name and parameters Node put in its frame.
    assert.deepEqual(calls, [{ method: 'notifyProviderModelsChanged', params: ['phone-1'] }]);
    // :480 -- subscribeProviderModelsChanged is `listenOn(ctx.providerModelsListeners, …)`; Node's dispatch fans out to that set (remote-shim-dispatch.ts:279).
    ctx.fanOut(ctx.providerModelsListeners, { origin: 'a' });
    assert.deepEqual(received, [{ origin: 'a' }]);
    unsubscribe();
    ctx.fanOut(ctx.providerModelsListeners, { origin: 'b' });
    assert.deepEqual(received, [{ origin: 'a' }]);
  });
});

// Node dispatch (remote-shim-dispatch.ts:278-279) read the pushed payload with readProviderModelsChange: a payload without a string origin
// was never fanned out. That reader is shared, so the rule holds for whichever adapter carries the event. The other Node check there
// (`if (!authenticated) return`, :277, "clear relay hints are ignored") has no counterpart: the protocol has no unauthenticated hint frames.
test('a pushed change is read by the shared reader: a string origin only', () => {
  assert.deepEqual(readProviderModelsChange({ origin: 'a' }), { origin: 'a' });
  assert.equal(readProviderModelsChange({ origin: 7 }), null);
  assert.equal(readProviderModelsChange({}), null);
});

test('a local window provider invalidation re-reads references without forcing them', async () => {
  resetSidebarReferenceCache();
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  const calls = [];
  // The provider setup is a section the core pushes: reading it is reading the store, never a capability request.
  const core = toolModulesSource();
  core.publishSection('providerSetup', { oauth: [{ id: 'openai-oauth', authenticated: true }] });
  const api = {
    sections: core.sections,
    invokeCapability: async ({ capability, args }) => {
      calls.push({ capability, args });
      return { value: {} };
    },
    listProviderModels: async (options) => {
      calls.push({ models: options });
      return [{ provider: 'openai-oauth', model: 'local-model' }];
    },
  };
  const unsubscribe = subscribeProviderModelsSync(api);
  try {
    await storeUp(api);
    await loadSidebarReferences(api, ['providerSetup', 'quickProviderModels']);
    assert.equal(readSidebarReference('providerSetup').oauth[0].authenticated, true);
    core.publishSection('providerSetup', { oauth: [{ id: 'openai-oauth', authenticated: false }] });
    globalThis.window.dispatchEvent(new Event('mixdog:remote-reconnected'));
    await tick();
    await loadSidebarReferences(api, ['providerSetup', 'quickProviderModels']);
    assert.equal(readSidebarReference('providerSetup').oauth[0].authenticated, false, 'the re-read follows the section');
    assert.equal(calls.filter((call) => call.models).length, 2, 'the models are read again');
    assert.ok(!calls.some((call) => call.capability === 'getProviderSetup'), 'the setup never goes over a request');
    assert.ok(!calls.some((call) => call.models?.force));
  } finally {
    unsubscribe();
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
    resetSidebarReferenceCache();
  }
});

for (const event of ['mixdog:remote-reconnected', 'mixdog:remote-state-gap']) {
  test(`sidebar provider references recover their offline snapshot on ${event}`, async () => {
    resetSidebarReferenceCache();
    const previous = globalThis.window;
    globalThis.window = Object.assign(new EventTarget(), { mixdogDesktop: { connection: { kind: 'ssh' } } });
    let connected = false;
    const calls = [];
    const core = toolModulesSource();
    core.publishSection('providerSetup', { managedByClient: true, unavailable: true, oauth: [] });
    const api = {
      sections: core.sections,
      invokeCapability: async () => ({ value: {} }),
      listProviderModels: async (options) => {
        calls.push({ models: options });
        return connected ? [{ provider: 'openai-oauth', model: 'new-model' }] : [];
      },
    };
    const unsubscribe = subscribeProviderModelsSync(api);
    try {
      await storeUp(api);
      const offline = await loadSidebarReferences(api, ['providerSetup', 'quickProviderModels']);
      assert.equal(offline.error, 'Desktop model providers are unavailable');
      assert.equal(readSidebarReference('providerSetup'), undefined);
      connected = true;
      core.publishSection('providerSetup', {
        managedByClient: true,
        unavailable: false,
        oauth: [{ id: 'openai-oauth', usable: true }],
      });
      globalThis.window.dispatchEvent(new Event(event));
      await tick();
      await loadSidebarReferences(api, ['providerSetup', 'quickProviderModels']);
      assert.equal(readSidebarReference('providerSetup').oauth[0].usable, true);
      assert.equal(readSidebarReference('quickProviderModels')[0].model, 'new-model');
      assert.ok(calls.some((call) => call.models?.force));
    } finally {
      unsubscribe();
      if (previous === undefined) delete globalThis.window;
      else globalThis.window = previous;
      resetSidebarReferenceCache();
    }
  });
}
