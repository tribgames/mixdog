import { normalizeBrowserPermissionPolicy } from '../browser-permission-policy';
import { isSessionRetentionSettingKey } from '../contract-settings';
import { announcedEvent } from '../core-announcements';
import type { DesktopSettingKey } from '../contract';
import { desktopSettingPath, desktopSettingsFromConfig } from '../desktop-settings';
import { readSettingsChange } from '../settings-changed';
import { notificationWriteMode } from '../notification-state';
import { storedPinsState } from '../activity-rail-pins';
import { createProjectWatchRegistry } from '../project-watch-registry';
import {
  defined,
  positional,
  SCM_OPERATION_ROUTES,
  SCM_REPLIES,
  type OperationMapper,
  type OperationRoute,
} from '../scm-operation-route';
import { terminalEnsureRequest, terminalReply } from '../terminal-protocol';
import type { ProtocolConnection, ProtocolWindow } from '../../main/protocol/connection';
import { coreErrorForWindow } from './core-error';
import { remoteAccessInfo, remotePagedMember } from './remote-reads';
import {
  visualizeRemoteViewing,
  listConversationNotifications,
  notificationPreferencesState,
  type OperationHost,
  readActivityRailPins,
  readMarkdownDefaultView,
  readSettings,
  readZoom,
  record,
  SECTION_READ_CONFIG,
  withPagedConfig,
  termActivity,
} from './section-reads';

export type { OperationRoute };

/** The byte length Buffer.from(text, 'base64') decodes to (it stops at the first '=' and skips characters outside
 *  the standard and URL-safe alphabets), computed without Buffer. */
export function base64ByteLength(text: string): number {
  const end = text.indexOf('=');
  const body = end < 0 ? text : text.slice(0, end);
  return Math.floor((body.replace(/[^A-Za-z0-9+/_-]/g, '').length * 3) / 4);
}
type Mapper = OperationMapper;

/** `config/value/write` on one key of the Config actor (desktop-services.md §3). */
const configWrite = (
  path: string,
  value: unknown,
  mode?: 'initializeIfMissing' | 'mergePatch' | 'mergePatchBots' | 'setConversation',
  announce?: 'desktop'
): OperationRoute => ({
  method: 'config/value/write',
  params: defined({ path, value, mode, announce }),
});

/** A settings write the window's handler announced as `desktop` after Node's store saved it: the core announces it once saved. */
const desktopWrite = (path: string, value: unknown): OperationRoute => configWrite(path, value, undefined, 'desktop');

const hostState =
  (key: 'browserTabs' | 'browserImport' | 'visualize'): Mapper =>
  (args) => ({
    method: 'host/state/set',
    params: { key, value: args[0] },
  });

