import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserConsoleLedger } from './console.ts';

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