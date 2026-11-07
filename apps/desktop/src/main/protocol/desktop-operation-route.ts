// The renderer's desktop operations (`invokeDesktopOperation(name, args)`) over the one protocol connection
// (desktop-services.md §12.5, protocol.md §12.5): each operation with a Rust op becomes that op's named params,
// filled from the positional arguments the Node handlers took (`desktop-operations.ts`, `desktop-service.ts`
// `createServiceOperationRouter`, `notification-center.ts`, `server-file-operations.ts`). Expected params come from
// the Rust `v2/params.rs` structs and `operations_map.json`, not from this table.
import { normalizeBrowserPermissionPolicy } from '../../shared/browser-permission-policy';
import { isSessionRetentionSettingKey } from '../../shared/contract-settings';
import { remoteClientKind } from '../../shared/remote-trust';
import { pairedDeviceInfo } from '../notification-center';
import { desktopSettingsFromConfig, storedPinsState } from '../settings-store';
import type { ProtocolConnection } from './connection';
import { coreErrorForWindow } from './core-error';
import {
  visualizeRemoteViewing,
  DEFAULT_OPERATION_HOST,
  listConversationNotifications,
  notificationPreferencesState,
  type OperationHost,
  readActivityRailPins,
  readMarkdownDefaultView,
  readSettings,
  readZoom,
} from './section-reads';

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
const configWrite = (
  path: string,
  value: unknown,
  mode?: 'initializeIfMissing' | 'mergePatch' | 'mergePatchBots' | 'setConversation'
): OperationRoute => ({
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
  replaceWorkspaceTextIn: positional('projectFs/replaceText', ['root', 'options', 'replacement', 'relPaths']),
  // Node: projectRecoveryIn(root, { action: list | inspect | restore | discard, id?, revision? }).
  projectRecoveryIn: ([root, request]) => {
    const { action, id, revision } = record(request);
    return { method: 'projectFs/recovery', params: defined({ root, action, id, revision }) };
  },
  // Node: lspDocument(projectPath, root, input); lspRequest(projectPath, root, relPath, languageId, method, params).
  lspDocument: ([projectPath, root, input]) => ({
    method: 'lsp/document',
    params: { projectPath, root, document: input },
  }),
  lspRequest: ([projectPath, root, relPath, languageId, method, params]) => ({
    method: 'lsp/request',
    params: { projectPath, root, request: { relPath, languageId, method, params } },
  }),
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
  // Node: setPreferences(currentDeviceId, pcCanNotify, deviceId, patch). The fifth value is the merge mode the lane
  // decides from the device's pairing (PREPARERS); the patch is merged in the core, in one write.
  setNotificationPreferences: ([, , deviceId, patch, mode]) =>
    configWrite(`notifications.devices.${String(deviceId)}`, patch, mode === 'mergePatchBots' ? 'mergePatchBots' : 'mergePatch'),
  setConversationNotification: ([target, setting]) =>
    configWrite('notifications.overrides', { target, setting }, 'setConversation'),

  // terminals; the size owner is the calling connection, so Node's force flag and client id have no param
  // With no id the core spawns a new terminal and answers the id it made.
  termEnsure: ([tabId, cwd, profile]) => ({
    method: 'terminal/ensure',
    params: defined({ tabId: tabId == null || tabId === '' ? undefined : tabId, options: defined({ cwd, profile }) }),
  }),
  termAttach: positional('terminal/attach', ['tabId']),
  termProfiles: positional('terminal/profiles', []),
  // Node: focus(id, focused, client): a view shows (true) or leaves (false) the tab; the client is the connection.
  termFocus: ([tabId, focused]) => ({ method: 'terminal/focus', params: { tabId, focused: focused === true } }),
  termPause: positional('terminal/pause', ['tabId']),
  termResume: positional('terminal/resume', ['tabId']),
  termDispose: positional('terminal/dispose', ['tabId']),

  // remote access
  remoteAccessSetEnabled: positional('remoteAccess/setEnabled', ['enabled']),
  remoteAccessSetName: positional('remoteAccess/setName', ['name']),
  remoteAccessSetClientAlias: positional('remoteAccess/setClientAlias', ['clientId', 'alias']),
  remoteAccessRotate: positional('remoteAccess/rotate', []),
  // Node: resolve(String(args[0] || ''), args[1] === true).
  remoteAccessResolveClaim: ([claimId, approve]) => ({
    method: 'remoteAccess/resolveClaim',
    params: { claimId: String(claimId || ''), approve: approve === true },
  }),
  // Node: 'release' and 'renew' as asked, anything else 'ensure'.
  remoteAccessPairCode: ([action]) => ({
    method: 'remoteAccess/pairCode',
    params: { action: action === 'release' || action === 'renew' ? action : 'ensure' },
  }),
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
  serverUploadBegin: positional('transfer/beginWrite', ['name', 'size', 'scope']),
  serverFileReadRange: positional('transfer/readRange', ['root', 'rel', 'offset', 'length']),
  // Node: trashEntry(root, rel, permanent === true); the core names the root `path`, as trash/info does.
  serverTrashEntry: ([root, rel, permanent]) => ({
    method: 'transfer/trash/entry',
    params: { path: root, rel, permanent: permanent === true },
  }),
  serverUploadChunk: positional('transfer/writeChunk', ['transferId', 'offset', 'bytesB64']),
  serverUploadCommit: positional('transfer/commit', ['transferId']),
  serverUploadAbort: positional('transfer/abort', ['transferId']),
  serverTrashInfo: positional('transfer/trash/info', ['path']),
};

/** Operations with a Rust op that the window serves over its own connection, so no operation call carries them. */
const NEEDS_RULING: Readonly<Record<string, string>> = {
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
  // An agent's explicit reveal or hide of a browser surface, reported by the window process's browser host; the core
  // publishes it as `ui/openRequested { kind: 'browser' }` to the attached clients (paired phones included).
  browserRemoteOpen: {
    route: ([request]) => {
      const fields = record(request);
      if (typeof fields.sessionId !== 'string' || !fields.sessionId) {
        throw new TypeError('browserRemoteOpen needs a request with a sessionId.');
      }
      return { method: 'host/browser/surface', params: fields };
    },
    result: null,
  },
  remoteAccessResume: { route: () => ({ method: 'host/power', params: { event: 'resume' } }), result: null },
  remoteAccessSuspend: { route: () => ({ method: 'host/power', params: { event: 'suspend' } }), result: null },
};

export const NOTIFICATION_DESKTOP_OPERATIONS: readonly string[] = Object.keys(NOTIFICATION_ROUTES);

/** The client notification for `name(...args)`, or none when `name` is not one of the five. */
export function routeDesktopNotification(name: string, args: readonly unknown[] = []): OperationRoute | null {
  return Object.hasOwn(NOTIFICATION_ROUTES, name) ? NOTIFICATION_ROUTES[name].route(args) : null;
}

interface SectionEntry {
  readonly section: string;
  readonly key: string | null;
  readonly value: unknown;
}

export interface ReplyContext {
  args: readonly unknown[];
  params: Record<string, unknown>;
  call(method: string, params: unknown): Promise<unknown>;
  invoke(name: string, args: unknown[]): Promise<unknown>;
}
type Reply = (reply: unknown, context: ReplyContext) => unknown;

/** What an operation needs decided before its request is built. */
type Prepare = (
  args: readonly unknown[],
  context: { entries(): readonly SectionEntry[] }
) => Promise<unknown[]>;

const PREPARERS: Readonly<Record<string, Prepare>> = {
  // A phone app paired at or after the store was first written starts from bot chats only (Node's devicePreferencesIn):
  // the mode names which default the core merges the patch onto. A device that is not paired is refused, as Node does.
  // The paired device is a row of the `remote` section's `clients` (mixdog-remote `ClientInfo`: id, name, platform,
  // browser, createdAt, lastSeenAt, online, and pendingRemoval while an unpair is queued); `migratedAt` is the one of
  // `config.notifications`, 0 while that subtree has not been written, as the notification state reads it.
  setNotificationPreferences: async (args, { entries }) => {
    const deviceId = String(args[2] ?? '');
    if (deviceId === 'pc') return [...args, 'mergePatch'];
    const clients = record(entries().find((entry) => entry.section === 'remote' && entry.key === null)?.value).clients;
    const client = (Array.isArray(clients) ? clients : [])
      .map(record)
      .find((candidate) => candidate.id === deviceId && candidate.pendingRemoval !== true);
    if (!client) throw new TypeError('That device is not paired with this PC.');
    const stored = record(entries().find((entry) => entry.section === 'config' && entry.key === 'notifications')?.value).migratedAt;
    const migratedAt = Number.isSafeInteger(stored) ? (stored as number) : 0;
    const info = pairedDeviceInfo({
      id: deviceId,
      name: '',
      platform: '',
      browser: String(client.browser ?? ''),
      createdAt: Number(client.createdAt),
      lastSeenAt: 0,
      online: false,
    });
    const botsFirst = info.kind === 'phone-app' && info.pairedAt !== undefined && info.pairedAt >= migratedAt;
    return [...args, botsFirst ? 'mergePatchBots' : 'mergePatch'];
  },
};

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
  'remoteAccessRotate', 'remoteAccessRevokeClient', 'serverUploadCommit', 'serverTrashInfo', 'githubRequest',
  'replaceWorkspaceTextIn', 'projectRecoveryIn', 'lspDocument', 'lspRequest', 'remoteAccessResolveClaim',
  'remoteAccessPairCode', 'serverFileReadRange', 'serverTrashEntry',
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
  // The core stats a list; Node answered the one entry, or threw the stat's error: a slot { error } is that error.
  statLocalEntryAbs: (reply) => {
    if (!Array.isArray(reply)) throw new TypeError('projectFs/statLocal did not answer a list.');
    const entry = reply[0];
    const failure = record(entry).error;
    if (typeof failure === 'string') throw new Error(failure);
    return entry;
  },
  // Node answered the started flow; the core answers {flowId} and the flow is its status snapshot (DS 5.4).
  githubCliLoginStart: (reply, { call }) => call('github/login/status', { flowId: record(reply).flowId }),
  // Node answered the boolean the UI reads as "the browser was opened by gh".
  githubCliLoginOpenBrowser: (reply) => reply === true,
  // Node answered {id, replay, sizeOwner?} and left `sizeOwner` out when no phone owns the size, where the core writes
  // null; the id is the core's own (a client id it accepted, else the one it made).
  termEnsure: (reply) => {
    const { sizeOwner, ...rest } = record(reply);
    return { ...rest, ...(sizeOwner == null ? {} : { sizeOwner }) };
  },
  // Node answered the bytes received so far: a chunk is acknowledged only when written, at offset + its length.
  serverUploadChunk: (_reply, { args }) => ({
    received: Number(args[1]) + Buffer.from(String(args[2]), 'base64').length,
  }),
  // Node answered false for an unknown upload: the core says so with { aborted }.
  serverUploadAbort: (reply) => record(reply).aborted === true,
  // Node: { uploadId, chunkBytes, maxBytes }.
  serverUploadBegin: (reply) => {
    const { uploadId, chunkBytes, maxBytes } = record(reply);
    return { uploadId, chunkBytes, maxBytes };
  },
  // Node answered the whole state after the write; the core answers the merged record of the one device.
  setNotificationPreferences: (_reply, { args, invoke }) =>
    invoke('notificationPreferencesState', [args[0], args[1]]),
  // Node answered the overrides in force: the stored list.
  setConversationNotification: (reply) => written(reply),
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

type SectionRead = (snapshot: ReturnType<ProtocolConnection['snapshot']>, args: readonly unknown[], host: Partial<OperationHost>) => unknown;

/** Operations answered from the sections the connection holds (desktop-services.md §2.4, §3). */
const SECTION_READS: Readonly<Record<string, SectionRead>> = {
  readSettings: (snapshot) => readSettings(snapshot),
  readActivityRailPins: (snapshot) => readActivityRailPins(snapshot),
  readZoom: (snapshot) => readZoom(snapshot),
  readMarkdownDefaultView: (snapshot) => readMarkdownDefaultView(snapshot),
  listConversationNotifications: (snapshot) => listConversationNotifications(snapshot, Date.now()),
  notificationPreferencesState: (snapshot, args, host) => notificationPreferencesState(snapshot, args, host),
  visualizeRemoteViewing: (snapshot, args) => visualizeRemoteViewing(snapshot, args),
};
export const SECTION_READ_DESKTOP_OPERATIONS: readonly string[] = Object.keys(SECTION_READS);

/** Deleted by the spec, with a caller that still runs on a core connection (it shares code with the Node host):
 *  the core publishes these changes itself (config/modelCatalog sections; browser approvals are core state, DS §12.3),
 *  so the call is answered as Node answered it, `undefined`, and sends nothing. */
export const IGNORED_DESKTOP_OPERATIONS: readonly string[] = [
  'notifyProviderModelsChanged',
  'notifySettingsChanged',
  'publishBrowserApprovalSessions',
];

/** Deleted or core-internal; no caller exists on a core connection. Calling one is a bug and is refused. */
export const DELETED_DESKTOP_OPERATIONS: Readonly<Record<string, string>> = {
  browserRemoteFrame: 'paint frames are X17 media frames on the host connection (host/browser-view.ts)',
  browserRemoteResolve: 'the host role answers the core\'s host/* requests itself (host/connection.ts)',
  browserRemoteWebrtcSignal: 'WebRTC runs in mixdog-remote (SPEC R36)',
  gitPathspecChanges: 'no caller (DS 17.2)',
  lspDisposeUnder: 'project/delete and worktree removal dispose the servers inside the core (DS 4.1)',
  modelProxyClaim: 'replaced by server request model/proxy/execute (protocol/model-proxy-relay.ts)',
  modelProxyEvent: 'replaced by server request model/proxy/execute (protocol/model-proxy-relay.ts)',
  modelProxyHeartbeat: 'replaced by connection liveness (protocol/model-proxy-relay.ts)',
  modelProxyResolve: 'replaced by server request model/proxy/execute (protocol/model-proxy-relay.ts)',
  readBrowserApprovalSessions: 'browser approvals are core state (DS 12.3)',
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
  const deleted = Object.hasOwn(DELETED_DESKTOP_OPERATIONS, name) ? `: ${DELETED_DESKTOP_OPERATIONS[name]}` : '';
  throw Object.assign(new Error(`desktop operation ${name} has no protocol method${deleted}`), { code: 'unknownMethod' });
}

export interface OperationLane {
  invoke(name: string, args: unknown[] | undefined): Promise<unknown>;
}

export function createOperationLane({
  protocol,
  host = DEFAULT_OPERATION_HOST,
}: {
  protocol: Pick<ProtocolConnection, 'call' | 'notify'> & Partial<Pick<ProtocolConnection, 'snapshot'>>;
  host?: Partial<OperationHost>;
}): OperationLane {
  const call = (method: string, params: unknown): Promise<unknown> =>
    protocol.call(method, params).catch((error: unknown) => {
      throw coreErrorForWindow(error);
    });
  const lane: OperationLane = {
    async invoke(name, args = []) {
      const notification = routeDesktopNotification(name, args);
      if (notification) {
        protocol.notify(notification.method, notification.params);
        return NOTIFICATION_ROUTES[name].result;
      }
      if (Object.hasOwn(SECTION_READS, name)) {
        if (!protocol.snapshot) throw new Error(`desktop operation ${name} needs the connection's held sections.`);
        return SECTION_READS[name](protocol.snapshot(), args, host);
      }
      if (IGNORED_DESKTOP_OPERATIONS.includes(name)) return undefined;
      const prepare = Object.hasOwn(PREPARERS, name) ? PREPARERS[name] : undefined;
      if (prepare && !protocol.snapshot) throw new Error(`desktop operation ${name} needs the connection's held sections.`);
      const routed = prepare ? await prepare(args, { entries: () => protocol.snapshot!().entries }) : args;
      const { method, params } = routeDesktopOperation(name, routed);
      return REPLIES[name](await call(method, params), { args, params, call, invoke: lane.invoke });
    },
  };
  return lane;
}
