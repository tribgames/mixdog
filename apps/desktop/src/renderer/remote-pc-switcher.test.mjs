import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from './test-support/test-dom.mjs';
import { RemotePcBrandDot, RemotePcCard, RemotePcSwitcher } from './RemotePcSwitcher.tsx';

function installBridge(window, hosts, calls) {
  window.mixdogRemoteWindow = { hostId: 'a', hostName: 'Home PC' };
  window.mixdogRemoteWindowSwitcher = {
    listHosts: () => Promise.resolve(hosts),
    openHost: (id) => {
      calls.push(['open', id]);
      return Promise.resolve(true);
    },
    manageConnections: () => {
      calls.push(['manage']);
      return Promise.resolve(true);
    },
  };
}

test('with one PC the title-bar button names the PC and carries no Remote badge or settings note', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root' });
  const calls = [];
  installBridge(window, [{ id: 'a', name: 'Home PC', online: true, lastConnectedAt: 1, current: true }], calls);
  await act(async () => root.render(React.createElement(RemotePcSwitcher)));
  const button = document.querySelector('button.remote-pc-button');
  assert.equal(button.textContent, 'Home PC');
  assert.ok(button.querySelector('.remote-pc-dot:not(.off)'));
  assert.equal(document.querySelector('.remote-pc-badge'), null);
  assert.equal(document.querySelector('.remote-pc-note'), null);
  // Connect another PC stays reachable with a single saved PC.
  await act(async () => button.click());
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  assert.match(items.at(-3).textContent, /Open another PC/);
  assert.match(items.at(-2).textContent, /Connect a device/);
  assert.match(items.at(-1).textContent, /Connection settings/);
  assert.equal(
    items.some((item) => /Close this remote window/.test(item.textContent)),
    false
  );
});

test('with no saved PC listed the menu opens on its actions, with no orphan separator', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root' });
  installBridge(window, [], []);
  await act(async () => root.render(React.createElement(RemotePcSwitcher)));
  await act(async () => document.querySelector('button.remote-pc-button').click());
  const menu = document.querySelector('.remote-pc-menu');
  assert.equal(menu.querySelector('.remote-pc-sep'), null);
  assert.equal(menu.firstElementChild.getAttribute('role'), 'menuitem');
  assert.ok([...menu.querySelectorAll('[role="menuitem"]')].every((item) => item.classList.contains('mx-menu-item')));
});

test('phone: the brand dot is green when connected and grey when the PC is offline', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root' });
  installBridge(window, [{ id: 'a', name: 'Home PC', online: true, lastConnectedAt: 1, current: true }], []);
  await act(async () => root.render(React.createElement(RemotePcBrandDot)));
  assert.ok(document.querySelector('.workspace-tab-home-dot:not(.off)'));
  installBridge(window, [{ id: 'a', name: 'Home PC', online: false, lastConnectedAt: 1, current: true }], []);
  await act(async () => root.render(React.createElement(RemotePcBrandDot, { key: 'again' })));
  assert.ok(document.querySelector('.workspace-tab-home-dot.off'));
});

test('phone: the drawer PC card shows name and state; with several PCs it opens the PC list', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root' });
  const calls = [];
  installBridge(window, [{ id: 'a', name: 'Home PC', online: true, lastConnectedAt: 1, current: true }], calls);
  await act(async () => root.render(React.createElement(RemotePcCard)));
  assert.match(document.querySelector('.remote-pc-card').textContent, /Home PC/);
  assert.equal(document.querySelector('.remote-pc-card-state'), null);
  assert.ok(document.querySelector('.remote-pc-card .remote-pc-dot:not(.off)'));
  assert.equal(document.querySelector('.remote-pc-card svg'), null);
  assert.equal(document.querySelector('button.remote-pc-card-head'), null);

  installBridge(
    window,
    [
      { id: 'a', name: 'Home PC', online: true, lastConnectedAt: 1, current: true },
      { id: 'b', name: 'Studio PC', online: false, lastConnectedAt: 2, current: false },
    ],
    calls
  );
  await act(async () => root.render(React.createElement(RemotePcCard, { key: 'several' })));
  await act(async () => document.querySelector('button.remote-pc-card-head').click());
  const items = [...document.querySelectorAll('.remote-pc-card-menu [role="menuitem"]')];
  assert.equal(items.length, 5);
  assert.match(items[1].textContent, /Studio PC.*Offline/);
  assert.match(items[2].textContent, /Open another PC/);
  assert.match(items[3].textContent, /Connect a device/);
  assert.match(items[4].textContent, /Connection settings/);
  await act(async () => items[1].click());
  assert.deepEqual(calls, [['open', 'b']]);
});

