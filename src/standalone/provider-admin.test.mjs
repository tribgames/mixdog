import assert from 'node:assert/strict';
import test from 'node:test';

import { providerSetup } from './provider-admin.mjs';

test('provider setup auto-detects an installed first-party Local Provider without an endpoint', async () => {
  const setup = await providerSetup({
    providers: {
      'mixdog-local': { enabled: true },
    },
    builtins: {
      localProvider: { installed: true },
    },
    modules: {
      localProvider: { enabled: true },
    },
  }, {
    getLocalProviderStatus: () => ({
      runtime: { installed: true },
      models: [
        { id: 'qwen3.8-27b-q4-k-m', installed: true },
      ],
    }),
  });

  assert.deepEqual(setup.local, [{
    id: 'mixdog-local',
    name: 'Local Provider',
    desc: 'Models managed on this PC by Mixdog',
    group: 'local',
    type: 'local',
    enabled: true,
    detected: true,
    authenticated: true,
    usable: true,
    status: 'Ready',
    detail: '1 installed model',
  }]);
  assert.equal('baseURL' in setup.local[0], false);
});
