import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionHost } from './session-host.ts';

async function hostFor(t, loadSessionStore) {
  const host = await SessionHost.create(
    { userDataPath: '.', resourcesPath: '.', appPath: '.', packaged: false },
    {
      async attachSessionClient() { return { async close() {} }; },
      async loadProjects() { return {}; },
      loadSessionStore,
      async loadStatuslineSegments() { return { shellJobsStatus: () => ({ count: 0, jobs: [], sessions: {} }) }; },
      async executeCodeGraphTool() { return {}; },
    }
  );
  t.after(() => host.dispose());
  return host;
}

test('concurrent agent pool callers share the store read but not returned arrays or rows', async (t) => {
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  let loads = 0;
  let reads = 0;
  const source = [{ tag: 'worker', sessionId: 'a', status: 'running' }];
  const host = await hostFor(t, async () => {
    loads++;
    await release.promise;
    return { listStoredAgentWorkers: () => { reads++; return source; } };
  });
  const calls = Array.from({ length: 16 }, () => host.listAgentPool());
  assert.equal(loads, 1);
  release.resolve();
  const results = await Promise.all(calls);
  assert.equal(reads, 1);
  for (const rows of results) {
    assert.deepEqual(rows, [{ ...source[0] }]);
    assert.notEqual(rows, source);
    assert.notEqual(rows[0], source[0]);
  }
  assert.notEqual(results[0], results[1]);
  assert.notEqual(results[0][0], results[1][0]);
  results[0][0].status = 'changed by caller';
  results[0].push({ sessionId: 'foreign' });
  assert.equal(results[1].length, 1);
  assert.equal(results[1][0].status, 'running');
  assert.equal(source[0].status, 'running');
});

test('settled reads are not cached', async (t) => {
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  let reads = 0;
  let rows = [{ tag: 'a', sessionId: 'a', status: 'running' }, { tag: 'b', sessionId: 'b', status: 'idle' }];
  const host = await hostFor(t, async () => {
    await release.promise;
    return { listStoredAgentWorkers: () => { reads++; return rows; } };
  });
  const pending = host.listAgentPool();
  release.resolve();
  assert.deepEqual((await pending).map((row) => row.sessionId), ['a', 'b']);
  rows = [{ tag: 'b', sessionId: 'b', status: 'running' }];
  assert.deepEqual(await host.listAgentPool(), [{ ...rows[0] }]);
  rows = [];
  assert.deepEqual(await host.listAgentPool(), []);
  assert.equal(reads, 3);
});

test('failed shared store loading rejects every caller and the next call retries normally', async (t) => {
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const failure = new Error('store unavailable');
  let fail = true;
  let loads = 0;
  const host = await hostFor(t, async () => {
    loads++;
    await release.promise;
    if (fail) throw failure;
    return { listStoredAgentWorkers: () => [] };
  });
  const pending = Array.from({ length: 8 }, () =>
    assert.rejects(host.listAgentPool(), (error) => error === failure)
  );
  release.resolve();
  await Promise.all(pending);
  assert.equal(loads, 1);
  fail = false;
  assert.deepEqual(await host.listAgentPool(), []);
  assert.equal(loads, 2);
});

test('listing errors clear the shared request and separate hosts never share rows', async (t) => {
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const failure = new Error('listing failed');
  let fail = true;
  let reads = 0;
  const first = await hostFor(t, async () => {
    await release.promise;
    return {
      listStoredAgentWorkers() {
        reads++;
        if (fail) throw failure;
        return [{ tag: 'first', sessionId: 'first' }];
      },
    };
  });
  const second = await hostFor(t, async () => ({
    listStoredAgentWorkers: () => [{ tag: 'second', sessionId: 'second' }],
  }));
  const errors = [
    assert.rejects(first.listAgentPool(), (error) => error === failure),
    assert.rejects(first.listAgentPool(), (error) => error === failure),
  ];
  assert.equal((await second.listAgentPool())[0].sessionId, 'second');
  release.resolve();
  await Promise.all(errors);
  assert.equal(reads, 1);
  fail = false;
  assert.equal((await first.listAgentPool())[0].sessionId, 'first');
  assert.equal(reads, 2);
});