const OPERATION_ROUTES: Readonly<Record<string, Mapper>> = {
  ...SCM_OPERATION_ROUTES,

  // documents
  documentPreviewIn: positional('document/preview', ['root', 'rel']),
  documentPreviewPagesIn: positional('document/previewPages', ['root', 'rel', 'options']),

  // files (the editor-backup and scoped-settings calls lead with the user-data path, which has no core param)
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

  // grants (a minted access token is the default, as the rooted service route's callers expect)
  grantDescribe: ([paths, mint]) => ({ method: 'projectFs/grant/describe', params: { paths, mint: mint !== false } }),
  grantRedeem: positional('projectFs/grant/redeem', ['accessToken', 'projectPath', 'relPath']),

  // a standalone folder (one that is no project) and the file operations on it, rooted at the folder
  standaloneRoot: ([path]) => ({ method: 'project/directory', params: { path, standalone: true } }),
  listProjectDirIn: positional('projectFs/listDir', ['root', 'rel']),
  createProjectEntryIn: positional('projectFs/create', ['root', 'relDir', 'name', 'directory']),
  renameProjectEntryIn: positional('projectFs/rename', ['root', 'rel', 'newName']),
  moveProjectEntryIn: positional('projectFs/move', ['root', 'rel', 'targetDirRel']),
  copyProjectEntryIn: positional('projectFs/copy', ['root', 'rel', 'targetDirRel']),
  trashProjectEntryIn: ([root, rel]) => ({ method: 'projectFs/trash', params: { root, rel, viaHost: true } }),
  projectEntryPathIn: positional('projectFs/entryPath', ['root', 'rel']),

  // local pages served by the core page server
  localPageUrlIn: positional('projectFs/localPageUrl', ['root', 'rel', 'accessToken', 'ownerId']),
  localPageRevokeOwner: positional('projectFs/localPage/revokeOwner', ['ownerId']),
  localPageOrigin: positional('projectFs/localPage/origin', []),
  // files: [{ path, dataBase64 | text, type }] (CoreLocalPages.virtual maps a Record of VirtualPageFile to it).
  localPageVirtualIn: positional('projectFs/localPage/virtual', ['files', 'ownerId']),
  localPageAssetType: positional('projectFs/localPage/assetType', ['root', 'file', 'dataRoot']),

  // desktop settings are keys of the Config actor (desktop-services.md §3)
  writeMarkdownDefaultView: ([, view]) => desktopWrite('desktop.editor.markdownDefaultView', view),
  updateActivityRailPins: ([pins, initializeIfMissing]) => {
    // A flag that is not a boolean is refused before anything is written.
    if (initializeIfMissing !== undefined && typeof initializeIfMissing !== 'boolean') {
      throw new TypeError('initializeIfMissing must be a boolean.');
    }
    return configWrite(
      'desktop.activityRailPins',
      pins,
      initializeIfMissing === true ? 'initializeIfMissing' : undefined
    );
  },
  // `autoClear` and `autoCompact` live in the agent config, every other key under `desktop` (settings-store.ts `update`).
  updateSetting: ([key, enabled]) => desktopWrite(desktopSettingPath(key as DesktopSettingKey), enabled === true),
  updateNotificationVolume: ([volume]) => desktopWrite('desktop.notificationVolume', Number(volume)),
  updateBotHandoffLimit: ([limit]) => desktopWrite('desktop.botHandoffLimit', Number(limit)),
  updateBrowserPermissions: ([policy]) =>
    desktopWrite('desktop.browserPermissions', normalizeBrowserPermissionPolicy(policy)),
  updateSessionRetention: ([key, days]) => {
    if (!isSessionRetentionSettingKey(key)) throw new TypeError('session retention setting is invalid.');
    return desktopWrite(`desktop.${key}`, days);
  },
  updateZoom: ([factor]) => configWrite('desktop.zoom', Number(factor)),
  sendTestNotification: positional('notify/test', ['target']),
  // Node: setPreferences(currentDeviceId, pcCanNotify, deviceId, patch). The fifth value is the merge mode the lane
  // decides from the device's pairing (PREPARERS); the patch is merged in the core, in one write.
  setNotificationPreferences: ([, , deviceId, patch, mode]) =>
    configWrite(
      `notifications.devices.${String(deviceId)}`,
      patch,
      mode === 'mergePatchBots' ? 'mergePatchBots' : 'mergePatch'
    ),
  setConversationNotification: ([target, setting]) =>
    configWrite('notifications.overrides', { target, setting }, 'setConversation'),

  // terminals; the size owner is the calling connection, so a force flag and client id have no param
  // With no id the core spawns a new terminal and answers the id it made.
  termEnsure: ([tabId, cwd, profile]) => terminalEnsureRequest(tabId, cwd, profile),
  // `resumeFrom` ({ epoch, seq }) asks the core to continue the replay after that point; left out when not given.
  termAttach: ([tabId, resumeFrom]) => ({ method: 'terminal/attach', params: defined({ tabId, resumeFrom }) }),
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
  pcAccessReadiness: positional('pcAccess/readiness', []),
  pcAccessApprove: positional('pcAccess/approve', []),
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
  // "Download to this PC": this PC's core copies the server file through its own link to the server (the window's id).
  serverDownloadBegin: positional('transfer/serverDownload/begin', ['serverId', 'downloadsDir', 'root', 'rel']),
  serverDownloadStep: positional('transfer/serverDownload/step', ['downloadId']),
  serverDownloadFinish: positional('transfer/serverDownload/finish', ['downloadId']),
  serverDownloadAbort: positional('transfer/serverDownload/abort', ['downloadId']),
  serverDownloadCheck: positional('transfer/serverDownload/check', ['path']),
};

