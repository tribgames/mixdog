// createScmApi against a fake context: every member sends the request the IPC handler's operation made (the shared
// routes), and answers what the handler answered.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DIRECT_KEYS } from '../../shared/desktop-api-split.ts';
import { createScmApi } from './api-scm.ts';

function setup(answer = async () => ({ ok: true })) {
  const calls = [];
  const ctx = { call: async (method, params) => (calls.push({ method, params }), answer(method, params)) };
  return { calls, api: createScmApi(ctx) };
}

// member, arguments, the request main sent for it
const CASES = [
  ['gitCliStatus', [], 'git/cliStatus', {}],
  ['installGitCli', [], 'git/cli/install', {}],
  ['githubCliStatus', [], 'github/status', {}],
  ['installGithubCli', [], 'github/install', {}],
  ['githubCliLoginStatus', ['f1'], 'github/login/status', { flowId: 'f1' }],
  ['githubCliLoginOpenBrowser', ['f1', { openBrowser: true }], 'github/login/openBrowser', { flowId: 'f1' }],
  ['githubCliLoginCancel', ['f1'], 'github/login/cancel', { flowId: 'f1' }],
  ['githubCliLogout', [], 'github/logout', {}],
  ['githubCliAccount', [], 'github/account', {}],
  ['gitGlobalConfig', [], 'git/globalConfig/read', {}],
  ['gitStatus', ['/r', { reuseLineStats: true, skipLineStats: 1 }], 'git/status', { cwd: '/r', reuseLineStats: true }],
  ['gitBranches', ['/r'], 'git/branches', { cwd: '/r' }],
  ['gitRenameBranch', ['/r', 'a', 'b'], 'git/renameBranch', { cwd: '/r', input: { branch: 'a', nextBranch: 'b' } }],
  ['gitDeleteBranch', ['/r', 'a'], 'git/deleteBranch', { cwd: '/r', input: { branch: 'a' } }],
  ['gitDiff', ['/r', 'p', true, false, true], 'git/diff', { cwd: '/r', path: 'p', staged: true, worktreeOnly: false, untracked: true }],
  ['gitApplyPatch', ['/r', 'p', 'x', true], 'git/applyPatch', { cwd: '/r', path: 'p', patch: 'x', reverse: true }],
  ['gitStage', ['/r', ['a']], 'git/stage', { cwd: '/r', paths: ['a'] }],
  ['gitUnstage', ['/r', ['a']], 'git/unstage', { cwd: '/r', paths: ['a'] }],
  ['gitIgnore', ['/r', 'p', 'repo'], 'git/ignore', { cwd: '/r', path: 'p', scope: 'repo' }],
  ['gitCommit', ['/r', 'm'], 'git/commit', { cwd: '/r', message: 'm' }],
  ['gitCommitPaths', ['/r', 'm', ['a']], 'git/commitPaths', { cwd: '/r', input: { message: 'm', paths: ['a'] } }],
  ['gitAmend', ['/r', undefined], 'git/amend', { cwd: '/r' }],
  ['gitUndoLastCommit', ['/r'], 'git/undoLastCommit', { cwd: '/r' }],
  ['gitStash', ['/r', 'm'], 'git/stash', { cwd: '/r', message: 'm' }],
  ['gitStashPop', ['/r'], 'git/stashPop', { cwd: '/r' }],
  ['gitStashList', ['/r'], 'git/stashList', { cwd: '/r' }],
  ['gitStashApply', ['/r', 's'], 'git/stashApply', { cwd: '/r', ref: 's' }],
  ['gitStashDrop', ['/r', 's'], 'git/stashDrop', { cwd: '/r', ref: 's' }],
  ['ghPrList', ['/r'], 'github/pr/list', { cwd: '/r' }],
  ['githubRequest', ['/r', { a: 1 }], 'github/request', { cwd: '/r', input: { a: 1 } }],
  ['ghPrDefaultBranch', ['/r'], 'github/pr/defaultBranch', { cwd: '/r' }],
  ['ghPrCreate', ['/r', { t: 1 }], 'github/pr/create', { cwd: '/r', value: { t: 1 } }],
  ['ghPrView', ['/r'], 'github/pr/view', { cwd: '/r', value: null }],
  ['ghPrCheckout', ['/r', 4], 'github/pr/checkout', { cwd: '/r', value: 4 }],
  ['ghPrMerge', ['/r', 4, 'squash'], 'github/pr/merge', { cwd: '/r', value: 4, method: 'squash' }],
  ['ghPrDiff', ['/r', 4], 'github/pr/diff', { cwd: '/r', value: 4 }],
  ['gitPush', ['/r'], 'git/push', { cwd: '/r' }],
  ['gitFetch', ['/r'], 'git/fetch', { cwd: '/r' }],
  ['gitPull', ['/r'], 'git/pull', { cwd: '/r' }],
  ['gitSync', ['/r'], 'git/sync', { cwd: '/r' }],
  ['gitContinue', ['/r'], 'git/continue', { cwd: '/r' }],
  ['gitAbortOperation', ['/r'], 'git/abortOperation', { cwd: '/r' }],
  ['gitRevert', ['/r', 'p', true, 'all'], 'git/revertFile', { cwd: '/r', path: 'p', untracked: true, mode: 'all' }],
  ['gitLog', ['/r', 'q', 2, 3], 'git/log', { cwd: '/r', query: 'q', skip: 2, limit: 3 }],
  ['gitShow', ['/r', 'h'], 'git/show', { cwd: '/r', hash: 'h' }],
  ['gitShowDiff', ['/r', 'h', 'p'], 'git/showDiff', { cwd: '/r', hash: 'h', path: 'p' }],
  ['gitRequestContext', ['/r', { k: 1 }], 'git/requestContext', { cwd: '/r', input: { k: 1 } }],
  ['gitShowFile', ['/r', 'rev', 'p'], 'git/showFile', { cwd: '/r', rev: 'rev', path: 'p' }],
  ['gitResetToCommit', ['/r', 'h', 'mixed', true], 'git/resetToCommit', { cwd: '/r', value: 'h', mode: 'mixed', confirmedDirty: true }],
  ['gitRevertCommit', ['/r', 'h'], 'git/revertCommit', { cwd: '/r', value: 'h' }],
  ['gitCherryPickCommit', ['/r', 'h'], 'git/cherryPickCommit', { cwd: '/r', value: 'h' }],
  ['gitCreateTag', ['/r', 't', 'h'], 'git/createTag', { cwd: '/r', value: 't', at: 'h' }],
  ['gitDeleteTag', ['/r', 't'], 'git/deleteTag', { cwd: '/r', value: 't' }],
  ['gitReview', ['/r', 'head'], 'review/diff/get', { scope: 'repo', cwd: '/r', source: 'head' }],
  ['gitReviewDiff', ['/r', 'p', true, 'head'], 'review/diff/get', { scope: 'repo', cwd: '/r', path: 'p', untracked: true, source: 'head', patch: true }],
  ['gitReviewDiffs', ['/r', ['a'], 'head'], 'review/diff/get', { scope: 'repo', cwd: '/r', files: ['a'], source: 'head', patch: true }],
];

