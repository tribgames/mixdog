import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from '../test-support/test-dom.mjs';
import { AuthPanel } from './auth-panel.tsx';

const DOM = { rootId: 'root', expose: ['HTMLElement', 'HTMLInputElement', 'Node', 'KeyboardEvent', 'Event', 'CustomEvent', 'MouseEvent'] };
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

function makeApi() {
  return {
    browserVaultLogins: async () => [
      {
        id: 'a'.repeat(24),
        origin: 'https://github.com',
        username: 'tempest',
        hasPassword: true,
        hasTotp: true,
        source: 'chrome',
        note: '',
        autoSignIn: true,
      },
      {
        id: 'b'.repeat(24),
        origin: 'https://notion.so',
        username: 'me@example.com',
        hasPassword: true,
        hasTotp: false,
        source: 'csv',
        note: '',
        autoSignIn: true,
      },
    ],
    browserSignedInSites: async () => [
      { site: 'github.com', cookies: 31 },
      { site: 'naver.com', cookies: 8 },
    ],
    readSettings: async () => ({ browserAutoSignIn: true, saveChatLogins: true }),
  };
}

test('the page renders one row per site from the vault and cookies, with no secret values', async (t) => {
  const dom = installTestDom(t, DOM);
  await act(async () => dom.root.render(React.createElement(AuthPanel, { api: makeApi() })));
  await settle();
  const main = dom.window.document.querySelector('#root');
  const text = main.textContent;
  // Vault logins and the cookie-only site all appear, one row each.
  assert.ok(text.includes('github.com'), 'github row');
  assert.ok(text.includes('tempest'), 'the username from the vault');
  assert.ok(text.includes('me@example.com'), 'the second vault login');
  assert.ok(text.includes('naver.com'), 'the cookie-only site');
  const rows = main.querySelectorAll('.auth-row');
  assert.equal(rows.length, 3, 'github (login+cookies), notion (login), naver (cookies)');
  // Pills: a password and an authenticator key on github, a cookie count, and
  // notion is signed out (password, no cookies).
  assert.ok(main.querySelector('.auth-pill-key'), 'a password pill');
  assert.ok(main.querySelector('.auth-pill-otp'), 'an authenticator-key pill');
  assert.ok(main.querySelector('.auth-pill-off'), 'a signed-out pill');
  assert.ok(text.includes('31'), 'the github cookie count');
  // Filter tab counts: 3 total, 2 with a password, 1 cookie-only.
  const filters = [...main.querySelectorAll('.auth-filters button')].map((button) => button.textContent.trim());
  assert.ok(filters[0].endsWith('3'), filters[0]);
  assert.ok(filters[1].endsWith('2'), filters[1]);
  assert.ok(filters[2].endsWith('1'), filters[2]);
  // The summaries carry no password or key, so none can render.
  assert.doesNotMatch(main.innerHTML, /otpauth|S3NT1NEL/);
});

test('editing a saved key: typing a replacement then emptying it never wipes the stored key', async (t) => {
  const saved = [];
  const api = { ...makeApi(), browserVaultSave: async (input) => void saved.push(input) };
  const dom = installTestDom(t, DOM);
  await act(async () => dom.root.render(React.createElement(AuthPanel, { api })));
  await settle();
  const doc = dom.window.document;
  // Open the github row's ⋯ menu and choose 수정.
  const githubRow = [...doc.querySelectorAll('.auth-row')].find((row) => row.textContent.includes('github.com'));
  await act(async () => githubRow.querySelector('.auth-row-menu').click());
  await settle();
  await act(async () => doc.querySelector('button[data-action-id="edit"]').click());
  await settle();
  // The dialog's inputs: site, username, password, authenticator key, note.
  const totp = [...doc.querySelectorAll('.conn-dialog .conn-input')][3];
  const setNativeValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  const typeKey = (value) =>
    act(async () => {
      setNativeValue.call(totp, value);
      totp.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  await typeKey('JBSWY3DPEHPK3PXP'); // the user types a replacement key
  await typeKey(''); // then clears the field, WITHOUT pressing 인증 키 삭제
  await act(async () => doc.querySelector('.conn-dialog .conn-btn--primary').click());
  await settle();
  assert.equal(saved.length, 1, 'the edit was saved');
  assert.equal(saved[0].id, 'a'.repeat(24));
  assert.equal(saved[0].origin, 'https://github.com');
  assert.ok(!('totpSecret' in saved[0]), 'an emptied field omits totpSecret, so the stored key survives');
});
