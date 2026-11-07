// The renderer's desktop operations as core requests (desktop-operation-route.ts): the exact op and params each
// converted operation sends, the operations that never leave the process, and the lane. Expectations are written from
// the Rust params structs (`v2/params.rs`) and the spec map (`operations_map.json`), not from the router.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { BROWSER_PERMISSION_KINDS } from '../../shared/browser-permission-policy.ts';

import {
  ROUTED_DESKTOP_OPERATIONS,
  NOTIFICATION_DESKTOP_OPERATIONS,
  REPLY_DESKTOP_OPERATIONS,
  UNROUTED_DESKTOP_OPERATIONS,
  createOperationLane,
  routeDesktopOperation,
} from './desktop-operation-route.ts';

const schemaDir = new URL('../../../../../native/core/crates/mixdog-app-protocol/schema/', import.meta.url);
const json = (name) => JSON.parse(readFileSync(new URL(name, schemaDir), 'utf8'));
const operations = json('operations_map.json').inventory.filter((row) => row.list === 'operations');
const clientMethods = json('client_methods.json');
const paramsSchema = (method) => clientMethods.definitions[clientMethods.methods[method].params.$ref.split('/').pop()];

const R = '/repo';
const U = '/user-data';
const FILES = [{ relPath: 'a.txt', content: 'x', expectedContent: 'w' }];
const POLICY = {
  defaults: Object.fromEntries(BROWSER_PERMISSION_KINDS.map((kind) => [kind, 'ask'])),
  sites: [{ origin: 'https://a.example', permission: 'geolocation', setting: 'allow' }],
};

