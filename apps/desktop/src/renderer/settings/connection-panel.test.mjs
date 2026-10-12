import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from '../test-support/test-dom.mjs';
import { updateClaimQueue } from '../remote-claim-store.ts';
import { getCachedConnectionInfo, setCachedConnectionInfo } from './connection-info.ts';
import { requestConnectionDialog } from './connection-intent.ts';
import { ConnectionPanel } from './connection-panel.tsx';

const DOM = { rootId: 'root', expose: ['HTMLElement', 'Node', 'KeyboardEvent', 'Event'] };

const readyInfo = (id, clients = []) => ({
  relayBrowserUrl: `https://relay.example/d/${id}/`,
  relayBrowserQrSvg: `<svg data-browser="${id}"></svg>`,
  relayAppQrSvg: `<svg data-device="${id}"></svg>`,
  relayConnectUrl: 'https://relay.example/connect',
  clients,
  enabled: true,
});

const client = (id, name, browser, online, lastSeenAt = 2) => ({
  id,
  name,
  platform: 'Windows',
  browser,
  createdAt: 1,
  lastSeenAt,
  online,
});

const settle = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });

/** A host API with the remote-access settings, pair code and saved hosts. */
function makeApi({ info = readyInfo('aaaaaaaa'), settings = {}, hosts = [], pairCode, clientAliases = false } = {}) {
  const state = {
    info,
    settings: { enabled: true, name: 'DESKTOP-IBLP835', defaultName: 'DESKTOP-IBLP835', ...settings },
    hosts,
  };
  const calls = [];
  const api = {
    getRemoteAccessInfo: () => Promise.resolve(state.info),
    getRemoteAccessSettings: () => Promise.resolve(state.settings),
    subscribeRemoteAccessSettings: () => () => undefined,
    setRemoteAccessEnabled: (enabled) => {
      calls.push(['enabled', enabled]);
      state.settings = { ...state.settings, enabled };
      state.info = enabled
        ? readyInfo('aaaaaaaa', state.info.clients)
        : { ...state.info, enabled: false, relayBrowserQrSvg: '', relayAppQrSvg: '', relayConnectUrl: '' };
      return Promise.resolve(state.settings);
    },
    setRemotePcName: (name) => {
      calls.push(['name', name]);
      state.settings = { ...state.settings, name: name || state.settings.defaultName };
      return Promise.resolve(state.settings);
    },
    getRemotePairCode:
      pairCode ??
      ((action) => {
        calls.push(['code', action]);
        return Promise.resolve(action === 'release' ? null : { code: '716386', expiresAt: Date.now() + 200_000 });
      }),
    listRemoteHosts: () => Promise.resolve(state.hosts),
    connectRemoteHostByCode: (code) => {
      calls.push(['connect', code]);
      return Promise.resolve({});
    },
    openRemoteHost: (id) => {
      calls.push(['open', id]);
      return Promise.resolve(state.hosts);
    },
    forgetRemoteHost: (id) => {
      calls.push(['forget', id]);
      state.hosts = state.hosts.filter((host) => host.id !== id);
      return Promise.resolve(state.hosts);
    },
    renameRemoteHost: (id, name) => {
      calls.push(['rename-host', id, name]);
      state.hosts = state.hosts.map((host) => (host.id === id ? { ...host, name } : host));
      return Promise.resolve();
    },
    rotateRemoteAccess: () => {
      calls.push(['rotate']);
      state.info = { ...state.info, clients: [] };
      return Promise.resolve(state.info);
    },
    revokeRemoteAccessClient: (id) => {
      calls.push(['revoke', id]);
      state.info = { ...state.info, clients: state.info.clients.filter((row) => row.id !== id) };
      return Promise.resolve(state.info);
    },
    // Device aliases are opt-in so other tests keep Disconnect as each row's only button.
    ...(clientAliases
      ? {
          setRemoteClientAlias: (id, alias) => {
            calls.push(['alias', id, alias]);
            state.info = {
              ...state.info,
              clients: state.info.clients.map((row) => (row.id === id ? { ...row, alias: alias || undefined } : row)),
            };
            return Promise.resolve();
          },
        }
      : {}),
  };
  setCachedConnectionInfo(api, info);
  return { api, calls, state };
}

async function mount(t, options) {
  const dom = installTestDom(t, DOM);
  const made = makeApi(options);
  t.after(() => updateClaimQueue(() => []));
  await act(async () => dom.root.render(React.createElement(ConnectionPanel, { api: made.api })));
  await settle();
  return { ...dom, ...made };
}

