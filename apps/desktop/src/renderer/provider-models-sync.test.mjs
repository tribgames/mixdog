import assert from 'node:assert/strict';
import test from 'node:test';
import { PROVIDER_MODELS_EVENT } from '../shared/provider-models.ts';
import { subscribeModelCatalogInvalidation } from './model-catalog-cache.ts';
import { createRemoteApi } from './remote-shim-api.ts';
import { publishedCeilings, withShim } from './remote-shim-test-harness.mjs';
import {
  PROVIDER_MODELS_INSTANCE_ID,
  invalidateSidebarReferenceForMutation,
  resetSidebarReferenceCache,
  subscribeProviderModelsSync,
} from './sidebar-reference-cache.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));

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

test('relay notifications reach the paired client and notify uses the remote method path', async () => {
  await withShim({}, async ({ ctx, dial }) => {
    const api = createRemoteApi(ctx);
    const leg = await dial({ ready: publishedCeilings(4096, 4096) });
    const received = [];
    const unsubscribe = api.subscribeProviderModelsChanged((change) => received.push(change));
    api.notifyProviderModelsChanged('phone-1');
    const sent = await leg.nextPayload();
    assert.equal(sent.method, 'notifyProviderModelsChanged');
    assert.deepEqual(sent.params, ['phone-1']);
    ctx.handleMessage({ event: PROVIDER_MODELS_EVENT, payload: { origin: 'a' } }, false);
    assert.deepEqual(received, [], 'clear relay hints are ignored');
    await leg.deliver({ event: PROVIDER_MODELS_EVENT, payload: { origin: 'a' } });
    await leg.deliver({ event: PROVIDER_MODELS_EVENT, payload: { origin: 7 } });
    assert.deepEqual(received, [{ origin: 'a' }]);
    unsubscribe();
    await leg.deliver({ event: PROVIDER_MODELS_EVENT, payload: { origin: 'b' } });
    assert.deepEqual(received, [{ origin: 'a' }]);
  });
});
