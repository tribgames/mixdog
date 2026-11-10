import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { PROVIDER_CATALOG_TIMEOUT_MS, pendingProviderCatalogOps } from './catalog-deadline.mjs';
import {
  _withRegisteredProviderForTestAsync,
  getProvider,
  providerCatalogRevision,
  refreshCatalogs,
  refreshProviderCatalogsOnStartup,
} from './registry.mjs';

async function flush() {
  for (let i = 0; i < 10; i += 1) await setImmediate();
}

test('startup and forced catalog refreshes complete despite a hung provider without stacking its work', async (t) => {
  // The forced refresh's shared metadata fetch hangs too; it is bounded the same way.
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const healthy = {
    calls: 0,
    async _refreshModelCache() {
      healthy.calls += 1;
    },
  };
  const hung = {
    calls: 0,
    signals: [],
    listModels({ signal } = {}) {
      hung.calls += 1;
      hung.signals.push(signal);
      return new Promise(() => {});
    },
  };
  await _withRegisteredProviderForTestAsync('deadline-healthy', healthy, () =>
    _withRegisteredProviderForTestAsync('deadline-hung', hung, async () => {
      const before = providerCatalogRevision();
      let startupDone = false;
      const startup = refreshProviderCatalogsOnStartup().then(() => {
        startupDone = true;
      });
      await flush();
      assert.equal(startupDone, false, 'the hung provider is still being waited for');
      t.mock.timers.tick(PROVIDER_CATALOG_TIMEOUT_MS);
      await startup;
      assert.equal(providerCatalogRevision(), before + 1, 'the startup epoch completes');
      assert.equal(healthy.calls, 1);
      assert.equal(hung.signals[0]?.aborted, true, 'the deadline aborts a signal-aware listModels');

      let forcedDone = false;
      const forced = refreshCatalogs({ force: true }).then(() => {
        forcedDone = true;
      });
      await flush();
      assert.equal(forcedDone, false, 'the hung metadata fetch is waited for up to its deadline');
      t.mock.timers.tick(PROVIDER_CATALOG_TIMEOUT_MS);
      // The hung provider already overran a deadline: it fails fast instead of
      // holding the forced refresh for another one.
      await forced;
      assert.equal(providerCatalogRevision(), before + 2, 'the forced epoch completes');
      assert.equal(healthy.calls, 2, 'a forced refresh still reaches every healthy provider');
      assert.equal(hung.calls, 1, 'the pending refresh is joined, not started again');
      assert.equal(pendingProviderCatalogOps().filter((name) => name === 'deadline-hung').length, 1);
    })
  );
});

test('a saved route naming the retired opencode-go provider is served by the connected OAuth account', async () => {
  const account = { name: 'opencode-go-oauth' };
  await _withRegisteredProviderForTestAsync('opencode-go-oauth', account, async () => {
    assert.equal(getProvider('opencode-go'), account);
  });
  assert.equal(getProvider('opencode-go'), undefined, 'not connected: the normal missing-provider path');
});