const buttonNamed = (document, name) => [...document.querySelectorAll('button')].find((b) => b.textContent === name);
const click = (element) => act(async () => element.click());
const typeInto = async (input, value) => {
  const set = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set;
  await act(async () => {
    set.call(input, value);
    input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
  });
};
const escape = (document, window) =>
  act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });

test('a displayed device list and its cache survive until the relay answers again', async (t) => {
  const dom = installTestDom(t, DOM);
  const old = readyInfo('aaaaaaaa', [client('c1', 'Fold', 'Mixdog App', true)]);
  const disconnected = Promise.withResolvers();
  const api = { getRemoteAccessInfo: () => disconnected.promise };
  setCachedConnectionInfo(api, old);
  await act(async () => dom.root.render(React.createElement(ConnectionPanel, { api })));
  assert.equal(dom.document.querySelectorAll('.conn-list .conn-row').length, 1);
  await act(async () => disconnected.resolve(null));
  assert.equal(getCachedConnectionInfo(api), null);
  assert.equal(dom.document.querySelector('.conn-list'), null, 'no stale list once the relay lost the link');
});

test('the page has no tabs or lede: identity card, two buttons, one device list, saved PCs', async (t) => {
  const info = readyInfo('bbbbbbbb', [
    client('c1', 'Fold · Mixdog App', 'Mixdog App', true),
    client('c2', 'Laptop · Chrome', 'Chrome', false),
    client('c3', 'Office', 'Mixdog Desktop', false, 0),
  ]);
  const { document } = await mount(t, {
    info,
    hosts: [{ id: 'h1', name: 'Home PC', url: '', addedAt: 1, lastConnectedAt: 0, open: false, online: true }],
  });
  assert.equal(document.querySelector('[role="tab"]'), null);
  assert.ok(!document.body.textContent.includes('Use this PC from your phone, browser, or another PC.'));

  const [identity, access] = document.querySelectorAll('.conn-card .conn-row');
  assert.equal(identity.querySelector('b').textContent, 'DESKTOP-IBLP835');
  assert.equal(identity.querySelector('.conn-row-meta').textContent, 'This PC · Default name (computer name)');
  assert.equal(identity.querySelector('button').textContent, 'Rename');
  assert.equal(access.querySelector('.conn-row-title').textContent, 'Use this PC from other devices');
  assert.equal(access.querySelector('.conn-row-meta').textContent, 'Phones, browsers and other PCs can connect.');
  assert.equal(access.querySelector('input[type="checkbox"]').checked, true);

  assert.deepEqual(
    [...document.querySelectorAll('.conn-toolbar button')].map((b) => b.textContent),
    ['Open another PC', 'Connect a device']
  );
  const heads = [...document.querySelectorAll('.conn-group-head')];
  assert.deepEqual(
    heads.map((head) => head.querySelector('h4').textContent),
    ['Devices connected to this PC3', 'PCs I opened1']
  );
  assert.equal(heads[0].querySelector('.conn-link--danger').textContent, 'Disconnect all');

  const rows = [...document.querySelectorAll('.conn-group')[0].querySelectorAll('.conn-row')];
  assert.deepEqual(
    rows.map((row) => [row.querySelector('b').textContent, row.querySelector('.conn-status').textContent]),
    [
      ['Fold', 'Online'],
      ['Laptop', 'Offline'],
      ['Office', 'Offline'],
    ]
  );
  assert.deepEqual(
    rows.map((row) => row.querySelector('.conn-row-meta').textContent.split(' · ')[0]),
    ['Mixdog app', 'Chrome', 'Mixdog PC'],
    'one list for every kind, each with its own kind label'
  );
  assert.equal(
    rows.every((row) => row.querySelector('.conn-tile svg')),
    true
  );
  assert.deepEqual(
    [...document.querySelectorAll('.conn-group')[1].querySelectorAll('button')].map((b) => b.textContent),
    ['Open', 'Rename', 'Forget']
  );
});

