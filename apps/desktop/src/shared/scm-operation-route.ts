// The source-control operations (git, GitHub, the git/GitHub/LibreOffice installers) as protocol requests and replies, in one place
// for both of their callers: the desktop's operation lane (main/protocol/desktop-operation-route.ts, which routes the windows and the
// relay) and the phone's protocol adapter (renderer/remote-protocol-scm.ts). Each name takes the positional arguments Node's
// `desktop-operations.ts` handler took, and each reply is Node's return value (the parity contract of DS-SCM-1).

export interface OperationRoute {
  method: string;
  params: Record<string, unknown>;
}

export type OperationMapper = (args: readonly unknown[]) => OperationRoute;

/** `names[i]` is the param the i-th positional argument fills; `null` is an argument the core has no param for (a
 *  Node-only value such as the user-data path every editor-backup call carried). An argument past the list is an
 *  error, never dropped; an undefined argument leaves its (optional) param out. */
export function positional(method: string, names: ReadonlyArray<string | null>): OperationMapper {
  return (args) => {
    if (args.length > names.length) {
      throw new TypeError(`desktop operation for ${method} takes at most ${names.length} arguments`);
    }
    const params: Record<string, unknown> = {};
    names.forEach((name, index) => {
      if (name !== null && args[index] !== undefined) params[name] = args[index];
    });
    return { method, params };
  };
}

