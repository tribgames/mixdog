import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from '../test-support/test-dom.mjs';
import { updateClaimQueue } from '../remote-claim-store.ts';
import { setCachedConnectionInfo } from './connection-info.ts';
import { ConnectionPanel } from './connection-panel.tsx';
import { SshConnectDialog, sshProgressSteps } from './ssh-connect-dialog.tsx';

const DOM = { rootId: 'root', expose: ['HTMLElement', 'Node', 'KeyboardEvent', 'Event'] };
const SAVED = {
  id: 'h1',
  name: 'vps',
  target: 'root@vps.example.com',
  lastConnectedAt: Date.now() - 60_000,
  open: false,
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
const press = (window, element, key) =>
  act(async () => {
    element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

/** A host API for the connect flow; every call is recorded. */
function makeApi({ check = { status: 'trusted' }, summary, ...overrides } = {}) {
  const calls = [];
  const listeners = new Set();
  const questionListeners = new Set();
  // Main mints the attempt at inspect time; connect/cancel/stop only name it.
  const targets = new Map();
  const requests = [];
  let issued = 0;
  const api = {
    sshConfigHosts: () =>
      Promise.resolve([
        { alias: 'gpu-box', detail: 'jae@10.0.0.21' },
        { alias: 'vps-main', detail: 'root@vps.example.com' },
        { alias: 'office-build', detail: 'dev@build.corp:2202' },
      ]),
    sshInspectHostKey: (target) => {
      calls.push(['inspect', target]);
      const attemptId = `attempt-${++issued}`;
      targets.set(attemptId, target);
      return Promise.resolve({ attemptId, check, ...(summary ? { summary } : {}) });
    },
    sshConnect: (request) => {
      requests.push(request);
      const target = targets.get(request.attemptId);
      calls.push(['connect', target, request.trustHostKey === true]);
      return Promise.resolve({ ok: true, host: { ...SAVED, target, open: true } });
    },
    sshCancel: (attemptId) => {
      calls.push(['cancel', targets.get(attemptId)]);
      return Promise.resolve();
    },
    sshAskpassReply: (attemptId, requestId, secret) => {
      calls.push(['reply', attemptId, requestId, secret]);
      return Promise.resolve();
    },
    subscribeSshProgress: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeSshAskpass: (listener) => {
      questionListeners.add(listener);
      return () => questionListeners.delete(listener);
    },
    ...overrides,
  };
  const progress = (phase, detail) => {
    const attemptId = api.lastAttempt;
    for (const listener of listeners) listener({ attemptId, phase, detail });
  };
  const connect = api.sshConnect;
  api.sshConnect = (request) => {
    api.lastAttempt = request.attemptId;
    return connect(request);
  };
  const ask = (question) => {
    for (const listener of questionListeners) listener(question);
  };
  return { api, calls, progress, requests, ask };
}

async function mountDialog(t, options = {}, props = {}) {
  const dom = installTestDom(t, DOM);
  const made = makeApi(options);
  const closed = [];
  const connected = [];
  await act(async () =>
    dom.root.render(
      React.createElement(SshConnectDialog, {
        api: made.api,
        onClose: () => closed.push(true),
        onConnected: (host) => connected.push(host),
        ...props,
      })
    )
  );
  await settle();
  return { ...dom, ...made, closed, connected };
}

const dialogText = (document) => document.querySelector('.conn-dialog').textContent;
const footerButtons = (document) =>
  [...document.querySelectorAll('.conn-dialog footer button')].map((b) => b.textContent);

test('B1: the address field lists ~/.ssh/config servers under it; keys select, Enter fills, the next Enter connects', async (t) => {
  const { document, window, calls, closed, connected } = await mountDialog(t);
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'Connect SSH server');
  const input = dialog.querySelector('input.conn-input');
  assert.equal(input.placeholder, 'user@server address');
  assert.equal(buttonNamed(document, 'Connect').disabled, true);
  const items = () => [...dialog.querySelectorAll('.ssh-suggest .mx-menu-item')];
  assert.deepEqual(
    items().map((item) => item.textContent),
    ['gpu-boxjae@10.0.0.21', 'vps-mainroot@vps.example.com', 'office-builddev@build.corp:2202']
  );
  assert.equal(items()[0].dataset.active, 'true');
  await press(window, input, 'ArrowDown');
  assert.equal(items()[1].dataset.active, 'true');
  await press(window, input, 'Enter');
  assert.equal(input.value, 'vps-main');
  assert.equal(dialog.querySelector('.ssh-suggest'), null, 'the menu closes once an entry is chosen');
  assert.deepEqual(calls, [], 'choosing does not connect yet');
  await press(window, input, 'Enter');
  await settle();
  assert.deepEqual(calls, [
    ['inspect', 'vps-main'],
    ['connect', 'vps-main', false],
  ]);
  assert.equal(closed.length, 1, 'success closes the dialog');
  assert.equal(connected[0].target, 'vps-main');
});

test('B1: typing narrows the suggestions; with no ~/.ssh/config servers only the field shows; Escape closes the menu first', async (t) => {
  const { document, window, closed } = await mountDialog(t);
  const input = document.querySelector('input.conn-input');
  await typeInto(input, 'gpu');
  assert.deepEqual(
    [...document.querySelectorAll('.ssh-suggest .mx-menu-item span')].map((s) => s.textContent),
    ['gpu-box']
  );
  await press(window, document, 'Escape');
  assert.equal(document.querySelector('.ssh-suggest'), null);
  assert.equal(closed.length, 0, 'the first Escape only closes the menu');
  await press(window, document, 'Escape');
  assert.equal(closed.length, 1);
});

test('B1: without ssh config servers there is no menu', async (t) => {
  const { document } = await mountDialog(t, { sshConfigHosts: () => Promise.resolve([]) });
  assert.equal(document.querySelector('.ssh-suggest'), null);
});

test('B2/B3: a valid address shows the port hint and connects on Enter; a malformed one shows the error and stays disabled', async (t) => {
  const { document, window, calls } = await mountDialog(t, { sshConfigHosts: () => Promise.resolve([]) });
  const input = document.querySelector('input.conn-input');
  await typeInto(input, 'root@123.45.67.89');
  const message = () => document.querySelector('.conn-field-msg');
  assert.equal(message().textContent, 'If the port is not 22, enter user@server address:port.');
  assert.equal(buttonNamed(document, 'Connect').disabled, false);
  await typeInto(input, 'root@123.45.67.89:22a');
  assert.equal(message().textContent, 'The address format is not valid.');
  assert.ok(message().classList.contains('conn-field-msg--error'));
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(buttonNamed(document, 'Connect').disabled, true);
  await press(window, input, 'Enter');
  assert.deepEqual(calls, []);
  await typeInto(input, 'root@123.45.67.89');
  await press(window, input, 'Enter');
  await settle();
  assert.deepEqual(calls[0], ['inspect', 'root@123.45.67.89']);
});

test('Advanced options: an invalid key file shows inline, disables Connect and keeps the section open until fixed', async (t) => {
  const { document, window, calls } = await mountDialog(t, { sshConfigHosts: () => Promise.resolve([]) });
  await typeInto(document.querySelector('input.conn-input'), 'root@123.45.67.89');
  const details = document.querySelector('details.ssh-advanced');
  assert.equal(details.open, false, 'starts collapsed');
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new window.Event('toggle'));
  });
  const keyInput = details.querySelector('.ssh-key-row input');
  await typeInto(keyInput, '-oProxyCommand=x');
  assert.equal(details.querySelector('.conn-field-msg--error').textContent, 'The key file must not start with "-".');
  assert.equal(buttonNamed(document, 'Connect').disabled, true);
  const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => {
    details.querySelector('summary').dispatchEvent(click);
  });
  assert.equal(click.defaultPrevented, true, 'the summary does not collapse it while a field is invalid');
  assert.equal(details.open, true);
  await typeInto(keyInput, '~/.ssh/id_ed25519');
  assert.equal(buttonNamed(document, 'Connect').disabled, false);
  assert.deepEqual(calls, []);
});

