import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { emptyHostBook, parsePairingLink, rememberHost } from './hosts.ts';
import { isAllowedUrl, originOf, originsOfBook, sanitizeOrigins } from './origins.ts';

const cases = JSON.parse(readFileSync(new URL('../test-vectors/origin-policy.json', import.meta.url), 'utf8'));

test('origins normalise like the native policies', () => {
  for (const { url, origin } of cases.origin) assert.equal(originOf(url), origin, url);
});

test('only the bundled screen and saved relay origins are allowed', () => {
  for (const { url, allowed } of cases.allowed) assert.equal(isAllowedUrl(url, cases.saved), allowed, url);
});

test('saved origins are sanitised to remote https / loopback origins', () => {
  assert.deepEqual(sanitizeOrigins(cases.sanitize.input), cases.sanitize.output);
});

test('the allow-list follows the host book', () => {
  const id = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
  let book = rememberHost(emptyHostBook(), parsePairingLink(`https://a.example.com/d/${id}/`)!, 1);
  book = rememberHost(book, parsePairingLink(`https://b.example.com:8443/d/${id}/`)!, 2);
  assert.deepEqual(originsOfBook(book), ['https://b.example.com:8443', 'https://a.example.com']);
});
