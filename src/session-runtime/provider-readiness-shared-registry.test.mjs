// #327: runtimes share one process-global provider registry. A runtime still on
// its secrets-less boot config (an OAuth route keeps it so) must never drop the
// key provider another runtime's session is on.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-readiness-shared-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dir;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const reg = await import('../runtime/agent/orchestrator/providers/registry.mjs');
const { createProviderReadiness } = await import('./provider-readiness.mjs');
const { ensureProviderEnabled } = await import('../runtime/agent/orchestrator/runtime-core/config-helpers.mjs');

const provider = (host, enabled) => ({
  type: 'custom',
  name: host,
  baseURL: `https://${host}.example.com/v1`,
  enabled,
  schemaVersion: 2,
  protocol: 'openai-chat',
  auth: 'none',
  preconnect: false,
  modelOverrides: { m1: { manual: true } },
});
// The full, secrets-aware load: the key provider and the OAuth one both on.
const FULL = { 'custom-key': provider('key', true), 'custom-oauth': provider('oauth', true) };
// What a secrets-less boot load answers: the key provider reads as off.
const LAZY = { 'custom-key': provider('key', false), 'custom-oauth': provider('oauth', false) };

function runtime(providers) {
  const rt = { config: { providers }, closeRequested: false, wakeDeferredWarmups() {} };
  const readiness = createProviderReadiness({
    rt,
    keychain: { prewarmSecrets: async () => {}, onKeychainRecovered: () => () => {} },
    // No network: the boot catalog refresh is not under test here.
    getReg: () => ({ ...reg, refreshProviderCatalogsOnStartup: () => Promise.resolve([]) }),
    getWarmProviderModelCache: () => () => {},
    getEnsureFullConfig: () => () => {
      rt.config = { providers: FULL };
      return rt.config;
    },
    getStoredProviders: () => ({}),
  });
  return { rt, readiness };
}

test('a runtime on its secrets-less boot config never drops a provider another runtime is on', async () => {
  const keyRuntime = runtime(FULL);
  const oauthRuntime = runtime(LAZY);
  await keyRuntime.readiness.ensureProvidersReady(ensureProviderEnabled(keyRuntime.rt.config, 'custom-key'));
  const live = reg.getProvider('custom-key');
  assert.ok(live);
  // A new session on the OAuth route prepares its provider (route-resolution.refreshRouteEffort).
  await oauthRuntime.readiness.ensureProvidersReady(ensureProviderEnabled({ providers: LAZY }, 'custom-oauth'));
  assert.ok(reg.getProvider('custom-oauth'));
  assert.equal(reg.getProvider('custom-key'), live, 'the key provider stays registered');
  // The first runtime re-enters its route: still registered, never rebuilt.
  await keyRuntime.readiness.ensureProvidersReady(ensureProviderEnabled(keyRuntime.rt.config, 'custom-key'));
  assert.equal(reg.getProvider('custom-key'), live);
});