test('C1: progress steps follow the phases; the install step appears only when the server installs', async (t) => {
  const pending = Promise.withResolvers();
  const { document, progress, api } = await mountDialog(t, { sshConfigHosts: () => Promise.resolve([]) });
  api.sshConnect = ((connect) => (request) => {
    api.lastAttempt = request.attemptId;
    return pending.promise.then(() => connect(request));
  })(api.sshConnect);
  await typeInto(document.querySelector('input.conn-input'), 'root@123.45.67.89');
  await click(buttonNamed(document, 'Connect'));
  await settle();
  const states = () =>
    [...document.querySelectorAll('.conn-steps li')].map((li) => `${li.dataset.n}:${li.dataset.state}`);
  assert.equal(document.querySelector('h3').textContent, 'Connecting to 123.45.67.89');
  assert.match(dialogText(document), /root@123\.45\.67\.89/);
  assert.deepEqual(states(), ['1:now', '2:wait', '3:wait', '4:wait']);
  await act(async () => progress('check', '22.19.0'));
  assert.deepEqual(states(), ['1:done', '2:now', '3:wait', '4:wait']);
  assert.match(document.querySelectorAll('.conn-steps li')[1].textContent, /Node\.js 22\.19\.0/);
  await act(async () => progress('install'));
  assert.deepEqual(states(), ['1:done', '2:done', '3:now', '4:wait']);
  assert.equal(document.querySelector('.conn-field-msg--busy').textContent, 'The first time takes about a minute.');
  assert.ok(document.querySelector('.conn-spinner'));
  await act(async () => progress('start'));
  assert.deepEqual(states(), ['1:done', '2:done', '3:done', '4:now']);
  assert.deepEqual(footerButtons(document), ['Edit address', 'Cancel', 'Connecting…']);
  assert.equal(buttonNamed(document, 'Connecting…').disabled, true);
  await act(async () => pending.resolve());
});

test('C1: later connections skip the install step', () => {
  assert.deepEqual(
    sshProgressSteps('start', false).map((step) => step.key),
    ['connect', 'check', 'link']
  );
  assert.deepEqual(
    sshProgressSteps('install', true).map((step) => step.state),
    ['done', 'done', 'now', 'wait']
  );
  assert.deepEqual(
    sshProgressSteps('ready', true).map((step) => step.state),
    ['done', 'done', 'done', 'done']
  );
});

test('C2: an unknown server asks for confirmation first and connects only after Connect, which saves that key', async (t) => {
  const { document, calls, closed, requests } = await mountDialog(t, {
    sshConfigHosts: () => Promise.resolve([]),
    check: { status: 'unknown', fingerprint: 'SHA256:q3vXb7mPk2', keyType: 'ED25519' },
  });
  await typeInto(document.querySelector('input.conn-input'), 'root@123.45.67.89');
  await click(buttonNamed(document, 'Connect'));
  await settle();
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.getAttribute('role'), 'alertdialog');
  assert.equal(dialog.querySelector('h3').textContent, 'First time connecting to this server');
  assert.equal(dialog.querySelector('code').textContent, 'SHA256:q3vXb7mPk2');
  assert.deepEqual(
    [...dialog.querySelectorAll('dt')].map((dt) => dt.textContent),
    ['Fingerprint', 'Key type']
  );
  assert.match(dialog.querySelector('dl').textContent, /ED25519/);
  assert.deepEqual(footerButtons(document), ['Cancel', 'Connect']);
  assert.equal(
    calls.some((call) => call[0] === 'connect'),
    false,
    'nothing connects before the user confirms'
  );
  await click(buttonNamed(document, 'Connect'));
  await settle();
  assert.deepEqual(calls.at(-1), ['connect', 'root@123.45.67.89', true]);
  assert.equal(closed.length, 1);
  // The confirmation rides on the attempt main opened: no second pre-check and
  // no address in the request, so the key shown is the key that gets saved.
  assert.deepEqual(calls.filter((call) => call[0] === 'inspect').length, 1);
  assert.deepEqual(requests, [{ attemptId: 'attempt-1', trustHostKey: true }]);
});

test('C2: Cancel on the host-key question connects nothing, releases the attempt and closes', async (t) => {
  const { document, calls, closed } = await mountDialog(t, {
    sshConfigHosts: () => Promise.resolve([]),
    check: { status: 'unknown', fingerprint: 'SHA256:x', keyType: 'ED25519' },
  });
  await typeInto(document.querySelector('input.conn-input'), 'gpu-box');
  await click(buttonNamed(document, 'Connect'));
  await settle();
  await click(buttonNamed(document, 'Cancel'));
  assert.equal(
    calls.some((call) => call[0] === 'connect'),
    false
  );
  assert.deepEqual(
    calls.filter((call) => call[0] === 'cancel'),
    [['cancel', 'gpu-box']],
    'the inspected key is dropped in main'
  );
  assert.equal(closed.length, 1);
});

test('closing while the key is still being read releases the attempt that comes back late', async (t) => {
  const pending = Promise.withResolvers();
  const { document, calls, closed } = await mountDialog(t, {
    sshConfigHosts: () => Promise.resolve([]),
    sshInspectHostKey: (target) => {
      calls.push(['inspect', target]);
      return pending.promise;
    },
  });
  await typeInto(document.querySelector('input.conn-input'), 'gpu-box');
  await click(buttonNamed(document, 'Connect'));
  await click(buttonNamed(document, 'Cancel'));
  assert.equal(closed.length, 1);
  await act(async () =>
    pending.resolve({ attemptId: 'late', check: { status: 'unknown', fingerprint: 'SHA256:x', keyType: 'ED25519' } })
  );
  await settle();
  assert.equal(
    calls.some((call) => call[0] === 'connect'),
    false
  );
  assert.ok(
    calls.some((call) => call[0] === 'cancel'),
    'the late attempt is cancelled, not left in main'
  );
});

test('C5: a changed key is a block with both fingerprints and the ssh-keygen -R command', async (t) => {
  const { document, calls } = await mountDialog(t, {
    sshConfigHosts: () => Promise.resolve([]),
    check: {
      status: 'changed',
      previous: 'SHA256:old',
      current: 'SHA256:new',
      keyType: 'ED25519',
      host: '123.45.67.89',
      removeCommand: 'ssh-keygen -R "123.45.67.89"',
      replaceable: true,
    },
  });
  await typeInto(document.querySelector('input.conn-input'), 'root@123.45.67.89');
  await click(buttonNamed(document, 'Connect'));
  await settle();
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'The server’s fingerprint has changed');
  assert.deepEqual(
    [...dialog.querySelectorAll('dt')].map((dt) => dt.textContent),
    ['Earlier', 'Current']
  );
  assert.deepEqual(
    [...dialog.querySelectorAll('dd code')].map((c) => c.textContent),
    ['SHA256:old', 'SHA256:new']
  );
  assert.deepEqual(footerButtons(document), ['Close']);
  assert.match(dialog.textContent, /ssh-keygen -R "123\.45\.67\.89"/);
  assert.equal(
    calls.some((call) => call[0] === 'connect'),
    false
  );
});

