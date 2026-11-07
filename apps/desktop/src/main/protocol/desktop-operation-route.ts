// The renderer's desktop operations (`invokeDesktopOperation(name, args)`) over the one protocol connection
// (desktop-services.md §12.5, protocol.md §12.5): each operation with a Rust op becomes that op's named params,
// filled from the positional arguments the Node handlers took (`desktop-operations.ts`, `desktop-service.ts`
// `createServiceOperationRouter`, `notification-center.ts`, `server-file-operations.ts`). Expected params come from
// the Rust `v2/params.rs` structs and `operations_map.json`, not from this table.
import { normalizeBrowserPermissionPolicy } from '../../shared/browser-permission-policy';
import { isSessionRetentionSettingKey } from '../../shared/contract-settings';
import { desktopSettingsFromConfig, storedPinsState } from '../settings-store';
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
  // Node: focus(id, focused, client). terminal/focus has no `focused`: a focus is sent, an unfocus has no op.
  termFocus: ([tabId, focused]) => {
    if (focused !== true) {
      throw Object.assign(new Error('desktop operation termFocus is not mapped: terminal/focus cannot unfocus'), {
        code: 'unmappedOperation',
      });
    }
    return { method: 'terminal/focus', params: { tabId } };
  },
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

/** Operations whose spec target is a client notification (no reply, no slot): sent with `ProtocolConnection.notify`.
 *  `result` is what Node's handler returned. */
const NOTIFICATION_ROUTES: Readonly<Record<string, { route: Mapper; result: null | undefined }>> = {
  termWrite: {
    route: (args) => ({
      method: 'terminal/input',
      params: { tabId: String(args[0] || ''), data: String(args[1] ?? '') },
    }),
    result: null,
  },
  // The 4th argument (remote client claiming the size) is the sending connection now (DS 6.2).
  termResize: {
    route: (args) => ({
      method: 'terminal/resize',
      params: { tabId: String(args[0] || ''), cols: Number(args[1]), rows: Number(args[2]) },
    }),
    result: null,
  },
  publishUpdaterState: {
    route: (args) => ({ method: 'host/update/report', params: { state: args[0] } }),
    result: undefined,
  },
  remoteAccessResume: { route: () => ({ method: 'host/power', params: { event: 'resume' } }), result: null },
  remoteAccessSuspend: { route: () => ({ method: 'host/power', params: { event: 'suspend' } }), result: null },
};

export const NOTIFICATION_DESKTOP_OPERATIONS: readonly string[] = Object.keys(NOTIFICATION_ROUTES);

/** The client notification for `name(...args)`, or none when `name` is not one of the five. */
export function routeDesktopNotification(name: string, args: readonly unknown[] = []): OperationRoute | null {
  return Object.hasOwn(NOTIFICATION_ROUTES, name) ? NOTIFICATION_ROUTES[name].route(args) : null;
}

export interface ReplyContext {
  args: readonly unknown[];
  params: Record<string, unknown>;
  call(method: string, params: unknown): Promise<unknown>;
}
type Reply = (reply: unknown, context: ReplyContext) => unknown;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The value a `config/value/write` stored (`ConfigWriteResponse.values[0]`). */
function written(reply: unknown): unknown {
  const values = record(reply).values;
  if (!Array.isArray(values)) throw new TypeError('The config write did not return the stored value.');
  return values[0];
}

/** Node's settings writers answered the whole `DesktopSettings` of the saved config; the write reply carries only the
 *  stored value, so the saved config is read back (`config/read`, the write is complete when it answers). */
const savedSettings: Reply = async (_reply, { call }) =>
  desktopSettingsFromConfig(record(await call('config/read', { keys: ['agent', 'desktop'] })).config);

/** Replies that are Node's return value as the core sends it (the parity contract of DS-SCM-1, DS-WS-1, DS-REM-1:
 *  the JSON equals what the Node implementation returned). */