test('every scm member is covered by a case', () => {
  const covered = new Set([...CASES.map(([member]) => member), 'githubCliLoginStart', 'setGitGlobalConfig']);
  assert.deepEqual([...DIRECT_KEYS.scm].filter((key) => !covered.has(key)), []);
  assert.deepEqual(Object.keys(createScmApi({ call: async () => ({}) })).sort(), [...DIRECT_KEYS.scm].sort());
});

for (const [member, args, method, params] of CASES) {
  test(`${member} sends ${method}`, async () => {
    const { api, calls } = setup();
    await api[member](...args);
    assert.deepEqual(calls, [{ method, params }]);
  });
}

test('replies: the core value, nothing for a void operation, the boolean for open browser', async () => {
  const { api } = setup(async () => ({ v: 1 }));
  assert.deepEqual(await api.gitBranches('/r'), { v: 1 });
  assert.equal(await api.gitStage('/r', ['a']), undefined);
  assert.equal(await api.githubCliLoginCancel('f'), undefined);
  assert.equal(await api.githubCliLoginOpenBrowser('f'), false);
  const opened = setup(async () => true);
  assert.equal(await opened.api.githubCliLoginOpenBrowser('f'), true);
});

test('githubCliLoginStart answers the flow status', async () => {
  const { api, calls } = setup(async (method) => (method === 'github/login/start' ? { flowId: 'f9' } : { flowId: 'f9', state: 'pending' }));
  assert.deepEqual(await api.githubCliLoginStart(), { flowId: 'f9', state: 'pending' });
  assert.deepEqual(calls, [
    { method: 'github/login/start', params: {} },
    { method: 'github/login/status', params: { flowId: 'f9' } },
  ]);
});

test('setGitGlobalConfig announces the git settings after the write, and ignores a failed announcement', async () => {
  const { api, calls } = setup(async (method) => {
    if (method === 'ui/settings/announce') throw new Error('no');
    return { name: 'x' };
  });
  assert.deepEqual(await api.setGitGlobalConfig('user.name', ''), { name: 'x' });
  assert.deepEqual(calls, [
    { method: 'git/globalConfig/write', params: { key: 'user.name', value: '' } },
    { method: 'ui/settings/announce', params: { scope: 'git' } },
  ]);
});

test('a failed write does not announce, and an extra argument rejects before any request', async () => {
  const { api, calls } = setup(async () => {
    throw new Error('boom');
  });
  await assert.rejects(api.setGitGlobalConfig('user.name', 'x'), /boom/);
  assert.equal(calls.length, 1);
  const none = setup();
  await assert.rejects(none.api.gitBranches('/r', 'extra'), TypeError);
  assert.equal(none.calls.length, 0);
});