test('C3: a missing login key shows the two commands with copy buttons; Try again retries once the key is there', async (t) => {
  let attempts = 0;
  const failure = {
    kind: 'auth',
    keygen: 'ssh-keygen -t ed25519',
    register: 'ssh-copy-id root@123.45.67.89',
  };
  const { document, calls, closed, api } = await mountDialog(t, {
    sshConfigHosts: () => Promise.resolve([]),
  });
  const connect = api.sshConnect;
  api.sshConnect = (request) => {
    attempts += 1;
    if (attempts === 1) return Promise.resolve({ ok: false, failure });
    return connect(request);
  };
  await typeInto(document.querySelector('input.conn-input'), 'root@123.45.67.89');
  await click(buttonNamed(document, 'Connect'));
  await settle();
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'Can’t sign in');
  assert.deepEqual(
    [...dialog.querySelectorAll('.conn-address code')].map((c) => c.textContent),
    [failure.keygen, failure.register]
  );
  assert.equal(dialog.querySelectorAll('.conn-address button').length, 2);
  assert.deepEqual(
    [...dialog.querySelectorAll('.conn-steps li')].map((li) => li.dataset.n),
    ['1', '2']
  );
  assert.deepEqual(footerButtons(document), ['Edit address', 'Close', 'Try again']);
  assert.equal(attempts, 1, 'no automatic retry');
  await settle();
  assert.equal(attempts, 1);
  await click(buttonNamed(document, 'Try again'));
  await settle();
  assert.equal(attempts, 2);
  assert.equal(closed.length, 1);
  assert.deepEqual(calls.filter((call) => call[0] === 'inspect').length, 2, 'retry checks the host key again');
});

const GUIDANCE = [
  {
    failure: {
      kind: 'node',
      reason: 'too-old',
      found: '18.19.1',
      required: 22,
      command: 'curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22',
    },
    title: 'The server needs Node.js 22',
    text: /The version found on 123\.45\.67\.89 is v18\.19\.1\./,
    command: 'curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22',
  },
  {
    failure: { kind: 'node', reason: 'missing', found: null, required: 22, command: 'install-node' },
    title: 'The server needs Node.js 22',
    text: /Node\.js was not found on 123\.45\.67\.89\./,
    command: 'install-node',
  },
  {
    failure: { kind: 'npm-missing', command: 'install-node' },
    title: 'The server needs npm',
    text: /npm was not found on 123\.45\.67\.89\./,
    command: 'install-node',
  },
];
for (const { failure, title, text, command } of GUIDANCE) {
  test(`C4: ${failure.kind} ${failure.reason ?? ''} guidance carries its own command`, async (t) => {
    const { document } = await mountDialog(t, {
      sshConfigHosts: () => Promise.resolve([]),
      sshConnect: () => Promise.resolve({ ok: false, failure }),
    });
    await typeInto(document.querySelector('input.conn-input'), 'root@123.45.67.89');
    await click(buttonNamed(document, 'Connect'));
    await settle();
    assert.equal(document.querySelector('h3').textContent, title);
    assert.match(document.querySelector('.conn-dialog header p').textContent, text);
    assert.equal(document.querySelector('.conn-address code').textContent, command);
    assert.deepEqual(footerButtons(document), ['Edit address', 'Close', 'Try again']);
  });
}

test('an unclassified failure shows the ssh message and can be retried', async (t) => {
  const { document } = await mountDialog(t, {
    sshConfigHosts: () => Promise.resolve([]),
    sshConnect: () =>
      Promise.resolve({
        ok: false,
        failure: { kind: 'failed', message: 'ssh: connect to host 1.2.3.4 port 22: Connection timed out' },
      }),
  });
  await typeInto(document.querySelector('input.conn-input'), 'root@1.2.3.4');
  await click(buttonNamed(document, 'Connect'));
  await settle();
  assert.equal(document.querySelector('h3').textContent, 'Couldn’t connect');
  assert.match(dialogText(document), /Connection timed out/);
  assert.deepEqual(footerButtons(document), ['Edit address', 'Close', 'Try again']);
});

test('C6: another Mixdog asks before it is stopped; confirming connects again with a forced restart, Cancel goes back to the address', async (t) => {
  let attempts = 0;
  const running = { ok: false, failure: { kind: 'daemon-running', pid: 1667 } };
  const { document, calls, closed, api, requests } = await mountDialog(t, {
    sshConfigHosts: () => Promise.resolve([]),
  });
  const connect = api.sshConnect;
  api.sshConnect = (request) => {
    attempts += 1;
    return attempts <= 2 ? Promise.resolve(running) : connect(request);
  };
  await typeInto(document.querySelector('input.conn-input'), 'root@123.45.67.89');
  await click(buttonNamed(document, 'Connect'));
  await settle();
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.getAttribute('role'), 'alertdialog');
  assert.equal(dialog.querySelector('h3').textContent, 'Stop Mixdog on the server?');
  assert.match(dialog.querySelector('header p').textContent, /\(pid 1667\)/);
  assert.deepEqual(footerButtons(document), ['Cancel', 'Stop and connect']);
  await click(buttonNamed(document, 'Cancel'));
  assert.equal(attempts, 1, 'Cancel connects nothing');
  assert.equal(document.querySelector('input.conn-input').value, 'root@123.45.67.89');
  await click(buttonNamed(document, 'Connect'));
  await settle();
  assert.equal(document.querySelector('h3').textContent, 'Stop Mixdog on the server?');
  await click(buttonNamed(document, 'Stop and connect'));
  await settle();
  assert.deepEqual(
    requests.at(-1),
    { attemptId: 'attempt-2', trustHostKey: false, forceRestart: true },
    'the attempt that found the daemon connects again'
  );
  assert.deepEqual(
    calls.filter((call) => call[0] === 'cancel'),
    [['cancel', 'root@123.45.67.89']],
    'dismissing the prompt releases the attempt; confirming does not cancel the attempt it names'
  );
  assert.equal(attempts, 3);
  assert.equal(closed.length, 1);
});

test('Edit address cancels the running attempt and returns to the field; Cancel closes', async (t) => {
  const never = new Promise(() => undefined);
  const { document, calls, closed } = await mountDialog(t, {
    sshConfigHosts: () => Promise.resolve([]),
    sshConnect: () => never,
  });
  await typeInto(document.querySelector('input.conn-input'), 'root@123.45.67.89');
  await click(buttonNamed(document, 'Connect'));
  await settle();
  await click(buttonNamed(document, 'Edit address'));
  assert.ok(calls.some((call) => call[0] === 'cancel'));
  assert.equal(document.querySelector('input.conn-input').value, 'root@123.45.67.89');
  await click(buttonNamed(document, 'Connect'));
  await settle();
  await click(buttonNamed(document, 'Cancel'));
  assert.equal(calls.filter((call) => call[0] === 'cancel').length, 2);
  assert.equal(closed.length, 1);
});

test('a saved server skips the address and connects straight away', async (t) => {
  const { calls, closed } = await mountDialog(
    t,
    {},
    { host: { id: 'h1', name: 'My VPS', target: 'root@vps.example.com' } }
  );
  assert.deepEqual(calls, [
    ['inspect', 'root@vps.example.com'],
    ['connect', 'root@vps.example.com', false],
  ]);
  assert.equal(closed.length, 1);
});

