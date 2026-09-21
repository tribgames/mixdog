import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProviderAdmissionScheduler, wrapProviderAdmission } from './admission-scheduler.mjs';

test('provider admission reports active concurrency at dispatch', async () => {
  const scheduler = new ProviderAdmissionScheduler({ concurrency: 2 });
  const seen = [];
  let releaseFirst;

  const first = scheduler.run('openai:test', async (_signal, metrics) => {
    seen.push(metrics);
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    return 'first';
  });
  const second = scheduler.run('openai:test', async (_signal, metrics) => {
    seen.push(metrics);
    return 'second';
  });

  assert.equal(await second, 'second');
  releaseFirst();
  assert.equal(await first, 'first');
  assert.deepEqual(
    seen.map((metrics) => metrics.active),
    [1, 2]
  );
  assert.ok(seen.every((metrics) => metrics.queueWaitMs >= 0));
});

test('provider wrapper passes admission metrics to the provider send options', async () => {
  const scheduler = new ProviderAdmissionScheduler({ concurrency: 2 });
  const provider = {
    name: 'openai-oauth',
    send(_messages, _model, _tools, opts) {
      return opts._providerAdmission;
    },
  };
  wrapProviderAdmission(provider, provider.name, scheduler);

  const metrics = await provider.send([], 'gpt-test', [], {
    sessionId: 'foreground-test',
  });
  assert.equal(metrics.active, 1);
  assert.equal(metrics.queued, 0);
  assert.ok(metrics.queueWaitMs >= 0);
});

for (const source of ['request', 'external cooldown']) {
  test(`lanes created by ${source} isolate accounts and preserve owner fairness`, async (t) => {
    const scheduler = new ProviderAdmissionScheduler({
      concurrency: 1,
      now: () => 1000,
      setTimer: () => ({ unref() {} }),
      clearTimer: () => {},
    });
    t.after(() => scheduler.shutdown());
    const key = 'anthropic-oauth:first';
    if (source === 'external cooldown') {
      assert.equal(scheduler.applyExternalCooldown(key, 2000), true);
    }
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const seen = [];
    const first = scheduler.run(
      key,
      async (_signal, metrics) => {
        seen.push('first');
        entered.resolve(metrics);
        await release.promise;
        return 'first';
      },
      { ownerKey: 'a' }
    );
    if (source === 'external cooldown') {
      assert.deepEqual(seen, []);
      assert.equal(scheduler.resetCooldowns('anthropic-oauth'), 1);
    }
    const metrics = await entered.promise;
    assert.equal(metrics.active, 1);
    assert.equal(metrics.limit, 1);
    const queued = ['a', 'b'].map((ownerKey) =>
      scheduler.run(
        key,
        async () => {
          seen.push(ownerKey);
          return ownerKey;
        },
        { ownerKey }
      )
    );
    const other = await scheduler.run('anthropic-oauth:second', async (_signal, admission) => admission);
    assert.equal(other.active, 1);
    assert.equal(other.queued, 0);
    assert.deepEqual(seen, ['first']);
    release.resolve();
    assert.equal(await first, 'first');
    assert.deepEqual(await Promise.all(queued), ['a', 'b']);
    assert.deepEqual(seen, ['first', 'b', 'a']);
  });
}
