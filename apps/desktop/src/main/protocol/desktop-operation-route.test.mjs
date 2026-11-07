// The renderer's desktop operations as core requests (desktop-operation-route.ts): the exact op and params each
// converted operation sends, the operations that never leave the process, and the lane. Expectations are written from
// the Rust params structs (`v2/params.rs`) and the spec map (`operations_map.json`), not from the router.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { BROWSER_PERMISSION_KINDS } from '../../shared/browser-permission-policy.ts';

import {
  ROUTED_DESKTOP_OPERATIONS,
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