/** Operations with a Rust op that the window serves over its own connection, so no operation call carries them. */
const NEEDS_RULING: Readonly<Record<string, string>> = {
  // Not one request: a reference-counted watch. A window holds its own (renderer/core-direct/renderer-connection.ts,
  // renderer/project-file-changes.ts); the operation lane serves the callers without a window (the relay) before routing.
  folderWatch: 'fs/watch is owned by the window that watches (ProtocolConnection.watchFiles)',
  folderUnwatch: 'fs/unwatch is owned by the window that watches (ProtocolConnection.unwatchFiles)',
  listListeningPorts: 'system/ports/subscribe is owned by the viewing window (ProtocolConnection.viewPorts)',
};

/** Operations whose spec target is a client notification (no reply, no slot): sent with `ProtocolConnection.notify`.
 *  `result` is what the operation answers. */
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
type Prepare = (args: readonly unknown[], context: { entries(): readonly SectionEntry[] }) => Promise<unknown[]>;

const PREPARERS: Readonly<Record<string, Prepare>> = {
  // The write mode names which default the core merges the patch onto: a phone paired at or after the store was first
  // written starts from bot chats only. A device that is not paired is refused.
  setNotificationPreferences: async (args, { entries }) => {
    const remote = entries().find((entry) => entry.section === 'remote' && entry.key === null)?.value;
    const notifications = entries().find((entry) => entry.section === 'config' && entry.key === 'notifications')?.value;
    return [...args, notificationWriteMode(String(args[2] ?? ''), remote, notifications)];
  },
};

/** Operations the spec removes from the wire, with what replaces each. A call is an error here (never an empty
 *  answer): the caller is a Node-path call site that the core connection does not make (desktop-ops-new-b-r.md). */
const RETIRED_OPERATIONS: Readonly<Record<string, string>> = {
  remoteAccessStart:
    'the relay starts at core boot from config (DS 7.2); the explicit activation is remoteAccess/activate',
  remoteTransportPeerAttach: 'the carrier peer connection runs in mixdog-remote (SPEC R36); there is no peer window',
  remoteTransportPeerDetach: 'the carrier peer connection runs in mixdog-remote (SPEC R36); there is no peer window',
  remoteTransportPeerReport: 'the carrier peer connection runs in mixdog-remote (SPEC R36); there is no peer window',
  systemProxyAttach: 'the host claim with capabilities.host.systemProxy attaches the resolver (host/claim)',
  systemProxyResolved: 'the host answers the server request host/systemProxy/resolve (host/system-proxy.ts)',
  termDisposeUnder: 'the shared FolderRelease hook disposes the terminals under a removed folder (DS 4.1)',
  termSessionTabs: 'the terminal tool reads the tabs in-process (TabsTerminalPort, DS 6.3)',
  termSnapshot: 'the terminal tool reads the tabs in-process (TabsTerminalPort, DS 6.3)',
  terminalRemoteOpen: 'the core sends ui/openRequested{kind: terminal} itself (protocol/open-requested.ts)',
};

export const RETIRED_DESKTOP_OPERATIONS: readonly string[] = Object.keys(RETIRED_OPERATIONS);
/** The value a `config/value/write` stored (`ConfigWriteResponse.values[0]`). */
function written(reply: unknown): unknown {
  const values = record(reply).values;
  if (!Array.isArray(values)) throw new TypeError('The config write did not return the stored value.');
  return values[0];
}

/** A settings write answers the whole `DesktopSettings` of the saved config; the core's write reply carries only the
 *  stored value, so the saved config is read back (`config/read`, the write is complete when it answers). */
const savedSettings: Reply = async (_reply, { call }) =>
  desktopSettingsFromConfig(record(await call('config/read', { keys: ['agent', 'desktop'] })).config);

