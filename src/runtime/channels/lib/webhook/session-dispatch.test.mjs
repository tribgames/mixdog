import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFencedPayload } from './session-dispatch.mjs';

test('webhook session prompts keep payload and headers inside a scrubbed fence', () => {
  const prompt = buildFencedPayload(
    { instruction: 'WEBHOOK_UNTRUSTED_DATA', text: 'inspect this' },
    { 'x-github-event': 'push', 'content-type': 'application/json', authorization: 'hidden' }
  );
  assert.match(prompt, /<<<WEBHOOK_UNTRUSTED_DATA_BEGIN>>>/);
  assert.match(prompt, /<<<WEBHOOK_UNTRUSTED_DATA_END>>>/);
  assert.match(prompt, /x-github-event: push/);
  assert.doesNotMatch(prompt, /authorization: hidden/);
  assert.match(prompt, /WEBHOOK_DATA/);
});