// [operation, positional args, method, params]
const CASES = [
  ['gitAbortOperation', [R], 'git/abortOperation', { cwd: R }],
  ['gitAmend', [R, 'm'], 'git/amend', { cwd: R, message: 'm' }],
  ['gitAmend', [R], 'git/amend', { cwd: R }],
  ['gitApplyPatch', [R, 'a.txt', 'P', true], 'git/applyPatch', { cwd: R, path: 'a.txt', patch: 'P', reverse: true }],
  ['gitBranches', [R], 'git/branches', { cwd: R }],
  ['gitCherryPickCommit', [R, 'abc'], 'git/cherryPickCommit', { cwd: R, value: 'abc' }],
  ['gitCommit', [R, 'm'], 'git/commit', { cwd: R, message: 'm' }],
  ['gitCommitPaths', [R, 'm', ['a', 'b']], 'git/commitPaths', { cwd: R, input: { message: 'm', paths: ['a', 'b'] } }],
  ['gitContinue', [R], 'git/continue', { cwd: R }],
  ['gitCreateTag', [R, 'v1', 'abc'], 'git/createTag', { cwd: R, value: 'v1', at: 'abc' }],
  ['gitDeleteBranch', [R, 'topic'], 'git/deleteBranch', { cwd: R, input: { branch: 'topic' } }],
  ['gitDeleteTag', [R, 'v1'], 'git/deleteTag', { cwd: R, value: 'v1' }],
  [
    'gitDiff',
    [R, 'a', true, true, false],
    'git/diff',
    { cwd: R, path: 'a', staged: true, worktreeOnly: true, untracked: false },
  ],
  ['gitFetch', [R], 'git/fetch', { cwd: R }],
  ['gitIgnore', [R, 'a', 'folder'], 'git/ignore', { cwd: R, path: 'a', scope: 'folder' }],
  ['gitLog', [R, 'q', 5, 40], 'git/log', { cwd: R, query: 'q', skip: 5, limit: 40 }],
  ['gitPull', [R], 'git/pull', { cwd: R }],
  ['gitPush', [R], 'git/push', { cwd: R }],
  [
    'gitRenameBranch',
    [R, 'old', 'new'],
    'git/renameBranch',
    { cwd: R, input: { branch: 'old', nextBranch: 'new' } },
  ],
  [
    'gitResetToCommit',
    [R, 'abc', 'hard', true],
    'git/resetToCommit',
    { cwd: R, value: 'abc', mode: 'hard', confirmedDirty: true },
  ],
  ['gitRevertCommit', [R, 'abc'], 'git/revertCommit', { cwd: R, value: 'abc' }],
  [
    'gitRevertFile',
    [R, 'a', false, 'worktree'],
    'git/revertFile',
    { cwd: R, path: 'a', untracked: false, mode: 'worktree' },
  ],
  ['gitReview', [R, 'worktree'], 'review/diff/get', { scope: 'repo', cwd: R, source: 'worktree' }],
  ['gitReview', [R], 'review/diff/get', { scope: 'repo', cwd: R }],
  [
    'gitReviewDiff',
    [R, 'a', true, 'branch'],
    'review/diff/get',
    { scope: 'repo', cwd: R, path: 'a', untracked: true, source: 'branch', patch: true },
  ],
  [
    'gitReviewDiffs',
    [R, [{ path: 'a', untracked: false }], 'branch'],
    'review/diff/get',
    { scope: 'repo', cwd: R, files: [{ path: 'a', untracked: false }], source: 'branch', patch: true },
  ],
  ['gitShow', [R, 'abc'], 'git/show', { cwd: R, hash: 'abc' }],
  ['gitShowDiff', [R, 'abc', 'a'], 'git/showDiff', { cwd: R, hash: 'abc', path: 'a' }],
  ['gitShowFile', [R, 'abc', 'a'], 'git/showFile', { cwd: R, rev: 'abc', path: 'a' }],
  [
    'gitRequestContext',
    [R, { paths: ['a'], base: 'main' }],
    'git/requestContext',
    { cwd: R, input: { paths: ['a'], base: 'main' } },
  ],
  ['gitStage', [R, ['a']], 'git/stage', { cwd: R, paths: ['a'] }],
  ['gitStash', [R, 'wip'], 'git/stash', { cwd: R, message: 'wip' }],
  ['gitStashApply', [R, 'stash@{0}'], 'git/stashApply', { cwd: R, ref: 'stash@{0}' }],
  ['gitStashDrop', [R, 'stash@{0}'], 'git/stashDrop', { cwd: R, ref: 'stash@{0}' }],
  ['gitStashList', [R], 'git/stashList', { cwd: R }],
  ['gitStashPop', [R], 'git/stashPop', { cwd: R }],
  ['gitStatus', [R], 'git/status', { cwd: R }],
  ['gitStatus', [R, { skipLineStats: true }], 'git/status', { cwd: R }],
  ['gitSync', [R], 'git/sync', { cwd: R }],
  ['gitUndoLastCommit', [R], 'git/undoLastCommit', { cwd: R }],
  ['gitUnstage', [R, ['a']], 'git/unstage', { cwd: R, paths: ['a'] }],
  ['gitCliStatus', [true], 'git/cliStatus', { refresh: true }],
  ['gitCliStatus', [], 'git/cliStatus', {}],
  ['gitGlobalConfig', [], 'git/globalConfig/read', {}],
  ['installGitCli', [], 'git/cli/install', {}],
  ['setGitGlobalConfig', ['user.name', 'Ann'], 'git/globalConfig/write', { key: 'user.name', value: 'Ann' }],

  ['ghPrCheckout', [R, 7], 'github/pr/checkout', { cwd: R, value: 7 }],
  ['ghPrCreate', [R, { title: 't' }], 'github/pr/create', { cwd: R, value: { title: 't' } }],
  ['ghPrDefaultBranch', [R], 'github/pr/defaultBranch', { cwd: R }],
  ['ghPrDiff', [R, 7], 'github/pr/diff', { cwd: R, value: 7 }],
  ['ghPrList', [R], 'github/pr/list', { cwd: R }],
  ['ghPrMerge', [R, 7, 'squash'], 'github/pr/merge', { cwd: R, value: 7, method: 'squash' }],
  ['ghPrView', [R, 7], 'github/pr/view', { cwd: R, value: 7 }],
  ['cancelGithubCliLogin', ['f1'], 'github/login/cancel', { flowId: 'f1' }],
  ['githubCliAccount', [], 'github/account', {}],
  ['githubCliLoginStart', [], 'github/login/start', {}],
  ['githubCliLoginStatus', ['f1'], 'github/login/status', { flowId: 'f1' }],
  ['githubCliLoginOpenBrowser', ['f1'], 'github/login/openBrowser', { flowId: 'f1' }],
  ['githubCliLogout', [], 'github/logout', {}],
  ['githubCliStatus', [true], 'github/status', { refresh: true }],
  ['installGithubCli', [], 'github/install', {}],
  ['githubStarStatus', [], 'github/starStatus', {}],
  ['starGithub', [], 'github/star', {}],

  ['libreOfficeStatus', [true], 'document/libreOfficeStatus', { refresh: true }],
  ['documentPreviewIn', [R, 'a.docx'], 'document/preview', { root: R, rel: 'a.docx' }],
  [
    'documentPreviewPagesIn',
    [R, 'a.docx', { pages: [1] }],
    'document/previewPages',
    { root: R, rel: 'a.docx', options: { pages: [1] } },
  ],
  ['installLibreOffice', [], 'document/installLibreOffice', {}],

  ['deleteEditorBackup', [U, '/p/a.txt'], 'projectFs/backup/delete', { sourcePath: '/p/a.txt' }],
  ['readEditorBackup', [U, '/p/a.txt'], 'projectFs/backup/read', { sourcePath: '/p/a.txt' }],
  [
    'writeEditorBackup',
    [U, '/p/a.txt', 'c', 'e'],
    'projectFs/backup/write',
    { sourcePath: '/p/a.txt', content: 'c', expectedContent: 'e' },
  ],
  ['readLocalFileAbs', ['/x/a.png'], 'projectFs/readLocal', { path: '/x/a.png' }],
  ['statLocalEntryAbs', ['/x/a.png'], 'projectFs/statLocal', { paths: ['/x/a.png'] }],
  ['readProjectTextFileIn', [R, 'a'], 'projectFs/readText', { root: R, rel: 'a' }],
  ['readProjectTextFileAuthorized', [R, 'a'], 'projectFs/readText', { root: R, rel: 'a' }],
  [
    'writeProjectTextFileIn',
    [R, 'a', 'c', 'e', 'utf8'],
    'projectFs/writeText',
    { root: R, rel: 'a', content: 'c', expectedContent: 'e', encoding: 'utf8' },
  ],
  [
    'writeProjectTextFileAuthorized',
    [R, 'a', 'c', 'e', undefined],
    'projectFs/writeText',
    { root: R, rel: 'a', content: 'c', expectedContent: 'e' },
  ],
  ['writeProjectTextFilesIn', [R, FILES], 'projectFs/writeTextBatch', { root: R, files: FILES }],
  ['writeProjectTextFilesAuthorized', [R, FILES], 'projectFs/writeTextBatch', { root: R, files: FILES }],
  [
    'readScopedEditorSettings',
    [U, R, 'a.md', '/w.code-workspace'],
    'projectFs/readEditorSettings',
    { root: R, rel: 'a.md', workspaceFile: '/w.code-workspace' },
  ],
  ['readWorkspaceFile', ['/w.code-workspace'], 'projectFs/workspaceFile/read', { workspaceFile: '/w.code-workspace' }],
  [
    'writeWorkspaceFile',
    ['/w.code-workspace', [{ path: R }]],
    'projectFs/workspaceFile/write',
    { workspaceFile: '/w.code-workspace', folders: [{ path: R }] },
  ],
  ['searchWorkspaceTextIn', [R, { query: 'q' }], 'projectFs/searchText', { root: R, options: { query: 'q' } }],
  ['statProjectFileIn', [R, 'a'], 'projectFs/stat', { root: R, rel: 'a' }],
  ['listHostDirectories', ['/x'], 'projectFs/browseDirs', { path: '/x' }],
  ['listServerDirectories', ['/x', true], 'projectFs/browseDirs', { path: '/x', includeHidden: true }],

  [
    'writeMarkdownDefaultView',
    [U, 'preview'],
    'config/value/write',
    { path: 'desktop.editor.markdownDefaultView', value: 'preview' },
  ],
  [
    'updateActivityRailPins',
    [['a'], true],
    'config/value/write',
    { path: 'desktop.activityRailPins', value: ['a'], mode: 'initializeIfMissing' },
  ],
  ['updateActivityRailPins', [['a']], 'config/value/write', { path: 'desktop.activityRailPins', value: ['a'] }],
  ['updateSetting', ['reduceMotion', true], 'config/value/write', { path: 'desktop.reduceMotion', value: true }],
  ['updateNotificationVolume', [0.5], 'config/value/write', { path: 'desktop.notificationVolume', value: 0.5 }],
  ['updateBrowserPermissions', [POLICY], 'config/value/write', { path: 'desktop.browserPermissions', value: POLICY }],
  [
    'updateSessionRetention',
    ['sessionAutoDeleteDays', 30],
    'config/value/write',
    { path: 'desktop.sessionAutoDeleteDays', value: 30 },
  ],
  ['updateZoom', [1], 'config/value/write', { path: 'desktop.zoom', value: 1 }],
  ['sendTestNotification', ['dev1'], 'notify/test', { target: 'dev1' }],

  [
    'termEnsure',
    ['t1', R, 'bash'],
    'terminal/ensure',
    { tabId: 't1', options: { cwd: R, profile: 'bash' } },
  ],
  ['termAttach', ['t1'], 'terminal/attach', { tabId: 't1' }],
  ['termProfiles', [], 'terminal/profiles', {}],
  ['termFocus', ['t1', true, 'client'], 'terminal/focus', { tabId: 't1' }],
  ['termPause', ['t1'], 'terminal/pause', { tabId: 't1' }],
  ['termResume', ['t1'], 'terminal/resume', { tabId: 't1' }],
  ['termDispose', ['t1'], 'terminal/dispose', { tabId: 't1' }],

  ['remoteAccessSetEnabled', [true], 'remoteAccess/setEnabled', { enabled: true }],
  ['remoteAccessSetName', ['PC'], 'remoteAccess/setName', { name: 'PC' }],
  ['remoteAccessSetClientAlias', ['c1', 'Phone'], 'remoteAccess/setClientAlias', { clientId: 'c1', alias: 'Phone' }],
  ['remoteAccessRotate', [], 'remoteAccess/rotate', {}],
  ['remoteAccessRevokeClient', ['c1'], 'remoteAccess/revokeClient', { clientId: 'c1' }],
  [
    'remoteAccessSettleOwedControllerKeys',
    ['c1', ['k']],
    'remoteAccess/settleOwedControllerKeys',
    { input: ['c1', ['k']] },
  ],

  ['browserRemoteTabs', [[{ id: 1 }]], 'host/state/set', { key: 'browserTabs', value: [{ id: 1 }] }],
  ['browserRemoteImportProgress', [{ done: 1 }], 'host/state/set', { key: 'browserImport', value: { done: 1 } }],
  [
    'visualizeRemotePublish',
    [{ sessionId: 's' }],
    'host/state/set',
    { key: 'visualize', value: { sessionId: 's' } },
  ],

  [
    'serverUploadChunk',
    ['tr1', 4096, 'AAAA'],
    'transfer/writeChunk',
    { transferId: 'tr1', offset: 4096, bytesB64: 'AAAA' },
  ],
  ['serverUploadCommit', ['tr1'], 'transfer/commit', { transferId: 'tr1' }],
  ['serverUploadAbort', ['tr1'], 'transfer/abort', { transferId: 'tr1' }],
  ['serverTrashInfo', ['/srv/p'], 'transfer/trash/info', { path: '/srv/p' }],
];

