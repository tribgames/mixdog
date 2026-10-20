// The real boot path (beginBoot -> resolveConfig) must install the session
// generation tracking, and the real session adopter must advance it.
import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { beginBoot } from './begin.mjs';
import { resolveConfig } from './config.mjs';
import { sessionAdopter } from './infrastructure.mjs';
import { createRuntimeFacade } from '../runtime-facade.mjs';

async function bootedRuntime() {
  const boot = beginBoot({
    provider: 'openai',
    model: 'gpt-5.4',
    toolMode: 'full',
    cwd: process.cwd(),
    initialConfig: { providers: {}, modelSettings: {} },
  });
  boot.cfgMod = { loadConfig: () => ({}) };
  boot.sharedCfgMod = { pendingConfigWrites: async () => {}, invalidateConfigReadCache() {} };
  await resolveConfig(boot);
  boot.bindRuntimeNotificationSession = () => {};
  boot.workspaceApi = {};
  boot.adoptSession = sessionAdopter(boot);
  return boot;
}

test('the booted runtime advances sessionGeneration when a session is installed, reset or resumed', async () => {
  const boot = await bootedRuntime();
  const { rt } = boot;
  const facade = createRuntimeFacade({ state: rt });
  assert.equal(
    typeof Object.getOwnPropertyDescriptor(rt, 'sessionGeneration')?.get,
    'function',
    'resolveConfig installed the session generation tracking'
  );
  assert.equal(facade.sessionGeneration, 0, 'no session yet');

  boot.adoptSession({ id: 'sess_a' });
  assert.equal(facade.sessionGeneration, 1, 'a session is installed');

  boot.adoptSession({ id: 'sess_a', refreshed: true });
  assert.equal(facade.sessionGeneration, 1, 'the same conversation reinstalled is not a transition');

  boot.adoptSession(null);
  assert.equal(facade.sessionGeneration, 2, 'a reset leaves no session');

  boot.adoptSession({ id: 'sess_b' });
  assert.equal(facade.sessionGeneration, 3, 'a resume installs another session');

  rt.session = null;
  assert.equal(facade.sessionGeneration, 4, 'a direct clear (session-create, lifecycle) advances it too');
});
