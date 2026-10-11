import assert from 'node:assert/strict';
import test from 'node:test';
import { providerAccountsResetAt } from './provider-accounts.mjs';

const now = 1_000_000;
const account = (windows, extra = {}) => ({ usage: { windows, checkedAt: now }, ...extra });

test('scoped windows: a cleared 5H does not hide a full 7D Opus', () => {
  const row = account([
    { label: '5H', usedPct: 10, resetAt: now + 100 },
    { label: '7D Opus', usedPct: 100, resetAt: now + 900 },
  ]);
  assert.equal(providerAccountsResetAt([row], now, 'claude-opus-4'), now + 900);
});

test('a family window for another model is ignored', () => {
  const row = account([
    { label: '5H', usedPct: 100, resetAt: now + 100 },
    { label: '7D Opus', usedPct: 100, resetAt: now + 900 },
  ]);
  assert.equal(providerAccountsResetAt([row], now, 'claude-sonnet-4'), now + 100);
});

test('per account the latest blocking window, across accounts the earliest', () => {
  const a = account([
    { label: '5H', usedPct: 100, resetAt: now + 100 },
    { label: '7D', usedPct: 100, resetAt: now + 800 },
  ]);
  const b = account([{ label: '5H', usedPct: 100, resetAt: now + 500 }]);
  assert.equal(providerAccountsResetAt([a, b], now, 'm'), now + 500);
});

test('retry-after block counts; an inferred block makes the account unknown', () => {
  const server = { blockedUntil: now + 300, blockedSource: 'retry-after' };
  const inferred = { blockedUntil: now + 100 };
  assert.equal(providerAccountsResetAt([server], now, 'm'), now + 300);
  assert.equal(providerAccountsResetAt([inferred], now, 'm'), null);
  assert.equal(providerAccountsResetAt([inferred, server], now, 'm'), now + 300);
});

test('credit use ignores meter windows', () => {
  const row = account([{ label: '5H', usedPct: 100, resetAt: now + 100 }], {
    blockedUntil: now + 700,
    blockedSource: 'retry-after',
  });
  assert.equal(providerAccountsResetAt([row], now, 'm', { useCredits: true }), now + 700);
});

test('no exhausted account yields null', () => {
  assert.equal(providerAccountsResetAt([account([{ label: '5H', usedPct: 10, resetAt: now + 1 }])], now, 'm'), null);
  assert.equal(providerAccountsResetAt([], now, 'm'), null);
});