for (const [name, args, method, params] of CASES) {
  test(`${name}(${args.length} args) is ${method} with its named params`, () => {
    assert.deepEqual(routeDesktopOperation(name, args), { method, params });
  });
}

test('termEnsure without a tab id sends a fresh client-chosen one', () => {
  const first = routeDesktopOperation('termEnsure', [null, R, null]);
  const second = routeDesktopOperation('termEnsure', ['', R, null]);
  assert.equal(first.method, 'terminal/ensure');
  assert.match(first.params.tabId, /^[0-9a-f-]{36}$/);
  assert.notEqual(first.params.tabId, second.params.tabId);
  assert.deepEqual(first.params.options, { cwd: R, profile: null });
});

test('an argument the core has no param for is refused, not dropped', () => {
  assert.throws(() => routeDesktopOperation('gitCommit', [R, 'm', 'extra']), /takes at most 2 arguments/);
  assert.throws(() => routeDesktopOperation('updateSessionRetention', ['nope', 1]), /retention setting is invalid/);
});

test('the routed operations are the spec map targets with params the Rust schema declares', () => {
  const wantedMethods = new Map(
    operations.map((row) => [
      row.name,
      row.target.kind === 'method' ? [row.target.target] : row.target.kind === 'methods' ? row.target.target : null,
    ])
  );
  assert.equal(operations.length, 166);
  assert.deepEqual(
    [...wantedMethods].filter(([, methods]) => methods).map(([name]) => name).sort(),
    [...ROUTED_DESKTOP_OPERATIONS, ...UNROUTED_DESKTOP_OPERATIONS].sort()
  );
  const covered = new Set(CASES.map(([name]) => name));
  assert.deepEqual(ROUTED_DESKTOP_OPERATIONS.filter((name) => !covered.has(name)), []);
  for (const [name, args, method, params] of CASES) {
    assert.ok(wantedMethods.get(name).includes(method), `${name} -> ${method}`);
    const schema = paramsSchema(method);
    if (method === 'host/state/set') continue; // an enum: `{key, value}`
    for (const param of Object.keys(params)) assert.ok(param in schema.properties, `${name}: ${param} of ${method}`);
    {
      const complete = CASES.filter(([other]) => other === name).reduce((best, entry) =>
        Object.keys(entry[3]).length > Object.keys(best[3]).length ? entry : best
      );
      for (const required of (schema.required ?? []).filter((field) => field !== 'opId')) {
        assert.ok(required in complete[3], `${name}: ${method} requires ${required}`);
      }
    }
  }
});