/** Operations whose reply is the operation's return value exactly as the core sends it (DS-SCM-1, DS-WS-1, DS-REM-1). */
const SAME_REPLY: readonly string[] = [
  'documentPreviewIn',
  'documentPreviewPagesIn',
  'readEditorBackup',
  'writeEditorBackup',
  'readLocalFileAbs',
  'readProjectTextFileIn',
  'readProjectTextFileAuthorized',
  'writeProjectTextFileIn',
  'writeProjectTextFileAuthorized',
  'writeProjectTextFilesIn',
  'writeProjectTextFilesAuthorized',
  'readScopedEditorSettings',
  'readWorkspaceFile',
  'writeWorkspaceFile',
  'searchWorkspaceTextIn',
  'statProjectFileIn',
  'listHostDirectories',
  'listServerDirectories',
  'sendTestNotification',
  'termProfiles',
  'remoteAccessSetEnabled',
  'remoteAccessSetName',
  'remoteAccessRotate',
  'remoteAccessRevokeClient',
  'serverUploadCommit',
  'serverTrashInfo',
  'replaceWorkspaceTextIn',
  'projectRecoveryIn',
  'lspDocument',
  'lspRequest',
  'remoteAccessResolveClaim',
  'remoteAccessPairCode',
  'serverFileReadRange',
  'serverTrashEntry',
  'serverDownloadBegin',
  'serverDownloadStep',
  'serverDownloadFinish',
  'grantDescribe',
  'grantRedeem',
  'listProjectDirIn',
  'createProjectEntryIn',
  'renameProjectEntryIn',
  'moveProjectEntryIn',
  'copyProjectEntryIn',
  'localPageUrlIn',
  'localPageOrigin',
  'pcAccessReadiness',
  'pcAccessApprove',
];
/** Node returned nothing. */
const VOID_REPLY: readonly string[] = ['deleteEditorBackup'];
/** Node returned null. */
const NULL_REPLY: readonly string[] = [
  'termFocus',
  'termPause',
  'termResume',
  'termDispose',
  'remoteAccessSetClientAlias',
  'remoteAccessSettleOwedControllerKeys',
  'browserRemoteTabs',
  'browserRemoteImportProgress',
  'visualizeRemotePublish',
  'trashProjectEntryIn',
  'localPageRevokeOwner',
];

const CUSTOM_REPLY: Readonly<Record<string, Reply>> = {
  // The folder's path when the core classified it standalone; null for a registered Project.
  standaloneRoot: (reply) => (record(reply).standalone === true ? record(reply).path : null),
  // The path of an entry, as the rooted service route answers `projectEntryPath`.
  projectEntryPathIn: (reply) => record(reply).path,
  // The core answers {url}; the operation returns the URL string.
  localPageVirtualIn: (reply) => record(reply).url,
  // The core answers {type}; '' when the file is not served.
  localPageAssetType: (reply) => String(record(reply).type ?? ''),
  // The core stats a list; Node answered the one entry, or threw the stat's error: a slot { error } is that error.
  statLocalEntryAbs: (reply) => {
    if (!Array.isArray(reply)) throw new TypeError('projectFs/statLocal did not answer a list.');
    const entry = reply[0];
    const failure = record(entry).error;
    if (typeof failure === 'string') throw new Error(failure);
    return entry;
  },
  // Node answered {id, replay, sizeOwner?} and left `sizeOwner` out when no phone owns the size, where the core writes
  // null; the id is the core's own (a client id it accepted, else the one it made).
  termEnsure: (reply) => terminalReply(reply),
  // The same answer for a running tab, null for one that is not.
  termAttach: (reply) => (reply == null ? null : terminalReply(reply)),
  // Node answered the bytes received so far: a chunk is acknowledged only when written, at offset + its length.
  serverUploadChunk: (_reply, { args }) => ({
    received: Number(args[1]) + base64ByteLength(String(args[2])),
  }),
  // Node answered false for an unknown upload: the core says so with { aborted }.
  serverUploadAbort: (reply) => record(reply).aborted === true,
  // The core answers a bare boolean: whether a download was cancelled, whether a path is a finished download.
  serverDownloadAbort: (reply) => reply === true,
  serverDownloadCheck: (reply) => reply === true,
  // Node: { uploadId, chunkBytes, maxBytes }.
  serverUploadBegin: (reply) => {
    const { uploadId, chunkBytes, maxBytes } = record(reply);
    return { uploadId, chunkBytes, maxBytes };
  },
  // Node answered the whole state after the write; the core answers the merged record of the one device.
  setNotificationPreferences: (_reply, { args, invoke }) => invoke('notificationPreferencesState', [args[0], args[1]]),
  // Node answered the overrides in force: the stored list.
  setConversationNotification: (reply) => written(reply),
  updateSetting: savedSettings,
  updateNotificationVolume: savedSettings,
  updateBotHandoffLimit: savedSettings,
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
  ...SCM_REPLIES,
  ...Object.fromEntries(SAME_REPLY.map((name): [string, Reply] => [name, (reply) => reply])),
  ...Object.fromEntries(VOID_REPLY.map((name): [string, Reply] => [name, () => undefined])),
  ...Object.fromEntries(NULL_REPLY.map((name): [string, Reply] => [name, () => null])),
  ...CUSTOM_REPLY,
};

