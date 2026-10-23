import assert from 'node:assert/strict';
import test from 'node:test';
import { providerDisplayName, providerDisplayRank } from './provider-display.tsx';
import { SUBSCRIPTIONS } from './subscription-providers.ts';

test('Devin has a display name, ranks after Cursor and is a listed subscription', () => {
  assert.equal(providerDisplayName('devin-oauth'), 'Devin');
  assert.ok(providerDisplayRank('devin-oauth') > providerDisplayRank('cursor-oauth'));
  assert.ok(SUBSCRIPTIONS.some((row) => row.provider === 'devin-oauth' && row.label === 'Devin'));
});
