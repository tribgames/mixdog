import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyUnknownReason } from './verify-predicate.ts';
import { verifyWindowState } from './verify-window.ts';

test('an undecided text predicate names the read that failed it', () => {
  assert.deepEqual(verifyUnknownReason({ needsElementText: true, observedElements: 0 })?.reason, 'element_text_empty');
  assert.equal(
    verifyUnknownReason({ needsElementText: true, observedElements: 101 })?.reason,
    'element_text_incomplete'
  );
  assert.equal(verifyUnknownReason({ needsElementText: true, textComplete: true, observedElements: 4 }), null);
  assert.equal(verifyUnknownReason({ needsElementText: false, observedElements: 0 }), null);
  assert.equal(
    verifyUnknownReason({ needsElementText: true, providerError: 'boom', observedElements: 0 })?.reason,
    'provider_error'
  );
});

test('verify reports why absent stayed unknown instead of only that it did', async () => {
  const host = {
    assertExecutionNotAborted() {},
    sessionIdFor: () => 's1',
    async callPowerShell() {
      return {
        ok: true,
        result: {
          exists: true,
          title: 'docs',
          text_complete: false,
          elements: Array.from({ length: 101 }, (_, index) => ({ name: `item ${index}`, value: '' })),
        },
      };
    },
  };
  const result = await verifyWindowState(host, {
    action: 'verify',
    window_id: 'hwnd:0x1',
    expect: [{ absent: 'round1.txt' }],
    timeout_ms: 0,
  });
  const payload = JSON.parse(result.text);
  assert.equal(payload.decision, 'unknown');
  assert.equal(payload.unknown_reason, 'element_text_incomplete');
  assert.match(payload.unknown_hint, /capture the window/);
  // The undecided read shows what the window did say, bounded to 12 entries.
  assert.equal(payload.observed_text_sample.length, 12);
  assert.equal(payload.observed_text_sample[0], 'item 0');
});

test('incomplete provider coverage is not misreported as pagination on an exact window', () => {
  const reason = verifyUnknownReason({ needsElementText: true, observedElements: 4, textComplete: false });
  assert.equal(reason.reason, 'element_text_incomplete');
  assert.match(reason.hint, /did not complete its element-text read/);
  assert.doesNotMatch(reason.hint, /more text|narrow the target/);
});

test('a closed exact window ends an unmet wait at once instead of spending the budget', async (t) => {
  // The poll sleep is the only timer the wait uses: any call to it means the budget was being spent.
  t.mock.method(globalThis, 'setTimeout', () => {
    throw new Error('the wait slept on its budget instead of ending at once');
  });
  let reads = 0;
  const host = {
    assertExecutionNotAborted() {},
    sessionIdFor: () => 's1',
    async callPowerShell() {
      reads += 1;
      return { ok: true, result: { exists: false, title: '', elements: [] } };
    },
  };
  const outcome = await verifyWindowState(host, {
    action: 'verify',
    window_id: 'hwnd:0x1',
    expect: [{ present: 'Saved' }],
    timeout_ms: 30_000,
  });
  const payload = JSON.parse(outcome.text);
  assert.equal(reads, 1, 'one read, not the 30 s budget');
  assert.equal(payload.decision, 'unknown');
  assert.equal(payload.target_closed, true);
  assert.match(payload.unknown_hint, /list windows/);
});

test('a closed exact window still proves window_exists:false over stable samples', async () => {
  let reads = 0;
  const host = {
    assertExecutionNotAborted() {},
    sessionIdFor: () => 's1',
    async callPowerShell() {
      reads += 1;
      return { ok: true, result: { exists: false, title: '', elements: [] } };
    },
  };
  const payload = JSON.parse(
    (
      await verifyWindowState(host, {
        action: 'verify',
        window_id: 'hwnd:0x1',
        expect: [{ window_exists: false }],
        timeout_ms: 5_000,
      })
    ).text
  );
  assert.equal(payload.decision, 'satisfied');
  assert.equal(reads, 2);
  assert.equal(payload.target_closed, undefined);
});

// Fake clock: the poll sleep and a timed-out provider call both only advance it.
function fakeClock(t) {
  let now = 1_000;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    now += ms;
    queueMicrotask(callback);
    return 0;
  });
  return { advance: (ms) => (now += ms) };
}

const timeoutError = () => new Error('computer_command_timeout: command exceeded 2000ms; the input host was restarted');