test('Settings → Connection: SSH servers group, toolbar button, and the per-row actions', async (t) => {
  const dom = installTestDom(t, DOM);
  const state = { hosts: [{ ...SAVED, open: true }] };
  const calls = [];
  const info = {
    relayBrowserUrl: '',
    relayBrowserQrSvg: '',
    relayAppQrSvg: '',
    relayConnectUrl: '',
    clients: [],
    enabled: true,
  };
  const api = {
    getRemoteAccessInfo: () => Promise.resolve(info),
    sshConnect: () => Promise.resolve({ ok: true, host: SAVED }),
    sshListHosts: () => Promise.resolve(state.hosts),
    sshOpenHost: (id) => {
      calls.push(['open', id]);
      return Promise.resolve({ ok: true, host: SAVED });
    },
    sshRenameHost: (id, name) => {
      calls.push(['rename', id, name]);
      state.hosts = state.hosts.map((host) => (host.id === id ? { ...host, name } : host));
      return Promise.resolve(state.hosts);
    },
    sshForgetHost: (id) => {
      calls.push(['forget', id]);
      state.hosts = state.hosts.filter((host) => host.id !== id);
      return Promise.resolve(state.hosts);
    },
    sshConfigHosts: () => Promise.resolve([]),
    subscribeSshProgress: () => () => undefined,
  };
  setCachedConnectionInfo(api, info);
  t.after(() => updateClaimQueue(() => []));
  await act(async () => dom.root.render(React.createElement(ConnectionPanel, { api })));
  await settle();
  const { document } = dom;
  assert.ok(buttonNamed(document, 'Connect SSH server'), 'toolbar button');
  const group = [...document.querySelectorAll('.conn-group')].find((g) =>
    g.querySelector('h4')?.textContent.startsWith('SSH servers')
  );
  assert.equal(group.querySelector('h4 span').textContent, '1');
  const row = () => group.querySelector('.conn-row');
  assert.equal(row().querySelector('b').textContent, 'vps');
  assert.equal(row().querySelector('.conn-status').textContent, 'Online');
  assert.match(row().querySelector('.conn-row-meta').textContent, /^root@vps\.example\.com · Last connected /);
  const rowButton = (name) => [...row().querySelectorAll('button')].find((b) => b.textContent === name);
  assert.deepEqual(
    [...row().querySelectorAll('button')].map((b) => b.textContent),
    ['Open', 'Rename', 'Settings', 'Forget']
  );

  await click(rowButton('Open'));
  await settle();
  assert.deepEqual(calls, [['open', 'h1']], 'an open window is focused directly');

  await click(rowButton('Rename'));
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('input').value, 'vps');
  await typeInto(dialog.querySelector('input'), 'My VPS');
  await click(buttonNamed(document, 'Save'));
  await settle();
  assert.deepEqual(calls.at(-1), ['rename', 'h1', 'My VPS']);
  assert.equal(row().querySelector('b').textContent, 'My VPS');

  await click(rowButton('Forget'));
  const confirm = document.querySelector('.conn-dialog');
  assert.match(confirm.querySelector('header p').textContent, /Only the saved entry for My VPS is removed\./);
  await click(confirm.querySelector('.conn-btn--danger'));
  await settle();
  assert.deepEqual(calls.at(-1), ['forget', 'h1']);
  assert.equal(
    [...document.querySelectorAll('.conn-group')].some((g) =>
      g.querySelector('h4')?.textContent.startsWith('SSH servers')
    ),
    false
  );
});

test('a closed saved server opens the connect dialog on that server instead of connecting silently', async (t) => {
  const dom = installTestDom(t, DOM);
  const calls = [];
  const info = {
    relayBrowserUrl: '',
    relayBrowserQrSvg: '',
    relayAppQrSvg: '',
    relayConnectUrl: '',
    clients: [],
    enabled: true,
  };
  const made = makeApi({
    sshListHosts: () => Promise.resolve([SAVED]),
    getRemoteAccessInfo: () => Promise.resolve(info),
  });
  made.api.sshOpenHost = () => {
    calls.push('open');
    return Promise.resolve({ ok: true, host: SAVED });
  };
  setCachedConnectionInfo(made.api, info);
  t.after(() => updateClaimQueue(() => []));
  await act(async () => dom.root.render(React.createElement(ConnectionPanel, { api: made.api })));
  await settle();
  await click(buttonNamed(dom.document, 'Open'));
  await settle();
  assert.deepEqual(calls, [], 'a window that is not open goes through the dialog');
  assert.deepEqual(made.calls[0], ['inspect', 'root@vps.example.com']);
});

test('SSH connect styles: step states and the suggestion menu are defined; the menu reuses mx-menu', () => {
  const css = readFileSync(new URL('./settings.css', import.meta.url), 'utf8');
  for (const selector of [
    '.conn-steps li[data-state="done"]::before',
    '.conn-steps li[data-state="now"]::before',
    '.ssh-suggest',
  ]) {
    assert.ok(css.includes(selector), selector);
  }
});

const CHANGED = {
  status: 'changed',
  previous: 'SHA256:old',
  current: 'SHA256:new',
  keyType: 'ED25519',
  host: 'Vps.Example.com',
  removeCommand: 'ssh-keygen -R "vps.example.com"',
  replaceable: true,
};
const startConnect = async (document, address = 'root@vps.example.com') => {
  await typeInto(document.querySelector('input.conn-input'), address);
  await click(buttonNamed(document, 'Connect'));
  await settle();
};
const NO_CONFIG = { sshConfigHosts: () => Promise.resolve([]) };

test('ssh asks for a passphrase: the question replaces the progress, the answer goes back under the attempt, Cancel answers nothing', async (t) => {
  const never = new Promise(() => undefined);
  const { document, calls, ask } = await mountDialog(t, { ...NO_CONFIG, sshConnect: () => never });
  await startConnect(document);
  assert.match(document.querySelector('h3').textContent, /^Connecting to /);
  const question = {
    attemptId: 'attempt-1',
    requestId: 'r1',
    kind: 'passphrase',
    prompt: "Enter passphrase for key '/home/u/.ssh/id_ed25519': ",
    retry: false,
    timeoutMs: 120000,
  };
  await act(async () => ask({ ...question, attemptId: 'someone-else', requestId: 'x' }));
  assert.match(document.querySelector('h3').textContent, /^Connecting to /, 'another attempt’s question is not shown');
  await act(async () => ask(question));
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'Key passphrase');
  assert.match(dialog.textContent, /Enter passphrase for key '\/home\/u\/\.ssh\/id_ed25519':/);
  const input = dialog.querySelector('input');
  assert.equal(input.type, 'password');
  await typeInto(input, 'hunter2');
  await click(buttonNamed(document, 'Continue'));
  assert.deepEqual(calls.at(-1), ['reply', 'attempt-1', 'r1', 'hunter2']);
  assert.match(document.querySelector('h3').textContent, /^Connecting to /);
  await act(async () => ask({ ...question, requestId: 'r2', retry: true }));
  assert.match(document.querySelector('.conn-dialog').textContent, /did not accept it/);
  await click(buttonNamed(document, 'Cancel'));
  assert.deepEqual(calls.at(-1), ['reply', 'attempt-1', 'r2', null]);
  await act(async () => ask({ ...question, requestId: 'r3', kind: 'otp', prompt: 'Verification code: ' }));
  assert.equal(document.querySelector('h3').textContent, 'Verification code');
  assert.equal(document.querySelector('.conn-dialog input').type, 'text');
  await act(async () => ask({ ...question, requestId: 'r3', kind: 'close' }));
  assert.match(
    document.querySelector('h3').textContent,
    /^Connecting to /,
    'the timeout in main withdraws the question'
  );
});

