import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from '../test-support/test-dom.mjs';
import { SshHostSettingsDialog } from './ssh-host-dialogs.tsx';

const DOM = { rootId: 'root', expose: ['HTMLElement', 'Node', 'KeyboardEvent', 'Event', 'FormData'] };
const HOST = { id: 'h1', name: 'build-box', target: 'dev@build-box', lastConnectedAt: 1, open: true };
const SERVER_LOGINS = {
  connected: true,
  modelLogin: 'server',
  busySessions: 0,
  providers: [
    { id: 'anthropic-oauth', name: 'Claude', kind: 'oauth', signedIn: true, identity: 'you@example.com' },
    { id: 'openai', name: 'OpenAI', kind: 'api', signedIn: true },
    { id: 'gemini-oauth', name: 'Gemini', kind: 'oauth', signedIn: false },
  ],
};

const settle = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
const click = (element) => act(async () => element.click());
const buttonNamed = (document, name) => [...document.querySelectorAll('button')].find((b) => b.textContent === name);
const typeInto = async (input, value) => {
  const set = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set;
  await act(async () => {
    set.call(input, value);
    input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
  });
};
const submit = (form) =>
  act(async () => {
    form.dispatchEvent(new form.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  });

async function mount(t, { host = HOST, logins = SERVER_LOGINS, ...extra } = {}) {
  const dom = installTestDom(t, DOM);
  const calls = [];
  let closed = 0;
  const api = {
    readCapabilities: () => Promise.resolve([{ ok: true, value: { oauth: [], api: [] } }]),
    sshServerLogins: async (id) => {
      calls.push(['logins', id]);
      return logins;
    },
    sshUpdateHostSettings: async (id, settings) => {
      calls.push(['settings', id, settings]);
      return [];
    },
    ...extra,
  };
  await act(async () =>
    dom.root.render(
      React.createElement(SshHostSettingsDialog, {
        api,
        host,
        onSaved: () => calls.push(['saved']),
        onClose: () => {
          closed += 1;
        },
      })
    )
  );
  await settle();
  return { ...dom, api, calls, closed: () => closed };
}

const radio = (document, value) => document.querySelector(`.ssh-login-choice input[value="${value}"]`);

test("model login: this PC's accounts by default, with the provider list; nothing to confirm when it is kept", async (t) => {
  const { document, calls } = await mount(t, { logins: { ...SERVER_LOGINS, modelLogin: 'pc', providers: null } });
  assert.equal(document.querySelector('.ssh-login-choice > legend').textContent, 'Model login');
  assert.equal(radio(document, 'pc').checked, true);
  assert.ok(document.querySelector('.ssh-providers'), 'the models this server can use stay as they are');
  assert.equal(buttonNamed(document, 'Manage server logins'), undefined);
  await click(buttonNamed(document, 'Save'));
  await settle();
  assert.equal(calls.at(-2)[2].modelLogin, 'pc');
  assert.deepEqual(calls.at(-1), ['saved']);
});

test('model login: switching to server accounts asks once, naming the running sessions, then saves', async (t) => {
  const { document, calls } = await mount(t, {
    logins: { connected: true, modelLogin: 'pc', busySessions: 1, providers: null },
  });
  await click(radio(document, 'server'));
  assert.equal(document.querySelector('.ssh-providers'), null, "this PC's provider list belongs to this PC's accounts");
  assert.match(document.querySelector('.ssh-choice-sub .conn-note').textContent, /After saving/);
  assert.equal(buttonNamed(document, 'Manage server logins').disabled, true);
  await click(buttonNamed(document, 'Save'));
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.getAttribute('role'), 'alertdialog');
  assert.equal(dialog.querySelector('h3').textContent, 'Switch to server accounts?');
  assert.match(dialog.querySelector('.ssh-warn').textContent, /Running work stops\. .*1 running session/);
  assert.equal(
    calls.some((call) => call[0] === 'settings'),
    false,
    'nothing is saved before the answer'
  );
  // Cancel goes back to the settings with the choice kept.
  await click(buttonNamed(document, 'Cancel'));
  assert.equal(radio(document, 'server').checked, true);
  await click(buttonNamed(document, 'Save'));
  await click(buttonNamed(document, 'Change'));
  await settle();
  const saved = calls.filter((call) => call[0] === 'settings');
  assert.equal(saved.length, 1);
  assert.equal(saved[0][2].modelLogin, 'server');
});

