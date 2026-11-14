// createTakeoverApi over a fake context: each call is the request the core serves, and what the old main handlers refused is
// refused here without a request.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createTakeoverApi } from './api-takeover.ts';

const setup = (answer = async () => ({})) => {
  const calls = [];
  const ctx = { call: async (method, params) => (calls.push({ method, params }), answer(method, params)) };
  return { calls, api: createTakeoverApi(ctx) };
};

test('provideSecretInput sends approval/provideSecret and answers true', async () => {
  const { calls, api } = setup();
  assert.equal(await api.provideSecretInput('secret_abcdefgh1234', 'hunter2'), true);
  assert.deepEqual(calls, [{ method: 'approval/provideSecret', params: { requestId: 'secret_abcdefgh1234', secret: 'hunter2' } }]);
});

test('provideSecretInput trims the request id as the main handler did', async () => {
  const { calls, api } = setup();
  assert.equal(await api.provideSecretInput(' secret_abcdefgh1234 ', 'v'), true);
  assert.equal(calls[0].params.requestId, 'secret_abcdefgh1234');
});

test('provideSecretInput takes the sign-in card suffix slots', async () => {
  const { calls, api } = setup();
  assert.equal(await api.provideSecretInput('secret_abcdefgh1234-username', 'me'), true);
  assert.equal(calls.length, 1);
});

test('provideSecretInput of an unusable id or value is false and sends nothing', async () => {
  const { calls, api } = setup();
  assert.equal(await api.provideSecretInput('not-a-secret-id', 'v'), false);
  assert.equal(await api.provideSecretInput('secret_abcdefgh1234', ''), false);
  assert.equal(await api.provideSecretInput('secret_abcdefgh1234', 'x'.repeat(4097)), false);
  assert.equal(await api.provideSecretInput('secret_abcdefgh1234', 5), false);
  await assert.rejects(() => api.provideSecretInput('', 'v'), TypeError);
  await assert.rejects(() => api.provideSecretInput('s'.repeat(121), 'v'), TypeError);
  assert.deepEqual(calls, []);
});

test('provideSecretInput passes the core refusal on', async () => {
  const { api } = setup(async () => {
    throw new Error('refused');
  });
  await assert.rejects(() => api.provideSecretInput('secret_abcdefgh1234', 'v'), /refused/);
});

test('takeoverReady sends takeover/ready and answers the core ready flag', async () => {
  const { calls, api } = setup(async () => ({ ready: true }));
  assert.equal(await api.takeoverReady('s1', 't1'), true);
  assert.deepEqual(calls, [{ method: 'takeover/ready', params: { sessionId: 's1', takeoverId: 't1' } }]);
  assert.equal(await setup(async () => ({ ready: false })).api.takeoverReady('s1', 't1'), false);
  assert.equal(await setup(async () => undefined).api.takeoverReady('s1', 't1'), false);
});

test('takeoverReady refuses a missing id without a request', async () => {
  const { calls, api } = setup();
  await assert.rejects(() => api.takeoverReady('', 't1'), TypeError);
  await assert.rejects(() => api.takeoverReady('s1', 5), TypeError);
  await assert.rejects(() => api.takeoverReady('not a session', 't1'), TypeError);
  assert.deepEqual(calls, []);
});
