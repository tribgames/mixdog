import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CookieSignOutScopes, signOutCookieMatcher } from './cookie-sign-out-scopes.ts';

test('a saved logout suppresses cookies that can reach the site without suppressing unrelated hosts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-cookie-signout-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const file = join(root, 'scopes.json');
  await new CookieSignOutScopes(file).add('login.example.test');

  const blocked = signOutCookieMatcher(await new CookieSignOutScopes(file).read());
  const cookies = [
    'login.example.test',
    '.sub.login.example.test',
    '.example.test',
    'example.test',
    'sibling.example.test',
    'notlogin.example.test',
    'login.example.test.invalid',
  ];
  assert.deepEqual(cookies.filter((domain) => !blocked(domain)), [
    'example.test',
    'sibling.example.test',
    'notlogin.example.test',
    'login.example.test.invalid',
  ]);
});
