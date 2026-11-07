// The renderer's desktop operations (`invokeDesktopOperation(name, args)`) over the one protocol connection
// (desktop-services.md §12.5, protocol.md §12.5): each operation with a Rust op becomes that op's named params,
// filled from the positional arguments the Node handlers took (`desktop-operations.ts`, `desktop-service.ts`
// `createServiceOperationRouter`, `notification-center.ts`, `server-file-operations.ts`). Expected params come from
// the Rust `v2/params.rs` structs and `operations_map.json`, not from this table.
import { normalizeBrowserPermissionPolicy } from '../../shared/browser-permission-policy';
import { isSessionRetentionSettingKey } from '../../shared/contract-settings';
import type { ProtocolConnection } from './connection';
import { coreErrorForWindow } from './core-error';

export interface OperationRoute {
  method: string;
  params: Record<string, unknown>;
}

type Mapper = (args: readonly unknown[]) => OperationRoute;

/** `names[i]` is the param the i-th positional argument fills; `null` is an argument the core has no param for (a
 *  Node-only value such as the user-data path every editor-backup call carried). An argument past the list is an
 *  error, never dropped; an undefined argument leaves its (optional) param out. */
function positional(method: string, names: ReadonlyArray<string | null>): Mapper {
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

const defined = (params: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));

/** `config/value/write` on one key of the Config actor (desktop-services.md §3). */
const configWrite = (path: string, value: unknown, mode?: 'initializeIfMissing'): OperationRoute => ({
  method: 'config/value/write',
  params: defined({ path, value, mode }),
});

const hostState = (key: 'browserTabs' | 'browserImport' | 'visualize'): Mapper => (args) => ({
  method: 'host/state/set',
  params: { key, value: args[0] },
});

/** `review/diff/get` for a repository (`scope: 'repo'`): the three `gitReview*` operations (DS §5.3). */
const repoReview = (shape: (args: readonly unknown[]) => Record<string, unknown>): Mapper => (args) => ({
  method: 'review/diff/get',
  params: defined({ scope: 'repo', ...shape(args) }),
});

