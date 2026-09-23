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
  // A provider failure already explains itself.
  assert.equal(verifyUnknownReason({ needsElementText: true, providerError: 'timeout', observedElements: 0 }), null);
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
  assert.match(payload.unknown_hint, /narrow the target/);
  // The undecided read shows what the window did say, bounded to 12 entries.
  assert.equal(payload.observed_text_sample.length, 12);
  assert.equal(payload.observed_text_sample[0], 'item 0');
});

test('a closed exact window ends an unmet wait at once instead of spending the budget', async () => {
  let reads = 0;
  const host = {
    assertExecutionNotAborted() {},
    sessionIdFor: () => 's1',
    async callPowerShell() {
      reads += 1;
      return { ok: true, result: { exists: false, title: '', elements: [] } };
    },
  };
  const startedAt = Date.now();
  const payload = JSON.parse(
    (
      await verifyWindowState(host, {
        action: 'verify',
        window_id: 'hwnd:0x1',
        expect: [{ present: 'Saved' }],
        timeout_ms: 30_000,
      })
    ).text
  );
  assert.equal(reads, 1);
  assert.ok(Date.now() - startedAt < 5_000);
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
