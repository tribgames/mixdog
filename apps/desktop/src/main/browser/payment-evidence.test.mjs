import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserActionApproval } from './action-approval.ts';
import { PAYMENT_EVIDENCE_EXPRESSION, pageHasPaymentEvidence } from './payment-evidence.ts';

const input = (attrs = {}) => ({ name: attrs.name || '', id: attrs.id || '', getAttribute: (k) => attrs[k] ?? null });
/** Runs the page expression against a minimal document. */
function evidenceOf({ inputs = [], frames = [] }) {
  globalThis.document = {
    baseURI: 'https://shop.example/cart',
    querySelectorAll: (selector) => (selector.startsWith('iframe') ? frames.map((src) => ({ src })) : inputs),
  };
  try {
    return (0, eval)(PAYMENT_EVIDENCE_EXPRESSION);
  } finally {
    delete globalThis.document;
  }
}

test('payment evidence: card fields and payment-processor frames, never labels', () => {
  assert.equal(evidenceOf({ inputs: [input({ autocomplete: 'cc-number' })] }), true);
  assert.equal(evidenceOf({ inputs: [input({ autocomplete: 'section-pay cc-csc' })] }), true);
  assert.equal(evidenceOf({ inputs: [input({ name: 'card-number' })] }), true);
  assert.equal(evidenceOf({ inputs: [input({ id: 'CVC' })] }), true);
  assert.equal(evidenceOf({ frames: ['https://js.stripe.com/v3/elements-inner.html'] }), true);
  assert.equal(evidenceOf({ frames: ['https://www.paypal.com/smart/buttons'] }), true);
  assert.equal(evidenceOf({ frames: ['https://assets.braintreegateway.com/x'] }), true);
  assert.equal(evidenceOf({ frames: ['https://checkoutshopper-live.adyen.com/x'] }), true);
  // An ordinary form, a payment-like word in a label or an unrelated frame is no evidence.
  assert.equal(evidenceOf({ inputs: [input({ name: 'email', autocomplete: 'email' }), input({ name: 'comment' })] }), false);
  assert.equal(evidenceOf({ frames: ['https://www.youtube.com/embed/x', 'https://evil.example/js.stripe.com'] }), false);
});

test('an unreadable page counts as payment evidence (fail closed)', async () => {
  assert.equal(await pageHasPaymentEvidence(async () => true), true);
  assert.equal(await pageHasPaymentEvidence(async () => false), false);
  assert.equal(await pageHasPaymentEvidence(async () => Promise.reject(new Error('gone'))), true);
  assert.equal(await pageHasPaymentEvidence(async () => undefined), true);
});

test('the host asks with payment set only for a submit or post step on a page with evidence', async () => {
  const asked = [];
  const approval = createBrowserActionApproval({ ask: async (request) => (asked.push(request), true) });
  const target = () => ({ url: 'https://shop.example/cart', identity: 'doc1' });
  const submit = { action: 'click', submit: true, target: { name: 'Continue' }, session_id: 's', session_life: '1:0' };
  await approval.approve({ ...submit }, target, undefined, undefined, undefined, async () => true);
  await approval.approve({ ...submit }, target, undefined, undefined, undefined, async () => false);
  await approval.approve({ action: 'click', target: { name: 'Read more' }, session_id: 's' }, target, undefined, undefined, undefined, async () => assert.fail('not read for a step that is not gated'));
  assert.equal(asked.length, 2);
  assert.equal(asked[0].payment, true);
  assert.equal(asked[0].sessionLife, '1:0');
  assert.equal('payment' in asked[1], false);
});