export const REPLY_DESKTOP_OPERATIONS: readonly string[] = Object.keys(REPLIES);

type SectionRead = (
  snapshot: ReturnType<ProtocolConnection['snapshot']>,
  args: readonly unknown[],
  host: Partial<OperationHost> & Pick<OperationHost, 'hostName'>,
  call: (method: string, params: unknown) => Promise<unknown>
) => unknown;

/** Operations answered from the sections the connection holds (desktop-services.md §2.4, §3). */
const SECTION_READS: Readonly<Record<string, SectionRead>> = {
  readSettings: (snapshot) => readSettings(snapshot),
  readActivityRailPins: (snapshot) => readActivityRailPins(snapshot),
  readZoom: (snapshot) => readZoom(snapshot),
  readMarkdownDefaultView: (snapshot) => readMarkdownDefaultView(snapshot),
  listConversationNotifications: (snapshot) => listConversationNotifications(snapshot, Date.now()),
  notificationPreferencesState: (snapshot, args, host) => notificationPreferencesState(snapshot, args, host),
  visualizeRemoteViewing: (snapshot, args) => visualizeRemoteViewing(snapshot, args),
  remoteAccessInfo: (snapshot, args, _host, call) => remoteAccessInfo(snapshot, args, call),
  remoteAccessSettings: (snapshot, _args, _host, call) => remotePagedMember(snapshot, 'settings', call),
  remoteAccessListClaims: (snapshot, _args, _host, call) => remotePagedMember(snapshot, 'claims', call),
  remoteAccessControllerKeys: (snapshot, _args, _host, call) => remotePagedMember(snapshot, 'controllerKeys', call),
  remoteAccessOwedControllerKeys: (snapshot, _args, _host, call) => remotePagedMember(snapshot, 'owedKeys', call),
  termActivity: (snapshot) => termActivity(snapshot),
};
export const SECTION_READ_DESKTOP_OPERATIONS: readonly string[] = Object.keys(SECTION_READS);

/** Legacy publication call. Electron reports dialog marks via `host/state/set`; the core publishes its own
 *  browser-card marks separately. Neither mark publication carries the card. */
export const IGNORED_DESKTOP_OPERATIONS: readonly string[] = ['publishBrowserApprovalSessions'];

/** Deleted or core-internal; no caller exists on a core connection. Calling one is a bug and is refused. */
export const DELETED_DESKTOP_OPERATIONS: Readonly<Record<string, string>> = {
  browserRemoteFrame:
    'the host role sends it: host/browser/frame, then the picture as an X17 media frame on the host connection (host/browser-view.ts)',
  browserRemoteResolve: "the host role answers the core's host/* requests itself (host/connection.ts)",
  browserRemoteWebrtcSignal: 'WebRTC runs in mixdog-remote (SPEC R36)',
  gitPathspecChanges: 'no caller (DS 17.2)',
  lspDisposeUnder: 'project/delete and worktree removal dispose the servers inside the core (DS 4.1)',
  modelProxyClaim: 'replaced by server request model/proxy/execute (protocol/model-proxy-relay.ts)',
  modelProxyEvent: 'replaced by server request model/proxy/execute (protocol/model-proxy-relay.ts)',
  modelProxyHeartbeat: 'replaced by connection liveness (protocol/model-proxy-relay.ts)',
  modelProxyResolve: 'replaced by server request model/proxy/execute (protocol/model-proxy-relay.ts)',
  readBrowserApprovalSessions: 'browser approval marks are held in the app feed (hostState)',
};

export const ROUTED_DESKTOP_OPERATIONS: readonly string[] = Object.keys(OPERATION_ROUTES);
export const UNROUTED_DESKTOP_OPERATIONS: readonly string[] = Object.keys(NEEDS_RULING);

