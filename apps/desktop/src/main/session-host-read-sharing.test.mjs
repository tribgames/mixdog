import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionHostLifecycle } from './session-host-lifecycle.ts';

/** The owner surface these reads touch; every daemon call is counted. */
function harness() {
  const calls = [];
  const gates = [];
  const projections = new Map([['s1', { revision: 3, snapshot: { sessionId: 's1', workspace: null } }]]);
  const daemon = (method, args) => {
    calls.push([method, args]);
    const gate = Promise.withResolvers();
    gates.push(gate);
    return gate.promise;
  };
  const owner = {
    publication: { projections },
    snapshotWithRemoteSession: (snapshot) => ({ ...snapshot, decorated: true }),
    invokeSession: async (sessionId, method, args) => ({ value: await daemon(method, args), snapshot: { sessionId } }),
    invokeControlResult: async (method, args) => ({ value: await daemon(method, args), snapshot: {} }),
    invokeControl: (method, args) => daemon(method, args),
    registeredProject: async (path) => path,
    resolveSessionWorkspace: async () => ({ cwd: '/work' }),
    isDisposed: () => false,
  };
  const settle = (value) => gates.shift().resolve(value);
  return { lifecycle: new SessionHostLifecycle(owner), calls, settle, projections };
}

test('identical concurrent usage sweeps from the window and a phone run once', async () => {
  const h = harness();
  const window = h.lifecycle.readCapabilities([{ capability: 'getUsageDashboard', args: [{ refresh: true }] }]);
  const phone = h.lifecycle.readCapabilities([{ capability: 'getUsageDashboard', args: [{ refresh: true }] }]);
  const other = h.lifecycle.readCapabilities([{ capability: 'getUsageDashboard', args: [{ providers: ['x'] }] }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 2, 'different arguments are a different sweep');
  h.settle({ total: 1 });
  h.settle({ total: 2 });
  assert.deepEqual(await window, [{ ok: true, value: { total: 1 } }]);
  assert.deepEqual(await phone, [{ ok: true, value: { total: 1 } }]);
  assert.deepEqual(await other, [{ ok: true, value: { total: 2 } }]);
});

test('the model catalog is read once for concurrent and recent callers, and again after a mutation', async () => {
  const h = harness();
  const reads = [h.lifecycle.listProviderModels({}), h.lifecycle.listProviderModels({ quick: false })];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  h.settle([{ provider: 'p', id: 'm', display: 'M' }]);
  const [first, second] = await Promise.all(reads);
  assert.deepEqual(first, second);
  first[0].model = 'mutated by a caller';
  const reused = await h.lifecycle.listProviderModels({});
  assert.equal(reused[0].model, 'm', 'every caller gets its own copy');
  assert.equal(h.calls.length, 1);
  const write = h.lifecycle.invokeCapability('setWorktreeSettings', [{}]);
  await new Promise((resolve) => setImmediate(resolve));
  h.settle(null);
  await write;
  const after = h.lifecycle.listProviderModels({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 3, 'a mutation through the host drops the reused catalog');
  h.settle([]);
  await after;
});

test('a session branch menu joins concurrent reads and answers with the current projection', async () => {
  const h = harness();
  const window = h.lifecycle.invokeCapability('getBranchMenu', [], 's1');
  const phone = h.lifecycle.invokeCapability('getBranchMenu', [], 's1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 1, 'the phone waits for the window read');
  // Outside a repository: the answer is shared in flight but never kept.
  h.settle({ workspace: { repoCommonDir: null, projectPath: '/work', cwd: '/work' } });
  const first = await window;
  assert.equal(first.snapshot.decorated, true, 'the projection this host holds now');
  assert.deepEqual((await phone).value, first.value);
  assert.equal(h.calls.length, 1, 'the phone joined the window read');
  const later = h.lifecycle.invokeCapability('getBranchMenu', [], 's1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 2, 'not reusable: a later read loads again');
  h.settle({ workspace: { repoCommonDir: null, projectPath: '/work', cwd: '/work' } });
  await later;
});
