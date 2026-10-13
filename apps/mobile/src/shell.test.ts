import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptyHostBook,
  extractPairingLink,
  forgetHost,
  parsePairingLink,
  readHostBook,
  rememberHost,
} from './hosts.ts';

const ID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';

test('pairing links are canonical routes, never credentials', () => {
  assert.deepEqual(parsePairingLink(`https://relay.example.com/d/${ID.toUpperCase()}/?x=1#frag`), {
    url: `https://relay.example.com/d/${ID}/`,
    deviceId: ID,
  });
  assert.equal(parsePairingLink(`http://relay.example.com/d/${ID}/`), null);
  assert.ok(parsePairingLink(`http://localhost:8787/d/${ID}/`));
  assert.equal(parsePairingLink(`https://user:pw@relay.example.com/d/${ID}/`), null);
  assert.equal(parsePairingLink('https://relay.example.com/'), null);
  assert.equal(parsePairingLink('nonsense'), null);
  assert.equal(extractPairingLink(`Open this: https://r.example.com/d/${ID}/ thanks`)?.deviceId, ID);
});

test('paired hosts are remembered, ordered and forgotten', () => {
  const a = parsePairingLink(`https://a.example.com/d/${ID}/`)!;
  const b = parsePairingLink(`https://b.example.com/d/${ID}/`)!;
  let book = rememberHost(emptyHostBook(), a, 1);
  book = rememberHost(book, b, 2);
  assert.deepEqual(book.hosts.map((host) => host.url), [b.url, a.url]);
  assert.equal(book.last, b.url);
  book = rememberHost(book, a, 3);
  assert.equal(book.hosts.length, 2);
  assert.equal(book.last, a.url);
  assert.equal(readHostBook(JSON.stringify(book)).hosts.length, 2);
  assert.deepEqual(readHostBook('{bad'), emptyHostBook());
  assert.equal(forgetHost(book, a.url).last, '');
});