const SAME_REPLY: readonly string[] = [
  'gitAbortOperation', 'gitAmend', 'gitBranches', 'gitCherryPickCommit', 'gitCommit', 'gitCommitPaths', 'gitContinue',
  'gitCreateTag', 'gitDeleteBranch', 'gitDeleteTag', 'gitDiff', 'gitFetch', 'gitLog', 'gitPull', 'gitPush',
  'gitRenameBranch', 'gitResetToCommit', 'gitRevertCommit', 'gitReview', 'gitReviewDiff', 'gitReviewDiffs', 'gitShow',
  'gitShowDiff', 'gitShowFile', 'gitRequestContext', 'gitStash', 'gitStashApply', 'gitStashDrop', 'gitStashList',
  'gitStashPop', 'gitStatus', 'gitSync', 'gitUndoLastCommit', 'gitCliStatus', 'gitGlobalConfig', 'installGitCli',
  'setGitGlobalConfig', 'ghPrCheckout', 'ghPrCreate', 'ghPrDefaultBranch', 'ghPrDiff', 'ghPrList', 'ghPrMerge',
  'ghPrView', 'githubCliAccount', 'githubCliLoginStatus', 'githubCliLogout', 'githubCliStatus', 'installGithubCli',
  'githubStarStatus', 'starGithub', 'libreOfficeStatus', 'documentPreviewIn', 'documentPreviewPagesIn',
  'installLibreOffice', 'readEditorBackup', 'writeEditorBackup', 'readLocalFileAbs', 'readProjectTextFileIn',
  'readProjectTextFileAuthorized', 'writeProjectTextFileIn', 'writeProjectTextFileAuthorized',
  'writeProjectTextFilesIn', 'writeProjectTextFilesAuthorized', 'readScopedEditorSettings', 'readWorkspaceFile',
  'writeWorkspaceFile', 'searchWorkspaceTextIn', 'statProjectFileIn', 'listHostDirectories', 'listServerDirectories',
  'sendTestNotification', 'termProfiles', 'termAttach', 'remoteAccessSetEnabled', 'remoteAccessSetName',
  'remoteAccessRotate', 'remoteAccessRevokeClient', 'serverUploadCommit', 'serverTrashInfo',
];
/** Node returned nothing. */
const VOID_REPLY: readonly string[] = [
  'gitApplyPatch', 'gitIgnore', 'gitRevertFile', 'gitStage', 'gitUnstage', 'cancelGithubCliLogin', 'deleteEditorBackup',
];
/** Node returned null. */
const NULL_REPLY: readonly string[] = [
  'termFocus', 'termPause', 'termResume', 'termDispose', 'remoteAccessSetClientAlias',
  'remoteAccessSettleOwedControllerKeys', 'browserRemoteTabs', 'browserRemoteImportProgress', 'visualizeRemotePublish',
];

const CUSTOM_REPLY: Readonly<Record<string, Reply>> = {
  // The core stats a list; Node answered the one entry.
  statLocalEntryAbs: (reply) => {
    if (!Array.isArray(reply)) throw new TypeError('projectFs/statLocal did not answer a list.');
    return reply[0];
  },
  // Node answered the started flow; the core answers {flowId} and the flow is its status snapshot (DS 5.4).
  githubCliLoginStart: (reply, { call }) => call('github/login/status', { flowId: record(reply).flowId }),
  // Node answered the boolean the UI reads as "the browser was opened by gh".
  githubCliLoginOpenBrowser: (reply) => reply === true,
  // The tab id is the client's own; Node answered {id, replay, sizeOwner?}.
  termEnsure: (reply, { params }) => ({ id: params.tabId, ...record(reply) }),
  // Node answered the bytes received so far: a chunk is acknowledged only when written, at offset + its length.
  serverUploadChunk: (_reply, { args }) => ({
    received: Number(args[1]) + Buffer.from(String(args[2]), 'base64').length,
  }),
  // Node answered false for an unknown upload; the core's EmptyResult is a success.
  serverUploadAbort: () => true,
  updateSetting: savedSettings,
  updateNotificationVolume: savedSettings,
  updateBrowserPermissions: savedSettings,
  updateSessionRetention: savedSettings,
  updateZoom: (reply) => Number(written(reply)),
  writeMarkdownDefaultView: (reply) => written(reply),
  updateActivityRailPins: (reply) => {
    const state = storedPinsState(written(reply));
    if (!state) throw new TypeError('The config write did not return valid activity rail pins.');
    return state;
  },
};

const REPLIES: Readonly<Record<string, Reply>> = {
  ...Object.fromEntries(SAME_REPLY.map((name): [string, Reply] => [name, (reply) => reply])),
  ...Object.fromEntries(VOID_REPLY.map((name): [string, Reply] => [name, () => undefined])),
  ...Object.fromEntries(NULL_REPLY.map((name): [string, Reply] => [name, () => null])),
  ...CUSTOM_REPLY,
};

export const REPLY_DESKTOP_OPERATIONS: readonly string[] = Object.keys(REPLIES);

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

export function createOperationLane({
  protocol,
}: {
  protocol: Pick<ProtocolConnection, 'call' | 'notify'>;
}): OperationLane {
  const call = (method: string, params: unknown): Promise<unknown> =>
    protocol.call(method, params).catch((error: unknown) => {
      throw coreErrorForWindow(error);
    });
  return {
    async invoke(name, args = []) {
      const notification = routeDesktopNotification(name, args);
      if (notification) {
        protocol.notify(notification.method, notification.params);
        return NOTIFICATION_ROUTES[name].result;
      }
      const { method, params } = routeDesktopOperation(name, args);
      return REPLIES[name](await call(method, params), { args, params, call });
    },
  };
}