test("model login: switching back to this PC's accounts asks too", async (t) => {
  const { document, calls } = await mount(t, { host: { ...HOST, settings: { modelLogin: 'server' } } });
  assert.equal(radio(document, 'server').checked, true);
  assert.equal(document.querySelector('.ssh-choice-sub .conn-note').textContent, '2 server logins · Claude, OpenAI');
  await click(radio(document, 'pc'));
  await click(buttonNamed(document, 'Save'));
  assert.equal(document.querySelector('.conn-dialog h3').textContent, 'Switch to this PC’s accounts?');
  assert.match(document.querySelector('.ssh-warn').textContent, /any running sessions stop/);
  await click(buttonNamed(document, 'Change'));
  await settle();
  assert.equal(calls.find((call) => call[0] === 'settings')[2].modelLogin, 'pc');
});

test('server logins: subscriptions open in the browser, the pasted address completes them, keys and log-outs go to the server', async (t) => {
  let logins = SERVER_LOGINS;
  const flows = [];
  const { document, calls } = await mount(t, {
    host: { ...HOST, settings: { modelLogin: 'server' } },
    sshServerLogins: () => Promise.resolve(logins),
    sshServerLoginBegin: async (id, provider) => {
      flows.push(['begin', id, provider]);
      return { flowId: 'f1', provider, state: 'pending', url: 'https://x', error: null, forwarded: true };
    },
    sshServerLoginStatus: () =>
      Promise.resolve({
        flowId: 'f1',
        provider: 'gemini-oauth',
        state: 'pending',
        url: null,
        error: null,
        forwarded: true,
      }),
    sshServerLoginComplete: (id, flowId, address) => {
      flows.push(['complete', id, flowId, address]);
      logins = {
        ...SERVER_LOGINS,
        providers: SERVER_LOGINS.providers.map((provider) => ({ ...provider, signedIn: true })),
      };
      return Promise.resolve({
        flowId,
        provider: 'gemini-oauth',
        state: 'complete',
        url: null,
        error: null,
        forwarded: false,
      });
    },
    sshServerLoginCancel: async (id, flowId) => {
      flows.push(['cancel', id, flowId]);
    },
    sshServerLoginSaveKey: async (id, provider, key) => {
      flows.push(['key', id, provider, key]);
    },
    sshServerLoginLogout: async (id, provider) => {
      flows.push(['logout', id, provider]);
    },
  });
  await click(buttonNamed(document, 'Manage server logins'));
  await settle();
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'build-box logins');
  const rows = () =>
    [...document.querySelectorAll('.ssh-login-row')].map((row) => [
      row.querySelector('b').textContent,
      row.querySelector('small').textContent,
      [...row.querySelectorAll('button')].map((button) => button.textContent),
    ]);
  assert.deepEqual(rows(), [
    ['Claude', 'Subscription · you@example.com', ['Log out']],
    ['OpenAI', 'API key', ['Change', 'Log out']],
    ['Gemini', 'Not signed in', ['Log in']],
  ]);
  // A subscription login: the steps and the paste field.
  await click(document.querySelectorAll('.ssh-login-row')[2].querySelector('button'));
  await settle();
  assert.deepEqual(flows.at(-1), ['begin', 'h1', 'gemini-oauth']);
  const steps = [...document.querySelectorAll('.ssh-login-codebox li')].map((item) => item.textContent);
  assert.deepEqual(steps, [
    'When the browser opens, sign in to Gemini.',
    'When the sign-in finishes, it is passed to the server automatically.',
    'If the browser shows “can’t connect”, paste the address from its address bar below.',
  ]);
  const address = document.querySelector('.ssh-login-codebox input');
  await typeInto(address, 'http://localhost:1455/auth/callback?code=x');
  await submit(address.form);
  await settle();
  assert.deepEqual(flows.at(-1), ['complete', 'h1', 'f1', 'http://localhost:1455/auth/callback?code=x']);
  assert.equal(document.querySelector('.ssh-login-codebox'), null, 'the steps close once the login is done');
  assert.deepEqual(
    rows().map(([name, detail]) => [name, detail]),
    [
      ['Claude', 'Subscription · you@example.com'],
      ['OpenAI', 'API key'],
      ['Gemini', 'Subscription'],
    ]
  );
  // An API key: typed here, stored on the server.
  await click(document.querySelectorAll('.ssh-login-row')[1].querySelector('button'));
  const key = document.querySelector('.ssh-login-codebox input[type="password"]');
  await typeInto(key, ' sk-new ');
  await submit(key.form);
  await settle();
  assert.deepEqual(flows.at(-1), ['key', 'h1', 'openai', 'sk-new']);
  await click(document.querySelectorAll('.ssh-login-row')[0].querySelector('button'));
  await settle();
  assert.deepEqual(flows.at(-1), ['logout', 'h1', 'anthropic-oauth']);
  // Closing goes back to the settings.
  await click(buttonNamed(document, 'Close'));
  assert.equal(document.querySelector('.conn-dialog h3').textContent, 'build-box settings');
  assert.equal(
    calls.some((call) => call[0] === 'settings'),
    false
  );
});