test('mutations carry no opId here: the client library assigns it in call()', () => {
  for (const [, , , params] of CASES) assert.equal('opId' in params, false);
});

test('an operation with no Rust op is unknownMethod and one the schema cannot carry is unmappedOperation', () => {
  const unknown = operations
    .filter((row) => row.target.kind !== 'method' && row.target.kind !== 'methods')
    .map((row) => row.name);
  assert.equal(unknown.length, 41);
  for (const name of unknown) {
    assert.throws(() => routeDesktopOperation(name, []), { code: 'unknownMethod' }, name);
  }
  assert.equal(UNROUTED_DESKTOP_OPERATIONS.length, 16);
  for (const name of UNROUTED_DESKTOP_OPERATIONS) {
    assert.throws(() => routeDesktopOperation(name, []), { code: 'unmappedOperation' }, name);
  }
});

test('the lane sends the routed request through the connection and never falls back', async () => {
  const calls = [];
  const lane = createOperationLane({
    protocol: {
      notify: () => {},
      call: async (method, params) => {
        calls.push({ method, params });
        return { ok: true };
      },
    },
  });
  assert.deepEqual(await lane.invoke('gitBranches', [R]), { ok: true });
  assert.deepEqual(await lane.invoke('termProfiles', undefined), { ok: true });
  await assert.rejects(lane.invoke('gitPathspecChanges', [R]), { code: 'unknownMethod' });
  await assert.rejects(lane.invoke('githubRequest', [R, {}]), { code: 'unmappedOperation' });
  assert.deepEqual(calls, [
    { method: 'git/branches', params: { cwd: R } },
    { method: 'terminal/profiles', params: {} },
  ]);
});