test('C5: replacing a changed key needs the server name typed in full, and connects the same attempt with it', async (t) => {
  const { document, requests, calls } = await mountDialog(t, { ...NO_CONFIG, check: CHANGED });
  await startConnect(document);
  const dialog = document.querySelector('.conn-dialog');
  assert.match(dialog.textContent, /ssh-keygen -R "vps\.example\.com"/);
  assert.equal(dialog.querySelector('input'), null, 'no way to type until the advanced step is opened');
  await click(buttonNamed(document, 'Advanced · Replace the key'));
  const replace = () => buttonNamed(document, 'Replace key');
  assert.equal(replace().disabled, true);
  await typeInto(document.querySelector('.conn-dialog input'), 'vps');
  assert.equal(replace().disabled, true);
  await typeInto(document.querySelector('.conn-dialog input'), ' vps.example.com ');
  assert.equal(replace().disabled, false, 'the name is compared without regard to case');
  await click(replace());
  await settle();
  assert.deepEqual(requests.at(-1), { attemptId: 'attempt-1', trustHostKey: false, replaceHostKey: 'vps.example.com' });
  assert.ok(calls.some((call) => call[0] === 'connect'));
});

test('C2: behind a jump host every hop’s fingerprint is listed with the server’s, and the ssh -G summary is shown', async (t) => {
  const { document } = await mountDialog(t, {
    ...NO_CONFIG,
    summary: { hostName: '10.1.0.5', user: 'ops', port: 22, proxyJump: 'bastion.example.com', proxyCommand: false },
    check: {
      status: 'unknown',
      fingerprint: 'SHA256:target',
      keyType: 'ED25519',
      hops: [
        {
          name: 'bastion.example.com',
          role: 'jump',
          status: 'unknown',
          fingerprint: 'SHA256:bastion',
          keyType: 'ED25519',
        },
        { name: 'inner', role: 'target', status: 'trusted' },
      ],
    },
  });
  await startConnect(document, 'inner');
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'First time connecting to this server');
  const rows = [...dialog.querySelectorAll('.ssh-hops li')].map((li) => li.textContent);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /Jump host bastion\.example\.com.*SHA256:bastion · ED25519/);
  assert.match(rows[1], /Server inner.*Already trusted/);
  assert.deepEqual(
    [...dialog.querySelectorAll('dl dt')].map((dt) => dt.textContent),
    ['Server', 'User', 'Port', 'Via']
  );
  assert.match(dialog.textContent, /10\.1\.0\.5.*ops.*22.*bastion\.example\.com/);
});

const FAILURES = [
  [
    'an unreadable key store: ssh missing on Windows',
    { kind: 'ssh-missing', command: 'Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0' },
    'OpenSSH is not installed',
    /Add-WindowsCapability/,
  ],
  ['ssh missing elsewhere', { kind: 'ssh-missing', command: null }, 'OpenSSH is not installed', /package manager/],
  ['a revoked host key', { kind: 'host-key-revoked' }, 'This server’s key is revoked', /known_hosts/],
  [
    'an unsupported platform',
    { kind: 'unsupported-platform', message: 'FreeBSD is not supported' },
    'This server can’t run Mixdog',
    /FreeBSD/,
  ],
  [
    'a failed install',
    { kind: 'install-failed', message: 'npm exited with 1' },
    'The installation failed',
    /npm exited with 1/,
  ],
  [
    'a failed dependency install',
    { kind: 'deps-install', message: 'npm ERR! network' },
    'The server couldn’t install what Mixdog needs',
    /npm ERR! network/,
  ],
  [
    'a daemon that would not stop',
    { kind: 'daemon-stop', message: 'pid 9 survived' },
    'The old Mixdog could not be stopped',
    /pid 9 survived/,
  ],
  [
    'a daemon that could not be replaced',
    { kind: 'daemon-replace', message: 'start failed' },
    'Mixdog could not be replaced',
    /start failed/,
  ],
  [
    'a process not proven to be Mixdog',
    { kind: 'daemon-unproven', message: 'pid 9' },
    'This Mixdog can’t be confirmed',
    /pid 9/,
  ],
  ['a locked install', { kind: 'install-locked' }, 'Another installation is running', /Wait a moment/],
  [
    'no free port',
    { kind: 'port-unavailable', message: 'port 7000 is taken' },
    'The server has no free port',
    /port 7000/,
  ],
  [
    'a refused login with a stopped agent',
    {
      kind: 'auth',
      keygen: 'ssh-keygen -t ed25519',
      register: 'ssh-copy-id root@h',
      agent: { state: 'disabled', command: 'Set-Service ssh-agent -StartupType Manual; Start-Service ssh-agent' },
    },
    'Can’t sign in',
    /administrator PowerShell[\s\S]*Set-Service ssh-agent/,
  ],
];
for (const [name, failure, title, body] of FAILURES) {
  test(`the server’s error code for ${name} gets its own view`, async (t) => {
    const { document } = await mountDialog(t, {
      ...NO_CONFIG,
      sshConnect: () => Promise.resolve({ ok: false, failure }),
    });
    await startConnect(document);
    const dialog = document.querySelector('.conn-dialog');
    assert.equal(dialog.querySelector('h3').textContent, title);
    assert.match(dialog.textContent, body);
    assert.ok(buttonNamed(document, 'Try again'));
  });
}

test('a revoked key found before connecting is refused in the same view', async (t) => {
  const { document, calls } = await mountDialog(t, {
    ...NO_CONFIG,
    check: { status: 'revoked', fingerprint: 'SHA256:r', host: 'h' },
  });
  await startConnect(document);
  assert.equal(document.querySelector('h3').textContent, 'This server’s key is revoked');
  assert.equal(
    calls.some((call) => call[0] === 'connect'),
    false
  );
});

test('a cancelled question returns to the address; a busy daemon of another version is restarted on confirmation', async (t) => {
  let attempts = 0;
  const { document, api, requests } = await mountDialog(t, NO_CONFIG);
  const connect = api.sshConnect;
  api.sshConnect = (request) => {
    attempts += 1;
    if (attempts === 1) return Promise.resolve({ ok: false, failure: { kind: 'cancelled' } });
    if (attempts === 2) return Promise.resolve({ ok: false, failure: { kind: 'daemon-busy', message: 'busy' } });
    return connect(request);
  };
  await startConnect(document);
  assert.equal(
    document.querySelector('input.conn-input').value,
    'root@vps.example.com',
    'back at the address, no error'
  );
  await click(buttonNamed(document, 'Connect'));
  await settle();
  assert.equal(document.querySelector('h3').textContent, 'Restart Mixdog on the server?');
  assert.deepEqual(
    [...document.querySelectorAll('.conn-dialog footer button')].map((b) => b.textContent),
    ['Cancel', 'Restart and connect']
  );
  await click(buttonNamed(document, 'Restart and connect'));
  await settle();
  assert.deepEqual(requests.at(-1), { attemptId: 'attempt-2', trustHostKey: false, forceRestart: true });
});

/** The Connection page with SSH management calls recorded. */
async function mountPanel(t, extra = {}) {
  const dom = installTestDom(t, DOM);
  const calls = [];
  const questions = new Set();
  const cleanupListeners = new Set();
  const info = {
    relayBrowserUrl: '',
    relayBrowserQrSvg: '',
    relayAppQrSvg: '',
    relayConnectUrl: '',
    clients: [],
    enabled: true,
  };
  const api = {
    getRemoteAccessInfo: () => Promise.resolve(info),
    sshConnect: () => Promise.resolve({ ok: true, host: SAVED }),
    sshListHosts: () => Promise.resolve([SAVED]),
    sshConfigHosts: () => Promise.resolve([]),
    subscribeSshProgress: () => () => undefined,
    subscribeSshAskpass: (listener) => (questions.add(listener), () => questions.delete(listener)),
    sshAskpassReply: (...args) => (calls.push(['reply', ...args]), Promise.resolve()),
    subscribeSshCleanupProgress: (listener) => (
      cleanupListeners.add(listener), () => cleanupListeners.delete(listener)
    ),
    sshUpdateHostSettings: (id, settings) => (calls.push(['settings', id, settings]), Promise.resolve([SAVED])),
    ...extra,
  };
  setCachedConnectionInfo(api, info);
  t.after(() => updateClaimQueue(() => []));
  await act(async () => dom.root.render(React.createElement(ConnectionPanel, { api })));
  await settle();
  const rowButton = (name) =>
    [...dom.document.querySelectorAll('.conn-group .conn-row button')].find((b) => b.textContent === name);
  return {
    ...dom,
    calls,
    api,
    rowButton,
    ask: (question) =>
      act(async () => {
        for (const listener of questions) listener(question);
      }),
    cleanupProgress: (progress) =>
      act(async () => {
        for (const listener of cleanupListeners) listener(progress);
      }),
  };
}

