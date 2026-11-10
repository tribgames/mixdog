// The renderer's desktop operations (`invokeDesktopOperation(name, args)`) over the one protocol connection
// (desktop-services.md §12.5, protocol.md §12.5): each operation with a Rust op becomes that op's named params,
// filled from the positional arguments the Node handlers took (`desktop-operations.ts`, `desktop-service.ts`
// `createServiceOperationRouter`, `notification-center.ts`, `server-file-operations.ts`). Expected params come from
// the Rust `v2/params.rs` structs and `operations_map.json`, not from this table.
import { normalizeBrowserPermissionPolicy } from '../../shared/browser-permission-policy';
import { isSessionRetentionSettingKey } from '../../shared/contract-settings';
import { readSettingsChange, SETTINGS_CHANGED_EVENT } from '../../shared/settings-changed';
import { notificationWriteMode } from '../../shared/notification-state';
import { desktopSettingsFromConfig, storedPinsState } from '../settings-store';
import { createProjectWatchRegistry } from '../../shared/project-watch-registry';
import { defined, positional, SCM_OPERATION_ROUTES, SCM_REPLIES, type OperationMapper, type OperationRoute } from '../../shared/scm-operation-route';
import { terminalEnsureRequest, terminalReply } from '../../shared/terminal-protocol';
import type { ProtocolConnection, ProtocolWindow } from './connection';
import { coreErrorForWindow } from './core-error';
import { remoteAccessInfo, remotePagedMember } from './remote-reads';
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
  termActivity,
} from './section-reads';

export type { OperationRoute };
type Mapper = OperationMapper;

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

