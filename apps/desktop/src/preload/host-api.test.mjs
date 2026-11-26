import assert from 'node:assert/strict';
import test from 'node:test';
import { HOST_KEYS } from '../shared/desktop-api-split.ts';
import { DESKTOP_IPC } from '../shared/contract-ipc.ts';
import { createHostApi } from './host-api.ts';

const EXTRAS = [
  'enableAllowAllActions',
  'observeSignIn',
  'previewConvertedDocument',
  'invokePcQuotaCapability',
  'readPcQuotaCapabilities',
  'onEditorBackupFlush',
];

function makeDeps() {
  const calls = [];
  const handlers = new Map();
  const ipcRenderer = {
    on: (channel, handler) => handlers.set(channel, handler),
    send: (...args) => calls.push(['send', ...args]),
    sendSync: (...args) => calls.push(['sendSync', ...args]),
    removeListener: () => {},
  };
  const deps = {
    invokeIpc: (...args) => {
      calls.push(['invoke', ...args]);
      return Promise.resolve(undefined);
    },
    subscribeIpc: () => () => {},
    ipcRenderer,
    webUtils: { getPathForFile: (file) => file.path },
    browserTexture: {
      browserPageFrame: () => null,
      browserPresentTexture: () => {},
      browserDiscardTexture: () => {},
    },
  };
  return { deps, calls, handlers };
}

test('keys_match_classification', () => {
  const before = process.env.MIXDOG_DESKTOP_PERF;
  process.env.MIXDOG_DESKTOP_PERF = '1';
  try {
    const api = createHostApi(makeDeps().deps);
    const expected = [...Object.values(HOST_KEYS).flat(), ...EXTRAS].sort();
    assert.deepEqual(Object.keys(api).sort(), expected);
  } finally {
    if (before === undefined) delete process.env.MIXDOG_DESKTOP_PERF;
    else process.env.MIXDOG_DESKTOP_PERF = before;
  }
});

test('perfLog is absent unless the perf switch is on', () => {
  const before = process.env.MIXDOG_DESKTOP_PERF;
  delete process.env.MIXDOG_DESKTOP_PERF;
  try {
    assert.equal('perfLog' in createHostApi(makeDeps().deps), false);
  } finally {
    if (before !== undefined) process.env.MIXDOG_DESKTOP_PERF = before;
  }
});

test('extras invoke the channels main registers (registerHostExtrasIpc)', async () => {
  const { deps, calls } = makeDeps();
  const api = createHostApi(deps);
  await api.enableAllowAllActions();
  await api.invokePcQuotaCapability({ capability: 'getUsageDashboard' });
  await api.readPcQuotaCapabilities([{ capability: 'getLeadStatus' }]);
  api.observeSignIn('getMcpOAuthLoginStatus', ['f1'], { state: 'done' });
  assert.deepEqual(
    calls.map((c) => c[1]),
    [DESKTOP_IPC.enableAllowAllActions, DESKTOP_IPC.pcQuotaInvoke, DESKTOP_IPC.pcQuotaRead, DESKTOP_IPC.observeSignIn]
  );
  assert.deepEqual(calls[3].slice(2), [{ capability: 'getMcpOAuthLoginStatus', args: ['f1'] }, { state: 'done' }]);
});

test('a notification open before the renderer subscribes is held for it', () => {
  const { deps, handlers } = makeDeps();
  const api = createHostApi(deps);
  handlers.get(DESKTOP_IPC.notificationOpenSession)({}, 's1');
  handlers.get(DESKTOP_IPC.notificationOpenSession)({}, 's2');
  const seen = [];
  api.onNotificationOpenSession((id) => seen.push(id));
  assert.deepEqual(seen, ['s2']);
});

test('folderPathForFile answers an empty path when webUtils throws', () => {
  const { deps } = makeDeps();
  deps.webUtils = {
    getPathForFile: () => {
      throw new Error('x');
    },
  };
  assert.equal(createHostApi(deps).folderPathForFile({}), '');
});

test('every notice raised before the toast region subscribes is held for it', () => {
  const { deps, handlers } = makeDeps();
  const api = createHostApi(deps);
  const raise = handlers.get(DESKTOP_IPC.desktopNotice);
  raise({}, { key: 'a', code: 'secret-storage-failed' });
  raise({}, { key: 'b', code: 'unknown-code' });
  raise({}, { key: 'c', code: 'conversation-save-failed' });
  const seen = [];
  const stop = api.subscribeDesktopNotices((notice) => seen.push(notice.key));
  raise({}, { key: 'd', code: 'secret-storage-failed' });
  stop();
  raise({}, { key: 'e', code: 'secret-storage-failed' });
  assert.deepEqual(seen, ['a', 'c', 'd']);
});

test('held notices deduplicate by key and stop accumulating after unsubscribe', () => {
  const { deps, handlers } = makeDeps();
  const api = createHostApi(deps);
  const raise = handlers.get(DESKTOP_IPC.desktopNotice);
  for (let i = 0; i < 10; i += 1) {
    raise({}, { key: 'dup', code: 'secret-storage-failed', params: { n: String(i) } });
  }
  const first = [];
  const stop = api.subscribeDesktopNotices((notice) => first.push([notice.key, notice.params.n]));
  assert.deepEqual(first, [['dup', '9']], 'repeated keys overwrite rather than growing heldNotices');
  stop();
  raise({}, { key: 'after-unmount-1', code: 'secret-storage-failed' });
  raise({}, { key: 'after-unmount-2', code: 'conversation-save-failed' });
  const second = [];
  const stop2 = api.subscribeDesktopNotices((notice) => second.push(notice.key));
  stop2();
  assert.deepEqual(second, [], 'notices raised after listener teardown are not buffered');
});