test('a renamed PC shows the Windows name in its meta line; Rename opens the name dialog with its helper', async (t) => {
  const { document, calls } = await mount(t, { settings: { name: 'Studio PC' } });
  assert.equal(document.querySelector('.conn-card .conn-row-meta').textContent, 'This PC · Computer name DESKTOP-IBLP835');
  await click(buttonNamed(document, 'Rename'));
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'This PC’s name');
  assert.equal(dialog.querySelector('input').value, 'Studio PC');
  assert.equal(
    dialog.querySelector('.conn-field-msg').textContent,
    'Leave empty to go back to the default name (DESKTOP-IBLP835).'
  );
  assert.deepEqual(
    [...dialog.querySelectorAll('footer button')].map((b) => b.textContent),
    ['Cancel', 'Save']
  );
  assert.equal(dialog.querySelector('.conn-dialog > header button'), null, 'no ✕ close button');
  await typeInto(dialog.querySelector('input'), '');
  await click(buttonNamed(document, 'Save'));
  await settle();
  assert.deepEqual(calls, [['name', '']], 'an empty name resets to the default');
  assert.equal(document.querySelector('.conn-dialog'), null);
  assert.equal(document.querySelector('.conn-card .conn-row b').textContent, 'DESKTOP-IBLP835');
});

test('a connected device can be given a local alias; the default label stays as secondary text and clearing restores it', async (t) => {
  const info = readyInfo('eeeeeeee', [
    client('c1', 'iPhone · Safari', 'Safari', true),
    client('c2', 'iPhone · Safari', 'Safari', false),
  ]);
  const { document, calls } = await mount(t, { info, clientAliases: true });
  const rows = () => [...document.querySelectorAll('.conn-list .conn-row')];
  const renameButton = (row) => [...row.querySelectorAll('button')].find((b) => b.textContent === 'Rename');
  assert.equal(rows().filter((row) => renameButton(row)).length, 2, 'every device has a Rename action');

  await click(renameButton(rows()[0]));
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'Rename device');
  await typeInto(dialog.querySelector('input'), 'Mom’s iPhone');
  await click(buttonNamed(document, 'Save'));
  await settle();
  assert.deepEqual(calls, [['alias', 'c1', 'Mom’s iPhone']]);
  assert.equal(rows()[0].querySelector('b').textContent, 'Mom’s iPhone');
  assert.ok(rows()[0].querySelector('.conn-row-meta').textContent.startsWith('iPhone · '), 'default label kept');
  assert.equal(rows()[1].querySelector('b').textContent, 'iPhone');

  await click(renameButton(rows()[0]));
  await typeInto(document.querySelector('.conn-dialog input'), '');
  await click(buttonNamed(document, 'Save'));
  await settle();
  assert.deepEqual(calls.at(-1), ['alias', 'c1', '']);
  assert.equal(rows()[0].querySelector('b').textContent, 'iPhone');
});

test('the switch turns remote access off: the Connect button disables and the list dims with "Off" rows', async (t) => {
  const info = readyInfo('cccccccc', [client('c1', 'Fold · Mixdog App', 'Mixdog App', true)]);
  const { document, calls } = await mount(t, { info });
  const toggle = document.querySelector('input[aria-label="Use this PC from other devices"]');
  await click(toggle);
  await settle();
  assert.deepEqual(calls, [['enabled', false]]);
  assert.equal(toggle.checked, false);
  assert.equal(
    document.querySelector('.conn-card .conn-row:nth-child(2) .conn-row-meta').textContent,
    'Off. Connected devices can’t use this PC for now.'
  );
  assert.equal(buttonNamed(document, 'Connect a device').disabled, true);
  assert.equal(
    buttonNamed(document, 'Open another PC').disabled,
    false,
    'opening another PC does not depend on the switch'
  );
  assert.ok(document.querySelector('.conn-group.is-dimmed'));
  assert.equal(document.querySelector('.conn-group .conn-status').textContent, 'Off');
  assert.equal(document.querySelectorAll('.conn-list .conn-row').length, 1, 'the device list is kept');
});

