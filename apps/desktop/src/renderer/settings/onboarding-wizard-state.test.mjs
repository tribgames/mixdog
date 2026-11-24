import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from '../test-support/test-dom.mjs';

const DOM = { rootId: 'root', expose: ['HTMLElement', 'Node', 'Event'] };
const { useOnboardingRun, useOnboardingSetup } = await import('./onboarding-wizard-state.ts');

test("a throwing caller gets the failure instead of the wizard's banner, and later mutations still run", async (t) => {
  const dom = installTestDom(t, DOM);
  const calls = [];
  const api = {
    invokeCapability: async ({ capability }) => {
      calls.push(capability);
      if (capability === 'completeOAuthProviderLogin') throw new Error('The authorization code is invalid.');
      return { value: { saved: true } };
    },
  };
  const seen = { hook: null };
  function Probe() {
    seen.hook = useOnboardingRun(api);
    return null;
  }
  await act(async () => dom.root.render(React.createElement(Probe)));
  await act(async () => {
    await assert.rejects(
      seen.hook.run('completeOAuthProviderLogin', ['flow-1', 'bad'], 'oauth-complete', false, false, 'throw'),
      /The authorization code is invalid\./
    );
  });
  assert.equal(seen.hook.error, '', 'the wizard banner behind the sign-in dialog stays empty');
  let saved;
  await act(async () => {
    saved = await seen.hook.run('setProfile', [{ title: 'Dev' }]);
  });
  assert.deepEqual(saved, { saved: true });
  assert.deepEqual(calls, ['completeOAuthProviderLogin', 'setProfile']);
});

async function mountSetup(t, readCapabilities) {
  const dom = installTestDom(t, DOM);
  const errors = [];
  const setError = (message) => errors.push(message);
  const api = { readCapabilities };
  const seen = { hook: null };
  function Probe() {
    seen.hook = useOnboardingSetup(api, setError);
    return null;
  }
  await act(async () => dom.root.render(React.createElement(Probe)));
  return { seen, errors, dom };
}

test('the setup and profile are read together on mount', async (t) => {
  const reads = [];
  const { seen, errors } = await mountSetup(t, async (requests) => {
    reads.push(requests.map(({ capability, args }) => ({ capability, args })));
    return requests.map(({ capability }) => ({
      ok: true,
      value: capability === 'getProviderSetup' ? { api: [{ id: 'gemini' }] } : { title: 'Dev' },
    }));
  });
  assert.deepEqual(reads, [
    [
      { capability: 'getProviderSetup', args: [{ force: false }] },
      { capability: 'getProfile', args: undefined },
    ],
  ]);
  assert.equal(seen.hook.loading, false);
  assert.deepEqual(seen.hook.providerSetup, { api: [{ id: 'gemini' }] });
  assert.deepEqual(seen.hook.profile, { title: 'Dev' });
  assert.deepEqual(errors, ['']);
});

test('a failed read is reported with the others still applied, and load(true) forces the setup read', async (t) => {
  const forces = [];
  const { seen, errors } = await mountSetup(t, async (requests) =>
    requests.map(({ capability, args }) => {
      if (capability === 'getProviderSetup') {
        forces.push(args[0].force);
        return { ok: false, error: 'setup down' };
      }
      return { ok: true, value: { title: 'Dev' } };
    })
  );
  assert.deepEqual(errors, ['', 'setup down']);
  assert.deepEqual(seen.hook.providerSetup, {});
  assert.deepEqual(seen.hook.profile, { title: 'Dev' });
  await act(async () => seen.hook.load(true));
  assert.deepEqual(forces, [false, true]);
});

test('a client-managed setup is re-read, forced, when the window regains focus', async (t) => {
  let unavailable = true;
  const forces = [];
  const { seen } = await mountSetup(t, async (requests) =>
    requests.map(({ capability, args }) => {
      if (capability === 'getProviderSetup') {
        forces.push(args[0].force);
        return { ok: true, value: { managedByClient: true, unavailable } };
      }
      return { ok: true, value: {} };
    })
  );
  assert.equal(seen.hook.providerSetup.unavailable, true);
  unavailable = false;
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  assert.equal(seen.hook.providerSetup.unavailable, false);
  assert.equal(forces.at(-1), true);
});

test('an unmanaged setup is not re-read on focus', async (t) => {
  let reads = 0;
  await mountSetup(t, async (requests) => {
    reads += 1;
    return requests.map(() => ({ ok: true, value: {} }));
  });
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  assert.equal(reads, 1);
});
