import assert from 'node:assert/strict';
import test from 'node:test';

import { adoptProfileIfBehind } from './profile-adopt.ts';

function fake(handlers) {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push([method, params]);
      return handlers[method](params);
    },
  };
}

test('a core behind the generation is told the profile and reports what moved', async () => {
  const client = fake({
    'migrate/profile/status': () => ({ generation: 1, profile: null, completedWithProfile: false }),
    'migrate/profile/adopt': () => ({ generation: 2, moved: ['ssh-hosts.json'] }),
  });
  assert.deepEqual(await adoptProfileIfBehind(client, 'C:\profile'), { adopted: true, moved: ['ssh-hosts.json'] });
  assert.deepEqual(client.calls, [
    ['migrate/profile/status', {}],
    ['migrate/profile/adopt', { userData: 'C:\profile' }],
  ]);
});

test('a core at the generation is left alone', async () => {
  const client = fake({ 'migrate/profile/status': () => ({ generation: 2, profile: 'x', completedWithProfile: true }) });
  assert.deepEqual(await adoptProfileIfBehind(client, 'p'), { adopted: false, moved: [] });
  assert.equal(client.calls.length, 1);
});

test('the expected generation is a parameter', async () => {
  const client = fake({
    'migrate/profile/status': () => ({ generation: 2, profile: null, completedWithProfile: false }),
    'migrate/profile/adopt': () => ({ generation: 3, moved: [] }),
  });
  assert.equal((await adoptProfileIfBehind(client, 'p', 3)).adopted, true);
});

test('a failing status or adopt is logged and not thrown', async () => {
  const original = console.error;
  const logged = [];
  console.error = (line) => logged.push(line);
  try {
    const status = fake({ 'migrate/profile/status': () => { throw new Error('no method'); } });
    assert.deepEqual(await adoptProfileIfBehind(status, 'p'), { adopted: false, moved: [] });
    const adopt = fake({
      'migrate/profile/status': () => ({ generation: 1 }),
      'migrate/profile/adopt': () => { throw new Error('refused'); },
    });
    assert.deepEqual(await adoptProfileIfBehind(adopt, 'p'), { adopted: false, moved: [] });
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 2);
});
