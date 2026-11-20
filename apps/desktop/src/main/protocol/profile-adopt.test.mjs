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

test('a core that has moved SSH hosts but not editor settings is told the profile', async () => {
  const client = fake({
    'migrate/profile/status': () => ({ generation: 2, profile: 'C:\\profile', completedWithProfile: true }),
    'migrate/profile/adopt': () => ({ generation: 3, moved: ['User/settings.json'] }),
  });
  assert.deepEqual(await adoptProfileIfBehind(client, 'C:\\profile'), { adopted: true, moved: ['User/settings.json'] });
  assert.deepEqual(client.calls, [
    ['migrate/profile/status', {}],
    ['migrate/profile/adopt', { userData: 'C:\\profile' }],
  ]);
});

test('a core at the generation with a canonical preference is left alone', async () => {
  const client = fake({
    'migrate/profile/status': () => ({ generation: 3, profile: 'p', completedWithProfile: true }),
    'config/read': () => ({ config: { 'desktop.editor.markdownDefaultView': null } }),
  });
  assert.deepEqual(await adoptProfileIfBehind(client, 'p'), { adopted: false, moved: [] });
  assert.deepEqual(client.calls, [
    ['migrate/profile/status', {}],
    ['config/read', { keys: ['desktop.editor.markdownDefaultView'] }],
  ]);
});

test('reattaching retries an unfinished preference import after the files have moved', async () => {
  let generation = 2;
  let config = {};
  const client = fake({
    'migrate/profile/status': () => ({ generation, profile: 'p', completedWithProfile: true }),
    'config/read': () => ({ config }),
    'migrate/profile/adopt': () => {
      if (generation === 2) {
        generation = 3;
        throw new Error('preference write failed');
      }
      config = { 'desktop.editor.markdownDefaultView': 'rich' };
      return { generation, moved: [] };
    },
  });
  assert.deepEqual(await adoptProfileIfBehind(client, 'p'), { adopted: false, moved: [] });
  assert.deepEqual(await adoptProfileIfBehind(client, 'p'), { adopted: true, moved: [] });
  assert.deepEqual(await adoptProfileIfBehind(client, 'p'), { adopted: false, moved: [] });
});

test('the expected generation is a parameter', async () => {
  const client = fake({
    'migrate/profile/status': () => ({ generation: 3, profile: 'p', completedWithProfile: true }),
    'migrate/profile/adopt': () => ({ generation: 4, moved: [] }),
  });
  assert.equal((await adoptProfileIfBehind(client, 'p', 4)).adopted, true);
});

test('a failing status or adopt is logged and not thrown', async () => {
  const original = console.error;
  const logged = [];
  console.error = (line) => logged.push(line);
  try {
    const status = fake({
      'migrate/profile/status': () => {
        throw new Error('no method');
      },
    });
    assert.deepEqual(await adoptProfileIfBehind(status, 'p'), { adopted: false, moved: [] });
    const adopt = fake({
      'migrate/profile/status': () => ({ generation: 1 }),
      'migrate/profile/adopt': () => {
        throw new Error('refused');
      },
    });
    assert.deepEqual(await adoptProfileIfBehind(adopt, 'p'), { adopted: false, moved: [] });
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 2);
});
