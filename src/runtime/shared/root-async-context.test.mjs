// The root context must leave the caller's request behind even when the
// module is first evaluated inside that request (a host that never captured
// the root at its entry point).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { currentUsageContext, withUsageContext } from './llm/usage-context.mjs';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');

test('imported late inside a request, the root context still leaves every request behind', async (t) => {
  const handles = [];
  t.after(() => handles.forEach(clearInterval));
  const inRoot = (late) =>
    late.runInRootAsyncContext(() => {
      handles.push(setInterval(() => {}, 60_000).unref());
      return currentUsageContext();
    });

  // A module first evaluated inside a request (its own evaluation promise
  // keeps that request's store under async_hooks, so that request is not the
  // one checked for collection below).
  const late = await withUsageContext({ sessionId: 'sess_importing' }, async () => {
    const module = await import('./root-async-context.mjs?late-import');
    assert.equal(module.initRootAsyncContext(), false, 'a request context is never captured as the root');
    assert.equal(inRoot(module), undefined, 'the importing request is not visible in the root context');
    return module;
  });

  let identity = { sessionId: 'sess_later', transcript: 'x'.repeat(1024) };
  const collected = new WeakRef(identity);
  assert.equal(await withUsageContext(identity, async () => inRoot(late)), undefined);
  identity = null;
  for (let i = 0; i < 5 && collected.deref(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
    gc();
  }
  assert.equal(collected.deref(), undefined, 'a handle made in the root context keeps no request alive');
});
