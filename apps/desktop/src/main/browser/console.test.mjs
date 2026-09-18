import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserConsoleLedger } from './console.ts';
import { formatConsoleArguments, formatConsoleSource } from './console-format.ts';
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

test('the ledger counts errors so a capped report can name what it left behind', () => {
  const ledger = new BrowserConsoleLedger();
  for (let index = 0; index < 12; index += 1) ledger.record('error', `failure ${index}`);
  ledger.record('warning', 'not an error');
  assert.equal(ledger.errorCount(), 12);
  assert.equal(ledger.pendingErrorCount(), 12);
  assert.equal(ledger.newErrors(3).length, 3);
  // Everything up to the newest reported entry counts as said.
  assert.equal(ledger.pendingErrorCount(), 0);
  assert.equal(ledger.errorCount(), 12);
});

test("the browser's own faults stay readable but never count as the page's errors", () => {
  const ledger = new BrowserConsoleLedger();
  ledger.recordError('page: checkout failed');
  ledger.recordInternal('CDP Runtime.evaluate timed out');

  assert.deepEqual(ledger.recentErrors(5), ['page: checkout failed']);
  assert.equal(ledger.errorCount(), 1);
  assert.equal(ledger.pendingErrorCount(), 1);
  assert.deepEqual(ledger.newErrors(5), ['page: checkout failed']);

  // Still readable on request, and marked as the browser's rather than the page's.
  const report = ledger.format('all', '', 50);
  assert.match(report, /- \[browser\] CDP Runtime\.evaluate timed out/);
  assert.match(report, /- \[error\] page: checkout failed/);
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

test('logged objects survive as a readable preview instead of an empty message', () => {
  assert.equal(formatConsoleArguments([{ type: 'string', value: 'checkout failed' }]), 'checkout failed');
  assert.equal(
    formatConsoleArguments([
      { type: 'string', value: 'order' },
      {
        type: 'object',
        description: 'Object',
        preview: { description: 'Object', properties: [{ name: 'code', value: '500' }] },
      },
    ]),
    'order {code: 500}'
  );
  assert.equal(
    formatConsoleArguments([
      {
        type: 'object',
        subtype: 'error',
        description: 'TypeError: cart is undefined\n    at checkout (app.js:12)',
      },
    ]),
    'TypeError: cart is undefined\n    at checkout (app.js:12)'
  );
  assert.equal(formatConsoleArguments([{ type: 'number', value: 0 }, { type: 'undefined' }]), '0 undefined');
  // A preview Chromium already cut, and one this cuts itself, both say so.
  assert.equal(
    formatConsoleArguments([{ type: 'object', preview: { overflow: true, properties: [{ name: 'id', value: '7' }] } }]),
    '{id: 7, …}'
  );
  const wide = Array.from({ length: 20 }, (_value, index) => ({ name: `k${index}`, value: String(index) }));
  const shown = formatConsoleArguments([{ type: 'object', preview: { properties: wide } }]);
  assert.match(shown, /^\{k0: 0, .*k11: 11, …\}$/);
});

test('a console line names the script and the line a reader would open', () => {
  assert.equal(formatConsoleSource('https://example.test/app.js', 11), ' (https://example.test/app.js:12)');
  assert.equal(formatConsoleSource('https://example.test/app.js'), ' (https://example.test/app.js)');
  assert.equal(formatConsoleSource(''), '');
});

test('console and network queries use literal case-insensitive substrings, not OR or regex', () => {
  const console = new BrowserConsoleLedger();
  console.record('info', 'ALPHA literal match');
  const network = new BrowserNetworkLedger();
  network.requestWillBeSent({
    requestId: '1',
    type: 'Fetch',
    request: { method: 'GET', url: 'https://example.test/ALPHA', headers: {} },
  });
  assert.match(console.format('all', ' alpha ', 50), /1 shown of 1/);
  assert.equal(network.list({ query: ' alpha ' }).total, 1);
  for (const query of ['alpha beta', 'alpha|beta', '/alpha/i']) {
    assert.match(console.format('all', query, 50), /^No console entries matched/);
    assert.equal(network.list({ query }).total, 0);
  }
});