export const defined = (params: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** `positional`, where every argument after the cwd is a required JSON value: an undefined one is null. */
const pullRequest =
  (method: string, names: readonly string[]): OperationMapper =>
  (args) => {
    const route = positional(method, names)(args);
    for (const name of names.slice(1)) route.params[name] ??= null;
    return route;
  };

/** `review/diff/get` for a repository (`scope: 'repo'`): the three `gitReview*` operations (DS §5.3). */
const repoReview =
  (shape: (args: readonly unknown[]) => Record<string, unknown>): OperationMapper =>
  (args) => ({
    method: 'review/diff/get',
    params: defined({ scope: 'repo', ...shape(args) }),
  });

export const SCM_OPERATION_ROUTES: Readonly<Record<string, OperationMapper>> = {
  // git
  gitAbortOperation: positional('git/abortOperation', ['cwd']),
  gitAmend: positional('git/amend', ['cwd', 'message']),
  gitApplyPatch: positional('git/applyPatch', ['cwd', 'path', 'patch', 'reverse']),
  gitBranches: positional('git/branches', ['cwd']),
  gitCherryPickCommit: positional('git/cherryPickCommit', ['cwd', 'value']),
  gitCommit: positional('git/commit', ['cwd', 'message']),
  // Node: gitCommitPaths(cwd, message, paths); Rust: input { message, paths }.
  gitCommitPaths: ([cwd, message, paths]) => ({
    method: 'git/commitPaths',
    params: { cwd, input: { message, paths } },
  }),
  gitContinue: positional('git/continue', ['cwd']),
  gitCreateTag: positional('git/createTag', ['cwd', 'value', 'at']),
  // Node: gitDeleteBranch(cwd, value); Rust: input { branch }.
  gitDeleteBranch: ([cwd, branch]) => ({ method: 'git/deleteBranch', params: { cwd, input: { branch } } }),
  gitDeleteTag: positional('git/deleteTag', ['cwd', 'value']),
  gitDiff: positional('git/diff', ['cwd', 'path', 'staged', 'worktreeOnly', 'untracked']),
  gitFetch: positional('git/fetch', ['cwd']),
  gitIgnore: positional('git/ignore', ['cwd', 'path', 'scope']),
  gitLog: positional('git/log', ['cwd', 'query', 'skip', 'limit']),
  gitPull: positional('git/pull', ['cwd']),
  gitPush: positional('git/push', ['cwd']),
  // Node: gitRenameBranch(cwd, value, nextValue); Rust: input { branch, nextBranch }.
  gitRenameBranch: ([cwd, branch, nextBranch]) => ({
    method: 'git/renameBranch',
    params: { cwd, input: { branch, nextBranch } },
  }),
  gitResetToCommit: positional('git/resetToCommit', ['cwd', 'value', 'mode', 'confirmedDirty']),
  gitRevertCommit: positional('git/revertCommit', ['cwd', 'value']),
  gitRevertFile: positional('git/revertFile', ['cwd', 'path', 'untracked', 'mode']),
  gitReview: repoReview(([cwd, source]) => ({ cwd, source })),
  gitReviewDiff: repoReview(([cwd, path, untracked, source]) => ({ cwd, path, untracked, source, patch: true })),
  gitReviewDiffs: repoReview(([cwd, files, source]) => ({ cwd, files, source, patch: true })),
  gitShow: positional('git/show', ['cwd', 'hash']),
  gitShowDiff: positional('git/showDiff', ['cwd', 'hash', 'path']),
  gitShowFile: positional('git/showFile', ['cwd', 'rev', 'path']),
  gitRequestContext: positional('git/requestContext', ['cwd', 'input']),
  gitStage: positional('git/stage', ['cwd', 'paths']),
  gitStash: positional('git/stash', ['cwd', 'message']),
  gitStashApply: positional('git/stashApply', ['cwd', 'ref']),
  gitStashDrop: positional('git/stashDrop', ['cwd', 'ref']),
  gitStashList: positional('git/stashList', ['cwd']),
  gitStashPop: positional('git/stashPop', ['cwd']),
  // The second argument is Node's status-scan hint { reuseLineStats, skipLineStats }: it goes to the core, which skips the
  // line counts on skip and serves the counted scan from its cache on reuse.
  gitStatus: ([cwd, hint, ...extra]) => {
    if (extra.length) throw new TypeError('desktop operation for git/status takes at most 2 arguments');
    const options = hint && typeof hint === 'object' ? (hint as Record<string, unknown>) : {};
    return {
      method: 'git/status',
      params: defined({
        cwd,
        reuseLineStats: options.reuseLineStats === true ? true : undefined,
        skipLineStats: options.skipLineStats === true ? true : undefined,
      }),
    };
  },
  gitSync: positional('git/sync', ['cwd']),
  gitUndoLastCommit: positional('git/undoLastCommit', ['cwd']),
  gitUnstage: positional('git/unstage', ['cwd', 'paths']),
  gitCliStatus: positional('git/cliStatus', ['refresh']),
  gitGlobalConfig: positional('git/globalConfig/read', []),
  installGitCli: positional('git/cli/install', []),
  setGitGlobalConfig: positional('git/globalConfig/write', ['key', 'value']),

  // GitHub
  githubRequest: positional('github/request', ['cwd', 'input']),
  // The pull request value (a number, or the create input) and the merge method are JSON values the core's params require
  // (`JsonValue`, no default): what Node's handler took as `undefined` goes as null, the core's own "absent" (merge: `merge`).
  ghPrCheckout: pullRequest('github/pr/checkout', ['cwd', 'value']),
  ghPrCreate: pullRequest('github/pr/create', ['cwd', 'value']),
  ghPrDefaultBranch: positional('github/pr/defaultBranch', ['cwd']),
  ghPrDiff: pullRequest('github/pr/diff', ['cwd', 'value']),
  ghPrList: positional('github/pr/list', ['cwd']),
  ghPrMerge: pullRequest('github/pr/merge', ['cwd', 'value', 'method']),
  ghPrView: pullRequest('github/pr/view', ['cwd', 'value']),
  cancelGithubCliLogin: positional('github/login/cancel', ['flowId']),
  githubCliAccount: positional('github/account', []),
  // Node: githubCliLoginStart({ openBrowser? }); a paired client sends { openBrowser: false } (it opens the device page itself).
  githubCliLoginStart: ([options]) => ({
    method: 'github/login/start',
    params: defined({ openBrowser: record(options).openBrowser }),
  }),
  githubCliLoginStatus: positional('github/login/status', ['flowId']),
  // The second argument is Node's { openBrowser? } options, which its handler ignored (gh never opens a browser itself).
  githubCliLoginOpenBrowser: positional('github/login/openBrowser', ['flowId', null]),
  githubCliLogout: positional('github/logout', []),
  githubCliStatus: positional('github/status', ['refresh']),
  installGithubCli: positional('github/install', []),
  githubStarStatus: positional('github/starStatus', []),
  starGithub: positional('github/star', []),

  // the office suite the document previews need
  libreOfficeStatus: positional('document/libreOfficeStatus', ['refresh']),
  installLibreOffice: positional('document/installLibreOffice', []),
};

export interface ScmReplyContext {
  args: readonly unknown[];
  params: Record<string, unknown>;
  call(method: string, params: unknown): Promise<unknown>;
}
export type ScmReply = (reply: unknown, context: ScmReplyContext) => unknown;

/** Replies that are Node's return value as the core sends it (the parity contract of DS-SCM-1, DS-REM-1: the JSON equals what
 *  the Node implementation returned). */
const SAME_REPLY: readonly string[] = [
  'gitAbortOperation', 'gitAmend', 'gitBranches', 'gitCherryPickCommit', 'gitCommit', 'gitCommitPaths', 'gitContinue',
  'gitCreateTag', 'gitDeleteBranch', 'gitDeleteTag', 'gitDiff', 'gitFetch', 'gitLog', 'gitPull', 'gitPush',
  'gitRenameBranch', 'gitResetToCommit', 'gitRevertCommit', 'gitReview', 'gitReviewDiff', 'gitReviewDiffs', 'gitShow',
  'gitShowDiff', 'gitShowFile', 'gitRequestContext', 'gitStash', 'gitStashApply', 'gitStashDrop', 'gitStashList',
  'gitStashPop', 'gitStatus', 'gitSync', 'gitUndoLastCommit', 'gitCliStatus', 'gitGlobalConfig', 'installGitCli',
  'setGitGlobalConfig', 'ghPrCheckout', 'ghPrCreate', 'ghPrDefaultBranch', 'ghPrDiff', 'ghPrList', 'ghPrMerge',
  'ghPrView', 'githubCliAccount', 'githubCliLoginStatus', 'githubCliLogout', 'githubCliStatus', 'installGithubCli',
  'githubStarStatus', 'starGithub', 'libreOfficeStatus', 'installLibreOffice', 'githubRequest',
];
/** Node returned nothing. */
const VOID_REPLY: readonly string[] = [
  'gitApplyPatch', 'gitIgnore', 'gitRevertFile', 'gitStage', 'gitUnstage', 'cancelGithubCliLogin',
];

export const SCM_REPLIES: Readonly<Record<string, ScmReply>> = {
  ...Object.fromEntries(SAME_REPLY.map((name): [string, ScmReply] => [name, (reply) => reply])),
  ...Object.fromEntries(VOID_REPLY.map((name): [string, ScmReply] => [name, () => undefined])),
  // Node answered the started flow; the core answers {flowId} and the flow is its status snapshot (DS 5.4).
  githubCliLoginStart: (reply, { call }) => call('github/login/status', { flowId: record(reply).flowId }),
  // Node answered the boolean the UI reads as "the browser was opened by gh".
  githubCliLoginOpenBrowser: (reply) => reply === true,
};
