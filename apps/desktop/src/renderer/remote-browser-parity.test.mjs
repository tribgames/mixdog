import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteApi } from './remote-shim-api.ts';
import { publishedCeilings, withShim } from './remote-shim-test-harness.mjs';

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

const connect = async ({ ctx, dial }, browserParity) => {
  ctx.updaterListeners = new Set();
  ctx.settingsChangedListeners = new Set();
  const api = createRemoteApi(ctx);
  const leg = await dial({ remoteParity: true, browserParity, ready: publishedCeilings(4096, 4096) });
  return { api, leg };
};

test('a host without browserParity leaves the pane on its single stream', async () => {
  await withShim({}, async (shim) => {
    const { api } = await connect(shim, false);
    assert.equal(shim.ctx.peerBrowserParity, false);
    for (const key of BROWSER_MEMBERS) assert.equal(api[key], undefined, `${key} is absent`);
    assert.equal(typeof api.remoteBrowserStream, 'function');
  });
});

test('a browserParity host exposes tabs, history, saved logins and import over their own methods', async () => {
  await withShim({}, async (shim) => {
    const { api, leg } = await connect(shim, true);
    assert.equal(shim.ctx.peerBrowserParity, true);
    for (const key of BROWSER_MEMBERS) assert.equal(typeof api[key], 'function', `${key} is present`);

    const expected = [
      ['browserRemoteTabs', [true], () => api.remoteBrowserTabs(true)],
      ['browserRemoteTabOpen', ['https://a.test/'], () => api.remoteBrowserOpenTab('https://a.test/')],
      ['browserRemoteTabClose', ['main-browser-a'], () => api.remoteBrowserCloseTab('main-browser-a')],
      ['browserHistorySearch', ['ex'], () => api.browserHistorySearch('ex')],
      ['browserCredentialSuggestions', ['main-browser-a'], () => api.browserCredentialSuggestions('main-browser-a')],
      [
        'browserCredentialFill',
        ['main-browser-a', 'a'.repeat(24)],
        () => api.browserCredentialFill('main-browser-a', 'a'.repeat(24)),
      ],
      ['browserProfileImportSources', undefined, () => api.browserProfileImportSources()],
    ];
    for (const [method, params, invoke] of expected) {
      const pending = invoke();
      const frame = await leg.nextPayload();
      assert.equal(frame.method, method);
      if (params) assert.deepEqual(frame.params, params);
      await leg.deliver({ id: frame.id, ok: true, value: method });
      assert.equal(await pending, method);
    }
  });
});

test('pushed tab lists and import progress reach their listeners; malformed rows are dropped', async () => {
  await withShim({}, async (shim) => {
    const { api, leg } = await connect(shim, true);
    const tabs = [];
    const progress = [];
    const offTabs = api.onRemoteBrowserTabs((list) => tabs.push(list));
    const offProgress = api.onBrowserProfileImportProgress((update) => progress.push(update));
    await leg.deliver({
      event: 'browserRemoteTabs',
      payload: [{ id: 'main-browser-a', title: 'A', url: 'https://a.test/', loading: 1 }, { id: 7 }, null],
    });
    await leg.deliver({ event: 'browserProfileImportProgress', payload: { jobId: 'job', item: 'history', state: 'running' } });
    await leg.deliver({ event: 'browserProfileImportProgress', payload: 'nope' });
    assert.deepEqual(tabs, [[{ id: 'main-browser-a', title: 'A', url: 'https://a.test/', loading: false }]]);
    assert.deepEqual(progress, [{ jobId: 'job', item: 'history', state: 'running' }]);
    offTabs();
    offProgress();
    assert.equal(shim.ctx.remoteBrowserTabListeners.size, 0);
    assert.equal(shim.ctx.browserImportProgressListeners.size, 0);
  });
});