test('per-server settings: folder, key file and auto-reconnect are saved for the row’s server', async (t) => {
  const { document, calls, rowButton } = await mountPanel(t, {
    sshListHosts: () => Promise.resolve([{ ...SAVED, settings: { remoteCwd: '/srv/app', autoReconnect: false } }]),
  });
  await click(rowButton('Settings'));
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'vps settings');
  const [folder, key] = dialog.querySelectorAll('input[type="text"]');
  const reconnect = dialog.querySelector('input[type="checkbox"]');
  assert.equal(folder.value, '/srv/app');
  assert.equal(reconnect.checked, false);
  await typeInto(folder, '~/work');
  await typeInto(key, 'C:\\Users\\김 철수\\.ssh\\id_work');
  await click(reconnect);
  await click(buttonNamed(document, 'Save'));
  await settle();
  assert.deepEqual(calls, [
    [
      'settings',
      'h1',
      {
        remoteCwd: '~/work',
        identityFile: 'C:\\Users\\김 철수\\.ssh\\id_work',
        autoReconnect: true,
        graceMinutes: 30,
        allowedProviders: null,
        modelLogin: 'pc',
      },
    ],
  ]);
  assert.equal(document.querySelector('.conn-dialog'), null);
});

test('per-server settings: the models this server can use list the providers enabled on this PC; a restriction is saved as a list', async (t) => {
  const { document, calls, rowButton } = await mountPanel(t, {
    readCapabilities: () =>
      Promise.resolve([
        {
          ok: true,
          value: {
            oauth: [
              { id: 'anthropic', authenticated: true },
              { id: 'google', authenticated: false },
            ],
            api: [{ id: 'openai', authenticated: true }],
          },
        },
      ]),
  });
  await click(rowButton('Settings'));
  await settle();
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('.ssh-providers legend').textContent, 'Models this server can use');
  const all = () => dialog.querySelector('.ssh-providers input[type="checkbox"]');
  assert.equal(all().checked, true, 'every provider enabled on this PC until restricted');
  const providerLabels = () => [...dialog.querySelectorAll('.ssh-providers label.ssh-check')];
  assert.equal(providerLabels().length, 1, 'the list is hidden while everything is allowed');
  await click(all());
  const labels = providerLabels().map((label) => label.textContent);
  assert.equal(labels.length, 3);
  assert.equal(
    labels.some((label) => /google/i.test(label)),
    false,
    'a provider that is not signed in is not offered'
  );
  const boxes = providerLabels()
    .map((label) => label.querySelector('input'))
    .slice(1);
  await click(boxes[0]);
  await click(buttonNamed(document, 'Save'));
  await settle();
  const [, , saved] = calls[0];
  assert.equal(Array.isArray(saved.allowedProviders), true);
  assert.equal(saved.allowedProviders.length, 1);
});

test('per-server settings: no model permission time, background toggle or budget; old saved ones are not sent back', async (t) => {
  const { document, calls, rowButton } = await mountPanel(t, {
    sshListHosts: () =>
      Promise.resolve([
        {
          ...SAVED,
          open: true,
          settings: {
            grantMinutes: 45,
            grantTokens: 5_000_000,
            allowBackgroundModelUse: true,
            backgroundCallsPerHour: 9,
          },
        },
      ]),
  });
  await click(rowButton('Settings'));
  await settle();
  const dialog = document.querySelector('.conn-dialog');
  assert.doesNotMatch(dialog.textContent, /permission|scheduled and webhook|model use|tokens/i);
  await click(buttonNamed(document, 'Save'));
  await settle();
  const [, , saved] = calls[0];
  for (const key of [
    'grantMinutes',
    'grantCalls',
    'grantTokens',
    'allowBackgroundModelUse',
    'backgroundCallsPerHour',
    'backgroundTokensPerDay',
  ]) {
    assert.equal(key in saved, false, key);
  }
});

test('per-server settings: a refused value is shown and keeps the dialog open', async (t) => {
  const { document, rowButton } = await mountPanel(t, {
    sshUpdateHostSettings: () =>
      Promise.reject(new Error('The server folder must be an absolute server path or start with ~.')),
  });
  await click(rowButton('Settings'));
  await click(buttonNamed(document, 'Save'));
  await settle();
  assert.match(document.querySelector('.conn-dialog [role="alert"]').textContent, /absolute server path/);
});

test('cleanup: confirm with the work-history checkbox, progress, the result and optionally forgetting the entry', async (t) => {
  const done = Promise.withResolvers();
  const { document, calls, rowButton, ask, cleanupProgress } = await mountPanel(t, {
    sshCleanupHost: (id, request) => (calls.push(['cleanup', id, request]), done.promise),
  });
  await click(rowButton('Clean up Mixdog on the server…'));
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.getAttribute('role'), 'alertdialog');
  assert.equal(dialog.querySelector('h3').textContent, 'Clean up Mixdog on vps');
  const [history, forget] = dialog.querySelectorAll('input[type="checkbox"]');
  assert.equal(history.parentElement.textContent, 'Delete the work history too');
  assert.equal(history.checked, false, 'the work history stays unless asked');
  await click(history);
  await click(forget);
  await click(dialog.querySelector('.conn-btn--danger'));
  assert.equal(document.querySelector('h3').textContent, 'Cleaning up vps');
  const [, id, request] = calls.find((call) => call[0] === 'cleanup');
  assert.equal(id, 'h1');
  assert.deepEqual(
    { ...request, operationId: typeof request.operationId },
    { operationId: 'string', removeUserData: true, forget: true }
  );
  const states = () => [...document.querySelectorAll('.conn-steps li')].map((li) => li.dataset.state);
  assert.deepEqual(states(), ['now', 'wait', 'wait']);
  await cleanupProgress({ operationId: 'another-operation', phase: 'remove' });
  assert.deepEqual(states(), ['now', 'wait', 'wait'], 'another run’s progress is not shown');
  await cleanupProgress({ operationId: request.operationId, phase: 'stop' });
  assert.deepEqual(states(), ['done', 'now', 'wait']);
  // A login question during the cleanup is asked in this dialog under the operation id.
  await ask({
    attemptId: request.operationId,
    requestId: 'q1',
    kind: 'password',
    prompt: "root@vps's password: ",
    retry: false,
    timeoutMs: 120000,
  });
  assert.equal(document.querySelector('h3').textContent, 'Server password');
  await typeInto(document.querySelector('.conn-dialog input'), 'pw');
  await click(buttonNamed(document, 'Continue'));
  assert.deepEqual(calls.at(-1), ['reply', request.operationId, 'q1', 'pw']);
  await act(async () => done.resolve({ ok: true, hosts: [], detail: 'Removed 12 files' }));
  await settle();
  assert.equal(document.querySelector('h3').textContent, 'Cleaned up vps');
  assert.match(document.querySelector('.conn-dialog').textContent, /Removed 12 files/);
  await click(buttonNamed(document, 'Close'));
  assert.equal(document.querySelector('.conn-dialog'), null);
});