test('Disconnect all (two or more devices) confirms with the count; a single device has no such link; per-row disconnect needs two clicks', async (t) => {
  const info = readyInfo('dddddddd', [
    client('c1', 'Fold · Mixdog App', 'Mixdog App', true),
    client('c2', 'Laptop · Chrome', 'Chrome', false),
  ]);
  const { document, calls } = await mount(t, { info });
  await click(document.querySelector('.conn-link--danger'));
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'Disconnect all devices');
  assert.match(dialog.querySelector('header p').textContent, /2 devices/);
  assert.deepEqual(
    [...dialog.querySelectorAll('footer button')].map((b) => b.textContent),
    ['Cancel', 'Disconnect 2']
  );
  await click(buttonNamed(document, 'Cancel'));
  assert.equal(document.querySelector('.conn-dialog'), null);
  assert.deepEqual(calls, []);

  const rowButton = () => document.querySelector('.conn-list .conn-row button');
  await click(rowButton());
  assert.equal(rowButton().textContent, 'Confirm disconnect');
  assert.deepEqual(calls, []);
  await click(rowButton());
  await settle();
  assert.deepEqual(calls, [['revoke', 'c1']]);
  assert.equal(document.querySelector('.conn-link--danger'), null, 'one device left: no disconnect-all');

  await click(document.querySelector('.conn-list .conn-row button'));
  await click(document.querySelector('.conn-list .conn-row button'));
  await settle();
  assert.equal(document.querySelectorAll('.conn-list .conn-row').length, 0);
});

test('Disconnect all runs rotateRemoteAccess after the "Disconnect N" confirmation', async (t) => {
  const info = readyInfo('dedededede', [
    client('c1', 'Fold · Mixdog App', 'Mixdog App', true),
    client('c2', 'Laptop · Chrome', 'Chrome', false),
  ]);
  const { document, calls } = await mount(t, { info });
  await click(document.querySelector('.conn-link--danger'));
  await click(buttonNamed(document, 'Disconnect 2'));
  await settle();
  assert.deepEqual(calls, [['rotate']]);
  assert.equal(document.querySelector('.conn-dialog'), null);
});

test('Connect a device: the phone view shows the install QR, the code and the approval step in one view; the code is released when it closes', async (t) => {
  const { document, calls } = await mount(t);
  await click(buttonNamed(document, 'Connect a device'));
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'Connect a device');
  assert.equal(dialog.querySelector('header p').textContent, 'Choose the kind of device to connect.');
  assert.deepEqual(
    [...dialog.querySelectorAll('[role="tab"]')].map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]),
    [
      ['Phone', 'true'],
      ['Browser', 'false'],
      ['Other PC', 'false'],
    ]
  );
  await settle();
  assert.ok(dialog.querySelector('.conn-qr svg[data-device="aaaaaaaa"]'));
  assert.deepEqual(
    [...dialog.querySelectorAll('.conn-steps li')].map((li) => [li.dataset.n, li.textContent]),
    [
      ['1', 'Scan with your phone camera to install the Mixdog app'],
      ['2', 'In the app, tap Connect with a code and enter this code'],
      ['3', 'Allow the request on this PC'],
    ]
  );
  assert.equal(dialog.querySelector('.conn-code-tile b').textContent, '716·386');
  assert.match(dialog.querySelector('.conn-code-meta span').textContent, /left/);
  assert.deepEqual(
    calls.map((call) => call[1]),
    ['ensure']
  );
  assert.deepEqual(
    [...dialog.querySelectorAll('footer button')].map((b) => b.textContent),
    ['Close']
  );

  await click(buttonNamed(document, 'Close'));
  assert.equal(calls.at(-1)[1], 'release');
});

test('Connect a device: browser view has the full-width address with copy plus the code; the other-PC view has only the code', async (t) => {
  const { document, calls } = await mount(t);
  await click(buttonNamed(document, 'Connect a device'));
  const tab = (name) => [...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent === name);
  await click(tab('Browser'));
  await settle();
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('.conn-address code').textContent, 'relay.example/connect');
  assert.ok(dialog.querySelector('.conn-address button[aria-label="Copy"]'));
  assert.equal(dialog.querySelector('.conn-code-tile b').textContent, '716·386');
  assert.deepEqual(
    [...dialog.querySelectorAll('.conn-steps li')].map((li) => [li.dataset.n, li.textContent]),
    [
      ['1', 'Open this address in a browser'],
      ['2', 'Enter this code'],
    ]
  );
  assert.equal(dialog.querySelector('.conn-seg + *') !== null, true);
  assert.equal(dialog.querySelector('footer .conn-footnote').textContent, 'Notifications only work in the app.');
  assert.equal(dialog.querySelector('footer .conn-link'), null);

  await click(tab('Other PC'));
  assert.equal(calls.filter((call) => call[1] === 'release').length, 0, 'browser and other PC share one code');
  assert.equal(calls.filter((call) => call[1] === 'ensure').length, 1, 'switching tabs does not re-request it');
  assert.deepEqual(
    [...dialog.querySelectorAll('.conn-steps li')].map((li) => li.textContent),
    ['On that PC, go to Settings → Connection → Open another PC', 'Enter this code']
  );
  assert.equal(dialog.querySelector('.conn-address'), null);
  assert.equal(dialog.querySelector('.conn-code-tile b').textContent, '716·386');
  assert.deepEqual(
    [...dialog.querySelectorAll('footer button')].map((b) => b.textContent),
    ['Close']
  );

  await click(tab('Phone'));
  assert.equal(calls.filter((call) => call[1] === 'release').length, 0, 'every view shares the one code');
});

