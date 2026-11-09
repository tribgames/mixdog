import assert from 'node:assert/strict';
import test from 'node:test';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

// Node's version (b6f10295a) read each gate off the relay challenge's flags and re-read them on every leg. The table is the same
// (remote-shim-api.ts); the gates are the context's `peer*` flags, which the phone sets per connection from the core's capabilities
// (apps/mobile/src/phone-capabilities.ts, `peerFlagsOf`; remote-host-parity.test.mjs holds that mapping). A gate reads the flag at the time of
// the access, so a flag withdrawn by a later leg withdraws the member. Not kept: the normalization of pushed tab lists and import progress
// (malformed rows dropped, `loading` coerced) -- nothing in the phone delivers those pushes until PH-2's browser adapter does.

const BROWSER_MEMBERS = [
  'remoteBrowserTabs',
  'remoteBrowserOpenTab',
  'remoteBrowserCloseTab',
  'onRemoteBrowserTabs',
  'browserHistorySearch',
  'browserCredentialSuggestions',
  'browserCredentialFill',
  'browserProfileImportSources',
  'browserProfileImportStart',
  'onBrowserProfileImportProgress',
];

test('project recovery is gated by the current host flag, including a later leg', async () => {
  await withPhoneApi({ projectRecovery: () => ({ records: [] }) }, async ({ ctx, api, calls }) => {
    ctx.peerProjectRecovery = false;
    assert.equal(api.projectRecovery, undefined);
    ctx.peerProjectRecovery = true;
    assert.deepEqual(await api.projectRecovery('/project', { action: 'list' }), { records: [] });
    assert.deepEqual(calls, [{ method: 'projectRecovery', params: ['/project', { action: 'list' }] }]);
    ctx.peerProjectRecovery = false;
    assert.equal(api.projectRecovery, undefined);
  });
});

test('a host without browserParity leaves the pane on its single stream', async () => {
  await withPhoneApi({}, async ({ ctx, api }) => {
    ctx.peerBrowserParity = false;
    for (const key of BROWSER_MEMBERS) assert.equal(api[key], undefined, `${key} is absent`);
    assert.equal(typeof api.remoteBrowserStream, 'function');
  });
});

test('a browserParity host exposes tabs, history, saved logins and import over their own methods', async () => {
  const handlers = Object.fromEntries(
    ['browserRemoteTabs', 'browserRemoteTabOpen', 'browserRemoteTabClose', 'browserHistorySearch', 'browserCredentialSuggestions', 'browserCredentialFill', 'browserProfileImportSources'].map(
      (method) => [method, () => method]
    )
  );
  await withPhoneApi(handlers, async ({ ctx, api, calls }) => {
    ctx.peerBrowserParity = true;
    for (const key of BROWSER_MEMBERS) assert.equal(typeof api[key], 'function', `${key} is present`);

    const expected = [
      ['browserRemoteTabs', [true], () => api.remoteBrowserTabs(true)],
      ['browserRemoteTabOpen', ['https://a.test/'], () => api.remoteBrowserOpenTab('https://a.test/')],
      ['browserRemoteTabClose', ['main-browser-a'], () => api.remoteBrowserCloseTab('main-browser-a')],
      ['browserHistorySearch', ['ex'], () => api.browserHistorySearch('ex')],
      ['browserCredentialSuggestions', ['main-browser-a'], () => api.browserCredentialSuggestions('main-browser-a')],
      ['browserCredentialFill', ['main-browser-a', 'a'.repeat(24)], () => api.browserCredentialFill('main-browser-a', 'a'.repeat(24))],
      ['browserProfileImportSources', undefined, () => api.browserProfileImportSources()],
    ];
    for (const [method, params, invoke] of expected) {
      const before = calls.length;
      assert.equal(await invoke(), method);
      assert.equal(calls.length, before + 1);
      assert.equal(calls.at(-1).method, method);
      if (params) assert.deepEqual(calls.at(-1).params, params);
    }
  });
});

test('only a host advertising browserDrive is driven at the phone size, read on every access', async () => {
  await withPhoneApi({}, async ({ ctx, api }) => {
    ctx.peerBrowserParity = true;
    assert.equal(api.remoteBrowserDrive, false, 'a browserParity host without browserDrive predates the control');
    ctx.peerBrowserDrive = true;
    assert.equal(api.remoteBrowserDrive, true);
    ctx.peerBrowserDrive = false;
    assert.equal(api.remoteBrowserDrive, false, 'a reconnect to an older host withdraws it');
  });
});

test('conversation browser tabs follow the browserSessionTabs flag, read on every access', async () => {
  await withPhoneApi({}, async ({ ctx, api }) => {
    assert.equal(api.remoteBrowserSessionTabs, false, 'a legacy host has no conversation tab controls');
    ctx.peerBrowserSessionTabs = true;
    assert.equal(api.remoteBrowserSessionTabs, true);
    ctx.peerBrowserSessionTabs = false;
    assert.equal(api.remoteBrowserSessionTabs, false);
  });
});

test('listHostDirectories is absent on a legacy handshake so the folder browser falls back', async () => {
  await withPhoneApi({ listHostDirectories: () => 'ok' }, async ({ ctx, api, calls }) => {
    assert.equal(ctx.peerHostDirectories, false);
    assert.equal(api.listHostDirectories, undefined);
    ctx.peerHostDirectories = true;
    assert.equal(typeof api.listHostDirectories, 'function');
    assert.equal(await api.listHostDirectories('/h'), 'ok');
    assert.deepEqual(calls, [{ method: 'listHostDirectories', params: ['/h'] }]);
  });
});
