import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract.ts';
import { connectionFeatureGate } from './connections/feature-gates.ts';
import { registerBrowserIpc } from './ipc-browser.ts';

const ID = 'a1b2c3d4e5f60718293a4b5c';

function setup() {
  const handlers = new Map();
  const calls = [];
  const browserHost = {
    browserVaultLogins: async () => [],
    browserVaultSave: async (input) => void calls.push(['save', input]),
    browserVaultDelete: async (id) => {
      calls.push(['delete', id]);
      return true;
    },
    browserLinkedSignIns: async () => [],
    browserLinkedSignInDelete: async (id) => {
      calls.push(['delete-linked', id]);
      return true;
    },
  };
  registerBrowserIpc({ handle: (channel, fn) => handlers.set(channel, fn), browserHost });
  return { call: (channel, ...args) => handlers.get(channel)({}, ...args), calls };
}

test('a saved login from the settings page is passed on trimmed and bounded', async () => {
  const { call, calls } = setup();
  await call(DESKTOP_IPC.browserVaultSave, {
    id: ID,
    origin: ' https://shop.example.com ',
    username: ' me ',
    password: ' keep spaces ',
    totpSecret: ' GEZDGNBV ',
    note: 'work',
    injected: 'dropped',
  });
  assert.deepEqual(calls, [
    [
      'save',
      { id: ID, origin: 'https://shop.example.com', username: 'me', password: ' keep spaces ', totpSecret: 'GEZDGNBV', note: 'work' },
    ],
  ]);
});

test('junk, oversized and incomplete saved logins are refused before the vault is touched', async () => {
  const { call, calls } = setup();
  const big = 'x'.repeat(4097);
  const bad = [
    undefined,
    null,
    'login',
    42,
    [],
    {},
    { origin: 'https://a.example', username: '   ' },
    { origin: '', username: 'me' },
    { origin: { toString: () => 'https://a.example' }, username: 'me' },
    { origin: 'https://a.example', username: 7 },
    { origin: big, username: 'me' },
    { origin: 'https://a.example', username: big },
    { origin: 'https://a.example', username: 'me', password: big },
    { origin: 'https://a.example', username: 'me', password: 12 },
    { origin: 'https://a.example', username: 'me', totpSecret: big },
    { origin: 'https://a.example', username: 'me', note: big },
    { origin: 'https://a.example', username: 'me', id: 'not-an-id' },
    { origin: 'https://a.example', username: 'me', id: null },
  ];
  for (const input of bad) {
    await assert.rejects(async () => call(DESKTOP_IPC.browserVaultSave, input), TypeError, JSON.stringify(input));
  }
  assert.deepEqual(calls, []);
  // The limit itself is allowed.
  await call(DESKTOP_IPC.browserVaultSave, { origin: 'https://a.example', username: 'me', password: 'x'.repeat(4096) });
  assert.equal(calls.length, 1);
});

test('only a 24-hex saved-login id reaches delete', async () => {
  const { call, calls } = setup();
  assert.equal(await call(DESKTOP_IPC.browserVaultDelete, ID), true);
  for (const id of [
    undefined,
    null,
    42,
    {},
    '',
    ID.toUpperCase(),
    `${ID}0`,
    ID.slice(1),
    `${ID.slice(0, 23)}g`,
    `${ID}\n`,
    '../../etc/passwd',
    'x'.repeat(100_000),
    'https://shop.example.com',
  ]) {
    await assert.rejects(async () => call(DESKTOP_IPC.browserVaultDelete, id), /Saved login id is invalid/);
  }
  assert.deepEqual(calls, [['delete', ID]]);
});

test('only a 24-hex linked sign-in id reaches its delete', async () => {
  const { call, calls } = setup();
  assert.deepEqual(await call(DESKTOP_IPC.browserLinkedSignIns), []);
  assert.equal(await call(DESKTOP_IPC.browserLinkedSignInDelete, ID), true);
  for (const id of [undefined, null, 42, '', ID.toUpperCase(), `${ID}0`, 'chatgpt.com']) {
    await assert.rejects(async () => call(DESKTOP_IPC.browserLinkedSignInDelete, id), /Linked sign-in id is invalid/);
  }
  assert.deepEqual(calls, [['delete-linked', ID]]);
});

test('a server window refuses every vault channel; this PC allows them', () => {
  for (const channel of [
    DESKTOP_IPC.browserVaultLogins,
    DESKTOP_IPC.browserVaultSave,
    DESKTOP_IPC.browserVaultDelete,
    DESKTOP_IPC.browserLinkedSignIns,
    DESKTOP_IPC.browserLinkedSignInDelete,
  ]) {
    const refusal = connectionFeatureGate('ssh', channel);
    assert.ok(refusal, channel);
    assert.equal(refusal.code, 'ssh-unsupported');
    assert.match(refusal.message, /not available in a server window/);
    assert.equal(connectionFeatureGate('local', channel), null);
  }
});
