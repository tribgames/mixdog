import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalAccessDeniedError, isLocalAccessDenied } from './local-access-denied.ts';

test('only explicit authority codes survive serialization as a definite denial', () => {
  const denial = new LocalAccessDeniedError('private diagnostic');
  assert.equal(isLocalAccessDenied(denial), true);
  assert.equal(isLocalAccessDenied(JSON.parse(JSON.stringify({ code: denial.code }))), true);
  for (const error of [null, undefined, {}, new Error(denial.message), { code: 'EACCES' }, { code: 'ETIMEDOUT' }]) {
    assert.equal(isLocalAccessDenied(error), false);
  }
});

test('a denial naming its reason by code is still a denial, and a plain error with that wording is not', () => {
  for (const code of ['SELECTED_FILE_GRANT_UNAVAILABLE', 'PROJECT_UNAVAILABLE']) {
    const denial = new LocalAccessDeniedError('reason', code);
    assert.equal(denial.code, code);
    assert.equal(isLocalAccessDenied(denial), true);
  }
  assert.equal(isLocalAccessDenied(new Error('Project is not available.')), false);
});
