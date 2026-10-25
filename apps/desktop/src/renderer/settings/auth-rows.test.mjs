import assert from 'node:assert/strict';
import test from 'node:test';

import { authCounts, filterAuthRows, mergeAuthRows } from './auth-rows.ts';

const login = (origin, username, extra = {}) => ({
  id: origin.replace(/\W/g, '').slice(0, 24).padEnd(24, '0'),
  origin,
  username,
  hasPassword: true,
  hasTotp: false,
  source: 'chrome',
  note: '',
  autoSignIn: true,
  ...extra,
});

test('rows merge a login with its site cookies, and a cookie-only site stands alone', () => {
  const logins = [
    login('https://github.com', 'tempest', { hasTotp: true, source: 'chat' }),
    login('https://notion.so', 'me@example.com', { source: 'csv' }),
  ];
  const sites = [
    { site: 'github.com', cookies: 31 },
    { site: 'naver.com', cookies: 8 },
  ];
  const rows = mergeAuthRows(logins, sites);
  const github = rows.find((row) => row.host === 'github.com');
  assert.deepEqual(
    { cookies: github.cookies, hasPassword: github.hasPassword, hasTotp: github.hasTotp, loggedOut: github.loggedOut },
    { cookies: 31, hasPassword: true, hasTotp: true, loggedOut: false }
  );
  // notion.so has a password but no cookies: signed out.
  const notion = rows.find((row) => row.host === 'notion.so');
  assert.equal(notion.loggedOut, true);
  // naver.com is cookie-only: no password row, no secrets.
  const naver = rows.find((row) => row.host === 'naver.com');
  assert.deepEqual({ hasPassword: naver.hasPassword, cookies: naver.cookies, loginId: naver.loginId }, {
    hasPassword: false,
    cookies: 8,
    loginId: undefined,
  });
});

test('counts partition the list and the filters select their rows', () => {
  const rows = mergeAuthRows(
    [login('https://a.test', 'u'), login('https://b.test', 'u')],
    [
      { site: 'a.test', cookies: 2 },
      { site: 'c.test', cookies: 4 },
    ]
  );
  assert.deepEqual(authCounts(rows), { all: 3, password: 2, cookies: 1 });
  assert.deepEqual(
    filterAuthRows(rows, 'password', '').map((row) => row.host),
    ['a.test', 'b.test']
  );
  assert.deepEqual(
    filterAuthRows(rows, 'cookies', '').map((row) => row.host),
    ['c.test']
  );
  assert.deepEqual(
    filterAuthRows(rows, 'all', 'b.te').map((row) => row.host),
    ['b.test']
  );
});

test('a row carries no secret value, only whether a password or key is stored', () => {
  const [row] = mergeAuthRows([login('https://x.test', 'owner', { hasTotp: true })], []);
  assert.ok(!('password' in row) && !('totpSecret' in row), 'no secret fields on a row');
  assert.deepEqual({ hasPassword: row.hasPassword, hasTotp: row.hasTotp }, { hasPassword: true, hasTotp: true });
  assert.equal(row.username, 'owner');
});
