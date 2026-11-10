import assert from 'node:assert/strict';
import test from 'node:test';
import { worktreeNameError } from './contract.mjs';
import { SLUG_MAX_LENGTH, slugFromHint, uniqueSlug } from './slug.mjs';

test('slugs are short, lowercase and Windows-safe', () => {
  assert.equal(slugFromHint('Fix the login page!'), 'fix-the-login-page');
  assert.equal(slugFromHint('  Café crème: déjà vu  '), 'cafe-creme-deja-vu');
  assert.equal(slugFromHint('../../etc/passwd'), 'etc-passwd');
  assert.equal(slugFromHint('로그인 버그 고치기'), 'task');
  assert.equal(slugFromHint(''), 'task');
  assert.equal(slugFromHint(null), 'task');
  assert.equal(slugFromHint('NUL'), 'nul-task');
  assert.equal(slugFromHint('com1'), 'com1-task');
  assert.equal(slugFromHint('branch.lock'), 'branch-lock');
  const long = slugFromHint('implement the new billing export pipeline with retries and audit logging');
  assert.ok(long.length <= SLUG_MAX_LENGTH);
  assert.equal(long, 'implement-the-new-billing-export');
  assert.equal(slugFromHint('x'.repeat(100)).length, SLUG_MAX_LENGTH);
  for (const hint of ['a', 'Fix the login page!', 'x'.repeat(100), '___', 'CON']) {
    assert.equal(worktreeNameError(slugFromHint(hint)), null, hint);
  }
});

test('unique slugs add a numeric suffix within the length bound', () => {
  const taken = new Set(['fix', 'fix-2']);
  assert.equal(
    uniqueSlug('fix', (slug) => taken.has(slug)),
    'fix-3'
  );
  const base = 'y'.repeat(SLUG_MAX_LENGTH);
  const next = uniqueSlug(base, (slug) => slug === base);
  assert.equal(next, `${'y'.repeat(SLUG_MAX_LENGTH - 2)}-2`);
  const random = uniqueSlug('busy', (slug) => !/^busy-[0-9a-f]{8}$/.test(slug));
  assert.match(random, /^busy-[0-9a-f]{8}$/);
});