test('a domain error of the core reaches the window as the error Node raised', async () => {
  const failure = Object.assign(new Error('rpc'), {
    detail: { kind: 'rpc', data: { reason: 'domainError', message: 'Not a git repository', code: 'GIT_NOT_REPO', detail: {} } },
  });
  const lane = createOperationLane({
    protocol: {
      call: async () => {
        throw failure;
      },
    },
  });
  await assert.rejects(lane.invoke('gitStatus', [R]), (error) => {
    assert.equal(error.message, 'Not a git repository');
    assert.equal(error.code, 'GIT_NOT_REPO');
    return true;
  });
});

// ---- replies: what the desktop gets back is what Node returned -------------------------------------------------

/** A lane over a fake core; `answers` maps a method to its reply. */
function laneWith(answers, notified = []) {
  const calls = [];
  const lane = createOperationLane({
    protocol: {
      notify: (method, params) => notified.push({ method, params }),
      call: async (method, params) => {
        calls.push({ method, params });
        const answer = answers[method];
        return typeof answer === 'function' ? answer(params) : answer;
      },
    },
  });
  return { lane, calls, notified };
}

test('every routed operation has exactly one reply adapter', () => {
  assert.deepEqual([...REPLY_DESKTOP_OPERATIONS].sort(), [...ROUTED_DESKTOP_OPERATIONS].sort());
});

