// #327: the provider set is owned by the config of record. Additive requests
// (any runtime's view, a route's forced provider) never remove or rebuild a
// registered provider; the record rebuilds changed providers and removes only
// on a stored decision; the boot catalog refresh follows (name, signature).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-registry-ownership-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dir;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const { getProvider, initProviders, syncProviders, refreshProviderCatalogsOnStartup } = await import('./registry.mjs');

const custom = (host, extra = {}) => ({
  type: 'custom',
  name: host,
  baseURL: `https://${host}.example.com/v1`,
  enabled: true,
  schemaVersion: 2,
  protocol: 'openai-chat',
  auth: 'none',
  preconnect: false,
  modelOverrides: { m1: { manual: true } },
  ...extra,
});
const off = (cfg) => ({ ...cfg, enabled: false });

// First in this file: the registry is still empty.
test('a request that leaves the registry empty rejects as no provider enabled', async () => {
  await assert.rejects(initProviders({ 'custom-none': off(custom('none')) }), (error) => {
    assert.equal(error.code, 'PROVIDERS_NONE_ENABLED');
    return true;
  });
});

test('an additive request from another view never removes or rebuilds a registered provider', async () => {
  const keyed = custom('keyed');
  const routed = custom('routed');
  await initProviders({ 'custom-keyed': keyed, 'custom-routed': off(routed) });
  const live = getProvider('custom-keyed');
  assert.ok(live);
  // A secrets-less view reads the keyed provider as off; its route turns another one on.
  await initProviders({ 'custom-keyed': off(keyed), 'custom-routed': routed });
  assert.equal(getProvider('custom-keyed'), live);
  assert.ok(getProvider('custom-routed'));
  // Each runtime forcing its own provider over a base where the other is off.
  await initProviders({ 'custom-keyed': keyed, 'custom-routed': off(routed) });
  assert.equal(getProvider('custom-keyed'), live);
  assert.ok(getProvider('custom-routed'));
  // A changed config in an additive request is not a rebuild.
  await initProviders({ 'custom-keyed': custom('keyed', { headers: { 'X-View': 'other' } }) });
  assert.equal(getProvider('custom-keyed'), live);
});

test('the record rebuilds a changed provider and removes one only on a stored decision', async () => {
  const kept = custom('kept');
  const gone = custom('gone');
  await initProviders({ 'custom-kept': kept, 'custom-gone': gone });
  const live = getProvider('custom-kept');
  // A full load whose credential could not be read: the entry reads off, nothing was decided.
  await syncProviders(
    { 'custom-kept': off(kept), 'custom-gone': gone },
    { decisions: { 'custom-kept': { type: 'custom' }, 'custom-gone': { type: 'custom' } } }
  );
  assert.equal(getProvider('custom-kept'), live);
  // Stored decisions that could not be read decide nothing.
  await syncProviders({}, { decisions: null });
  assert.equal(getProvider('custom-kept'), live);
  // A changed config of record rebuilds it.
  const changed = custom('kept', { headers: { 'X-Record': '2' } });
  const decisions = { 'custom-kept': { type: 'custom' }, 'custom-gone': { type: 'custom', enabled: false } };
  await syncProviders({ 'custom-kept': changed, 'custom-gone': off(gone) }, { decisions });
  assert.notEqual(getProvider('custom-kept'), live);
  // Disable / logout store enabled:false: the provider leaves the registry.
  assert.equal(getProvider('custom-gone'), undefined);
  // A deleted custom provider is gone from the stored section.
  await syncProviders({ 'custom-kept': changed }, { decisions: {} });
  assert.equal(getProvider('custom-kept'), undefined);
});

test('the boot catalog refresh fetches a provider once per config; provider-set churn starts none', async (t) => {
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetched.push(new URL(String(url?.url ?? url)).hostname);
    return Response.json({ data: [] });
  });
  const a = custom('cat-a');
  const b = custom('cat-b');
  await initProviders({ 'custom-cat-a': a, 'custom-cat-b': b });
  const first = refreshProviderCatalogsOnStartup();
  await first;
  assert.ok(fetched.includes('cat-a.example.com') && fetched.includes('cat-b.example.com'));
  const seen = fetched.length;
  // Other runtimes' views and forced routes: no provider added or rebuilt.
  await initProviders({ 'custom-cat-a': off(a), 'custom-cat-b': b });
  await initProviders({ 'custom-cat-a': a, 'custom-cat-b': off(b) });
  assert.equal(refreshProviderCatalogsOnStartup(), first);
  assert.equal(fetched.length, seen);
  // The record rebuilds b: only b is fetched again.
  const decisions = { 'custom-cat-a': { type: 'custom' }, 'custom-cat-b': { type: 'custom' } };
  await syncProviders({ 'custom-cat-a': a, 'custom-cat-b': custom('cat-b', { headers: { 'X-Rev': '2' } }) }, { decisions });
  const second = refreshProviderCatalogsOnStartup();
  assert.notEqual(second, first);
  await second;
  assert.deepEqual([...new Set(fetched.slice(seen))], ['cat-b.example.com']);
});