const OPERATION_ROUTES: Readonly<Record<string, Mapper>> = {
  ...SCM_OPERATION_ROUTES,

  // documents
  documentPreviewIn: positional('document/preview', ['root', 'rel']),
  documentPreviewPagesIn: positional('document/previewPages', ['root', 'rel', 'options']),

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
  termEnsure: ([tabId, cwd, profile]) => terminalEnsureRequest(tabId, cwd, profile),
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
  // Not one request: a reference-counted watch. A window holds its own (protocol/window-ipc.ts, renderer/
  // project-file-changes.ts); the operation lane serves the callers without a window (the relay) before routing.
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
  // `config.notifications`: an unwritten subtree is a store Node would stamp `now` on first load, a written one without
  // the stamp reads 0 (`migratedAtOf`, notification-preferences.ts:228 and :120), as the notification state reads it.
  setNotificationPreferences: async (args, { entries }) => {
    const remote = entries().find((entry) => entry.section === 'remote' && entry.key === null)?.value;
    const notifications = entries().find((entry) => entry.section === 'config' && entry.key === 'notifications')?.value;
    return [...args, notificationWriteMode(String(args[2] ?? ''), remote, notifications)];
  },
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Operations the spec removes from the wire, with what replaces each. A call is an error here (never an empty
 *  answer): the caller is a Node-path call site that the core connection does not make (desktop-ops-new-b-r.md). */
const RETIRED_OPERATIONS: Readonly<Record<string, string>> = {
  remoteAccessStart: 'the relay starts at core boot from config (DS 7.2); the explicit activation is remoteAccess/activate',
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

/** Node's settings writers answered the whole `DesktopSettings` of the saved config; the write reply carries only the
 *  stored value, so the saved config is read back (`config/read`, the write is complete when it answers). */
const savedSettings: Reply = async (_reply, { call }) =>
  desktopSettingsFromConfig(record(await call('config/read', { keys: ['agent', 'desktop'] })).config);

/** Replies that are Node's return value as the core sends it (the parity contract of DS-SCM-1, DS-WS-1, DS-REM-1:
 *  the JSON equals what the Node implementation returned). */
const SAME_REPLY: readonly string[] = [
  'documentPreviewIn', 'documentPreviewPagesIn', 'readEditorBackup', 'writeEditorBackup', 'readLocalFileAbs',
  'readProjectTextFileIn', 'readProjectTextFileAuthorized', 'writeProjectTextFileIn', 'writeProjectTextFileAuthorized',
  'writeProjectTextFilesIn', 'writeProjectTextFilesAuthorized', 'readScopedEditorSettings', 'readWorkspaceFile',
  'writeWorkspaceFile', 'searchWorkspaceTextIn', 'statProjectFileIn', 'listHostDirectories', 'listServerDirectories',
  'sendTestNotification', 'termProfiles', 'termAttach', 'remoteAccessSetEnabled', 'remoteAccessSetName',
  'remoteAccessRotate', 'remoteAccessRevokeClient', 'serverUploadCommit', 'serverTrashInfo',
  'replaceWorkspaceTextIn', 'projectRecoveryIn', 'lspDocument', 'lspRequest', 'remoteAccessResolveClaim',
  'remoteAccessPairCode', 'serverFileReadRange', 'serverTrashEntry',
];
/** Node returned nothing. */
const VOID_REPLY: readonly string[] = [
  'deleteEditorBackup',
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
  // Node answered {id, replay, sizeOwner?} and left `sizeOwner` out when no phone owns the size, where the core writes
  // null; the id is the core's own (a client id it accepted, else the one it made).
  termEnsure: (reply) => terminalReply(reply),
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
  host: Partial<OperationHost>,
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

/** Deleted by the spec, with a caller that still runs on a core connection (it shares code with the Node host). The
 *  pending browser approvals are core state (DS §12.3): the core raises `item/browser/requestApproval` to every client
 *  that can answer it, phones included, so nothing is announced; answered as Node answered it, `undefined`. (The two
 *  other deleted announcements, `notifySettingsChanged` and `notifyProviderModelsChanged`, are handled in `invoke`.) */
export const IGNORED_DESKTOP_OPERATIONS: readonly string[] = ['publishBrowserApprovalSessions'];

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
  protocol: Pick<ProtocolConnection, 'call' | 'notify' | 'attach' | 'watchFiles' | 'unwatchFiles'> &
    Partial<Pick<ProtocolConnection, 'snapshot' | 'whenSynced'>>;
  host?: Partial<OperationHost>;
}): OperationLane {
  const call = (method: string, params: unknown): Promise<unknown> =>
    protocol.call(method, params).catch((error: unknown) => {
      throw coreErrorForWindow(error);
    });
  // `folderWatch`/`folderUnwatch` for callers that hold no window of their own (the paired phones, through the relay's
  // remote methods): Node's reference-counted folder watcher raised `folder-changed` for the directory; here the same
  // project watch registry the windows use (`fs/watch`) raises it. This lane owns the watches, as one window of the
  // connection, and they end with the last unwatch.
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
  // One normalization for the registry and for this lane's own per-directory count, as Node's registry used one key for both
  // watch and unwatch: C:\Work and c:\work are the same watch on Windows.
  const folderKeyOf = (path: string): string => (process.platform === 'win32' ? path.toLocaleLowerCase() : path);
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
        // One event per change however many callers watch the directory, as Node's registry raised it.
        const off = folderWatches.subscribe(dir, () => host.emitDesktopEvent?.('folder-changed', dir), recursive);
        folderSubscriptions.set(key, { count: 1, off });
      }
    } else if (held && --held.count <= 0) {
      folderSubscriptions.delete(key);
      held.off();
    }
    return null;
  };
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
        return SECTION_READS[name](snapshot(), args, host, call);
      }
      if (name === 'notifySettingsChanged') {
        const change = readSettingsChange({ scope: args[0] });
        if (!change) throw new TypeError('settings scope is invalid.');
        // The windows of this process re-read as Node's broadcast made them. Paired browsers hold the core's own
        // sections (`config`, `providerSetup`, ...); the host's theme and language travel as
        // `hostState.displayPreferences`, which Node's announcement made them re-read.
        host.emitDesktopEvent?.(SETTINGS_CHANGED_EVENT, change);
        if (change.scope === 'desktop' && host.readDisplayPreferences) {
          await call('host/state/set', { key: 'displayPreferences', value: await host.readDisplayPreferences() });
        }
        return undefined;
      }
      if (name === 'notifyProviderModelsChanged') {
        // A cache hint between UI peers: the windows drop their provider model lists; the core's providerSetup /
        // providerAccounts sections already tell every client when the providers themselves change.
        host.emitDesktopEvent?.('provider-models-changed', { origin: args[0] });
        return undefined;
      }
      if (IGNORED_DESKTOP_OPERATIONS.includes(name)) return undefined;
      if (Object.hasOwn(RETIRED_OPERATIONS, name)) {
        throw Object.assign(new Error(`desktop operation ${name} is retired: ${RETIRED_OPERATIONS[name]}`), {
          code: 'operationRetired',
        });
      }
      const prepare = Object.hasOwn(PREPARERS, name) ? PREPARERS[name] : undefined;
      const held = prepare ? await heldSections() : null;
      const routed = prepare ? await prepare(args, { entries: () => held!().entries }) : args;
      const { method, params } = routeDesktopOperation(name, routed);
      return REPLIES[name](await call(method, params), { args, params, call, invoke: lane.invoke });
    },
  };
  return lane;
}