const OPERATION_ROUTES: Readonly<Record<string, Mapper>> = {
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
  // The second argument is Node's status-scan cache hint (reuseLineStats / skipLineStats): the core owns that cache.
  gitStatus: positional('git/status', ['cwd', null]),
  gitSync: positional('git/sync', ['cwd']),
  gitUndoLastCommit: positional('git/undoLastCommit', ['cwd']),
  gitUnstage: positional('git/unstage', ['cwd', 'paths']),
  gitCliStatus: positional('git/cliStatus', ['refresh']),
  gitGlobalConfig: positional('git/globalConfig/read', []),
  installGitCli: positional('git/cli/install', []),
  setGitGlobalConfig: positional('git/globalConfig/write', ['key', 'value']),

  // GitHub
  ghPrCheckout: positional('github/pr/checkout', ['cwd', 'value']),
  ghPrCreate: positional('github/pr/create', ['cwd', 'value']),
  ghPrDefaultBranch: positional('github/pr/defaultBranch', ['cwd']),
  ghPrDiff: positional('github/pr/diff', ['cwd', 'value']),
  ghPrList: positional('github/pr/list', ['cwd']),
  ghPrMerge: positional('github/pr/merge', ['cwd', 'value', 'method']),
  ghPrView: positional('github/pr/view', ['cwd', 'value']),
  cancelGithubCliLogin: positional('github/login/cancel', ['flowId']),
  githubCliAccount: positional('github/account', []),
  githubCliLoginStart: positional('github/login/start', []),
  githubCliLoginStatus: positional('github/login/status', ['flowId']),
  githubCliLoginOpenBrowser: positional('github/login/openBrowser', ['flowId']),
  githubCliLogout: positional('github/logout', []),
  githubCliStatus: positional('github/status', ['refresh']),
  installGithubCli: positional('github/install', []),
  githubStarStatus: positional('github/starStatus', []),
  starGithub: positional('github/star', []),

  // documents
  libreOfficeStatus: positional('document/libreOfficeStatus', ['refresh']),
  documentPreviewIn: positional('document/preview', ['root', 'rel']),
  documentPreviewPagesIn: positional('document/previewPages', ['root', 'rel', 'options']),
  installLibreOffice: positional('document/installLibreOffice', []),

  // files (the editor-backup and scoped-settings calls lead with the Node user-data path)
  deleteEditorBackup: positional('projectFs/backup/delete', [null, 'sourcePath']),
  readEditorBackup: positional('projectFs/backup/read', [null, 'sourcePath']),
  writeEditorBackup: positional('projectFs/backup/write', [null, 'sourcePath', 'content', 'expectedContent']),
  readLocalFileAbs: positional('projectFs/readLocal', ['path']),
  // Node stats one path; the core stats a list (the answer is a list too).
  statLocalEntryAbs: ([path]) => ({ method: 'projectFs/statLocal', params: { paths: [path] } }),
  readProjectTextFileIn: positional('projectFs/readText', ['root', 'rel']),
  readProjectTextFileAuthorized: positional('projectFs/readText', ['root', 'rel']),
  writeProjectTextFileIn: positional('projectFs/writeText', ['root', 'rel', 'content', 'expectedContent', 'encoding']),
  writeProjectTextFileAuthorized: positional('projectFs/writeText', [
    'root',
    'rel',
    'content',
    'expectedContent',
    'encoding',
  ]),
  writeProjectTextFilesIn: positional('projectFs/writeTextBatch', ['root', 'files']),
  writeProjectTextFilesAuthorized: positional('projectFs/writeTextBatch', ['root', 'files']),
  readScopedEditorSettings: positional('projectFs/readEditorSettings', [null, 'root', 'rel', 'workspaceFile']),
  readWorkspaceFile: positional('projectFs/workspaceFile/read', ['workspaceFile']),
  writeWorkspaceFile: positional('projectFs/workspaceFile/write', ['workspaceFile', 'folders']),
  searchWorkspaceTextIn: positional('projectFs/searchText', ['root', 'options']),
  statProjectFileIn: positional('projectFs/stat', ['root', 'rel']),
  listHostDirectories: positional('projectFs/browseDirs', ['path']),
  listServerDirectories: positional('projectFs/browseDirs', ['path', 'includeHidden']),

  // desktop settings are keys of the Config actor (desktop-services.md §3)
  writeMarkdownDefaultView: ([, view]) => configWrite('desktop.editor.markdownDefaultView', view),
  updateActivityRailPins: ([pins, initializeIfMissing]) =>
    configWrite('desktop.activityRailPins', pins, initializeIfMissing === true ? 'initializeIfMissing' : undefined),
  updateSetting: ([key, enabled]) => configWrite(`desktop.${String(key)}`, enabled === true),
  updateNotificationVolume: ([volume]) => configWrite('desktop.notificationVolume', Number(volume)),
  updateBrowserPermissions: ([policy]) =>
    configWrite('desktop.browserPermissions', normalizeBrowserPermissionPolicy(policy)),
  updateSessionRetention: ([key, days]) => {
    if (!isSessionRetentionSettingKey(key)) throw new TypeError('session retention setting is invalid.');
    return configWrite(`desktop.${key}`, days);
  },
  updateZoom: ([factor]) => configWrite('desktop.zoom', Number(factor)),
  sendTestNotification: positional('notify/test', ['target']),

  // terminals; the size owner is the calling connection, so Node's force flag and client id have no param
  termEnsure: ([tabId, cwd, profile]) => ({
    method: 'terminal/ensure',
    params: { tabId: tabId == null || tabId === '' ? crypto.randomUUID() : tabId, options: defined({ cwd, profile }) },
  }),
  termAttach: positional('terminal/attach', ['tabId']),
  termProfiles: positional('terminal/profiles', []),
  termFocus: positional('terminal/focus', ['tabId', null, null]),
  termPause: positional('terminal/pause', ['tabId']),
  termResume: positional('terminal/resume', ['tabId']),
  termDispose: positional('terminal/dispose', ['tabId']),

  // remote access
  remoteAccessSetEnabled: positional('remoteAccess/setEnabled', ['enabled']),
  remoteAccessSetName: positional('remoteAccess/setName', ['name']),
  remoteAccessSetClientAlias: positional('remoteAccess/setClientAlias', ['clientId', 'alias']),
  remoteAccessRotate: positional('remoteAccess/rotate', []),
  remoteAccessRevokeClient: positional('remoteAccess/revokeClient', ['clientId']),
  // Node: settleOwed(operationArgs), the whole argument list.
  remoteAccessSettleOwedControllerKeys: (args) => ({
    method: 'remoteAccess/settleOwedControllerKeys',
    params: { input: [...args] },
  }),

  // state the desktop publishes into section hostState
  browserRemoteTabs: hostState('browserTabs'),
  browserRemoteImportProgress: hostState('browserImport'),
  visualizeRemotePublish: hostState('visualize'),

  // server-window transfers (the upload bytes are already base64, as `bytesB64`)
  serverUploadChunk: positional('transfer/writeChunk', ['transferId', 'offset', 'bytesB64']),
  serverUploadCommit: positional('transfer/commit', ['transferId']),
  serverUploadAbort: positional('transfer/abort', ['transferId']),
  serverTrashInfo: positional('transfer/trash/info', ['path']),
};

