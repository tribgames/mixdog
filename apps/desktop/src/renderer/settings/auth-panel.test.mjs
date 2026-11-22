import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from '../test-support/test-dom.mjs';
import { BROWSER_PERMISSION_KINDS } from '../../shared/browser-permission-policy.ts';
import { AuthPanel } from './auth-panel.tsx';
import { BrowserPermissionsGroup } from './browser-permissions.tsx';

const DOM = {
  rootId: 'root',
  expose: ['HTMLElement', 'HTMLInputElement', 'Node', 'KeyboardEvent', 'Event', 'CustomEvent', 'MouseEvent'],
};
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

function makeApi() {
  return {
    browserVaultLogins: async () => [
      {
        id: 'a'.repeat(24),
        origin: 'https://github.com',
        username: 'sample',
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
  assert.ok(text.includes('sample'), 'the username from the vault');
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

test('a search that matches nothing says so instead of claiming there are no logins', async (t) => {
  const dom = await mount(t, makeApi());
  const doc = dom.window.document;
  const search = doc.querySelector('.auth-search input');
  const setNativeValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setNativeValue.call(search, 'no-such-site');
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  assert.deepEqual(rowHosts(doc), []);
  assert.equal(doc.querySelector('.settings-empty').textContent, 'No results found.');
});

test('the "stay signed in only" option is hidden when its count is zero', async (t) => {
  const second = await mount(t, { ...makeApi(), browserSignedInSites: async () => [] });
  const options = second.window.document.querySelectorAll('.auth-seg button');
  assert.equal(options.length, 1, 'no cookie-only logins: the second option is hidden');
  assert.ok(options[0].textContent.endsWith('2'));
});

test('with no logins: primary Import, an import hint, no switch or search, settings kept', async (t) => {
  const api = {
    ...makeApi(),
    browserVaultLogins: async () => [],
    browserSignedInSites: async () => [],
    browserProfileImportSources: async () => [],
  };
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
  assert.equal(doc.querySelectorAll('.mixdog-settings__row').length, 3, 'the toggles remain');
});

test('a failed first settings read hides the toggles and site permissions until an announcement reads them', async (t) => {
  let read = () => Promise.reject(new Error('core not ready'));
  const listeners = new Set();
  const defaults = Object.fromEntries(BROWSER_PERMISSION_KINDS.map((kind) => [kind, 'ask']));
  const api = {
    ...makeApi(),
    readSettings: () => read(),
    setBrowserPermissions: async () => undefined,
    subscribeSettingsChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const dom = await mount(t, api);
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('.mixdog-settings__row').length, 0, 'unknown toggles are not shown off');
  assert.ok(!doc.body.textContent.includes('Site permissions'));
  read = async () => ({ saveChatLogins: false, browserPermissions: { defaults, sites: [] } });
  await act(async () => {
    for (const listener of [...listeners]) listener({ scope: 'desktop' });
  });
  await settle();
  const toggles = [...doc.querySelectorAll('input[type="checkbox"]')].map((input) => input.checked);
  assert.deepEqual(toggles, [true, false, false], 'auto sign-in on by default, chat save off as stored, HID off');
  assert.ok(doc.body.textContent.includes('Site permissions'));
});

test('a toggle write answering after a newer announcement read never restores the older settings', async (t) => {
  let stored = { browserAutoSignIn: true, saveChatLogins: true };
  const write = Promise.withResolvers();
  const listeners = new Set();
  const api = {
    ...makeApi(),
    readSettings: async () => stored,
    updateSetting: () => write.promise,
    subscribeSettingsChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const dom = await mount(t, api);
  const doc = dom.window.document;
  const toggles = () => [...doc.querySelectorAll('input[type="checkbox"]')].map((input) => input.checked);
  assert.deepEqual(toggles(), [true, true, false]);
  await act(async () => doc.querySelector('input[type="checkbox"]').click());
  assert.deepEqual(toggles(), [false, true, false], 'the choice shows at once');
  // Chat saving was turned off elsewhere; the announcement's read answers before the auto-sign-in write does.
  stored = { browserAutoSignIn: false, saveChatLogins: false };
  await act(async () => {
    for (const listener of [...listeners]) listener({ scope: 'desktop' });
  });
  await settle();
  assert.deepEqual(toggles(), [false, false, false]);
  await act(async () => write.resolve({ browserAutoSignIn: false, saveChatLogins: true }));
  await settle();
  assert.deepEqual(toggles(), [false, false, false], 'the late write answer does not turn chat saving back on');
});

test('two toggle writes that both fail leave the stored settings: chat saving never comes back on', async (t) => {
  const writes = [];
  const api = {
    ...makeApi(),
    readSettings: async () => ({ browserAutoSignIn: true, saveChatLogins: false }),
    updateSetting: () => {
      const answer = Promise.withResolvers();
      writes.push(answer);
      return answer.promise;
    },
  };
  const dom = await mount(t, api);
  const doc = dom.window.document;
  const boxes = () => [...doc.querySelectorAll('input[type="checkbox"]')];
  assert.deepEqual(
    boxes().map((input) => input.checked),
    [true, false, false]
  );
  await act(async () => boxes()[1].click());
  await act(async () => boxes()[2].click());
  assert.deepEqual(
    boxes().map((input) => input.checked),
    [true, true, true],
    'both choices show while in flight'
  );
  await act(async () => writes[0].reject(new Error('disk')));
  await settle();
  await act(async () => writes[1].reject(new Error('disk')));
  await settle();
  assert.deepEqual(
    boxes().map((input) => input.checked),
    [true, false, false]
  );
});

test('a site-permission write answering after a newer announcement read never restores the older policy', async (t) => {
  const defaults = Object.fromEntries(BROWSER_PERMISSION_KINDS.map((kind) => [kind, 'ask']));
  const camera = { origin: 'https://a.example', permission: 'media:video', setting: 'allow' };
  const microphone = { origin: 'https://b.example', permission: 'media:audio', setting: 'block' };
  let stored = { browserPermissions: { defaults, sites: [camera] } };
  const write = Promise.withResolvers();
  const listeners = new Set();
  const api = {
    readSettings: async () => stored,
    setBrowserPermissions: () => write.promise,
    subscribeSettingsChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const dom = installTestDom(t, DOM);
  await act(async () => dom.root.render(React.createElement(BrowserPermissionsGroup, { api, active: true })));
  await settle();
  const doc = dom.window.document;
  const sites = () => [...doc.querySelectorAll('.browser-permission-sites li')].map((row) => row.textContent);
  assert.equal(sites().length, 1);
  const remove = [...doc.querySelectorAll('.browser-permission-sites button')].find((b) => b.textContent === 'Remove');
  await act(async () => remove.click());
  assert.equal(sites().length, 0, 'the removal shows at once');
  // Another device added a microphone rule; the announcement's read answers before the removal does.
  stored = { browserPermissions: { defaults, sites: [microphone] } };
  await act(async () => {
    for (const listener of [...listeners]) listener({ scope: 'desktop' });
  });
  await settle();
  assert.equal(sites().length, 0, 'the pending removal (the whole policy it sends) still shows on top');
  await act(async () => write.resolve({ browserPermissions: { defaults, sites: [] } }));
  await settle();
  assert.equal(sites().length, 1, 'the late write answer does not drop the newer rule');
  assert.match(sites()[0], /b\.example/);
});

test('with logins Import is not primary, and the text button opens the clear-all confirm', async (t) => {
  const api = { ...makeApi(), browserClearSignIns: async () => undefined };
  const dom = await mount(t, api);
  const doc = dom.window.document;
  assert.ok(!doc.querySelector('.auth-tools button').classList.contains('primary'));
  assert.equal(doc.querySelectorAll('.mixdog-settings__row').length, 3);
  await act(async () => doc.querySelector('.auth-clear-all').click());
  await settle();
  assert.ok(doc.body.textContent.includes('Clear all saved logins?'), 'the existing confirm opens');
});

async function mountLinked(t) {
  const state = {
    linked: [
      {
        id: 'c'.repeat(24),
        site: 'chatgpt.com',
        redirectHost: 'auth.openai.com',
        provider: 'google.com',
        identity: 'sample.user1@gmail.com',
        lastUsedAt: 2,
      },
      {
        id: 'd'.repeat(24),
        site: 'vercel.com',
        redirectHost: 'vercel.com',
        provider: 'github.com',
        identity: '',
        lastUsedAt: 1,
      },
    ],
    deleted: [],
    cleared: 0,
  };
  const api = {
    ...makeApi(),
    browserLinkedSignIns: async () => state.linked,
    browserLinkedSignInDelete: async (id) => {
      state.deleted.push(id);
      state.linked = state.linked.filter((link) => link.id !== id);
      return true;
    },
    browserClearSignIns: async () => {
      state.cleared += 1;
      state.linked = [];
    },
  };
  const dom = await mount(t, api);
  const doc = dom.window.document;
  const filterOptions = () => doc.querySelectorAll('.auth-seg button');
  const row = (host) =>
    [...doc.querySelectorAll('.auth-row')].find((entry) => entry.querySelector('b').textContent === host);
  return { state, dom, doc, filterOptions, row };
}

test('linked sign-ins list with the cookie-only logins: provider pill, identity and source', async (t) => {
  const { doc, filterOptions, row } = await mountLinked(t);
  assert.deepEqual(rowHosts(doc), ['github.com', 'notion.so']);
  assert.ok(filterOptions()[1].textContent.endsWith('3'), filterOptions()[1].textContent);
  await act(async () => filterOptions()[1].click());
  assert.deepEqual(rowHosts(doc), ['chatgpt.com', 'naver.com', 'vercel.com']);
  const chatgpt = row('chatgpt.com');
  assert.equal(chatgpt.querySelector('.auth-pill-linked').textContent, 'Google');
  assert.equal(chatgpt.querySelector('.auth-user').textContent, 'sample.user1@gmail.com');
  assert.match(chatgpt.querySelector('.auth-source').textContent, /Linked sign-in/);
  assert.equal(row('vercel.com').querySelector('.auth-pill-linked').textContent, 'GitHub');
  assert.equal(row('vercel.com').querySelector('.auth-user'), null, 'no account named: none shown');
  assert.equal(row('naver.com').querySelector('.auth-pill-linked'), null);
});

test('search finds a linked sign-in by its identity, its site or its provider', async (t) => {
  const { dom, doc, filterOptions } = await mountLinked(t);
  await act(async () => filterOptions()[1].click());
  const search = doc.querySelector('.auth-search input');
  const setNativeValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  const type = (value) =>
    act(async () => {
      setNativeValue.call(search, value);
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  await type('SAMPLE.USER1');
  assert.deepEqual(rowHosts(doc), ['chatgpt.com']);
  await type('github');
  assert.deepEqual(rowHosts(doc), ['vercel.com']);
  await type('chatgpt');
  assert.deepEqual(rowHosts(doc), ['chatgpt.com']);
});

test('the row menu of a linked sign-in deletes that one link', async (t) => {
  const { state, doc, filterOptions, row } = await mountLinked(t);
  await act(async () => filterOptions()[1].click());
  await act(async () => row('chatgpt.com').querySelector('.auth-row-menu').click());
  await settle();
  const items = [...doc.querySelectorAll('button[data-action-id]')].map((button) => button.dataset.actionId);
  assert.deepEqual(items, ['delete']);
  await act(async () => doc.querySelector('button[data-action-id="delete"]').click());
  await settle();
  assert.deepEqual(state.deleted, ['c'.repeat(24)]);
  assert.deepEqual(rowHosts(doc), ['naver.com', 'vercel.com']);
});

test('clear all saved logins also clears linked sign-ins (the host forgets every link)', async (t) => {
  const { state, doc, filterOptions } = await mountLinked(t);
  await act(async () => filterOptions()[1].click());
  await act(async () => doc.querySelector('.auth-clear-all').click());
  await settle();
  const confirm = [...doc.querySelectorAll('footer button')].find((button) => button.textContent === 'Clear all');
  await act(async () => confirm.click());
  await settle();
  assert.equal(state.cleared, 1);
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

test('automatic cookie import: toggle, status line and forget-key act on the host and stay hidden where it is unavailable', async (t) => {
  let status = {
    enabled: false,
    profileId: '',
    keySaved: true,
    keyStorageAvailable: true,
    running: false,
    needsManualImport: false,
  };
  const configured = [];
  let forgotten = 0;
  const api = {
    ...makeApi(),
    browserProfileImportSources: async () => [
      { id: 'chrome', name: 'Google Chrome', supports: { cookies: true }, profiles: [{ id: 'Default', name: 'Me' }] },
    ],
    browserCookieAutoImportStatus: async () => status,
    browserCookieAutoImportConfigure: async (request) => {
      configured.push(request);
      status = { ...status, ...request };
      return status;
    },
    browserCookieAutoImportForgetKey: async () => {
      forgotten += 1;
      status = { ...status, keySaved: false, needsManualImport: true };
      return status;
    },
  };
  const dom = await mount(t, api);
  const doc = dom.window.document;
  const toggle = () => doc.querySelector('input[aria-label="Import cookies automatically"]');
  assert.ok(toggle(), 'the setting is offered next to the import');
  assert.equal(toggle().checked, false, 'off by default');
  await act(async () => toggle().click());
  await settle();
  assert.deepEqual(configured, [{ enabled: true, profileId: 'Default' }], 'the first listed profile is used');
  assert.equal(toggle().checked, true);
  assert.ok(doc.body.textContent.includes('Chrome key saved on this PC'), 'the saved key is shown');
  const forget = [...doc.querySelectorAll('.settings-action')].find(
    (button) => button.textContent === 'Forget saved key'
  );
  await act(async () => forget.click());
  await settle();
  assert.equal(forgotten, 1);
  assert.ok(doc.body.textContent.includes('Needs one manual import'), 'the status line asks for one manual import');
  assert.ok(![...doc.querySelectorAll('.settings-action')].some((button) => button.textContent === 'Forget saved key'));
});

test('automatic cookie import on by default shows no status line before the first import', async (t) => {
  const status = {
    enabled: true,
    profileId: '',
    keySaved: false,
    keyStorageAvailable: true,
    running: false,
    needsManualImport: false,
  };
  const api = {
    ...makeApi(),
    browserProfileImportSources: async () => [
      { id: 'chrome', name: 'Google Chrome', supports: { cookies: true }, profiles: [{ id: 'Default', name: 'Me' }] },
    ],
    browserCookieAutoImportStatus: async () => status,
    browserCookieAutoImportConfigure: async () => status,
  };
  const dom = await mount(t, api);
  const doc = dom.window.document;
  assert.equal(doc.querySelector('input[aria-label="Import cookies automatically"]').checked, true);
  assert.equal(doc.querySelector('.settings-empty[role="status"]'), null);
  assert.ok(!doc.body.textContent.includes('Needs one manual import'));
});

const COOKIE_STATUS_WITH_HISTORY = {
    enabled: true,
    profileId: 'Default',
    keySaved: false,
    keyStorageAvailable: true,
    running: false,
    lastImportAt: Date.UTC(2026, 8, 9),
    lastCount: 7,
    needsManualImport: true,
    skippedChromeRunning: false,
};

async function cookieStatusLine(t, status) {
  const dom = await mount(t, {
    ...makeApi(),
    browserProfileImportSources: async () => [
      { id: 'chrome', name: 'Google Chrome', supports: { cookies: true }, profiles: [{ id: 'Default', name: 'Me' }] },
    ],
    browserCookieAutoImportStatus: async () => status,
    browserCookieAutoImportConfigure: async () => status,
  });
  return dom.window.document.querySelector('.settings-empty[role="status"]')?.textContent ?? '';
}

test('automatic cookie import that needs one manual import says so, with the last known import', async (t) => {
  assert.match(
    await cookieStatusLine(t, COOKIE_STATUS_WITH_HISTORY),
    /^Needs one manual import.* Last imported .* · 7 cookies$/
  );
});

test('automatic cookie import skipped while Chrome ran says so, with the last known import', async (t) => {
  assert.match(
    await cookieStatusLine(t, {
      ...COOKIE_STATUS_WITH_HISTORY,
      keySaved: true,
      needsManualImport: false,
      skippedChromeRunning: true,
    }),
    /^Last import skipped: Chrome was running\..* Last imported .* · 7 cookies$/
  );
});

test('automatic cookie import reports a newer Chrome skip instead of an earlier failure', async (t) => {
  const line = await cookieStatusLine(t, {
    ...COOKIE_STATUS_WITH_HISTORY,
    keySaved: true,
    needsManualImport: false,
    lastError: 'Chrome data decryption failed.',
    skippedChromeRunning: true,
  });
  assert.match(line, /^Last import skipped: Chrome was running\./);
  assert.doesNotMatch(line, /failed/);
});

test('automatic cookie import shows the bound profile as missing instead of substituting another', async (t) => {
  const status = {
    enabled: true,
    profileId: 'Profile 1',
    keySaved: true,
    keyStorageAvailable: true,
    running: false,
    needsManualImport: false,
  };
  const api = {
    ...makeApi(),
    browserProfileImportSources: async () => [
      { id: 'chrome', name: 'Google Chrome', supports: { cookies: true }, profiles: [{ id: 'Default', name: 'Me' }] },
    ],
    browserCookieAutoImportStatus: async () => status,
    browserCookieAutoImportConfigure: async () => status,
  };
  const dom = await mount(t, api);
  const doc = dom.window.document;
  assert.ok(doc.body.textContent.includes('Profile 1 (profile not found)'), "the runs' target is named, as missing");
  assert.ok(!/\bMe\b/.test(doc.body.textContent), 'the first listed profile is not shown in its place');
});

test('automatic cookie import is not offered where the host has no such setting', async (t) => {
  const dom = await mount(t, makeApi());
  assert.equal(dom.window.document.querySelector('input[aria-label="Import cookies automatically"]'), null);
});