test('operations Node answered with nothing or null answer the same', async () => {
  const { lane: any } = laneWith({
    'git/stage': { staged: 1 },
    'github/login/cancel': {},
    'projectFs/backup/delete': {},
    'terminal/pause': {},
    'host/state/set': {},
    'remoteAccess/setClientAlias': {},
  });
  assert.equal(await any.invoke('gitStage', [R, ['a']]), undefined);
  assert.equal(await any.invoke('cancelGithubCliLogin', ['f1']), undefined);
  assert.equal(await any.invoke('deleteEditorBackup', [U, '/p']), undefined);
  assert.equal(await any.invoke('termPause', ['t1']), null);
  assert.equal(await any.invoke('browserRemoteTabs', [[]]), null);
  assert.equal(await any.invoke('remoteAccessSetClientAlias', ['c', 'a']), null);
});

test('values Node returned pass through as the core sent them', async () => {
  const status = { files: [{ path: 'a' }], branch: 'main' };
  const { lane } = laneWith({ 'git/status': status, 'git/commit': 'abc123' });
  assert.equal(await lane.invoke('gitStatus', [R]), status);
  assert.equal(await lane.invoke('gitCommit', [R, 'm']), 'abc123');
});

test('statLocalEntryAbs answers the one entry of the list', async () => {
  const entry = { absolutePath: '/x/a', name: 'a', dir: false };
  const { lane } = laneWith({ 'projectFs/statLocal': [entry] });
  assert.equal(await lane.invoke('statLocalEntryAbs', ['/x/a']), entry);
  const { lane: bad } = laneWith({ 'projectFs/statLocal': entry });
  await assert.rejects(bad.invoke('statLocalEntryAbs', ['/x/a']), /did not answer a list/);
});

test('termEnsure answers with the tab id it sent', async () => {
  const { lane, calls } = laneWith({ 'terminal/ensure': { replay: 'r' } });
  const first = await lane.invoke('termEnsure', ['t1', R, null]);
  assert.deepEqual(first, { id: 't1', replay: 'r' });
  const fresh = await lane.invoke('termEnsure', [null, R, null]);
  assert.equal(fresh.id, calls[1].params.tabId);
});

test('githubCliLoginStart answers the flow, read from the status of the started flow', async () => {
  const flow = { flowId: 'f9', state: 'waiting', code: 'ABCD-1234' };
  const { lane, calls } = laneWith({ 'github/login/start': { flowId: 'f9' }, 'github/login/status': flow });
  assert.equal(await lane.invoke('githubCliLoginStart', []), flow);
  assert.deepEqual(calls, [
    { method: 'github/login/start', params: {} },
    { method: 'github/login/status', params: { flowId: 'f9' } },
  ]);
});

test('settings writers answer the saved DesktopSettings, read back after the write', async () => {
  const config = { desktop: { keepAwake: false, notificationVolume: 40 }, agent: { autoClear: { enabled: false } } };
  const { lane, calls } = laneWith({
    'config/value/write': { revision: 3, values: [false] },
    'config/read': { config },
  });
  const settings = await lane.invoke('updateSetting', ['keepAwake', false]);
  assert.equal(settings.keepAwake, false);
  assert.equal(settings.autoClear, false);
  assert.equal(settings.notificationVolume, 40);
  assert.deepEqual(calls[1], { method: 'config/read', params: { keys: ['agent', 'desktop'] } });
  assert.equal((await lane.invoke('updateNotificationVolume', [40])).notificationVolume, 40);
});

test('updateZoom, writeMarkdownDefaultView and updateActivityRailPins answer the stored value', async () => {
  const { lane } = laneWith({
    'config/value/write': (params) =>
      params.path === 'desktop.zoom'
        ? { revision: 1, values: [1] }
        : params.path === 'desktop.editor.markdownDefaultView'
          ? { revision: 2, values: ['preview'] }
          : { revision: 3, values: [{ revision: 4 }] },
  });
  assert.equal(await lane.invoke('updateZoom', [1]), 1);
  assert.equal(await lane.invoke('writeMarkdownDefaultView', [U, 'preview']), 'preview');
  const pins = await lane.invoke('updateActivityRailPins', [['sessions'], false]);
  assert.equal(pins.revision, 4);
  assert.ok(Array.isArray(pins.pins));
  const { lane: broken } = laneWith({ 'config/value/write': { revision: 1 } });
  await assert.rejects(broken.invoke('updateZoom', [1]), /did not return the stored value/);
});