test('without a saved-PC entry the name announced by the connected PC is used everywhere, "PC" last', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root' });
  const { setRemoteHostName } = await import('./remote-host-access.ts');
  window.mixdogRemoteWindowSwitcher = {
    listHosts: () => Promise.resolve([{ id: 'a', name: '', online: true, lastConnectedAt: 1, current: true }]),
    openHost: () => Promise.resolve(true),
    manageConnections: () => Promise.resolve(true),
  };
  try {
    await act(async () => root.render(React.createElement(RemotePcCard)));
    assert.equal(document.querySelector('.remote-pc-card-name').textContent, 'PC');
    await act(async () => setRemoteHostName('DESKTOP-IBLP835'));
    assert.equal(document.querySelector('.remote-pc-card-name').textContent, 'DESKTOP-IBLP835');
    await act(async () => root.render(React.createElement(RemotePcSwitcher)));
    assert.equal(document.querySelector('button.remote-pc-button').textContent, 'DESKTOP-IBLP835');
    await act(async () => document.querySelector('button.remote-pc-button').click());
    assert.match(document.querySelector('.remote-pc-menu [role="menuitem"]').textContent, /DESKTOP-IBLP835/);
  } finally {
    setRemoteHostName('');
  }
});

test('rail placement: a compact rail cell named by the PC, whose menu opens beside the rail', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root' });
  installBridge(window, [{ id: 'a', name: 'Home PC', online: false, lastConnectedAt: 1, current: true }], []);
  await act(async () => root.render(React.createElement(RemotePcSwitcher, { placement: 'rail' })));
  const button = document.querySelector('.remote-pc-switcher-rail > button.remote-pc-rail-button');
  assert.equal(button.getAttribute('aria-label'), 'Home PC');
  assert.equal(button.textContent, '');
  assert.ok(button.querySelector('.remote-pc-dot.off'));
  await act(async () => button.click());
  assert.match(document.querySelector('.remote-pc-switcher-rail > .remote-pc-menu').textContent, /Home PC/);
});

test('plain browser tab: no title band, the rail carries the switcher; Electron keeps the band', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root' });
  installBridge(window, [{ id: 'a', name: 'Home PC', online: true, lastConnectedAt: 1, current: true }], []);
  const { DesktopTitlebar } = await import('./titlebar.tsx');
  await act(async () => root.render(React.createElement(DesktopTitlebar)));
  assert.equal(document.querySelector('header.topbar'), null);
  assert.equal(document.documentElement.getAttribute('data-mixdog-titlebar'), 'hidden');
  await act(async () => root.render(null));
  assert.equal(document.documentElement.hasAttribute('data-mixdog-titlebar'), false);
});

test('Electron renderer keeps the title band with the switcher at its leading edge', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root', globals: ELECTRON });
  installBridge(window, [{ id: 'a', name: 'Home PC', online: true, lastConnectedAt: 1, current: true }], []);
  const { DesktopTitlebar } = await import('./titlebar.tsx');
  await act(async () => root.render(React.createElement(DesktopTitlebar)));
  await settleChip();
  assert.ok(document.querySelector('header.topbar > .remote-pc-switcher:not(.remote-pc-switcher-rail)'));
  assert.equal(document.documentElement.hasAttribute('data-mixdog-titlebar'), false);
});

