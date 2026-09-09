import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browserQueryMatchesLine,
  parseBrowserQuery,
  rankBrowserSemanticMatch,
} from './semantic-query.ts';

test('keywords match with OR and an all-keyword match outranks a partial one', () => {
  const partial = rankBrowserSemanticMatch('technical details', { role: 'button', name: 'Details' });
  const full = rankBrowserSemanticMatch('technical details', { role: 'button', name: 'Technical details' });
  const none = rankBrowserSemanticMatch('technical details', { role: 'button', name: 'Save' });
  assert.equal(partial.matched, 1);
  assert.equal(partial.terms, 2);
  assert.equal(full.matched, 2);
  assert.ok(full.score > partial.score);
  assert.equal(none, null);
  assert.equal(partial.field, 'name');
});

test('a single keyword behaves as the substring filter did, including href normalisation', () => {
  const byHref = rankBrowserSemanticMatch('download', {
    role: 'link', name: 'Release asset', href: 'https://example.test/downloads/latest?token=download',
  });
  assert.equal(byHref.field, 'href');
  const onlyInSearch = rankBrowserSemanticMatch('download', {
    role: 'link', name: 'Sign in', href: 'https://example.test/login?return_to=%2Fissues%3Fq%3Ddownload',
  });
  assert.equal(onlyInSearch, null);
  const verbatim = rankBrowserSemanticMatch('save', { role: 'button', name: 'Save' });
  const prefix = rankBrowserSemanticMatch('save', { role: 'button', name: 'Save as draft' });
  assert.ok(verbatim.score > prefix.score);
});

test('a /pattern/ query is a regular expression, case-sensitive unless flagged', () => {
  assert.ok(rankBrowserSemanticMatch('/^Sub.*form$/i', { role: 'button', name: 'submit the form' }));
  assert.equal(rankBrowserSemanticMatch('/^Sub.*form$/', { role: 'button', name: 'submit the form' }), null);
  assert.ok(rankBrowserSemanticMatch('/^Sub.*form$/', { role: 'button', name: 'Submit the form' }));
  assert.equal(rankBrowserSemanticMatch('/(/', { role: 'button', name: '(' }), null);
});

test('query parsing refuses unsupported flags and broken patterns, and filters lines', () => {
  assert.deepEqual(parseBrowserQuery('  Save   Draft '), { tokens: ['save', 'draft'] });
  assert.throws(() => parseBrowserQuery('/x/g'), /only the i flag/);
  assert.throws(() => parseBrowserQuery('/(/'), /invalid/);
  const plan = parseBrowserQuery('/^total: \\d+$/i');
  assert.ok(browserQueryMatchesLine(plan, 'TOTAL: 42'));
  assert.equal(browserQueryMatchesLine(plan, 'total: n/a'), false);
  const words = parseBrowserQuery('price stock');
  assert.ok(browserQueryMatchesLine(words, 'In Stock'));
  assert.equal(browserQueryMatchesLine(words, 'Shipping'), false);
  assert.ok(browserQueryMatchesLine(parseBrowserQuery(''), 'anything'));
});