import assert from 'node:assert/strict';
import test from 'node:test';

import { deferredModule } from './deferred-module.ts';

test('a deferred module imports once, then reads synchronously', async () => {
  let imports = 0;
  const module = deferredModule(async () => {
    imports += 1;
    return { value: 'surface' };
  });
  let notified = 0;
  module.subscribe(() => {
    notified += 1;
  });
  assert.equal(module.peek(), null);

  const [first, second] = await Promise.all([module.load(), module.load()]);
  assert.equal(imports, 1);
  assert.equal(first, second);
  assert.equal(module.peek(), first);
  assert.equal(notified, 1);

  // A later open (or the idle lane) never imports again.
  assert.equal(await module.load(), first);
  assert.equal(imports, 1);
});

test('a failed import clears itself so the next load retries', async () => {
  let attempts = 0;
  const module = deferredModule(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('chunk fetch failed');
    return { value: 'surface' };
  });
  await assert.rejects(module.load(), /chunk fetch failed/);
  assert.equal(module.peek(), null);
  assert.deepEqual(await module.load(), { value: 'surface' });
  assert.equal(attempts, 2);
});

test('an unsubscribed listener is not told about the load', async () => {
  const module = deferredModule(async () => ({}));
  let notified = 0;
  const unsubscribe = module.subscribe(() => {
    notified += 1;
  });
  unsubscribe();
  await module.load();
  assert.equal(notified, 0);
});