test('with several PCs the menu lists them with state, switches, and offers code connect + manage', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root' });
  const calls = [];
  installBridge(
    window,
    [
      { id: 'a', name: 'Home PC', online: true, lastConnectedAt: 1, current: true },
      { id: 'b', name: 'Studio PC', online: false, lastConnectedAt: 2, current: false },
    ],
    calls
  );
  await act(async () => root.render(React.createElement(RemotePcSwitcher)));
  await act(async () => document.querySelector('button.remote-pc-button').click());
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  assert.equal(items.length, 5);
  assert.match(items[0].textContent, /Home PC.*In use/);
  assert.match(items[1].textContent, /Studio PC.*Offline/);
  assert.equal(items[0].disabled, true);
  assert.match(items[2].textContent, /Open another PC/);
  assert.match(items[4].textContent, /Connection settings/);
  await act(async () => items[1].click());
  assert.deepEqual(calls, [['open', 'b']]);
  await act(async () => document.querySelector('button.remote-pc-button').click());
  await act(async () => [...document.querySelectorAll('[role="menuitem"]')][2].click());
  assert.deepEqual(calls.at(-1), ['manage']);
});

test('an authenticated host name is persisted per device and replaces an empty or stale label', async (t) => {
  const { window } = installTestDom(t, {
    jsdom: { url: 'https://relay.example/d/0123456789abcdef0123456789abcdef/' },
    expose: ['localStorage', 'location'],
  });
  const { savePcName, readSavedPcs } = await import('./remote-saved-pcs.ts');
  const id = '0123456789abcdef0123456789abcdef';
  const other = 'fedcba9876543210fedcba9876543210';
  window.localStorage.setItem('mixdog.savedPcs', JSON.stringify([{ deviceId: other, name: '', lastConnectedAt: 1 }]));
  savePcName(id, '  Home PC ');
  savePcName(other, 'Office PC');
  assert.deepEqual(
    readSavedPcs()
      .map((pc) => [pc.deviceId, pc.name])
      .sort(),
    [
      [id, 'Home PC'],
      [other, 'Office PC'],
    ].sort()
  );
  savePcName(id, 'Renamed PC');
  assert.equal(readSavedPcs().find((pc) => pc.deviceId === id).name, 'Renamed PC');
  savePcName(id, '');
  assert.equal(readSavedPcs().find((pc) => pc.deviceId === id).name, 'Renamed PC', 'an empty name never wipes a label');
});

// The main window is Electron without a remote-window marker (a plain browser is a remote surface).
const ELECTRON = { navigator: { userAgent: 'Mozilla/5.0 Electron/30 Mixdog' } };

function installMainWindow(
  window,
  { hosts = [], settings = { enabled: true, name: 'Studio PC', defaultName: 'DESKTOP-IBLP835' } } = {},
  calls = []
) {
  window.mixdogDesktop = {
    listRemoteHosts: () => Promise.resolve(hosts),
    getRemoteAccessSettings: () => Promise.resolve(settings),
    subscribeRemoteAccessSettings: () => () => undefined,
    openRemoteHost: (id) => {
      calls.push(['open', id]);
      return Promise.resolve(hosts);
    },
  };
}

const settleChip = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });

test('main window, no saved PCs: the chip renders nothing', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root', globals: ELECTRON });
  installMainWindow(window);
  await act(async () => root.render(React.createElement(RemotePcSwitcher)));
  await settleChip();
  assert.equal(document.querySelector('.remote-pc-switcher'), null);
});

test('main window, saved PCs: "● this PC name ▾" and a menu with online / window-open state', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root', globals: ELECTRON });
  const calls = [];
  installMainWindow(
    window,
    {
      hosts: [
        { id: 'a', name: 'Home PC', url: '', addedAt: 1, lastConnectedAt: Date.now() - 5000, open: true, online: true },
        { id: 'b', name: 'Office PC', url: '', addedAt: 1, lastConnectedAt: 2, open: false, online: false },
      ],
    },
    calls
  );
  await act(async () => root.render(React.createElement(RemotePcSwitcher)));
  await settleChip();
  const button = document.querySelector('button.remote-pc-button');
  assert.equal(button.textContent, 'Studio PC');
  assert.ok(button.querySelector('.remote-pc-dot:not(.off)'));
  assert.ok(button.querySelector('svg'), 'chevron');
  assert.ok(!/\d/.test(button.textContent), 'no device counts');

  await act(async () => button.click());
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  assert.equal(items.length, 6);
  assert.match(items[0].textContent, /Studio PC.*This PC · In use/);
  assert.match(items[1].textContent, /Home PC.*Online · Window open/);
  assert.match(items[2].textContent, /Office PC.*Offline · /);
  assert.ok(items[2].querySelector('.remote-pc-dot.off'));
  assert.ok(items[0].disabled);
  assert.deepEqual(
    items.slice(3).map((item) => item.textContent),
    ['Open another PC', 'Connect a device', 'Connection settings']
  );
  assert.ok(
    items.slice(3).every((item) => item.querySelector('svg')),
    'action rows carry icons'
  );
  await act(async () => items[1].click());
  assert.deepEqual(calls, [['open', 'a']], 'a click opens or focuses that PC window');
  assert.equal(document.querySelector('.remote-pc-menu'), null);
});

