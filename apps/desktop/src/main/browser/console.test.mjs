import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserConsoleLedger } from './console.ts';
import { BrowserNetworkLedger } from './network.ts';
import { validateBrowserToolArgs } from '../../../../../src/runtime/browser-bridge/action-schema.mjs';

test('new console errors are reported once while recent errors stay available', () => {
  const ledger = new BrowserConsoleLedger();
  ledger.record('error', 'first');
  ledger.record('warning', 'not an error');
  ledger.record('error', 'second');
  assert.deepEqual(ledger.newErrors(3), ['first', 'second']);
  assert.deepEqual(ledger.newErrors(3), [], 'already reported');
  ledger.record('error', 'third');
  assert.deepEqual(ledger.newErrors(3), ['third']);
  assert.deepEqual(ledger.recentErrors(2), ['second', 'third']);
  for (let index = 0; index < 250; index += 1) ledger.record('error', `bulk ${index}`);
  const bulk = ledger.newErrors(2);
  assert.deepEqual(bulk, ['bulk 248', 'bulk 249'], 'the cap does not resurrect reported entries');
  assert.deepEqual(ledger.newErrors(2), []);
});

test('console searches the entire schema-valid query without prefix false positives', () => {
  const ledger = new BrowserConsoleLedger();
  const prefix = 'x'.repeat(2_000);
  ledger.record('error', `${prefix}alpha`);
  ledger.record('error', `${prefix}beta`);
  const query = `${prefix}beta`;
  assert.equal(validateBrowserToolArgs({ action: 'console', input: { query } }).ok, true);
  const result = ledger.format('all', query, 50);
  assert.match(result, /1 shown of 1/);
  assert.match(result, /beta/);
  assert.doesNotMatch(result, /alpha/);
  const maximum = 'x'.repeat(4_096);
  assert.equal(validateBrowserToolArgs({ action: 'console', input: { query: maximum } }).ok, true);
  assert.match(ledger.format('all', maximum, 50), /^No console entries matched/);
});

test('console and network queries use literal case-insensitive substrings, not OR or regex', () => {
  const console = new BrowserConsoleLedger();
  console.record('info', 'ALPHA literal match');
  const network = new BrowserNetworkLedger();
  network.requestWillBeSent({
    requestId: '1', type: 'Fetch',
    request: { method: 'GET', url: 'https://example.test/ALPHA', headers: {} },
  });
  assert.match(console.format('all', ' alpha ', 50), /1 shown of 1/);
  assert.equal(network.list({ query: ' alpha ' }).total, 1);
  for (const query of ['alpha beta', 'alpha|beta', '/alpha/i']) {
    assert.match(console.format('all', query, 50), /^No console entries matched/);
    assert.equal(network.list({ query }).total, 0);
  }
});