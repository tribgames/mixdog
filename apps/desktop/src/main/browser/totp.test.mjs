import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeBase32, parseTotpSecret, totpCode } from './totp.ts';

// RFC 6238 Appendix B, Table 1 (T0 = 0, X = 30 s, 8 digits).
const SEEDS = {
  SHA1: Buffer.from('12345678901234567890', 'ascii'),
  SHA256: Buffer.from('12345678901234567890123456789012', 'ascii'),
  SHA512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii'),
};
const VECTORS = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

test('RFC 6238 test vectors: SHA1, SHA256 and SHA512, 8 digits, 30 s step', () => {
  for (const [seconds, sha1, sha256, sha512] of VECTORS) {
    for (const [algorithm, expected] of [
      ['SHA1', sha1],
      ['SHA256', sha256],
      ['SHA512', sha512],
    ]) {
      const code = totpCode({ secret: SEEDS[algorithm], digits: 8, period: 30, algorithm }, seconds * 1000);
      assert.equal(code, expected, `${algorithm} at ${seconds}`);
    }
  }
});

test('6-digit codes are the same truncation modulo 10^6', () => {
  for (const [seconds, sha1] of VECTORS) {
    const code = totpCode({ secret: SEEDS.SHA1, digits: 6, period: 30, algorithm: 'SHA1' }, seconds * 1000);
    assert.equal(code, sha1.slice(2), `at ${seconds}`);
  }
});

test('base32 decodes per RFC 4648 and ignores case, spaces, hyphens and padding', () => {
  assert.equal(decodeBase32('MZXW6YTBOI======').toString('ascii'), 'foobar');
  assert.equal(decodeBase32('mzxw 6ytb-oi').toString('ascii'), 'foobar');
  assert.throws(() => decodeBase32('not base32!'));
});

test('a plain key and an otpauth address both parse; the address sets digits, period and hash', () => {
  // base32 of the RFC seed "12345678901234567890".
  const key = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const plain = parseTotpSecret(` ${key.toLowerCase()} `);
  assert.deepEqual(
    { ...plain, secret: plain.secret.toString('ascii') },
    {
      secret: '12345678901234567890',
      digits: 6,
      period: 30,
      algorithm: 'SHA1',
    }
  );
  const uri = parseTotpSecret(
    `otpauth://totp/Example:me@example.com?secret=${key}&issuer=Example&digits=8&period=60&algorithm=sha256`
  );
  assert.equal(uri.digits, 8);
  assert.equal(uri.period, 60);
  assert.equal(uri.algorithm, 'SHA256');
  assert.equal(uri.secret.toString('ascii'), '12345678901234567890');
  // The address reproduces the RFC table with its own parameters.
  assert.equal(totpCode(parseTotpSecret(`otpauth://totp/x?secret=${key}&digits=8`), 59_000), '94287082');
});

test('invalid keys are refused', () => {
  for (const bad of [
    '',
    'ABC',
    'otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=7',
    'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=MD5',
    'otpauth://totp/x',
  ]) {
    assert.throws(() => parseTotpSecret(bad), bad);
  }
});
