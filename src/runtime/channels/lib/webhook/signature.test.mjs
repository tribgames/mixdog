import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import test from 'node:test';
import { verifySignature } from './signature.mjs';

test('stripe signature is computed over the raw body bytes, not a UTF-8 decode', () => {
  const secret = 'whsec';
  const t = String(Math.floor(Date.now() / 1000));
  const rawBody = Buffer.from([0xff, 0xfe, 0x7b, 0x7d]); // invalid UTF-8
  const v1 = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${t}.`), rawBody]))
    .digest('hex');
  assert.equal(verifySignature(secret, rawBody, `t=${t},v1=${v1}`, 'stripe'), true);
});
