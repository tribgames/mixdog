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
});