/** The core request for `name(...args)`. An operation with no Rust op is `unknownMethod`, one the schema cannot
 *  carry `unmappedOperation`; both are raised before anything is sent. */
export function routeDesktopOperation(name: string, args: readonly unknown[] = []): OperationRoute {
  const route = Object.hasOwn(OPERATION_ROUTES, name) ? OPERATION_ROUTES[name] : undefined;
  if (route) return route(args);
  const reason = Object.hasOwn(NEEDS_RULING, name) ? NEEDS_RULING[name] : undefined;
  if (reason)
    throw Object.assign(new Error(`desktop operation ${name} is not mapped: ${reason}`), { code: 'unmappedOperation' });
  const deleted = Object.hasOwn(DELETED_DESKTOP_OPERATIONS, name) ? `: ${DELETED_DESKTOP_OPERATIONS[name]}` : '';
  throw Object.assign(new Error(`desktop operation ${name} has no protocol method${deleted}`), {
    code: 'unknownMethod',
  });
}

export interface OperationLane {
  invoke(name: string, args: unknown[] | undefined): Promise<unknown>;
}

/** The core's announcements reach this process's windows as the desktop events Node's service raised for them
 *  (`settings-changed`, `provider-models-changed`): the core tells every client, the announcer included. Returns the removal. */
export function watchAnnouncements(
  protocol: Pick<ProtocolConnection, 'onEvent'>,
  emit: (name: string, value: unknown) => void
): () => void {
  return protocol.onEvent((event) => {
    if (event.type !== 'notification') return;
    const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
    const announced = announcedEvent(method, params);
    if (announced) emit(announced.name, announced.value);
  });
}

/** Watches for callers with no window of their own (the paired phones, through the relay); this lane owns them as one
 *  window of the connection, and they end with the last unwatch. */
const createFolderOperations = (
  protocol: Pick<ProtocolConnection, 'attach' | 'watchFiles' | 'unwatchFiles'>,
  host: Pick<Partial<OperationHost>, 'emitDesktopEvent'>,
  platform: 'win32' | 'darwin' | 'linux'
): ((name: string, args: readonly unknown[]) => null) => {
  const folderWatchIds = new Map<string, () => void>();
  const folderSubscriptions = new Map<string, { count: number; off: () => void }>();
  let nextFolderWatch = 1;
  let detachFolderOwner: (() => void) | null = null;
  const folderOwner: ProtocolWindow = {
    push() {},
    loginFeedLost() {},
    notification(method, params) {
      if (method !== 'fs/changed') return;
      const watchId = (params as { watchId?: unknown } | null)?.watchId;
      if (typeof watchId === 'string') folderWatchIds.get(watchId)?.();
    },
  };
  // One normalization for the registry and for this lane's own per-directory count, so watch and unwatch use one key:
  // C:\Work and c:\work are the same watch on Windows.
  const folderKeyOf = (path: string): string => (platform === 'win32' ? path.toLocaleLowerCase() : path);
  const folderWatches = createProjectWatchRegistry({
    keyOf: folderKeyOf,
    async start(target) {
      const watchId = `host-folder-${nextFolderWatch++}`;
      folderWatchIds.set(watchId, target.changed);
      try {
        await protocol.watchFiles(folderOwner, { watchId, path: target.path, recursive: target.recursive });
      } catch (error) {
        folderWatchIds.delete(watchId);
        throw error;
      }
      return () => {
        folderWatchIds.delete(watchId);
        return protocol.unwatchFiles(watchId);
      };
    },
    idle() {
      detachFolderOwner?.();
      detachFolderOwner = null;
    },
  });
  const folderOperation = (name: string, args: readonly unknown[]): null => {
    const dir = String(args[0]);
    const recursive = args[1] === true;
    const key = `${folderKeyOf(dir)}\0${recursive}`;
    const held = folderSubscriptions.get(key);
    if (name === 'folderWatch') {
      if (held) held.count += 1;
      else {
        detachFolderOwner ??= protocol.attach(folderOwner);
        // One event per change however many callers watch the directory.
        const off = folderWatches.subscribe(dir, () => host.emitDesktopEvent?.('folder-changed', dir), recursive);
        folderSubscriptions.set(key, { count: 1, off });
      }
    } else if (held && --held.count <= 0) {
      folderSubscriptions.delete(key);
      held.off();
    }
    return null;
  };
  return folderOperation;
};