test('upload chunks answer the bytes received; abort answers true', async () => {
  const { lane } = laneWith({ 'transfer/writeChunk': {}, 'transfer/abort': {} });
  assert.deepEqual(await lane.invoke('serverUploadChunk', ['tr1', 8, 'AAAA']), { received: 11 });
  assert.equal(await lane.invoke('serverUploadAbort', ['tr1']), true);
});

test('githubCliLoginOpenBrowser answers a boolean', async () => {
  assert.equal(await laneWith({ 'github/login/openBrowser': true }).lane.invoke('githubCliLoginOpenBrowser', ['f']), true);
  assert.equal(await laneWith({ 'github/login/openBrowser': {} }).lane.invoke('githubCliLoginOpenBrowser', ['f']), false);
});

test('termFocus sends a focus and refuses an unfocus, which terminal/focus cannot carry', async () => {
  assert.deepEqual(routeDesktopOperation('termFocus', ['t1', true, 'desktop']), {
    method: 'terminal/focus',
    params: { tabId: 't1' },
  });
  assert.throws(() => routeDesktopOperation('termFocus', ['t1', false, 'desktop']), { code: 'unmappedOperation' });
});

// ---- the five client notifications ------------------------------------------------------------------------------

const NOTIFICATIONS = [
  ['termWrite', ['t1', 'ls\r'], 'terminal/input', { tabId: 't1', data: 'ls\r' }, null],
  ['termResize', ['t1', 120, 30, 'phone-1'], 'terminal/resize', { tabId: 't1', cols: 120, rows: 30 }, null],
  ['publishUpdaterState', [{ status: 'idle' }], 'host/update/report', { state: { status: 'idle' } }, undefined],
  ['remoteAccessResume', [], 'host/power', { event: 'resume' }, null],
  ['remoteAccessSuspend', [], 'host/power', { event: 'suspend' }, null],
];

for (const [name, args, method, params, result] of NOTIFICATIONS) {
  test(`${name} is the notification ${method}, never a request`, async () => {
    const { lane, calls, notified } = laneWith({});
    assert.equal(await lane.invoke(name, args), result);
    assert.deepEqual(notified, [{ method, params }]);
    assert.deepEqual(calls, []);
  });
}

test('the notification operations are the spec map clientNotification rows', () => {
  const wanted = operations.filter((row) => row.target.kind === 'clientNotification').map((row) => row.name);
  assert.deepEqual([...NOTIFICATION_DESKTOP_OPERATIONS].sort(), wanted.sort());
});

test('termEnsure leaves sizeOwner out when the core says null and keeps an owner', async () => {
  const owner = { cols: 80, rows: 24, owner: 'phone-1' };
  const none = await laneWith({ 'terminal/ensure': { id: 't1', replay: 'r', sizeOwner: null } }).lane.invoke('termEnsure', ['t1', R, null]);
  assert.deepEqual(none, { id: 't1', replay: 'r' });
  assert.equal('sizeOwner' in none, false);
  const owned = await laneWith({ 'terminal/ensure': { id: 't1', replay: 'r', sizeOwner: owner } }).lane.invoke('termEnsure', ['t1', R, null]);
  assert.deepEqual(owned.sizeOwner, owner);
});

test('readScopedEditorSettings sends root and rel as the editor handler passes them (rel is required by the core)', () => {
  assert.deepEqual(routeDesktopOperation('readScopedEditorSettings', [U, R, 'src/a.ts', undefined]), {
    method: 'projectFs/readEditorSettings',
    params: { root: R, rel: 'src/a.ts' },
  });
  // Without rel nothing is invented: the core answers invalidParams, as it should for a call the editor never makes.
  assert.deepEqual(routeDesktopOperation('readScopedEditorSettings', [U, R]).params, { root: R });
});