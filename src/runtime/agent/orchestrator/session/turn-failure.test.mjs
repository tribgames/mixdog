import assert from 'node:assert/strict';
import test from 'node:test';
import { turnFailureRecord } from './turn-failure.mjs';

const firstByteTimeout = () =>
  Object.assign(new Error('first byte timed out after 180000ms'), {
    name: 'ProviderTimeoutError',
    code: 'EPROVIDERTIMEOUT',
    timeoutPhase: 'headers',
    waitedMs: 180_000,
    attempts: 2,
    providerLabel: 'INJECTED_LABEL',
  });

test('a final first-byte failure names the provider from the turn route, not the error', () => {
  const { detail } = turnFailureRecord(firstByteTimeout(), { provider: 'antigravity-oauth', model: 'm' });
  assert.equal(
    detail,
    'Model still thinking: no output in 3m; Antigravity OAuth sent nothing yet; attempts: 2.'
  );
  assert.ok(!detail.includes('INJECTED'));
});

test('without a route provider the final failure says "the provider"', () => {
  const { detail } = turnFailureRecord(firstByteTimeout());
  assert.match(detail, /; the provider sent nothing yet; /);
});