export function createOperationLane({
  protocol,
  host,
  platform,
}: {
  /** The host's OS: it decides whether folder keys fold case (Windows paths are case-insensitive). */
  platform: 'win32' | 'darwin' | 'linux';
  protocol: Pick<ProtocolConnection, 'call' | 'notify' | 'attach' | 'watchFiles' | 'unwatchFiles'> &
    Partial<Pick<ProtocolConnection, 'snapshot' | 'whenSynced'>>;
  /** The host's own answers; `hostName` is the machine's name, which this module reads from no process. */
  host: Partial<OperationHost> & Pick<OperationHost, 'hostName'>;
}): OperationLane {
  const call = (method: string, params: unknown): Promise<unknown> =>
    protocol.call(method, params).catch((error: unknown) => {
      throw coreErrorForWindow(error);
    });
  const folderOperation = createFolderOperations(protocol, host, platform);
  const lane: OperationLane = {
    async invoke(name, args = []) {
      if (name === 'folderWatch' || name === 'folderUnwatch') return folderOperation(name, args);
      const notification = routeDesktopNotification(name, args);
      if (notification) {
        protocol.notify(notification.method, notification.params);
        return NOTIFICATION_ROUTES[name].result;
      }
      // Node answers these at once and never fails them: a read that comes before the connect handshake has folded the
      // first snapshot waits for it (the handshake's own failure is the read's failure).
      const heldSections = async (): Promise<NonNullable<typeof protocol.snapshot>> => {
        if (!protocol.snapshot) throw new Error(`desktop operation ${name} needs the connection's held sections.`);
        await protocol.whenSynced?.();
        return protocol.snapshot;
      };
      if (Object.hasOwn(SECTION_READS, name)) {
        const snapshot = await heldSections();
        return SECTION_READS[name](
          await withPagedConfig(snapshot(), call, SECTION_READ_CONFIG[name] ?? []),
          args,
          host,
          call
        );
      }
      if (name === 'notifySettingsChanged') {
        const change = readSettingsChange({ scope: args[0] });
        if (!change) throw new TypeError('settings scope is invalid.');
        // The host's theme and language travel as `hostState.displayPreferences`, which the announcement makes the
        // paired devices re-read: published first, so a re-read on the announcement sees them.
        if (change.scope === 'desktop' && host.readDisplayPreferences) {
          await call('host/state/set', { key: 'displayPreferences', value: await host.readDisplayPreferences() });
        }
        // Node's broadcast reached this process's windows and every paired device: the core tells every client, these
        // windows included (`ui/settings/changed`, wired in `watchAnnouncements`).
        await call('ui/settings/announce', { scope: change.scope });
        return undefined;
      }
      if (name === 'notifyProviderModelsChanged') {
        // A cache hint between UI peers: every client drops its provider model lists, this one too: the core tells every client (`ui/providerModels/changed`).
        await call('ui/providerModels/announce', { origin: args[0] });
        return undefined;
      }
      if (IGNORED_DESKTOP_OPERATIONS.includes(name)) return undefined;
      if (Object.hasOwn(RETIRED_OPERATIONS, name)) {
        throw Object.assign(new Error(`desktop operation ${name} is retired: ${RETIRED_OPERATIONS[name]}`), {
          code: 'operationRetired',
        });
      }
      const prepare = Object.hasOwn(PREPARERS, name) ? PREPARERS[name] : undefined;
      let routed: readonly unknown[] = args;
      if (prepare) {
        const held = await heldSections();
        // The preparer reads the notifications subtree: only that one is paged when held as a stub.
        const pagedKeys = name === 'setNotificationPreferences' ? ['notifications'] : [];
        const paged = await withPagedConfig(held(), call, pagedKeys);
        routed = await prepare(args, { entries: () => paged.entries });
      }
      const { method, params } = routeDesktopOperation(name, routed);
      return REPLIES[name](await call(method, params), { args, params, call, invoke: lane.invoke });
    },
  };
  return lane;
}
