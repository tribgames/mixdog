import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  consumePurchasePermit,
  createPurchasePermit,
  isFinalPurchaseTarget,
  PURCHASE_PERMIT_MS,
} from './purchase-policy.js';

test('extension purchase policy recognizes final submission without gating cart navigation', () => {
  assert.equal(isFinalPurchaseTarget({
    tag: 'button',
    role: '',
    type: 'submit',
    label: 'Place your order',
  }), true);
  assert.equal(isFinalPurchaseTarget({
    tag: 'button',
    role: '',
    type: 'submit',
    label: '주문 확정',
  }), true);
  assert.equal(isFinalPurchaseTarget({
    tag: 'button',
    role: '',
    type: 'button',
    label: 'Add to cart',
  }), false);
  assert.equal(isFinalPurchaseTarget({
    tag: 'a',
    role: 'button',
    type: '',
    label: 'Proceed to checkout',
  }), false);
});

test('extension purchase permits are one-use, target-bound, and short-lived', () => {
  const permits = new Map();
  permits.set(7, createPurchasePermit({ kind: 'pointer', x: 100, y: 80 }, 1_000));
  assert.equal(
    consumePurchasePermit(permits, 7, 'pointer', { x: 102, y: 79 }, 1_001),
    true,
  );
  assert.equal(
    consumePurchasePermit(permits, 7, 'pointer', { x: 102, y: 79 }, 1_002),
    false,
  );

  permits.set(7, createPurchasePermit({ kind: 'keyboard' }, 1_000));
  assert.equal(
    consumePurchasePermit(permits, 8, 'keyboard', {}, 1_001),
    false,
  );
  assert.equal(
    consumePurchasePermit(permits, 7, 'keyboard', {}, 1_000 + PURCHASE_PERMIT_MS + 1),
    false,
  );
});

test('extension manifest has no cookie or broad page-host permission', async () => {
  const manifest = JSON.parse(await readFile(
    new URL('./manifest.json', import.meta.url),
    'utf8',
  ));
  assert.equal(manifest.permissions.includes('cookies'), false);
  assert.equal(manifest.permissions.includes('scripting'), false);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
});
