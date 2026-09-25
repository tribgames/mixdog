import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPublicUrl, resolveAndValidate } from './ssrf-guard.mjs';

test('IANA special-purpose IPv4 ranges are refused as destinations', async () => {
  for (const address of ['192.0.0.8', '192.0.2.1', '192.88.99.1', '198.51.100.7', '203.0.113.9']) {
    assert.throws(() => assertPublicUrl(`http://${address}/`), /Blocked request to private address/, address);
    await assert.rejects(resolveAndValidate(address), /Blocked request to private address/, address);
  }
});

test('IPv6 forms that carry a private IPv4 or a non-public prefix are refused', async () => {
  for (const address of [
    '64:ff9b::a00:1', // NAT64 of 10.0.0.1
    '64:ff9b::127.0.0.1',
    '64:ff9b:1::1', // local-use NAT64
    '2002:c0a8:101::1', // 6to4 of 192.168.1.1
    '2002:7f00:1::1', // 6to4 of 127.0.0.1
    '::a00:1', // IPv4-compatible 10.0.0.1
    '::192.168.0.1',
    '2001:db8::1',
    '3fff::1',
    'fec0::1',
    '100::1',
  ]) {
    assert.throws(() => assertPublicUrl(`http://[${address}]/`), /Blocked request to private address/, address);
    await assert.rejects(resolveAndValidate(address), /Blocked request to private address/, address);
  }
});

test('public destinations, including ones wrapped in IPv6, stay reachable', async () => {
  for (const address of ['8.8.8.8', '192.0.3.1', '198.51.101.1', '203.0.114.1']) {
    assert.doesNotThrow(() => assertPublicUrl(`http://${address}/`), address);
  }
  for (const address of ['2606:4700::1111', '64:ff9b::808:808', '2002:808:808::1', '2001:db9::1']) {
    assert.doesNotThrow(() => assertPublicUrl(`http://[${address}]/`), address);
    assert.deepEqual(await resolveAndValidate(address), [{ address, family: 6 }], address);
  }
});
