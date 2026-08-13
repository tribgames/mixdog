import assert from 'node:assert/strict';
import test from 'node:test';

import { isLocalOrigin } from './http-wire.mjs';

test('memory HTTP requests require loopback Host, Origin, and Referer values', () => {
  assert.equal(isLocalOrigin({ headers: { host: '127.0.0.1:37777' } }), true);
  assert.equal(isLocalOrigin({
    headers: { host: 'localhost:37777', origin: 'http://localhost:4100' },
  }), true);
  assert.equal(isLocalOrigin({ headers: { host: 'memory.attacker.test:37777' } }), false);
  assert.equal(isLocalOrigin({
    headers: { host: '127.0.0.1:37777', origin: 'https://attacker.test' },
  }), false);
});
