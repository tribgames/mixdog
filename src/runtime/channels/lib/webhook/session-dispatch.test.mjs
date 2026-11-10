import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFencedPayload, createWebhookSessionDispatcher, webhookRunPrompt } from './session-dispatch.mjs';

test('a webhook run waiting on the user is never cut off by a dispatch timeout; the caller got 202 at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const statuses = [];
  let signal = null;
  let finishRun;
  const dispatcher = createWebhookSessionDispatcher({
    getBridgeDispatch: () => (options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        finishRun = resolve;
      });
    },
    store: {
      recordEndpointEvent: async () => {},
      updateDeliveryStatus: async (_name, _id, status) => statuses.push(status),
    },
  });
  const res = {
    head: null,
    body: '',
    writeHead(code) {
      this.head = code;
    },
    end(text) {
      this.body = text;
    },
  };
  const ok = await dispatcher.dispatchEndpoint({
    name: 'hook',
    body: {},
    headers: {},
    res,
    deliveryId: 'd1',
    endpoint: { instructions: 'Go.', ownerAgentId: 'lead' },
  });
  assert.equal(ok, true);
  assert.equal(res.head, 202, 'the HTTP response returns before the run ends');
  assert.equal(JSON.parse(res.body).id, 'd1');
  t.mock.timers.tick(24 * 60 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(signal?.aborted, true, 'no timeout cancels the run');
  assert.deepEqual(statuses, ['processing'], 'the delivery is not failed while the run waits');
  finishRun({ sessionId: 'sess_home_lead', result: 'ok' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(statuses, ['processing', 'done']);
});

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