test('cleanup: Cancel changes nothing; a failure shows its view and Try again repeats the cleanup', async (t) => {
  let runs = 0;
  const { document, calls, rowButton } = await mountPanel(t, {
    sshCleanupHost: () => {
      runs += 1;
      return Promise.resolve({ ok: false, failure: { kind: 'install-locked' } });
    },
  });
  await click(rowButton('Clean up Mixdog on the server…'));
  await click(buttonNamed(document, 'Cancel'));
  await settle();
  assert.equal(document.querySelector('.conn-dialog'), null);
  assert.equal(runs, 0);
  await click(rowButton('Clean up Mixdog on the server…'));
  await click(document.querySelector('.conn-dialog .conn-btn--danger'));
  await settle();
  assert.equal(document.querySelector('h3').textContent, 'Another installation is running');
  await click(buttonNamed(document, 'Try again'));
  await settle();
  assert.equal(runs, 2);
  assert.equal(calls.length, 0);
});

test('C5: a key in the user’s own known_hosts is only explained with its command; there is no replace step', async (t) => {
  const { document } = await mountDialog(t, { ...NO_CONFIG, check: { ...CHANGED, replaceable: false } });
  await startConnect(document);
  assert.match(dialogText(document), /ssh-keygen -R "vps\.example\.com"/);
  assert.equal(buttonNamed(document, 'Advanced · Replace the key'), undefined);
});

test('C2: a hop that is read only after the earlier one is trusted says so; confirming it checks the next server again', async (t) => {
  const hops = [
    { name: 'bastion', role: 'jump', status: 'unknown', fingerprint: 'SHA256:bastion', keyType: 'ED25519' },
    { name: 'inner', role: 'target', status: 'pending' },
  ];
  const second = {
    status: 'unknown',
    fingerprint: 'SHA256:inner',
    keyType: 'ED25519',
    hops: [
      { ...hops[0], status: 'trusted' },
      { name: 'inner', role: 'target', status: 'unknown', fingerprint: 'SHA256:inner', keyType: 'ED25519' },
    ],
  };
  const checks = [{ status: 'unknown', fingerprint: 'SHA256:bastion', keyType: 'ED25519', hops }, second];
  let connects = 0;
  const { document, calls } = await mountDialog(t, {
    ...NO_CONFIG,
    sshInspectHostKey: (target) => (
      calls.push(['inspect', target]), Promise.resolve({ attemptId: `a-${calls.length}`, check: checks.shift() })
    ),
    sshConnect: () =>
      Promise.resolve(
        connects++ === 0
          ? { ok: false, failure: { kind: 'host-key-next' } }
          : { ok: true, host: { ...SAVED, target: 'inner', open: true } }
      ),
  });
  await startConnect(document, 'inner');
  assert.match(dialogText(document), /Checked after the previous server is trusted/);
  assert.match(dialogText(document), /SHA256:bastion/);
  await click(buttonNamed(document, 'Connect'));
  await settle();
  assert.deepEqual(
    calls.filter((call) => call[0] === 'inspect'),
    [
      ['inspect', 'inner'],
      ['inspect', 'inner'],
    ],
    'the same address is checked again'
  );
  assert.match(dialogText(document), /SHA256:inner/, 'the next server’s fingerprint is asked about');
  await click(buttonNamed(document, 'Connect'));
  await settle();
  assert.equal(connects, 2);
});

const MORE_GUIDANCE = [
  {
    failure: { kind: 'daemon-unmanaged', message: 'A Mixdog (pid 77) not started by the desktop app is running.' },
    title: 'Mixdog on the server was started by someone else',
    text: /It was left running; Mixdog will not stop it for you/,
    body: /pid 77/,
  },
  {
    failure: { kind: 'daemon-data-in-use', message: 'The data folder is locked by pid 81.' },
    title: 'The server’s Mixdog data is in use',
    text: /It was left running/,
    body: /pid 81/,
  },
];
for (const { failure, title, text, body } of MORE_GUIDANCE) {
  test(`C4: ${failure.kind} is explained, with no restart button`, async (t) => {
    const { document } = await mountDialog(t, {
      ...NO_CONFIG,
      sshConnect: () => Promise.resolve({ ok: false, failure }),
    });
    await startConnect(document, 'root@123.45.67.89');
    assert.equal(document.querySelector('h3').textContent, title);
    assert.match(document.querySelector('.conn-dialog header p').textContent, text);
    assert.match(dialogText(document), body);
    assert.deepEqual(footerButtons(document), ['Edit address', 'Close', 'Try again']);
    assert.equal(buttonNamed(document, 'Restart and connect'), undefined);
    assert.equal(buttonNamed(document, 'Stop and connect'), undefined);
  });
}

test('a server’s own request is shown under the host it comes from and is not treated as a password', async (t) => {
  const never = new Promise(() => undefined);
  const { document, ask } = await mountDialog(t, { ...NO_CONFIG, sshConnect: () => never });
  await startConnect(document);
  await act(async () =>
    ask({
      attemptId: 'attempt-1',
      requestId: 'r1',
      kind: 'other',
      host: 'gate.example.com',
      prompt: 'Approve on your phone: ',
      retry: false,
      timeoutMs: 120000,
    })
  );
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'Server request');
  const notes = [...dialog.querySelectorAll('.conn-note')].map((note) => note.textContent);
  assert.deepEqual(notes.slice(0, 2), ['Request from gate.example.com:', 'Approve on your phone:']);
  await act(async () =>
    ask({
      attemptId: 'attempt-1',
      requestId: 'r2',
      kind: 'passphrase',
      host: 'gate.example.com',
      prompt: "Enter passphrase for key 'k': ",
      retry: false,
      timeoutMs: 120000,
    })
  );
  assert.equal(
    document.querySelector('.conn-dialog').textContent.includes('Request from'),
    false,
    'the line is only for text the server supplies'
  );
});

test('port forwards that Mixdog could not set aside are listed once, with Continue and Cancel; accepting is sent with the connection', async (t) => {
  const forwards = ['local [127.0.0.1]:8080 [127.0.0.1]:80'];
  const { document, requests, calls, closed } = await mountDialog(t, {
    ...NO_CONFIG,
    summary: { hostName: '10.0.0.1', user: null, port: 22, proxyJump: null, proxyCommand: false, forwards },
  });
  await startConnect(document, 'root@10.0.0.1');
  assert.equal(document.querySelector('h3').textContent, 'Port forwards in your ssh config');
  assert.match(dialogText(document), /local \[127\.0\.0\.1\]:8080/);
  assert.deepEqual(footerButtons(document), ['Cancel', 'Continue']);
  assert.deepEqual(
    calls.filter((call) => call[0] === 'connect'),
    [],
    'nothing connects before the answer'
  );
  await click(buttonNamed(document, 'Continue'));
  await settle();
  assert.equal(requests.at(-1).acceptForwards, true);
  assert.equal(closed.length, 1);
});

test('Cancel on the forwards notice connects nothing and releases the attempt', async (t) => {
  const { document, calls, closed } = await mountDialog(t, {
    ...NO_CONFIG,
    summary: {
      hostName: '10.0.0.1',
      user: null,
      port: 22,
      proxyJump: null,
      proxyCommand: false,
      forwards: ['dynamic [127.0.0.1]:1080'],
    },
  });
  await startConnect(document, 'root@10.0.0.1');
  await click(buttonNamed(document, 'Cancel'));
  assert.deepEqual(
    calls.filter((call) => call[0] === 'connect'),
    []
  );
  assert.ok(calls.some((call) => call[0] === 'cancel'));
  assert.equal(closed.length, 1);
});

