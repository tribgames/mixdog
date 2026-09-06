import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectCatalogRequests } from './project-catalog-requests.ts';

test('overlapping reconnect reads share one request and authoritative empty results win', async () => {
  const gate = Promise.withResolvers();
  let calls = 0;
  const accepted = [];
  const requests = createProjectCatalogRequests(
    () => { calls += 1; return gate.promise; },
    (rows, acceptEmpty) => accepted.push({ rows, acceptEmpty }),
  );
  const gap = requests.refresh({ acceptEmpty: false, coalesce: true });
  const reconnect = requests.refresh({ acceptEmpty: true, coalesce: true });
  assert.equal(gap, reconnect);
  await Promise.resolve();
  assert.equal(calls, 1);
  gate.resolve([]);
  await gap;
  assert.deepEqual(accepted, [{ rows: [], acceptEmpty: true }]);
});

test('a mutation refresh supersedes an older read instead of reusing stale catalog data', async () => {
  const old = Promise.withResolvers();
  const fresh = Promise.withResolvers();
  let calls = 0;
  const accepted = [];
  const requests = createProjectCatalogRequests(
    () => ++calls === 1 ? old.promise : fresh.promise,
    (rows) => accepted.push(rows),
  );
  const before = requests.refresh({ coalesce: true });
  await Promise.resolve();
  const after = requests.refresh();
  fresh.resolve([{ path: 'new', name: 'New', alias: null }]);
  await after;
  old.resolve([{ path: 'old', name: 'Old', alias: null }]);
  await before;
  assert.equal(calls, 2);
  assert.deepEqual(accepted.map((rows) => rows[0].path), ['new']);
});

test('disconnect invalidates in-flight results and a failed read does not poison the next refresh', async () => {
  const old = Promise.withResolvers();
  let calls = 0;
  const accepted = [];
  const requests = createProjectCatalogRequests(
    () => ++calls === 1 ? old.promise : Promise.resolve([]),
    (rows) => accepted.push(rows),
  );
  const pending = requests.refresh({ coalesce: true });
  await Promise.resolve();
  requests.invalidate();
  old.resolve([{ path: 'stale', name: 'Stale', alias: null }]);
  await pending;
  assert.deepEqual(accepted, []);
  await requests.refresh({ coalesce: true });
  assert.deepEqual(accepted, [[]]);
  const recovering = createProjectCatalogRequests(
    () => calls++ === 2 ? Promise.reject(new Error('offline')) : Promise.resolve([]),
    () => {},
  );
  await assert.rejects(recovering.refresh({ coalesce: true }), /offline/);
  assert.deepEqual(await recovering.refresh({ coalesce: true }), []);
});
