import test from 'node:test';
import assert from 'node:assert/strict';

import { verificationUrlOf } from './ErrorNotice.tsx';

const url = 'https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini&plt=AKgnsbufABzN04&flowName=GlifWebSignIn&authuser';

test('the verification link is lifted out of login and request errors', () => {
  assert.equal(verificationUrlOf(`[antigravity-oauth] Account verification required for a@b.test.\nVerify your account to continue.\nVisit ${url} to continue, then sign in again.`), url);
  assert.equal(verificationUrlOf(Object.assign(new Error(`Antigravity requires account verification: open ${url} , complete the check, then retry`), { status: 403 })), url);
  assert.equal(verificationUrlOf('Antigravity 401 (https://cloudcode-pa.googleapis.com): Request had invalid authentication credentials. See https://developers.google.com/identity/sign-in/web/devconsole-project.'), '');
  assert.equal(verificationUrlOf(''), '');
});