test('a pending code request shows the loading tile; the code lands within a second, not after the 8 s heartbeat', async (t) => {
  let asks = 0;
  const { document } = await mount(t, {
    pairCode: (action) => {
      if (action === 'release') return Promise.resolve(null);
      asks += 1;
      return Promise.resolve(asks === 1 ? null : { code: '482917', expiresAt: Date.now() + 200_000 });
    },
  });
  await click(buttonNamed(document, 'Connect a device'));
  assert.ok(document.querySelector('[aria-label="Getting a code…"].conn-code-tile--loading'));
  assert.equal(document.querySelector('button[aria-label="New code"]').disabled, true);
  await act(async () => new Promise((done) => setTimeout(done, 900)));
  assert.equal(document.querySelector('.conn-code-tile b').textContent, '482·917');
});

for (const [label, answer] of [
  ['{ unsupported: true }', { unsupported: true }],
  ['a missing result', undefined],
]) {
  test(`a relay without codes (${label}) puts the note in the code slot`, async (t) => {
    const { document } = await mount(t, { pairCode: () => Promise.resolve(answer) });
    await click(buttonNamed(document, 'Connect a device'));
    await settle();
    const dialog = document.querySelector('.conn-dialog');
    assert.equal(dialog.querySelector('.conn-code-tile--na').textContent, 'Codes aren’t available right now');
    assert.equal(dialog.querySelector('.conn-code-meta'), null);
    assert.ok(dialog.textContent.includes('This connection server doesn’t support codes.'));
  });
}

test('Escape closes the Connect dialog and focus returns to the opener', async (t) => {
  const { document, window } = await mount(t);
  const opener = buttonNamed(document, 'Connect a device');
  opener.focus();
  await click(opener);
  assert.ok(document.querySelector('.conn-dialog').contains(document.activeElement));
  await escape(document, window);
  assert.equal(document.querySelector('.conn-dialog'), null);
  assert.equal(document.activeElement, opener);
});

const claim = (extra) => ({
  claimId: 'k1',
  clientId: 'k1',
  name: 'Galaxy Z Fold7',
  platform: 'Android',
  browser: 'Mixdog App',
  desktop: false,
  method: 'code',
  requestedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  ...extra,
});

test('a request arriving while the Connect dialog is open turns it into the approval; Allow shows Connected, Deny returns to connecting', async (t) => {
  const { document, window, calls } = await mount(t);
  const answers = [];
  window.mixdogDesktop = {
    resolveRemoteClientClaim: (id, approved) => {
      answers.push([id, approved]);
      return Promise.resolve(true);
    },
  };
  await click(buttonNamed(document, 'Connect a device'));
  await settle();
  await act(async () => updateClaimQueue(() => [claim()]));

  assert.equal(document.querySelectorAll('.conn-dialog').length, 1, 'the same dialog, no second window');
  assert.equal(document.querySelector('.settings-confirm-dialog'), null);
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'Connection request');
  assert.equal(dialog.querySelector('.conn-device b').textContent, 'Galaxy Z Fold7');
  assert.deepEqual(
    [...dialog.querySelectorAll('.conn-kv dd')].slice(0, 2).map((dd) => dd.textContent),
    ['Mixdog app · Android', 'Code']
  );
  assert.ok(dialog.querySelector('.conn-note').textContent.includes('files, terminals and agents'));
  assert.deepEqual(
    [...dialog.querySelectorAll('footer button')].map((b) => b.textContent),
    ['Deny', 'Allow']
  );
  assert.equal(calls.at(-1)[1], 'release', 'the code is withdrawn while the approval shows');

  await click(buttonNamed(document, 'Allow'));
  await settle();
  assert.deepEqual(answers, [['k1', true]]);
  assert.equal(dialog.querySelector('h3').textContent, 'Connected');
  assert.equal(dialog.querySelector('b').textContent, 'Galaxy Z Fold7');
  assert.deepEqual(
    [...dialog.querySelectorAll('footer button')].map((b) => b.textContent),
    ['Connect another device', 'Done']
  );
  await click(buttonNamed(document, 'Connect another device'));
  assert.equal(dialog.querySelector('h3').textContent, 'Connect a device');

  await act(async () => updateClaimQueue(() => [claim({ claimId: 'k2', clientId: 'k2', method: 'retry' })]));
  assert.equal(dialog.querySelector('.conn-kv dd:nth-of-type(2)').textContent, 'Retry request');
  await click(buttonNamed(document, 'Deny'));
  await settle();
  assert.deepEqual(answers.at(-1), ['k2', false]);
  assert.equal(dialog.querySelector('h3').textContent, 'Connect a device', 'denied: back to the connect view');
});

