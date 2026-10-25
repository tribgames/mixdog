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
  assert.ok(!text.includes('naver.com'), 'the cookie-only site sits behind the second option');
  const rows = main.querySelectorAll('.auth-row');
  assert.equal(rows.length, 2, 'the default option lists github and notion (saved passwords)');
  // Pills: a password and an authenticator key on github, a cookie count, and
  // notion is signed out (password, no cookies).
  assert.ok(main.querySelector('.auth-pill-key'), 'a password pill');
  assert.ok(main.querySelector('.auth-pill-otp'), 'an authenticator-key pill');
  assert.ok(main.querySelector('.auth-pill-off'), 'a signed-out pill');
  assert.ok(text.includes('31'), 'the github cookie count');
  // Segmented switch counts: 2 with a password, 1 cookie-only.
  const filters = [...main.querySelectorAll('.auth-seg button')].map((button) => button.textContent.trim());
  assert.equal(filters.length, 2);
  assert.ok(filters[0].endsWith('2'), filters[0]);
  assert.ok(filters[1].endsWith('1'), filters[1]);
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

const mount = async (t, api) => {
  const dom = installTestDom(t, DOM);
  await act(async () => dom.root.render(React.createElement(AuthPanel, { api })));
  await settle();
  return dom;
};
const rowHosts = (doc) => [...doc.querySelectorAll('.auth-row b')].map((node) => node.textContent);

test('the segmented switch filters the list and hides "stay signed in only" at zero', async (t) => {
  const dom = await mount(t, makeApi());
  const doc = dom.window.document;
  assert.deepEqual(rowHosts(doc), ['github.com', 'notion.so']);
  const [passwordOption, cookiesOption] = doc.querySelectorAll('.auth-seg button');
  assert.equal(passwordOption.getAttribute('aria-pressed'), 'true');
  await act(async () => cookiesOption.click());
  assert.deepEqual(rowHosts(doc), ['naver.com']);
  assert.equal(doc.querySelectorAll('.auth-seg button')[1].getAttribute('aria-pressed'), 'true');
});

test('the "stay signed in only" option is hidden when its count is zero', async (t) => {
  const second = await mount(t, { ...makeApi(), browserSignedInSites: async () => [] });
  const options = second.window.document.querySelectorAll('.auth-seg button');
  assert.equal(options.length, 1, 'no cookie-only logins: the second option is hidden');
  assert.ok(options[0].textContent.endsWith('2'));
});

test('with no logins: primary Import, an import hint, no switch or search, settings kept', async (t) => {
  const api = { ...makeApi(), browserVaultLogins: async () => [], browserSignedInSites: async () => [], browserProfileImportSources: async () => [] };
  const dom = await mount(t, api);
  const doc = dom.window.document;
  const buttons = [...doc.querySelectorAll('.auth-tools button')];
  assert.equal(buttons.length, 2);
  assert.ok(buttons[0].classList.contains('primary'), 'Import is the primary button');
  assert.ok(!buttons[1].classList.contains('primary'));
  assert.equal(doc.querySelector('.auth-seg'), null);
  assert.equal(doc.querySelector('.auth-search'), null);
  assert.equal(doc.querySelector('.auth-clear-all'), null);
  assert.match(doc.querySelector('.settings-empty').textContent, /Chrome/);
  assert.equal(doc.querySelectorAll('.mixdog-settings__row').length, 2, 'both toggles remain');
});

test('with logins Import is not primary, and the text button opens the clear-all confirm', async (t) => {
  const api = { ...makeApi(), browserClearSignIns: async () => undefined };
  const dom = await mount(t, api);
  const doc = dom.window.document;
  assert.ok(!doc.querySelector('.auth-tools button').classList.contains('primary'));
  assert.equal(doc.querySelectorAll('.mixdog-settings__row').length, 2);
  await act(async () => doc.querySelector('.auth-clear-all').click());
  await settle();
  assert.ok(doc.body.textContent.includes('Clear all saved logins?'), 'the existing confirm opens');
});