/** Operations whose Rust op exists but whose Node arguments the schema cannot carry, so a request would drop or
 *  invent data. They fail before anything is sent until the spec says how they map (desktop-ops-route-1.md "Open"). */
const NEEDS_RULING: Readonly<Record<string, string>> = {
  githubRequest: 'github/request has no cwd; Node resolves the repository from it',
  replaceWorkspaceTextIn: 'projectFs/replaceText has no replacement or relPaths',
  projectRecoveryIn: 'projectFs/recovery has no list action and no entry id',
  lspDocument: 'lsp/document has one root; Node takes projectPath and root',
  lspRequest: 'lsp/request has one root; Node takes projectPath, root, relPath, languageId, method and params',
  remoteAccessResolveClaim: 'the shape of remoteAccess/resolveClaim input is not specified',
  remoteAccessPairCode: 'remoteAccess/pairCode has no ensure/renew/release action',
  visualizeRemoteViewing: 'host/state/set publishes; Node answers whether a phone views the session',
  serverUploadBegin: 'transfer/beginWrite takes root and rel; Node takes name, size and a session scope',
  serverFileReadRange: 'transfer/readRange takes a transferId from transfer/beginRead; Node takes root and rel',
  serverTrashEntry: 'transfer/trash/entry has one path and no permanent flag; Node takes root, rel and permanent',
  setNotificationPreferences: 'the config path of a device patch is not specified',
  setConversationNotification: 'the config path of a notification target is not specified',
  // Served by the window process over the connection, not by an operation call (protocol/window-ipc.ts).
  folderWatch: 'fs/watch is owned by the window that watches (ProtocolConnection.watchFiles)',
  folderUnwatch: 'fs/unwatch is owned by the window that watches (ProtocolConnection.unwatchFiles)',
  listListeningPorts: 'system/ports/subscribe is owned by the viewing window (ProtocolConnection.viewPorts)',
};

export const ROUTED_DESKTOP_OPERATIONS: readonly string[] = Object.keys(OPERATION_ROUTES);
export const UNROUTED_DESKTOP_OPERATIONS: readonly string[] = Object.keys(NEEDS_RULING);

/** The core request for `name(...args)`. An operation with no Rust op is `unknownMethod`, one the schema cannot
 *  carry `unmappedOperation`; both are raised before anything is sent. */
export function routeDesktopOperation(name: string, args: readonly unknown[] = []): OperationRoute {
  const route = Object.hasOwn(OPERATION_ROUTES, name) ? OPERATION_ROUTES[name] : undefined;
  if (route) return route(args);
  const reason = Object.hasOwn(NEEDS_RULING, name) ? NEEDS_RULING[name] : undefined;
  if (reason) throw Object.assign(new Error(`desktop operation ${name} is not mapped: ${reason}`), { code: 'unmappedOperation' });
  throw Object.assign(new Error(`desktop operation ${name} has no protocol method`), { code: 'unknownMethod' });
}

export interface OperationLane {
  invoke(name: string, args: unknown[] | undefined): Promise<unknown>;
}

export function createOperationLane({ protocol }: { protocol: Pick<ProtocolConnection, 'call'> }): OperationLane {
  return {
    async invoke(name, args = []) {
      const { method, params } = routeDesktopOperation(name, args);
      return protocol.call(method, params).catch((error: unknown) => {
        throw coreErrorForWindow(error);
      });
    },
  };
}