test('Escape denies a visible approval; Tab stays inside the dialog', async (t) => {
  const { document, window } = await mount(t);
  const answers = [];
  window.mixdogDesktop = {
    resolveRemoteClientClaim: (id, approved) => {
      answers.push([id, approved]);
      return Promise.resolve(true);
    },
  };
  await act(async () => updateClaimQueue(() => [claim()]));
  await click(buttonNamed(document, 'Connect a device'));
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'Connection request', 'a waiting request is shown on open');
  buttonNamed(document, 'Allow').focus();
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  });
  assert.equal(document.activeElement, buttonNamed(document, 'Deny'), 'Tab wraps to the first button');
  await escape(document, window);
  await settle();
  assert.deepEqual(answers, [['k1', false]]);
});

test('a request that lands while the dialog is closed leaves the dialog alone; View opens it in the approval state', async (t) => {
  const { document, window } = await mount(t);
  window.mixdogDesktop = { resolveRemoteClientClaim: () => Promise.resolve(true) };
  await act(async () => updateClaimQueue(() => [claim()]));
  assert.equal(document.querySelector('.conn-dialog'), null);
  await act(async () => requestConnectionDialog('connect'));
  assert.equal(document.querySelector('.conn-dialog h3').textContent, 'Connection request');
});

test('a dialog request is ignored while the switch is off', async (t) => {
  const { document } = await mount(t, {
    settings: { enabled: false },
    info: { ...readyInfo('ffffffff'), enabled: false, relayBrowserQrSvg: '', relayAppQrSvg: '' },
  });
  await act(async () => requestConnectionDialog('connect'));
  assert.equal(document.querySelector('.conn-dialog'), null);
  await act(async () => requestConnectionDialog('open-pc'));
  assert.ok(document.querySelector('.conn-dialog'), 'opening another PC works with the switch off');
});

test('Open another PC: six boxes, auto-start on the sixth digit, waiting text, success closes', async (t) => {
  const connect = Promise.withResolvers();
  const { document, calls, api } = await mount(t);
  api.connectRemoteHostByCode = (code) => {
    calls.push(['connect', code]);
    return connect.promise;
  };
  await click(buttonNamed(document, 'Open another PC'));
  const dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'Open another PC');
  assert.equal(dialog.querySelectorAll('.conn-otp > span').length, 6);
  const input = dialog.querySelector('input[name="code"]');
  assert.ok(input);
  assert.equal(buttonNamed(document, 'Connect').disabled, true);
  await typeInto(input, '48291');
  assert.deepEqual(calls, []);
  assert.equal(dialog.querySelectorAll('.conn-otp > span')[5].className, 'is-focus');
  await typeInto(input, '482·917');
  assert.deepEqual(calls, [['connect', '482917']], 'the sixth digit starts the connection');
  assert.deepEqual(
    [...dialog.querySelectorAll('.conn-otp > span')].map((box) => box.textContent),
    ['4', '8', '2', '9', '1', '7']
  );
  assert.equal(dialog.querySelector('.conn-field-msg--busy').textContent, 'Press Allow on that PC to open it');
  assert.ok(dialog.querySelector('.conn-spinner'));
  assert.equal(buttonNamed(document, 'Connecting…').disabled, true);
  await act(async () => connect.resolve({}));
  await settle();
  assert.equal(document.querySelector('.conn-dialog'), null, 'success closes the dialog');
});

