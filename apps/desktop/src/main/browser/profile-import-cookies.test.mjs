import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBrowserCookieReport } from './profile-import-cookies.ts';

const failures = {
  decryption: 0,
  domainMismatch: 0,
  invalidEncoding: 0,
  invalidPartition: 0,
};

test('native cookie report accounts for source entries and categorized omissions', () => {
  const report = {
    version: 2,
    sourceCount: 5,
    expired: 0,
    cookies: [{ name: 'SID', value: 'test-only-token', domain: 'example.test' }],
    failures: { decryption: 1, domainMismatch: 1, invalidEncoding: 1, invalidPartition: 1 },
  };
  assert.equal(parseBrowserCookieReport(report), report);
  assert.equal(parseBrowserCookieReport({
    version: 2, sourceCount: 0, expired: 0, cookies: [], failures,
  }).sourceCount, 0);
  assert.equal(parseBrowserCookieReport({
    version: 2, sourceCount: 2, expired: 2, cookies: [], failures,
  }).expired, 2);
});

test('native cookie reports reject unaccounted or malformed results without echoing secrets', () => {
  const base = { version: 2, sourceCount: 0, expired: 0, cookies: [], failures };
  for (const output of [
    [],
    null,
    'private-token',
    { ...base, version: 1 },
    { ...base, sourceCount: 1 },
    { ...base, sourceCount: -1 },
    { ...base, sourceCount: 1_000_001 },
    { ...base, expired: -1 },
    { ...base, expired: 1 },
    { ...base, failures: { ...failures, decryption: 0.5 } },
    { ...base, failures: { ...failures, invalidEncoding: 'private-token' } },
    { ...base, failures: {} },
    { ...base, sourceCount: 1, cookies: [null] },
    { ...base, sourceCount: 1, cookies: [[]] },
  ]) {
    assert.throws(() => parseBrowserCookieReport(output), (error) => {
      assert.doesNotMatch(error.message, /private-token/);
      return true;
    });
  }
});