test('main window menu actions open Settings → Connection, with the C dialog, the A dialog or neither', async (t) => {
  const { takeConnectionDialogRequest } = await import('./settings/connection-intent.ts');
  const { root, document, window } = installTestDom(t, { rootId: 'root', expose: ['Event'], globals: ELECTRON });
  installMainWindow(window, {
    hosts: [{ id: 'a', name: 'Home PC', url: '', addedAt: 1, lastConnectedAt: 2, open: false, online: false }],
  });
  let opened = 0;
  window.addEventListener('mixdog:open-connection-settings', () => (opened += 1));
  await act(async () => root.render(React.createElement(RemotePcSwitcher)));
  await settleChip();
  const seen = [];
  for (const label of ['Open another PC', 'Connect a device', 'Connection settings']) {
    await act(async () => document.querySelector('button.remote-pc-button').click());
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === label);
    await act(async () => item.click());
    seen.push(takeConnectionDialogRequest());
  }
  assert.deepEqual(seen, ['open-pc', 'connect', null]);
  assert.equal(opened, 3);
});

test('without the desktop bridge and outside a remote window the chip renders nothing', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root', globals: ELECTRON });
  await act(async () => root.render(React.createElement(RemotePcSwitcher)));
  assert.equal(document.querySelector('.remote-pc-switcher'), null);
});

test('main window: SSH servers join the PC menu with an "SSH · " detail; an open one is focused, a closed one opens the connect dialog; "Connect SSH server" is an action', async (t) => {
  const { takeConnectionDialogRequest, takeSshHostRequest } = await import('./settings/connection-intent.ts');
  const { root, document, window } = installTestDom(t, { rootId: 'root', expose: ['Event'], globals: ELECTRON });
  installMainWindow(window);
  const calls = [];
  const ssh = [
    { id: 's1', name: 'My VPS', target: 'root@vps.example.com', lastConnectedAt: Date.now() - 1000, open: true },
    { id: 's2', name: 'gpu-box', target: 'gpu-box', lastConnectedAt: Date.now() - 5000, open: false },
  ];
  window.mixdogDesktop.sshListHosts = () => Promise.resolve(ssh);
  window.mixdogDesktop.sshOpenHost = (id) => {
    calls.push(['ssh-open', id]);
    return Promise.resolve({ ok: true, host: ssh[0] });
  };
  await act(async () => root.render(React.createElement(RemotePcSwitcher)));
  await settleChip();
  const openMenu = () => act(async () => document.querySelector('button.remote-pc-button').click());
  const items = () => [...document.querySelectorAll('[role="menuitem"]')];
  await openMenu();
  assert.match(items()[1].textContent, /My VPS.*SSH · Online · Window open/);
  assert.match(items()[2].textContent, /gpu-box.*SSH · /);
  assert.deepEqual(
    items()
      .slice(3)
      .map((item) => item.textContent),
    ['Open another PC', 'Connect SSH server', 'Connect a device', 'Connection settings']
  );

  await act(async () => items()[1].click());
  assert.deepEqual(calls, [['ssh-open', 's1']]);
  assert.equal(takeConnectionDialogRequest(), null, 'an open window is focused without leaving the page');

  await openMenu();
  await act(async () => items()[2].click());
  assert.equal(takeConnectionDialogRequest(), 'ssh-host');
  assert.deepEqual(
    takeSshHostRequest(),
    { id: 's2', name: 'gpu-box', target: 'gpu-box' },
    'a closed one connects through the dialog'
  );

  await openMenu();
  await act(async () =>
    items()
      .find((item) => item.textContent === 'Connect SSH server')
      .click()
  );
  assert.equal(takeConnectionDialogRequest(), 'ssh');
});
