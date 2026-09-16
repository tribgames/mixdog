import assert from 'node:assert/strict';
import test from 'node:test';
import { readGlobalCapabilities } from './global-capability-reads.ts';
import { callCapability } from './studio-support.ts';

test('global read batches preserve every value and position within the transport limit', async () => {
  const requests = Array.from({ length: 35 }, (_, id) => ({ capability: 'getMediaJob', args: [id] }));
  const batches = [];
  const pending = [];
  const api = {
    readCapabilities(chunk) {
      batches.push(chunk);
      return new Promise((resolve) => pending.push(resolve));
    },
    invokeCapability() {
      throw new Error('The snapshot-bearing path must not run.');
    },
  };
  const reading = readGlobalCapabilities(api, requests);
  assert.deepEqual(
    batches.map((chunk) => chunk.length),
    [32, 3]
  );
  pending[1](batches[1].map(({ args }) => ({ ok: true, value: { id: args[0] } })));
  pending[0](batches[0].map(({ args }) => ({ ok: true, value: { id: args[0] } })));
  assert.deepEqual(
    await reading,
    requests.map(({ args }) => ({ id: args[0] }))
  );
  assert.deepEqual(await readGlobalCapabilities(api, []), []);
  assert.equal(batches.length, 2);
});

test('value-only reads preserve falsy values and report errors without retrying the other transport', async () => {
  const requests = [0, false, null, undefined].map(() => ({ capability: 'getMediaJob', args: ['job'] }));
  assert.deepEqual(
    await readGlobalCapabilities(
      {
        readCapabilities: async () => [0, false, null, undefined].map((value) => ({ ok: true, value })),
      },
      requests
    ),
    [0, false, null, undefined]
  );
  for (const response of [[{ ok: false, error: 'remote job read failed' }], []]) {
    let calls = 0;
    await assert.rejects(
      readGlobalCapabilities(
        {
          readCapabilities: async () => {
            calls += 1;
            return response;
          },
          invokeCapability() {
            assert.fail('An unsuccessful read must not be retried.');
          },
        },
        requests.slice(0, 1)
      ),
      response.length ? /remote job read failed/ : /did not return a result/
    );
    assert.equal(calls, 1);
  }
  const failure = new Error('connection interrupted');
  await assert.rejects(
    readGlobalCapabilities(
      {
        readCapabilities: async () => {
          throw failure;
        },
        invokeCapability() {
          assert.fail('A rejected batch must not be replayed.');
        },
      },
      requests.slice(0, 1)
    ),
    (error) => error === failure
  );
});

test('legacy global reads retain invocation arguments and error identity', async () => {
  const calls = [];
  const requests = [
    { capability: 'getUsageDashboard', args: [{ refresh: true, refreshProviders: ['openai-oauth'] }] },
    { capability: 'readMediaAsset', args: ['asset', { variant: 'display', allowOriginal: true }] },
  ];
  const value = { bytes: 'unchanged' };
  assert.deepEqual(
    await readGlobalCapabilities(
      {
        invokeCapability: async (request) => {
          calls.push(request);
          return { value, snapshot: {} };
        },
      },
      requests
    ),
    [value, value]
  );
  assert.deepEqual(calls, requests);
  assert.deepEqual(await readGlobalCapabilities(undefined, requests), [undefined, undefined]);
  const failure = new Error('legacy read failed');
  await assert.rejects(
    readGlobalCapabilities(
      {
        invokeCapability: async () => {
          throw failure;
        },
      },
      requests
    ),
    (error) => error === failure
  );
});

test('Studio reads avoid snapshots while commands still execute exactly once', async () => {
  const reads = [];
  const commands = [];
  const value = { base64: 'AAECAw==', mime: 'application/octet-stream', variant: 'original' };
  const api = {
    readCapabilities: async (requests) => {
      reads.push(requests);
      return requests.map(() => ({ ok: true, value }));
    },
    invokeCapability: async (request) => {
      commands.push(request);
      return { value: true, snapshot: {} };
    },
  };
  const args = ['asset', { variant: 'original', allowOriginal: true }];
  assert.equal(await callCapability(api, 'readMediaAsset', args), value);
  assert.deepEqual(reads, [[{ capability: 'readMediaAsset', args }]]);
  assert.equal(await callCapability(api, 'cancelMediaJob', ['job']), true);
  assert.deepEqual(commands, [{ capability: 'cancelMediaJob', args: ['job'] }]);
  assert.equal(reads.length, 1);
});