test('linked sign-ins list with the cookie-only logins: provider pill, identity, search, delete and clear-all', async (t) => {
  let linked = [
    {
      id: 'c'.repeat(24),
      site: 'chatgpt.com',
      redirectHost: 'auth.openai.com',
      provider: 'google.com',
      identity: 'tempest1033@gmail.com',
      lastUsedAt: 2,
    },
    { id: 'd'.repeat(24), site: 'vercel.com', redirectHost: 'vercel.com', provider: 'github.com', identity: '', lastUsedAt: 1 },
  ];
  const deleted = [];
  let cleared = 0;
  const api = {
    ...makeApi(),
    browserLinkedSignIns: async () => linked,
    browserLinkedSignInDelete: async (id) => {
      deleted.push(id);
      linked = linked.filter((link) => link.id !== id);
      return true;
    },
    browserClearSignIns: async () => {
      cleared += 1;
      linked = [];
    },
  };
  const dom = await mount(t, api);
  const doc = dom.window.document;
  // The saved-password side is as it was; the other side counts naver.com and both links.
  assert.deepEqual(rowHosts(doc), ['github.com', 'notion.so']);
  const options = () => doc.querySelectorAll('.auth-seg button');
  assert.ok(options()[1].textContent.endsWith('3'), options()[1].textContent);
  await act(async () => options()[1].click());
  assert.deepEqual(rowHosts(doc), ['chatgpt.com', 'naver.com', 'vercel.com']);
  const row = (host) => [...doc.querySelectorAll('.auth-row')].find((entry) => entry.querySelector('b').textContent === host);
  const chatgpt = row('chatgpt.com');
  assert.equal(chatgpt.querySelector('.auth-pill-linked').textContent, 'Google');
  assert.equal(chatgpt.querySelector('.auth-user').textContent, 'tempest1033@gmail.com');
  assert.match(chatgpt.querySelector('.auth-source').textContent, /Linked sign-in/);
  assert.equal(row('vercel.com').querySelector('.auth-pill-linked').textContent, 'GitHub');
  assert.equal(row('vercel.com').querySelector('.auth-user'), null, 'no account named: none shown');
  assert.equal(row('naver.com').querySelector('.auth-pill-linked'), null);

  // Search finds a link by its identity, its site or its provider.
  const search = doc.querySelector('.auth-search input');
  const setNativeValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  const type = (value) =>
    act(async () => {
      setNativeValue.call(search, value);
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  await type('TEMPEST1033');
  assert.deepEqual(rowHosts(doc), ['chatgpt.com']);
  await type('github');
  assert.deepEqual(rowHosts(doc), ['vercel.com']);
  await type('chatgpt');
  assert.deepEqual(rowHosts(doc), ['chatgpt.com']);
  await type('');

  // The row menu deletes that one link.
  await act(async () => row('chatgpt.com').querySelector('.auth-row-menu').click());
  await settle();
  const items = [...doc.querySelectorAll('button[data-action-id]')].map((button) => button.dataset.actionId);
  assert.deepEqual(items, ['delete']);
  await act(async () => doc.querySelector('button[data-action-id="delete"]').click());
  await settle();
  assert.deepEqual(deleted, ['c'.repeat(24)]);
  assert.deepEqual(rowHosts(doc), ['naver.com', 'vercel.com']);

  // "Clear all saved logins" clears them too (the host forgets every link).
  await act(async () => doc.querySelector('.auth-clear-all').click());
  await settle();
  const confirm = [...doc.querySelectorAll('footer button')].find((button) => button.textContent === 'Clear all');
  await act(async () => confirm.click());
  await settle();
  assert.equal(cleared, 1);
  assert.deepEqual(rowHosts(doc), ['naver.com']);
});

test('reopening the page reloads the list and shows a vault error', async (t) => {
  let broken = false;
  const api = {
    ...makeApi(),
    browserVaultLogins: async () => {
      if (broken) throw new Error('vault unreadable');
      return makeApi().browserVaultLogins();
    },
  };
  const dom = installTestDom(t, DOM);
  const render = (active) => act(async () => dom.root.render(React.createElement(AuthPanel, { api, active })));
  await render(true);
  await settle();
  assert.equal(dom.window.document.querySelectorAll('.auth-row').length, 2);
  await render(false);
  broken = true;
  await render(true);
  await settle();
  assert.ok(dom.window.document.body.textContent.includes('vault unreadable'));
});

test('an older read answering after a newer one never restores its stale list over the newer error', async (t) => {
  const reads = [];
  const api = {
    ...makeApi(),
    browserVaultLogins: () =>
      new Promise((resolve, reject) => {
        reads.push({ resolve, reject });
      }),
  };
  const dom = installTestDom(t, DOM);
  const render = (active) => act(async () => dom.root.render(React.createElement(AuthPanel, { api, active })));
  await render(true);
  await render(false);
  await render(true);
  assert.equal(reads.length, 2);
  await act(async () => reads[1].reject(new Error('vault unreadable')));
  await act(async () => reads[0].resolve(await makeApi().browserVaultLogins()));
  await settle();
  const doc = dom.window.document;
  assert.ok(doc.body.textContent.includes('vault unreadable'), 'the newer error stays');
  assert.equal(doc.querySelectorAll('.auth-row').length, 0, 'the older list is dropped');
});