test('server logins: closing with a login pending cancels it on the server', async (t) => {
  const cancelled = [];
  const { document } = await mount(t, {
    host: { ...HOST, settings: { modelLogin: 'server' } },
    sshServerLoginBegin: (_id, provider) =>
      Promise.resolve({ flowId: 'f9', provider, state: 'pending', url: 'https://x', error: null, forwarded: false }),
    sshServerLoginStatus: () => new Promise(() => undefined),
    sshServerLoginCancel: async (id, flowId) => {
      cancelled.push([id, flowId]);
    },
  });
  await click(buttonNamed(document, 'Manage server logins'));
  await settle();
  await click(document.querySelectorAll('.ssh-login-row')[2].querySelector('button'));
  await settle();
  assert.match(document.querySelector('.ssh-login-codebox').textContent, /or the code it shows/);
  await click(buttonNamed(document, 'Close'));
  await settle();
  assert.deepEqual(cancelled, [['h1', 'f9']]);
});

test('server logins: a login whose start answers after the dialog closed is cancelled then', async (t) => {
  const cancelled = [];
  let answerBegin;
  const dom = await mount(t, {
    host: { ...HOST, settings: { modelLogin: 'server' } },
    sshServerLoginBegin: () =>
      new Promise((resolve) => {
        answerBegin = resolve;
      }),
    sshServerLoginStatus: () => new Promise(() => undefined),
    sshServerLoginCancel: async (id, flowId) => {
      cancelled.push([id, flowId]);
    },
  });
  const { document } = dom;
  await click(buttonNamed(document, 'Manage server logins'));
  await settle();
  await click(document.querySelectorAll('.ssh-login-row')[2].querySelector('button'));
  assert.equal(typeof answerBegin, 'function', 'the start is still on its way');
  // The whole dialog goes before the server answers.
  await act(async () => dom.root.unmount());
  assert.deepEqual(cancelled, [], 'no flow to cancel yet');
  await act(async () =>
    answerBegin({
      flowId: 'f7',
      provider: 'gemini-oauth',
      state: 'pending',
      url: 'https://x',
      error: null,
      forwarded: true,
    })
  );
  await settle();
  assert.deepEqual(cancelled, [['h1', 'f7']], 'the late login and its forward are cancelled');
});

test('server logins: a status that cannot be read ends the login and says why', async (t) => {
  const cancelled = [];
  const { document } = await mount(t, {
    host: { ...HOST, settings: { modelLogin: 'server' } },
    sshServerLoginBegin: (_id, provider) =>
      Promise.resolve({ flowId: 'f5', provider, state: 'pending', url: 'https://x', error: null, forwarded: true }),
    sshServerLoginStatus: () => Promise.reject(new Error('Connect to build-box to manage its logins.')),
    sshServerLoginCancel: async (id, flowId) => {
      cancelled.push([id, flowId]);
    },
  });
  await click(buttonNamed(document, 'Manage server logins'));
  await settle();
  await click(document.querySelectorAll('.ssh-login-row')[2].querySelector('button'));
  await settle();
  assert.ok(document.querySelector('.ssh-login-codebox'));
  // The first status poll runs after a second.
  await act(async () => new Promise((done) => setTimeout(done, 1_100)));
  await settle();
  assert.equal(document.querySelector('.ssh-login-codebox'), null, 'the steps close');
  assert.match(document.querySelector('[role="alert"]').textContent, /Connect to build-box/);
  assert.deepEqual(cancelled, [['h1', 'f5']]);
});
