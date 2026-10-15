import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFencedPayload, webhookRunPrompt } from './session-dispatch.mjs';

test('the run prompt carries the fenced payload, but only the endpoint instructions select skills', () => {
  const run = webhookRunPrompt(
    'Triage with $api-review.',
    { text: '$pptx please' },
    { 'x-note': '$pptx', 'content-type': 'application/json' }
  );
  assert.equal(run.skillSelection, 'Triage with $api-review.');
  assert.match(run.prompt, /^Triage with \$api-review\.\n\n/);
  assert.match(run.prompt, /"text": "\$pptx please"/);
  assert.match(run.prompt, /x-note: \$pptx/);
  assert.equal(webhookRunPrompt(undefined, {}, {}).skillSelection, '');
});

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