test('a slow sample is retried instead of ending the wait', async (t) => {
  const clock = fakeClock(t);
  const budgets = [];
  const host = {
    assertExecutionNotAborted() {},
    sessionIdFor: () => 's1',
    async callPowerShell(_request, timeoutMs) {
      budgets.push(timeoutMs);
      if (budgets.length === 1) {
        clock.advance(timeoutMs);
        throw timeoutError();
      }
      return { ok: true, result: { exists: true, title: 'Docs - Saved', elements: [] } };
    },
  };
  const payload = JSON.parse(
    (await verifyWindowState(host, { action: 'verify', window_id: 'hwnd:0x1', expect: [{ title_contains: 'Saved' }], timeout_ms: 30_000 }))
      .text
  );
  assert.equal(payload.decision, 'satisfied');
  assert.ok(budgets.length > 1, 'the sample after the timeout was made');
  let remaining = 30_000;
  for (const budget of budgets) {
    assert.ok(budget <= 5_000, `per-sample bound ${budget}`);
    assert.ok(budget <= remaining, `sample budget ${budget} within remaining ${remaining}`);
    remaining -= budget;
  }
});

test('when every sample times out the wait lasts until the deadline', async (t) => {
  const clock = fakeClock(t);
  const started = performance.now();
  const host = {
    assertExecutionNotAborted() {},
    sessionIdFor: () => 's1',
    async callPowerShell(_request, timeoutMs) {
      clock.advance(timeoutMs);
      throw timeoutError();
    },
  };
  const payload = JSON.parse(
    (await verifyWindowState(host, { action: 'verify', window_id: 'hwnd:0x1', expect: [{ title_contains: 'Saved' }], timeout_ms: 30_000 }))
      .text
  );
  assert.ok(performance.now() - started >= 30_000, 'waited out the full budget');
  assert.equal(payload.decision, 'unknown');
  assert.equal(payload.unknown_reason, 'provider_timeout');
  assert.match(payload.provider_error, /computer_command_timeout/);
});

test('repeated ordinary provider errors end at the deadline with a reason', async (t) => {
  const clock = fakeClock(t);
  const started = performance.now();
  let calls = 0;
  const host = {
    assertExecutionNotAborted() {},
    sessionIdFor: () => 's1',
    async callPowerShell() {
      calls += 1;
      clock.advance(100);
      return { ok: false, error: 'UIA element not available' };
    },
  };
  const payload = JSON.parse(
    (await verifyWindowState(host, { action: 'verify', window_id: 'hwnd:0x1', expect: [{ title_contains: 'Saved' }], timeout_ms: 5_000 }))
      .text
  );
  assert.ok(calls > 1, 'kept sampling');
  assert.ok(performance.now() - started >= 5_000, 'waited out the budget');
  assert.equal(payload.decision, 'unknown');
  assert.equal(payload.unknown_reason, 'provider_error');
  assert.ok(payload.unknown_hint);
  assert.equal(payload.provider_error, 'UIA element not available');
});

test('an integrity block fails on the first sample without waiting', async (t) => {
  fakeClock(t);
  let calls = 0;
  const host = {
    assertExecutionNotAborted() {},
    sessionIdFor: () => 's1',
    async callPowerShell() {
      calls += 1;
      return {
        ok: false,
        error:
          'accessibility_blocked_by_integrity: this window runs at High integrity, above this host (Medium), and Windows hides its controls from lower processes',
      };
    },
  };
  const payload = JSON.parse(
    (await verifyWindowState(host, { action: 'verify', window_id: 'hwnd:0x1', expect: [{ absent: 'Error' }], timeout_ms: 30_000 }))
      .text
  );
  assert.equal(calls, 1);
  assert.equal(payload.decision, 'unknown');
  assert.equal(payload.unknown_reason, 'accessibility_blocked_by_integrity');
  assert.match(payload.unknown_hint, /OCR|pixels/);
  assert.match(payload.unknown_hint, /title_contains\/window_exists/);
  assert.match(payload.provider_error, /High.*Medium/);
});

test('a tiny budget still gives the provider its 2 s floor', async () => {
  const budgets = [];
  const host = {
    assertExecutionNotAborted() {},
    sessionIdFor: () => 's1',
    async callPowerShell(_request, timeoutMs) {
      budgets.push(timeoutMs);
      return { ok: true, result: { exists: true, title: 'Docs', elements: [] } };
    },
  };
  await verifyWindowState(host, { action: 'verify', window_id: 'hwnd:0x1', expect: [{ title_contains: 'Docs' }], timeout_ms: 0 });
  assert.deepEqual(budgets, [2_000]);
});
