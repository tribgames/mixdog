import assert from 'node:assert/strict';
import test from 'node:test';
import { createProcessFateReader } from './process-fate.ts';
import { HOST_WARMUP_SESSION_ID } from './action-sets.ts';

function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  return Promise.resolve()
    .then(run)
    .finally(() => Object.defineProperty(process, 'platform', original));
}

test('the OS answer is read through the host worker on Windows only', async () => {
  const requests = [];
  const read = createProcessFateReader(async (request) => {
    requests.push(request);
    return { id: 1, ok: true, result: { state: 'ended', created: '1337' } };
  });
  await withPlatform('linux', async () => {
    assert.deepEqual(await read({ pid: 42, created: '' }), { state: 'unknown', created: '' });
  });
  assert.deepEqual(requests, []);
  await withPlatform('win32', async () => {
    assert.deepEqual(await read({ pid: 42, created: '99' }), { state: 'ended', created: '1337' });
  });
  assert.deepEqual(requests, [
    { action: 'process_fate', session_id: HOST_WARMUP_SESSION_ID, pid: '42', created: '99' },
  ]);
});

test('a refused or unrecognised answer is unknown, never ended', async () => {
  const answers = [
    [
      { ok: false, result: { state: 'ended', created: '5' } },
      { state: 'unknown', created: '5' },
    ],
    [
      { ok: true, result: { state: 'zombie', created: 7 } },
      { state: 'unknown', created: '' },
    ],
    [
      { ok: true, result: { state: 'running', created: '8' } },
      { state: 'running', created: '8' },
    ],
    [{ ok: true }, { state: 'unknown', created: '' }],
  ];
  await withPlatform('win32', async () => {
    for (const [response, expected] of answers) {
      const read = createProcessFateReader(async () => ({ id: 1, ...response }));
      assert.deepEqual(await read({ pid: 1, created: '' }), expected);
    }
  });
});
