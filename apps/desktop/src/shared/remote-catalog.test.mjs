import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteCatalog } from "./remote-catalog.ts";

test("a late subscriber receives the last roster, but reconnect never fabricates an empty roster", () => {
  const catalog = createRemoteCatalog();
  const initial = [{ sessionId: "worker", status: "running" }];
  catalog.publish(initial);
  const seen = [];
  const unsubscribe = catalog.subscribe((rows) => seen.push(rows));
  assert.deepEqual(seen, [initial]);
  unsubscribe();
  const completed = [{ sessionId: "worker", status: "completed" }];
  catalog.publish(completed);
  catalog.subscribe((rows) => seen.push(rows));
  assert.deepEqual(seen, [initial, completed], "tab re-entry sees current status");
  catalog.reset();
  const newReader = [];
  catalog.subscribe((rows) => newReader.push(rows));
  assert.equal(catalog.get(), null);
  assert.deepEqual(newReader, []);
  assert.deepEqual(seen, [initial, completed]);
  catalog.publish([]);
  assert.deepEqual(newReader, [[]], "an authoritative empty roster still clears removed agents");
});

test("startup reads coalesce and never replace a newer pushed roster", async () => {
  const catalog = createRemoteCatalog();
  const pending = Promise.withResolvers();
  let reads = 0;
  const load = () => { reads += 1; return pending.promise; };
  const a = catalog.read(load);
  const b = catalog.read(load);
  await Promise.resolve();
  assert.equal(reads, 1);
  const live = [{ id: "lead" }];
  catalog.publish(live);
  pending.resolve([]);
  assert.deepEqual(await a, live);
  assert.deepEqual(await b, live);
  assert.deepEqual(await catalog.read(load), live);
  assert.equal(reads, 1);
});

test("a failed initial read stays unknown and retryable, and an old generation cannot repopulate it", async () => {
  const catalog = createRemoteCatalog();
  await assert.rejects(catalog.read(async () => { throw new Error("offline"); }), /offline/);
  assert.equal(catalog.get(), null);
  const old = Promise.withResolvers();
  const oldRead = catalog.read(() => old.promise);
  await Promise.resolve();
  catalog.reset();
  const current = [{ id: "new-generation" }];
  await catalog.read(async () => current);
  old.resolve([{ id: "stale" }]);
  await oldRead;
  assert.deepEqual(catalog.get(), current);
});
