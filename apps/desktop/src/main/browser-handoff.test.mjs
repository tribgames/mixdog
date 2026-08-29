import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserHandoffRegistry } from './browser-handoff.ts';

test('a handoff is answered exactly once, by its own id', async () => {
  const registry = new BrowserHandoffRegistry();
  const ticket = registry.begin({
    reason: '  Solve the captcha  ',
    url: 'https://shop.example.test/checkout',
    timeoutMs: 1_000,
    now: 1_000,
  });
  assert.equal(ticket.request.id, 'h1');
  assert.equal(ticket.request.reason, 'Solve the captcha');
  assert.equal(ticket.request.expiresAt, 2_000);
  assert.equal(registry.current?.id, 'h1');

  // A different id must never answer this request.
  assert.equal(registry.resolve('h2', true), false);
  assert.equal(registry.resolve('h1', true), true);
  assert.equal(await ticket.settled, true);
  // The banner is gone, so the same answer cannot arrive twice.
  assert.equal(registry.resolve('h1', true), false);
  assert.equal(registry.current, null);
});

test('a released handoff reports no answer and frees the slot', async () => {
  const registry = new BrowserHandoffRegistry();
  const first = registry.begin({ reason: 'Finish verification', url: '', timeoutMs: 500 });
  assert.throws(
    () => registry.begin({ reason: 'Second', url: '', timeoutMs: 500 }),
    /already waiting for the user/,
  );
  assert.equal(registry.release('h9'), false);
  assert.equal(registry.release(), true);
  assert.equal(await first.settled, false);
  assert.equal(registry.release(), false);

  // The next request gets its own id, so a stale answer cannot claim it.
  const second = registry.begin({ reason: 'Retry verification', url: '', timeoutMs: 500 });
  assert.equal(second.request.id, 'h2');
  assert.equal(registry.resolve('h1', true), false);
  assert.equal(registry.resolve('h2', false), true);
  assert.equal(await second.settled, false);
});

test('handoff reasons are bounded and required', () => {
  const registry = new BrowserHandoffRegistry();
  assert.throws(() => registry.begin({ reason: '   ', url: '', timeoutMs: 100 }), /requires reason/);
  const ticket = registry.begin({ reason: 'x'.repeat(400), url: '', timeoutMs: 100 });
  assert.equal(ticket.request.reason.length, 200);
});