test('Open another PC: a wrong code turns the boxes red with a message; Enter again clears it', async (t) => {
  const { document, api } = await mount(t);
  api.connectRemoteHostByCode = () => Promise.reject(new Error('bad code'));
  await click(buttonNamed(document, 'Open another PC'));
  const dialog = document.querySelector('.conn-dialog');
  await typeInto(dialog.querySelector('input[name="code"]'), '482917');
  await settle();
  assert.equal(dialog.querySelectorAll('.conn-otp > span.is-error').length, 6);
  assert.equal(dialog.querySelector('.conn-field-msg--error').textContent, 'The code is wrong or has expired.');
  assert.deepEqual(
    [...dialog.querySelectorAll('footer button')].map((b) => b.textContent),
    ['Cancel', 'Enter again']
  );
  await click(buttonNamed(document, 'Enter again'));
  assert.equal(dialog.querySelectorAll('.conn-otp > span.is-error').length, 0);
  assert.equal(dialog.querySelector('input[name="code"]').value, '');
  await click(buttonNamed(document, 'Cancel'));
  assert.equal(document.querySelector('.conn-dialog'), null);
});

test('saved PCs: Open focuses via openRemoteHost, Forget confirms in a dialog, Rename edits the local alias', async (t) => {
  const { document, calls } = await mount(t, {
    hosts: [{ id: 'h1', name: 'Home PC', url: '', addedAt: 1, lastConnectedAt: 0, open: true }],
  });
  const row = () => document.querySelectorAll('.conn-group')[1].querySelector('.conn-row');
  assert.equal(row().querySelector('.conn-status').textContent, 'Online', 'an open window implies online');
  const rowButton = (name) => [...row().querySelectorAll('button')].find((b) => b.textContent === name);
  await click(rowButton('Open'));
  await settle();
  assert.deepEqual(calls, [['open', 'h1']]);

  await click(rowButton('Rename'));
  let dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('input').value, 'Home PC');
  await typeInto(dialog.querySelector('input'), 'Office');
  await click(buttonNamed(document, 'Save'));
  await settle();
  assert.deepEqual(calls.at(-1), ['rename-host', 'h1', 'Office']);
  assert.equal(row().querySelector('b').textContent, 'Office');

  await click(rowButton('Forget'));
  dialog = document.querySelector('.conn-dialog');
  assert.equal(dialog.querySelector('h3').textContent, 'Forget Office');
  assert.deepEqual(
    [...dialog.querySelectorAll('footer button')].map((b) => b.textContent),
    ['Cancel', 'Forget']
  );
  assert.equal(
    calls.some((call) => call[0] === 'forget'),
    false
  );
  await click(dialog.querySelector('.conn-btn--danger'));
  await settle();
  assert.deepEqual(calls.at(-1), ['forget', 'h1']);
  assert.equal(document.querySelectorAll('.conn-group').length, 1, 'no saved PCs left: the group is gone');
});

test('dialogs use the approved frame: 480 wide, 24 padding, 360 body, 64 code tile, 56 rows (design tokens)', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./settings.css', import.meta.url), 'utf8');
  const rule = (selector) => new RegExp(`${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  assert.match(rule('.conn-dialog'), /width: 480px/);
  assert.match(rule('.conn-dialog'), /padding: 24px/);
  assert.match(rule('.conn-dialog'), /gap: 20px/);
  assert.match(rule('.conn-body'), /height: 360px/);
  assert.match(rule('.conn-code-tile'), /height: 64px/);
  assert.match(rule('.conn-row'), /min-height: 56px/);
  assert.match(rule('.conn-btn'), /height: 32px/);
  assert.match(rule('.conn-dialog header p'), /margin: 4px 0 0/);
});

test('a device whose revoke is pending shows "Removing…" and cannot be revoked again', async (t) => {
  const info = readyInfo('eeeeeeee', [
    { ...client('c1', 'Fold · Mixdog App', 'Mixdog App', true), pendingRemoval: true },
    client('c2', 'Laptop · Chrome', 'Chrome', false),
  ]);
  const { document, calls } = await mount(t, { info });
  const [pending, normal] = [...document.querySelectorAll('.conn-list .conn-row')];
  const action = pending.querySelector('button');
  assert.equal(action.textContent, 'Removing…');
  assert.equal(action.disabled, true);
  assert.ok(pending.textContent.includes('Removing…'));
  assert.equal(normal.querySelector('button').textContent, 'Disconnect');
  assert.equal(normal.querySelector('button').disabled, false);
  await click(action);
  assert.deepEqual(calls, []);
});
