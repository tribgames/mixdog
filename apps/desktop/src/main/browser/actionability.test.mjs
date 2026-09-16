import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserActionabilityError, waitForBrowserActionable } from './actionability.ts';

test('read-only actionability probes wait for readiness and return the fresh result', async () => {
  let probes = 0;
  const result = await waitForBrowserActionable(async () => {
    probes++;
    if (probes < 3) throw new BrowserActionabilityError('button is disabled', 'disabled');
    return { ref: 'fresh' };
  });
  assert.deepEqual(result, { ref: 'fresh' });
  assert.equal(probes, 3);
});

test('transport failures, stale refs, and ambiguity are not blindly retried', async () => {
  for (const message of ['CDP disconnected', 'stale ref', 'target matched 2 elements']) {
    let probes = 0;
    const error = new Error(message);
    await assert.rejects(
      waitForBrowserActionable(async () => {
        probes++;
        throw error;
      }),
      (candidate) => candidate === error
    );
    assert.equal(probes, 1);
  }
});

test('an actionability deadline reports the last blocker without another probe', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const blocker = new BrowserActionabilityError('button is covered', 'covered');
  let probes = 0;
  await assert.rejects(
    waitForBrowserActionable(async () => {
      probes++;
      now = 5_001;
      throw blocker;
    }),
    (error) => error === blocker
  );
  assert.equal(probes, 1);
});

test('cancellation interrupts readiness polling and never admits a later probe', async () => {
  const controller = new AbortController();
  const reason = new Error('user took control');
  let probes = 0;
  await assert.rejects(
    waitForBrowserActionable(async () => {
      probes++;
      queueMicrotask(() => controller.abort(reason));
      throw new BrowserActionabilityError('not yet editable', 'not-editable');
    }, controller.signal),
    (error) => error === reason
  );
  assert.equal(probes, 1);
  await assert.rejects(
    waitForBrowserActionable(async () => {
      assert.fail('an already-cancelled wait must not probe');
    }, controller.signal),
    (error) => error === reason
  );
});