test('per-server settings: the time the server keeps its work after a disconnect defaults to 30 minutes and is saved as a number', async (t) => {
  const { document, calls, rowButton } = await mountPanel(t, {
    sshListHosts: () => Promise.resolve([{ ...SAVED, settings: { graceMinutes: 120 } }]),
  });
  await click(rowButton('Settings'));
  const grace = document.querySelector('.conn-dialog input[type="number"]');
  assert.equal(grace.value, '120');
  assert.equal(grace.min, '1');
  assert.equal(grace.max, '10080');
  await typeInto(grace, '45');
  await click(buttonNamed(document, 'Save'));
  await settle();
  assert.equal(calls[0][2].graceMinutes, 45);
});

/** A clipboard that records what is written. */
function stubClipboard(t) {
  const written = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (value) => written.push(value) } },
  });
  t.after(() => (original ? Object.defineProperty(globalThis, 'navigator', original) : delete globalThis.navigator));
  return written;
}

test('a failed connection offers "View log": the connection log, Copy and Copy diagnostics (redacted text), and the server log on request', async (t) => {
  const written = stubClipboard(t);
  const refs = [];
  const { document } = await mountDialog(t, {
    ...NO_CONFIG,
    sshConnect: () => Promise.resolve({ ok: false, failure: { kind: 'failed', message: 'boom' } }),
    sshDiagnosticsLog: (ref) => (
      refs.push(['log', ref]),
      Promise.resolve({
        lines: ['12:00:00.001 ssh    ssh.exe -T -- root@vps.example.com true', '12:00:00.200 stderr refused'],
        copyText: '12:00:00.001 ssh    ssh.exe -T -- <server> true',
      })
    ),
    sshDiagnosticsCopy: (ref) => (
      refs.push(['copy', ref]), Promise.resolve('Mixdog SSH diagnostics\nHostName <server>')
    ),
    sshServerLog: (ref) => (
      refs.push(['server', ref]), Promise.resolve({ ok: true, text: 'daemon started', copyText: 'daemon started' })
    ),
  });
  await startConnect(document, 'root@vps.example.com');
  assert.deepEqual(footerButtons(document), ['Edit address', 'View log', 'Close', 'Try again']);
  await click(buttonNamed(document, 'View log'));
  await settle();
  assert.equal(document.querySelector('h3').textContent, 'Connection log');
  assert.deepEqual(refs[0], ['log', 'root@vps.example.com']);
  const log = document.querySelector('pre.ssh-log');
  assert.match(log.textContent, /root@vps\.example\.com true\n12:00:00\.200 stderr refused/);
  await click(buttonNamed(document, 'Copy'));
  await click(buttonNamed(document, 'Copy diagnostics'));
  await settle();
  assert.deepEqual(
    written,
    ['12:00:00.001 ssh    ssh.exe -T -- <server> true', 'Mixdog SSH diagnostics\nHostName <server>'],
    'only the redacted text reaches the clipboard'
  );
  assert.match(document.querySelector('.conn-dialog').textContent, /replaced by <server>/);
  await click(buttonNamed(document, 'Fetch server log'));
  await settle();
  assert.equal(document.querySelector('h3').textContent, 'Server log');
  assert.equal(document.querySelector('pre.ssh-log').textContent, 'daemon started');
  assert.deepEqual(refs.at(-1), ['server', 'root@vps.example.com']);
  await click(buttonNamed(document, 'Close'));
  assert.equal(document.querySelector('h3').textContent, 'Couldn’t connect', 'closing the log returns to the failure');
});

test('an already-connected refusal explains itself and offers no "Try again"', async (t) => {
  const { document } = await mountDialog(t, {
    ...NO_CONFIG,
    sshConnect: () => Promise.resolve({ ok: false, failure: { kind: 'already-connected' } }),
  });
  await startConnect(document, 'root@vps.example.com');
  assert.equal(document.querySelector('h3').textContent, 'This server is already connected');
  assert.match(
    document.querySelector('.conn-dialog').textContent,
    /Disconnect it first to change its login key or folder\./
  );
  assert.ok(!footerButtons(document).includes('Try again'));
  assert.ok(footerButtons(document).includes('Close'));
});

test('a connect call that throws shows its message without the Electron IPC envelope', async (t) => {
  const { document } = await mountDialog(t, {
    ...NO_CONFIG,
    sshConnect: () =>
      Promise.reject(new Error("Error invoking remote method 'mixdog:ssh-connect': Error: The server said no.")),
  });
  await startConnect(document, 'root@vps.example.com');
  const text = document.querySelector('.conn-dialog').textContent;
  assert.match(text, /The server said no\./);
  assert.doesNotMatch(text, /Error invoking remote method/);
});

test('a server log that cannot be read shows why instead of an empty box', async (t) => {
  stubClipboard(t);
  const { document } = await mountDialog(t, {
    ...NO_CONFIG,
    sshConnect: () => Promise.resolve({ ok: false, failure: { kind: 'failed', message: 'boom' } }),
    sshDiagnosticsLog: () => Promise.resolve({ lines: [], copyText: '' }),
    sshServerLog: () => Promise.resolve({ ok: false, message: 'Permission denied (publickey).' }),
  });
  await startConnect(document, 'root@vps.example.com');
  await click(buttonNamed(document, 'View log'));
  await settle();
  assert.equal(document.querySelector('pre.ssh-log').textContent, 'Nothing has been logged yet.');
  assert.equal(buttonNamed(document, 'Copy').disabled, true, 'nothing to copy');
  await click(buttonNamed(document, 'Fetch server log'));
  await settle();
  assert.match(document.querySelector('[role="alert"]').textContent, /Permission denied/);
});

const CODE_CASES = [
  [
    { kind: 'protocol-mismatch', message: 'protocol 3 vs 4', code: 'protocol-mismatch' },
    'The Mixdog version on the server doesn’t match',
    /Connecting again installs the matching version[\s\S]*Clean up Mixdog on the server/,
    'protocol-mismatch',
  ],
  [
    { kind: 'internal', message: 'bad frame', code: 'protocol' },
    'An unexpected error occurred',
    /View log/,
    'protocol',
  ],
  [
    { kind: 'remote-shell', message: 'exited with status 1', code: 'remote-home' },
    'The server’s login shell interferes',
    /\.bashrc/,
    'remote-home',
  ],
  [{ kind: 'failed', message: 'refused', code: 'ssh-transient' }, 'Couldn’t connect', /refused/, 'ssh-transient'],
];
for (const [failure, title, body, code] of CODE_CASES) {
  test(`failure view ${failure.kind}: its guidance and the error code ${code}`, async (t) => {
    const { document } = await mountDialog(t, {
      ...NO_CONFIG,
      sshConnect: () => Promise.resolve({ ok: false, failure }),
    });
    await startConnect(document, 'root@vps.example.com');
    assert.equal(document.querySelector('h3').textContent, title);
    assert.match(dialogText(document), body);
    assert.equal(document.querySelector('.ssh-error-code').textContent, `Error code: ${code}`);
  });
}

test('the log dialog says copies hide the server address and user name, while the shown log is the user’s own unredacted text', async (t) => {
  stubClipboard(t);
  const { document } = await mountDialog(t, {
    ...NO_CONFIG,
    sshConnect: () => Promise.resolve({ ok: false, failure: { kind: 'failed', message: 'boom' } }),
    sshDiagnosticsLog: () => Promise.resolve({ lines: ['ssh root@vps.example.com'], copyText: 'ssh <server>' }),
  });
  await startConnect(document, 'root@vps.example.com');
  await click(buttonNamed(document, 'View log'));
  await settle();
  assert.match(
    dialogText(document),
    /Server addresses and user names are hidden when you copy\. Check the content before sharing\./
  );
  assert.equal(document.querySelector('pre.ssh-log').textContent, 'ssh root@vps.example.com');
});
