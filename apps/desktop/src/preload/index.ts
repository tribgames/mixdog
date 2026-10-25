// Typed IPC bridge: explicit method allow-list, no arbitrary invoke.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

import {
  DESKTOP_IPC,
  type DesktopApi,
  type DesktopBootContext,
  type DesktopConnectionIdentity,
  type DesktopSessionStateUpdate,
  type DesktopSessionStateWireUpdate,
  type DesktopStateFieldsPatch,
  type DesktopStateItemsPatch,
  type DesktopStateStreamingTailPatch,
  type DesktopStateWire,
  type DesktopTranscriptItem,
  type SessionSnapshot,
} from '../shared/contract';
import { createSnapshotDeltaDecoder } from '../main/state-delta';
import { createBrowserTextureBridge } from './browser-texture';
import { withApiFileGrantRefresh } from '../renderer/remote-file-grant-refresh';
import { ipcErrorFromEnvelope } from '../shared/coded-error';
import { DESKTOP_PET_IPC, desktopPetAppLayout } from '../shared/desktop-pet';

/** `ipcRenderer.invoke` that rebuilds a refusal main returned as an error
 *  envelope (Electron drops an Error's custom `code` in transit). */
function invokeIpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).then((result: T) => {
    const failure = ipcErrorFromEnvelope(result);
    if (failure) throw failure;
    return result;
  });
}

function additionalArgument(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? '';
}

const bootId = additionalArgument('mixdog-boot-id');
const processStartedAt = Number(additionalArgument('mixdog-process-started-at'));
const bootScenario = additionalArgument('mixdog-boot-scenario');
const afterUpdate = additionalArgument('mixdog-after-update') === '1';

function bootContextValue(): DesktopBootContext | undefined {
  if (!bootId || !Number.isFinite(processStartedAt)) return undefined;
  return Object.freeze({
    bootId,
    processStartedAt,
    ...(bootScenario ? { scenario: bootScenario } : {}),
    ...(afterUpdate ? { afterUpdate: true as const } : {}),
  });
}
const bootContext = bootContextValue();

/** Which daemon this window drives; main passes it at window creation. */
function connectionValue(): DesktopConnectionIdentity | undefined {
  const id = additionalArgument('mixdog-connection-id');
  const kind = additionalArgument('mixdog-connection-kind');
  if (!id || (kind !== 'local' && kind !== 'ssh')) return undefined;
  let name = '';
  try {
    name = decodeURIComponent(additionalArgument('mixdog-connection-name'));
  } catch {
    /* a malformed name shows as empty */
  }
  return Object.freeze({ id, kind, name });
}
const connection = connectionValue();

/** Wire-only keys of a DesktopStateWire; never part of a SessionSnapshot's fields. */
const STATE_WIRE_CONTROL_KEYS = new Set([
  'items',
  'streamingTail',
  '__itemsRevision',
  '__itemsPatch',
  '__streamingTailPatch',
  '__statePatch',
]);

function streamingTailFrom(value: unknown): DesktopTranscriptItem | null {
  return value && typeof value === 'object' ? (value as DesktopTranscriptItem) : null;
}

/** Forwards every argument of `channel` to `listener`; returns the unsubscribe. */
function subscribeIpc<Args extends unknown[]>(channel: string, listener: (...args: Args) => void): () => void {
  const receive = (_event: Electron.IpcRendererEvent, ...args: Args): void => listener(...args);
  ipcRenderer.on(channel, receive);
  return () => {
    ipcRenderer.removeListener(channel, receive);
  };
}

const api: DesktopApi = {
  ...(bootContext ? { bootContext } : {}),
  ...(connection ? { connection } : {}),
  // This app's own host always takes per-route Auto reasoning.
  routeAutoEffort: true,
  chooseProject: () => invokeIpc(DESKTOP_IPC.chooseProject),
  chooseFile: (defaultPath) => invokeIpc(DESKTOP_IPC.chooseFile, defaultPath),
  chooseConversationImportFile: () => invokeIpc(DESKTOP_IPC.chooseConversationImportFile),
  subscribeConversationImportProgress: (listener) => subscribeIpc(DESKTOP_IPC.conversationImportProgress, listener),
  chooseFiles: (defaultPath) => invokeIpc(DESKTOP_IPC.chooseFiles, defaultPath),
  chooseWorkspace: () => invokeIpc(DESKTOP_IPC.chooseWorkspace),
  saveWorkspace: (workspaceFile, folders) => invokeIpc(DESKTOP_IPC.saveWorkspace, workspaceFile, folders),
  readEditorSettings: (projectPath, relPath, workspaceFile) =>
    invokeIpc(DESKTOP_IPC.readEditorSettings, projectPath, relPath, workspaceFile),
  readMarkdownDefaultView: () => invokeIpc(DESKTOP_IPC.readMarkdownDefaultView),
  writeMarkdownDefaultView: (view) => invokeIpc(DESKTOP_IPC.writeMarkdownDefaultView, view),
  startProject: (projectPath) => invokeIpc(DESKTOP_IPC.startProject, projectPath),
  startProjectTask: (projectPath) => invokeIpc(DESKTOP_IPC.startProjectTask, projectPath),
  startTask: () => invokeIpc(DESKTOP_IPC.startTask),
  listProjects: () => invokeIpc(DESKTOP_IPC.listProjects),
  addProject: (projectPath) => invokeIpc(DESKTOP_IPC.addProject, projectPath),
  openProjectInExplorer: (projectPath) => invokeIpc(DESKTOP_IPC.openProjectInExplorer, projectPath),
  openMediaAsset: (assetId) => invokeIpc(DESKTOP_IPC.openMediaAsset, assetId),
  openMediaFolder: (assetId) => invokeIpc(DESKTOP_IPC.openMediaFolder, assetId),
  openExternal: (url) => invokeIpc(DESKTOP_IPC.openExternal, url),
  submitFeedback: (input) => invokeIpc(DESKTOP_IPC.submitFeedback, input),
  openLocalFileLink: (projectPath, href, confirmedPath) =>
    invokeIpc(DESKTOP_IPC.openLocalFileLink, projectPath, href, confirmedPath),
  localPageUrl: (projectPath, relPath, accessToken) =>
    invokeIpc(DESKTOP_IPC.localPageUrl, projectPath, relPath, accessToken),
  githubStarStatus: () => invokeIpc(DESKTOP_IPC.githubStarStatus),
  starGithub: () => invokeIpc(DESKTOP_IPC.starGithub),
  gitCliStatus: () => invokeIpc(DESKTOP_IPC.gitCliStatus),
  installGitCli: () => invokeIpc(DESKTOP_IPC.installGitCli),
  requestLinuxInputAccess: () => invokeIpc(DESKTOP_IPC.requestLinuxInputAccess),
  libreOfficeStatus: (refresh) => invokeIpc(DESKTOP_IPC.libreOfficeStatus, refresh === true),
  installLibreOffice: () => invokeIpc(DESKTOP_IPC.installLibreOffice),
  computerReadiness: () => invokeIpc(DESKTOP_IPC.computerReadiness),
  openComputerPermissionSettings: (pane) => invokeIpc(DESKTOP_IPC.openComputerPermissionSettings, pane),
  githubCliStatus: () => invokeIpc(DESKTOP_IPC.githubCliStatus),
  installGithubCli: () => invokeIpc(DESKTOP_IPC.installGithubCli),
  githubCliLoginStart: () => invokeIpc(DESKTOP_IPC.githubCliLoginStart),
  githubCliLoginStatus: (flowId) => invokeIpc(DESKTOP_IPC.githubCliLoginStatus, flowId),
  githubCliLoginOpenBrowser: (flowId, options) => invokeIpc(DESKTOP_IPC.githubCliLoginOpenBrowser, flowId, options),
  githubCliLoginCancel: (flowId) => invokeIpc(DESKTOP_IPC.githubCliLoginCancel, flowId),
  githubCliLogout: () => invokeIpc(DESKTOP_IPC.githubCliLogout),
  githubCliAccount: () => invokeIpc(DESKTOP_IPC.githubCliAccount),
  gitGlobalConfig: () => invokeIpc(DESKTOP_IPC.gitGlobalConfig),
  setGitGlobalConfig: (key, value) => invokeIpc(DESKTOP_IPC.setGitGlobalConfig, key, value),
  renameProject: (projectPath, alias) => invokeIpc(DESKTOP_IPC.renameProject, projectPath, alias),
  removeProject: (projectPath) => invokeIpc(DESKTOP_IPC.removeProject, projectPath),
  listProjectDir: (projectPath, relDir) => invokeIpc(DESKTOP_IPC.listProjectDir, projectPath, relDir),
  // File.path was removed in modern Electron; webUtils resolves native drops.
  folderPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  resolveLocalPaths: (paths) => invokeIpc(DESKTOP_IPC.resolveLocalPaths, paths),
  readLocalFile: (path) => invokeIpc(DESKTOP_IPC.readLocalFile, path),
  folderWatch: (dir, recursive) => invokeIpc(DESKTOP_IPC.folderWatch, dir, recursive === true),
  folderUnwatch: (dir, recursive) => invokeIpc(DESKTOP_IPC.folderUnwatch, dir, recursive === true),
  listServerDirectories: (path, includeHidden) =>
    invokeIpc(DESKTOP_IPC.listServerDirectories, path, includeHidden === true),
  serverUploadBegin: (name, size, scope) => invokeIpc(DESKTOP_IPC.serverUploadBegin, name, size, scope),
  serverUploadChunk: (uploadId, offset, bytes) => invokeIpc(DESKTOP_IPC.serverUploadChunk, uploadId, offset, bytes),
  serverUploadCommit: (uploadId) => invokeIpc(DESKTOP_IPC.serverUploadCommit, uploadId),
  serverUploadAbort: (uploadId) => invokeIpc(DESKTOP_IPC.serverUploadAbort, uploadId),
  serverDownloadBegin: (projectPath, relPath, accessToken) =>
    invokeIpc(DESKTOP_IPC.serverDownloadBegin, projectPath, relPath, accessToken),
  serverDownloadStep: (downloadId) => invokeIpc(DESKTOP_IPC.serverDownloadStep, downloadId),
  serverDownloadFinish: (downloadId) => invokeIpc(DESKTOP_IPC.serverDownloadFinish, downloadId),
  serverDownloadAbort: (downloadId) => invokeIpc(DESKTOP_IPC.serverDownloadAbort, downloadId),
  openServerDownload: (path, confirmedPath) => invokeIpc(DESKTOP_IPC.openServerDownload, path, confirmedPath),
  serverTrashInfo: (projectPath) => invokeIpc(DESKTOP_IPC.serverTrashInfo, projectPath),
  subscribeRelayPayloadRefused: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      detail: { bytes: number | null; limit: number | null }
    ): void => {
      listener(detail ?? { bytes: null, limit: null });
    };
    ipcRenderer.on(DESKTOP_IPC.relayPayloadRefused, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.relayPayloadRefused, receive);
  },
  subscribeFolderChanges: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, dir: string): void => {
      listener(String(dir || ''));
    };
    ipcRenderer.on(DESKTOP_IPC.folderChanged, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.folderChanged, receive);
  },
  readProjectFile: (projectPath, relPath, accessToken) =>
    invokeIpc(DESKTOP_IPC.readProjectFile, projectPath, relPath, accessToken),
  previewProjectFile: (projectPath, relPath, accessToken) =>
    invokeIpc(DESKTOP_IPC.previewProjectFile, projectPath, relPath, accessToken),
  captureFileSnapshot: (projectPath, relPath, accessToken) =>
    invokeIpc(DESKTOP_IPC.captureFileSnapshot, projectPath, relPath, accessToken),
  previewDocumentFile: (projectPath, relPath, accessToken) =>
    invokeIpc(DESKTOP_IPC.previewDocumentFile, projectPath, relPath, accessToken),
  previewDocumentPages: (projectPath, relPath, accessToken, options) =>
    invokeIpc(DESKTOP_IPC.previewDocumentPages, projectPath, relPath, accessToken, options),
  writeProjectFile: (projectPath, relPath, content, expectedContent, accessToken, encoding) =>
    invokeIpc(DESKTOP_IPC.writeProjectFile, projectPath, relPath, content, expectedContent, accessToken, encoding),
  readEditorBackup: (projectPath, relPath, accessToken) =>
    invokeIpc(DESKTOP_IPC.readEditorBackup, projectPath, relPath, accessToken),
  writeEditorBackup: (projectPath, relPath, content, expectedContent, accessToken) =>
    invokeIpc(DESKTOP_IPC.writeEditorBackup, projectPath, relPath, content, expectedContent, accessToken),
  deleteEditorBackup: (projectPath, relPath, accessToken) =>
    invokeIpc(DESKTOP_IPC.deleteEditorBackup, projectPath, relPath, accessToken),
  statProjectFile: (projectPath, relPath, accessToken) =>
    invokeIpc(DESKTOP_IPC.statProjectFile, projectPath, relPath, accessToken),
  createProjectEntry: (projectPath, relDir, name, dir) =>
    invokeIpc(DESKTOP_IPC.createProjectEntry, projectPath, relDir, name, dir),
  renameProjectEntry: (projectPath, relPath, newName) =>
    invokeIpc(DESKTOP_IPC.renameProjectEntry, projectPath, relPath, newName),
  trashProjectEntry: (projectPath, relPath, options) =>
    options
      ? invokeIpc(DESKTOP_IPC.trashProjectEntry, projectPath, relPath, options)
      : invokeIpc(DESKTOP_IPC.trashProjectEntry, projectPath, relPath),
  moveProjectEntry: (projectPath, relPath, targetDirRel) =>
    invokeIpc(DESKTOP_IPC.moveProjectEntry, projectPath, relPath, targetDirRel),
  copyProjectEntry: (projectPath, relPath, targetDirRel) =>
    invokeIpc(DESKTOP_IPC.copyProjectEntry, projectPath, relPath, targetDirRel),
  codeGraphQuery: (projectPath, mode, symbol) => invokeIpc(DESKTOP_IPC.codeGraphQuery, projectPath, mode, symbol),
  lspDocument: (input) => invokeIpc(DESKTOP_IPC.lspDocument, input),
  lspRequest: (input) => invokeIpc(DESKTOP_IPC.lspRequest, input),
  lspApplyWorkspaceEdit: (projectPath, writes) => invokeIpc(DESKTOP_IPC.lspApplyWorkspaceEdit, projectPath, writes),
  subscribeLspDiagnostics: (listener) => subscribeIpc(DESKTOP_IPC.lspDiagnostics, listener),
  subscribeLspStatus: (listener) => subscribeIpc(DESKTOP_IPC.lspStatus, listener),
  listSessions: () => invokeIpc(DESKTOP_IPC.listSessions),
  markSessionRead: (sessionId, messageCount, consumedUnread) =>
    invokeIpc(DESKTOP_IPC.markSessionRead, sessionId, messageCount, consumedUnread),
  subscribeSessions: (listener) => subscribeIpc(DESKTOP_IPC.sessionsChanged, listener),
  listAgentPool: () => invokeIpc(DESKTOP_IPC.listAgentPool),
  searchSessionContent: (query) => invokeIpc(DESKTOP_IPC.searchSessionContent, query),
  subscribeAgentPool: (listener) => subscribeIpc(DESKTOP_IPC.agentPoolChanged, listener),
  renameSession: (sessionId, title) => invokeIpc(DESKTOP_IPC.renameSession, sessionId, title),
  continueSessionInModel: (sessionId, route) => invokeIpc(DESKTOP_IPC.continueSessionInModel, sessionId, route),
  scheduleQuotaResume: (sessionId) => invokeIpc(DESKTOP_IPC.scheduleQuotaResume, sessionId),
  cancelQuotaResume: (sessionId) => invokeIpc(DESKTOP_IPC.cancelQuotaResume, sessionId),
  stopShellJob: (sessionId, taskId) => invokeIpc(DESKTOP_IPC.stopShellJob, sessionId, taskId),
  releaseShellJob: (sessionId, taskId) => invokeIpc(DESKTOP_IPC.releaseShellJob, sessionId, taskId),
  getQuotaAutoResume: () => invokeIpc(DESKTOP_IPC.getQuotaAutoResume),
  viewerDevice: () => invokeIpc(DESKTOP_IPC.viewerDevice),
  setQuotaAutoResume: (enabled) => invokeIpc(DESKTOP_IPC.setQuotaAutoResume, enabled),
  setSessionArchived: (sessionId, archived) => invokeIpc(DESKTOP_IPC.setSessionArchived, sessionId, archived),
  openAgentHome: (agentId) => invokeIpc(DESKTOP_IPC.openAgentHome, agentId),
  resetAgentHome: (agentId) => invokeIpc(DESKTOP_IPC.resetAgentHome, agentId),
  listAgentMemory: (agentId) => invokeIpc(DESKTOP_IPC.listAgentMemory, agentId),
  deleteAgentMemory: (agentId, entry) => invokeIpc(DESKTOP_IPC.deleteAgentMemory, agentId, entry),
  agentRoomAction: (action, args) => invokeIpc(DESKTOP_IPC.agentRoomAction, action, args),
  setSessionFavorite: (sessionId, favorite) => invokeIpc(DESKTOP_IPC.setSessionFavorite, sessionId, favorite),
  setSessionProject: (sessionId, projectPath) => invokeIpc(DESKTOP_IPC.setSessionProject, sessionId, projectPath),
  deleteSession: (sessionId) => invokeIpc(DESKTOP_IPC.deleteSession, sessionId),
  getRemoteAccessInfo: (options) => invokeIpc(DESKTOP_IPC.remoteAccessInfo, options),
  rotateRemoteAccess: () => invokeIpc(DESKTOP_IPC.rotateRemoteAccess),
  revokeRemoteAccessClient: (clientId) => invokeIpc(DESKTOP_IPC.revokeRemoteAccessClient, clientId),
  subscribeRemoteClientClaim: (listener) => subscribeIpc(DESKTOP_IPC.remoteClientClaim, listener),
  getRemoteAccessSettings: () => invokeIpc(DESKTOP_IPC.getRemoteAccessSettings),
  setRemoteAccessEnabled: (enabled) => invokeIpc(DESKTOP_IPC.setRemoteAccessEnabled, enabled),
  setRemotePcName: (name) => invokeIpc(DESKTOP_IPC.setRemotePcName, name),
  subscribeRemoteAccessSettings: (listener) => subscribeIpc(DESKTOP_IPC.remoteAccessSettingsChanged, listener),
  setRemoteClientAlias: (clientId, alias) => invokeIpc(DESKTOP_IPC.setRemoteClientAlias, clientId, alias),
  renameRemoteHost: (id, name) => invokeIpc(DESKTOP_IPC.renameRemoteHost, id, name),
  listRemoteClientClaims: () => invokeIpc(DESKTOP_IPC.listRemoteClientClaims),
  resolveRemoteClientClaim: (claimId, approved) => invokeIpc(DESKTOP_IPC.resolveRemoteClientClaim, claimId, approved),
  listRemoteHosts: () => invokeIpc(DESKTOP_IPC.listRemoteHosts),
  connectRemoteHostByCode: (code) => invokeIpc(DESKTOP_IPC.connectRemoteHostByCode, code),
  getRemotePairCode: (action) => invokeIpc(DESKTOP_IPC.remotePairCode, action),
  subscribeShowConnectionSettings: (listener) => subscribeIpc(DESKTOP_IPC.showConnectionSettings, () => listener()),
  openRemoteHost: (id) => invokeIpc(DESKTOP_IPC.openRemoteHost, id),
  forgetRemoteHost: (id) => invokeIpc(DESKTOP_IPC.forgetRemoteHost, id),
  sshListHosts: () => invokeIpc(DESKTOP_IPC.sshListHosts),
  sshRenameHost: (id, name) => invokeIpc(DESKTOP_IPC.sshRenameHost, id, name),
  sshForgetHost: (id) => invokeIpc(DESKTOP_IPC.sshForgetHost, id),
  sshOpenHost: (id) => invokeIpc(DESKTOP_IPC.sshOpenHost, id),
  sshConfigHosts: () => invokeIpc(DESKTOP_IPC.sshConfigHosts),
  sshInspectHostKey: (target) => invokeIpc(DESKTOP_IPC.sshInspectHostKey, target),
  sshConnect: (request) => invokeIpc(DESKTOP_IPC.sshConnect, request),
  sshCancel: (attemptId) => invokeIpc(DESKTOP_IPC.sshCancel, attemptId),
  sshAskpassReply: (attemptId, requestId, secret) =>
    invokeIpc(DESKTOP_IPC.sshAskpassReply, attemptId, requestId, secret),
  sshCleanupHost: (id, request) => invokeIpc(DESKTOP_IPC.sshCleanupHost, id, request),
  sshUpdateHostSettings: (id, settings) => invokeIpc(DESKTOP_IPC.sshUpdateHostSettings, id, settings),
  sshServerLogins: (id) => invokeIpc(DESKTOP_IPC.sshServerLogins, id),
  sshServerLoginBegin: (id, provider) => invokeIpc(DESKTOP_IPC.sshServerLoginBegin, id, provider),
  sshServerLoginStatus: (id, flowId) => invokeIpc(DESKTOP_IPC.sshServerLoginStatus, id, flowId),
  sshServerLoginComplete: (id, flowId, redirectUrl) =>
    invokeIpc(DESKTOP_IPC.sshServerLoginComplete, id, flowId, redirectUrl),
  sshServerLoginCancel: (id, flowId) => invokeIpc(DESKTOP_IPC.sshServerLoginCancel, id, flowId),
  sshServerLoginSaveKey: (id, provider, key) => invokeIpc(DESKTOP_IPC.sshServerLoginSaveKey, id, provider, key),
  sshServerLoginLogout: (id, provider) => invokeIpc(DESKTOP_IPC.sshServerLoginLogout, id, provider),
  sshServerLoginRemoveCustom: (id, provider) => invokeIpc(DESKTOP_IPC.sshServerLoginRemoveCustom, id, provider),
  subscribeSshAskpass: (listener) => subscribeIpc(DESKTOP_IPC.sshAskpass, listener),
  sshDiagnosticsLog: (ref) => invokeIpc(DESKTOP_IPC.sshDiagnosticsLog, ref),
  sshDiagnosticsCopy: (ref) => invokeIpc(DESKTOP_IPC.sshDiagnosticsCopy, ref),
  sshServerLog: (ref) => invokeIpc(DESKTOP_IPC.sshServerLog, ref),
  subscribeSshCleanupProgress: (listener) => subscribeIpc(DESKTOP_IPC.sshCleanupProgress, listener),
  subscribeSshProgress: (listener) => subscribeIpc(DESKTOP_IPC.sshProgress, listener),
  getConnectionLink: () => invokeIpc(DESKTOP_IPC.connectionLinkGet),
  subscribeConnectionLink: (listener) => subscribeIpc(DESKTOP_IPC.connectionLinkState, listener),
  subscribeConnectionNotice: (listener) => subscribeIpc(DESKTOP_IPC.connectionNotice, listener),
  retryConnection: () => invokeIpc(DESKTOP_IPC.connectionRetry),
  retryConnectionNow: () => invokeIpc(DESKTOP_IPC.connectionRetryNow),
  closeConnectionWindow: () => invokeIpc(DESKTOP_IPC.connectionCloseWindow),
  openConnectionSettings: () => invokeIpc(DESKTOP_IPC.connectionOpenSettings),
  getReopenServerWindows: () => invokeIpc(DESKTOP_IPC.reopenServerWindowsGet),
  setReopenServerWindows: (enabled) => invokeIpc(DESKTOP_IPC.reopenServerWindowsSet, enabled),
  subscribeServerRestoreProgress: (listener) => subscribeIpc(DESKTOP_IPC.serverRestoreProgress, listener),
  getServerRestoreProgress: () => invokeIpc(DESKTOP_IPC.serverRestoreProgressGet),
  listServerPorts: (rescan) => invokeIpc(DESKTOP_IPC.serverPortsList, rescan !== false),
  subscribeServerPorts: (listener) => subscribeIpc(DESKTOP_IPC.serverPortsChanged, listener),
  forwardServerPort: (remotePort, localPort) => invokeIpc(DESKTOP_IPC.serverPortForward, remotePort, localPort ?? null),
  stopServerPortForward: (remotePort) => invokeIpc(DESKTOP_IPC.serverPortStop, remotePort),
  dismissServerPort: (port) => invokeIpc(DESKTOP_IPC.serverPortDismiss, port),
  openServerPortInBrowser: (remotePort) => invokeIpc(DESKTOP_IPC.serverPortOpen, remotePort),
  subscribeConnectionSignIn: (listener) => subscribeIpc(DESKTOP_IPC.connectionSignIn, listener),
  prefetchSession: (sessionId, transcriptItemLimit, readTraceId) =>
    invokeIpc(DESKTOP_IPC.prefetchSession, sessionId, transcriptItemLimit, readTraceId),
  setVisibleSessions: (sessionIds) => invokeIpc(DESKTOP_IPC.setVisibleSessions, sessionIds),
  searchProjectFiles: (projectIdOrWorkspaceId, query, limit, includeIgnored, includeDirectories) =>
    invokeIpc(DESKTOP_IPC.searchProjectFiles, projectIdOrWorkspaceId, query, limit, includeIgnored, includeDirectories),
  searchWorkspaceText: (projectPath, options) => invokeIpc(DESKTOP_IPC.searchWorkspaceText, projectPath, options),
  projectRecovery: (projectPath, request) => invokeIpc(DESKTOP_IPC.projectRecovery, projectPath, request),
  replaceWorkspaceText: (projectPath, options, replacement, relPaths) =>
    invokeIpc(DESKTOP_IPC.replaceWorkspaceText, projectPath, options, replacement, relPaths),
  getSnapshot: () => invokeIpc(DESKTOP_IPC.getSnapshot),
  subscribeState: (listener) => {
    // Reassemble transcript deltas (see DesktopStateWire): the host sends the
    // full items array once, then identity-prefix patches. Renderers keep
    // consuming complete SessionSnapshot objects; unchanged items retain their
    // object identity across snapshots, so memoized rows skip re-rendering.
    let items: unknown[] = [];
    let streamingTail: DesktopTranscriptItem | null = null;
    let stateFields: Record<string, unknown> = {};
    let revision: number | null = null;
    const stateFieldsFrom = (record: Record<string, unknown>): Record<string, unknown> => {
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (!STATE_WIRE_CONTROL_KEYS.has(key)) fields[key] = value;
      }
      return fields;
    };
    // Lost sync (preload reload, missed event): drop the patch and ask the
    // host to restart from a full snapshot.
    const requestResync = (): void => {
      revision = null;
      try {
        ipcRenderer.send(DESKTOP_IPC.stateResync);
      } catch {
        /* next full send recovers */
      }
    };
    const receive = (_event: Electron.IpcRendererEvent, wire: DesktopStateWire): void => {
      if (!wire || typeof wire !== 'object') {
        items = [];
        streamingTail = null;
        stateFields = {};
        revision = null;
        listener(wire as SessionSnapshot);
        return;
      }
      const record = wire as Record<string, unknown>;
      const patch = record.__itemsPatch as DesktopStateItemsPatch | undefined;
      if (!patch) {
        const snapshot = { ...record };
        delete snapshot.__itemsRevision;
        delete snapshot.__statePatch;
        if (Array.isArray(snapshot.items)) {
          items = snapshot.items;
          revision = typeof record.__itemsRevision === 'number' ? record.__itemsRevision : null;
        } else {
          items = [];
          revision = null;
        }
        streamingTail = streamingTailFrom(snapshot.streamingTail);
        stateFields = stateFieldsFrom(snapshot);
        listener(snapshot as SessionSnapshot);
        return;
      }
      const statePatch = record.__statePatch as DesktopStateFieldsPatch | undefined;
      if (
        revision === null ||
        patch.base !== revision ||
        (statePatch && (statePatch.base !== revision || statePatch.revision !== patch.revision))
      ) {
        requestResync();
        return;
      }
      if (statePatch) {
        const nextFields = { ...stateFields };
        for (const key of statePatch.removed) delete nextFields[key];
        Object.assign(nextFields, statePatch.changed);
        stateFields = nextFields;
      } else {
        stateFields = stateFieldsFrom(record);
      }
      const tailPatch = record.__streamingTailPatch as DesktopStateStreamingTailPatch | undefined;
      let nextStreamingTail = streamingTail;
      if (tailPatch) {
        const priorText = typeof streamingTail?.text === 'string' ? streamingTail.text : '';
        if (
          !streamingTail ||
          streamingTail.id == null ||
          streamingTail.id !== tailPatch.tail.id ||
          tailPatch.prefix < 0 ||
          tailPatch.prefix > priorText.length
        ) {
          requestResync();
          return;
        }
        nextStreamingTail = {
          ...tailPatch.tail,
          text: priorText.slice(0, tailPatch.prefix) + tailPatch.append,
        };
      } else if (Object.hasOwn(record, 'streamingTail')) {
        nextStreamingTail = streamingTailFrom(record.streamingTail);
      }
      // A streaming-tail-only publication carries an empty settled-items
      // patch. Preserve the array identity so renderer memos do not rescan the
      // full transcript for every token flush.
      if (patch.prefix !== items.length || patch.append.length > 0) {
        items = items.slice(0, patch.prefix).concat(patch.append);
      }
      revision = patch.revision;
      const snapshot = { ...stateFields };
      snapshot.items = items;
      snapshot.streamingTail = nextStreamingTail;
      streamingTail = nextStreamingTail;
      listener(snapshot as SessionSnapshot);
    };
    ipcRenderer.on(DESKTOP_IPC.state, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.state, receive);
  },
  // Keep perf instrumentation entirely off the production renderer hot path.
  // Renderer call sites use optional chaining, so omitting the bridge prevents
  // them from scheduling measurements that the daemon would only discard.
  ...(process.env.MIXDOG_DESKTOP_PERF === '1'
    ? {
        perfLog: (line: string) => {
          try {
            ipcRenderer.send(DESKTOP_IPC.perfLog, String(line));
          } catch {
            /* diagnostics only */
          }
        },
      }
    : {}),
  reportScreenSessions: (sessionIds) => {
    try {
      ipcRenderer.send(DESKTOP_IPC.reportScreenSessions, sessionIds);
    } catch {
      /* worst case a completion on screen is still announced */
    }
  },
  // The desktop pet (main/desktop-pet-window.ts), on this window's own channels.
  getDesktopPetConfig: () => invokeIpc(DESKTOP_PET_IPC.getConfig),
  setDesktopPetEnabled: (enabled) => invokeIpc(DESKTOP_PET_IPC.setEnabled, enabled === true),
  setDesktopPetOption: (name, value) => invokeIpc(DESKTOP_PET_IPC.setOption, String(name), value === true),
  setDesktopPetScale: (scale) => invokeIpc(DESKTOP_PET_IPC.setScale, Number(scale)),
  resetDesktopPetPosition: () => invokeIpc(DESKTOP_PET_IPC.resetPosition),
  subscribeDesktopPetConfig: (listener) => subscribeIpc(DESKTOP_PET_IPC.config, listener),
  subscribeDesktopPetOpenSettings: (listener) => subscribeIpc(DESKTOP_PET_IPC.openSettings, () => listener()),
  subscribeDesktopPetAppLayout: (listener) =>
    subscribeIpc(DESKTOP_PET_IPC.appLayout, (layout: unknown) => listener(desktopPetAppLayout(layout))),
  publishDesktopPet: (state) => {
    try {
      ipcRenderer.send(DESKTOP_PET_IPC.publish, state);
    } catch {
      /* the pet keeps its last state */
    }
  },
  publishDesktopPetComposer: (rect) => {
    try {
      ipcRenderer.send(DESKTOP_PET_IPC.composer, rect);
    } catch {
      /* the pinned pet keeps its last place */
    }
  },
  publishDesktopPetTheme: (theme) => {
    try {
      ipcRenderer.send(DESKTOP_PET_IPC.theme, theme);
    } catch {
      /* the overlay keeps its last look */
    }
  },
  publishDesktopPetLayers: (layers) => {
    try {
      ipcRenderer.send(DESKTOP_PET_IPC.layers, layers);
    } catch {
      /* the overlay keeps its last state */
    }
  },
  publishDesktopPetAvailable: (available) => {
    try {
      ipcRenderer.send(DESKTOP_PET_IPC.available, available === true);
    } catch {
      /* the overlay keeps its last state */
    }
  },
  rendererDiagnostic: (diagnostic) => {
    try {
      ipcRenderer.send(DESKTOP_IPC.rendererDiagnostic, diagnostic);
    } catch {
      /* diagnostics only */
    }
  },
  rendererReady: () => {
    try {
      ipcRenderer.send(DESKTOP_IPC.rendererReady);
    } catch {
      /* show falls back to timeout */
    }
  },
  acknowledgeWhatsNew: (version) => {
    try {
      ipcRenderer.send(DESKTOP_IPC.acknowledgeWhatsNew, version);
    } catch {
      /* the announcement is simply retried next launch */
    }
  },
  termEnsure: (id, cwd, shell) => invokeIpc(DESKTOP_IPC.termEnsure, id, cwd ?? null, shell ?? null),
  termProfiles: () => invokeIpc(DESKTOP_IPC.termProfiles),
  termWrite: (id, data) => {
    try {
      ipcRenderer.send(DESKTOP_IPC.termWrite, id, data);
    } catch {
      /* keystroke lost */
    }
  },
  termResize: (id, cols, rows) => {
    try {
      ipcRenderer.send(DESKTOP_IPC.termResize, id, cols, rows);
    } catch {
      /* next resize wins */
    }
  },
  termAcknowledge: (id, charCount) => {
    try {
      ipcRenderer.send(DESKTOP_IPC.termAcknowledge, id, charCount);
    } catch {
      /* teardown */
    }
  },
  termDispose: (id) => invokeIpc(DESKTOP_IPC.termDispose, id),
  subscribeTermData: (listener) => subscribeIpc(DESKTOP_IPC.termData, listener),
  subscribeTermSizeOwner: (listener) => subscribeIpc(DESKTOP_IPC.termSizeOwner, listener),
  termActivity: () => invokeIpc(DESKTOP_IPC.termActivity),
  termFocus: (id, focused) => {
    try {
      ipcRenderer.send(DESKTOP_IPC.termFocus, id, focused);
    } catch {
      /* the next renewal reports it */
    }
  },
  subscribeTermActivity: (listener) => subscribeIpc(DESKTOP_IPC.termActivityChanged, listener),
  gitStatus: (cwd, options) => invokeIpc(DESKTOP_IPC.gitStatus, cwd, options),
  gitBranches: (cwd) => invokeIpc(DESKTOP_IPC.gitBranches, cwd),
  gitRenameBranch: (cwd, branch, nextBranch) => invokeIpc(DESKTOP_IPC.gitRenameBranch, cwd, branch, nextBranch),
  gitDeleteBranch: (cwd, branch) => invokeIpc(DESKTOP_IPC.gitDeleteBranch, cwd, branch),
  gitDiff: (cwd, path, staged, worktreeOnly, untracked) =>
    invokeIpc(DESKTOP_IPC.gitDiff, cwd, path, staged === true, worktreeOnly === true, untracked === true),
  gitApplyPatch: (cwd, path, patch, reverse) =>
    invokeIpc(DESKTOP_IPC.gitApplyPatch, cwd, path, patch, reverse === true),
  gitStage: (cwd, paths) => invokeIpc(DESKTOP_IPC.gitStage, cwd, paths),
  gitUnstage: (cwd, paths) => invokeIpc(DESKTOP_IPC.gitUnstage, cwd, paths),
  gitIgnore: (cwd, path, scope) => invokeIpc(DESKTOP_IPC.gitIgnore, cwd, path, scope),
  gitCommit: (cwd, message) => invokeIpc(DESKTOP_IPC.gitCommit, cwd, message),
  gitCommitPaths: (cwd, message, paths) => invokeIpc(DESKTOP_IPC.gitCommitPaths, cwd, message, paths),
  gitAmend: (cwd, message) => invokeIpc(DESKTOP_IPC.gitAmend, cwd, message),
  gitUndoLastCommit: (cwd) => invokeIpc(DESKTOP_IPC.gitUndoLastCommit, cwd),
  gitStash: (cwd, message) => invokeIpc(DESKTOP_IPC.gitStash, cwd, message),
  gitStashPop: (cwd) => invokeIpc(DESKTOP_IPC.gitStashPop, cwd),
  gitStashList: (cwd) => invokeIpc(DESKTOP_IPC.gitStashList, cwd),
  gitStashApply: (cwd, ref) => invokeIpc(DESKTOP_IPC.gitStashApply, cwd, ref),
  gitStashDrop: (cwd, ref) => invokeIpc(DESKTOP_IPC.gitStashDrop, cwd, ref),
  ghPrList: (cwd) => invokeIpc(DESKTOP_IPC.ghPrList, cwd),
  githubRequest: (cwd, input) => invokeIpc(DESKTOP_IPC.githubRequest, cwd, input),
  ghPrDefaultBranch: (cwd) => invokeIpc(DESKTOP_IPC.ghPrDefaultBranch, cwd),
  ghPrCreate: (cwd, input) => invokeIpc(DESKTOP_IPC.ghPrCreate, cwd, input),
  ghPrView: (cwd, number) => invokeIpc(DESKTOP_IPC.ghPrView, cwd, number),
  ghPrCheckout: (cwd, number) => invokeIpc(DESKTOP_IPC.ghPrCheckout, cwd, number),
  ghPrMerge: (cwd, number, method) => invokeIpc(DESKTOP_IPC.ghPrMerge, cwd, number, method),
  ghPrDiff: (cwd, number) => invokeIpc(DESKTOP_IPC.ghPrDiff, cwd, number),
  gitPush: (cwd) => invokeIpc(DESKTOP_IPC.gitPush, cwd),
  gitFetch: (cwd) => invokeIpc(DESKTOP_IPC.gitFetch, cwd),
  gitPull: (cwd) => invokeIpc(DESKTOP_IPC.gitPull, cwd),
  gitSync: (cwd) => invokeIpc(DESKTOP_IPC.gitSync, cwd),
  gitContinue: (cwd) => invokeIpc(DESKTOP_IPC.gitContinue, cwd),
  gitAbortOperation: (cwd) => invokeIpc(DESKTOP_IPC.gitAbortOperation, cwd),
  gitRevert: (cwd, path, untracked, mode) => invokeIpc(DESKTOP_IPC.gitRevert, cwd, path, untracked === true, mode),
  gitLog: (cwd, query, skip, limit) => invokeIpc(DESKTOP_IPC.gitLog, cwd, query, skip, limit),
  gitShow: (cwd, hash) => invokeIpc(DESKTOP_IPC.gitShow, cwd, hash),
  gitShowDiff: (cwd, hash, path) => invokeIpc(DESKTOP_IPC.gitShowDiff, cwd, hash, path),
  gitRequestContext: (cwd, input) => invokeIpc(DESKTOP_IPC.gitRequestContext, cwd, input),
  gitShowFile: (cwd, rev, path) => invokeIpc(DESKTOP_IPC.gitShowFile, cwd, rev, path),
  // `confirmedDirty` is forwarded as the renderer sends it: it is a caller
  // contract (see ipc.ts's handler for why the main side does not demand
  // evidence), and the refusal it waives only unstages work — the destructive
  // `hard` mode has no such flag.
  gitResetToCommit: (cwd, hash, mode, confirmedDirty) =>
    invokeIpc(DESKTOP_IPC.gitResetToCommit, cwd, hash, mode, confirmedDirty),
  gitRevertCommit: (cwd, hash) => invokeIpc(DESKTOP_IPC.gitRevertCommit, cwd, hash),
  gitCherryPickCommit: (cwd, hash) => invokeIpc(DESKTOP_IPC.gitCherryPickCommit, cwd, hash),
  gitCreateTag: (cwd, tag, hash) => invokeIpc(DESKTOP_IPC.gitCreateTag, cwd, tag, hash),
  gitDeleteTag: (cwd, tag) => invokeIpc(DESKTOP_IPC.gitDeleteTag, cwd, tag),
  gitReview: (cwd, source) => invokeIpc(DESKTOP_IPC.gitReview, cwd, source),
  gitReviewDiff: (cwd, path, untracked, source) =>
    invokeIpc(DESKTOP_IPC.gitReviewDiff, cwd, path, untracked === true, source),
  gitReviewDiffs: (cwd, files, source) => invokeIpc(DESKTOP_IPC.gitReviewDiffs, cwd, files, source),
  revealFile: (cwd, path, accessToken) => invokeIpc(DESKTOP_IPC.revealFile, cwd, path, accessToken),
  openFilePath: (cwd, path, accessToken, confirmedPath) =>
    invokeIpc(DESKTOP_IPC.openFilePath, cwd, path, accessToken, confirmedPath),
  openAttachmentImage: (dataUrl, name) => invokeIpc(DESKTOP_IPC.openAttachmentImage, dataUrl, name),
  readAttachmentThumbnail: (attachmentRef) => invokeIpc(DESKTOP_IPC.readAttachmentThumbnail, attachmentRef),
  openAttachmentFile: (dataUrl, name) => invokeIpc(DESKTOP_IPC.openAttachmentFile, dataUrl, name),
  readSessionAttachment: (sessionId, attachmentId) =>
    invokeIpc(DESKTOP_IPC.readSessionAttachment, sessionId, attachmentId),
  stageAttachmentFile: (dataUrl, name) => invokeIpc(DESKTOP_IPC.stageAttachmentFile, dataUrl, name),
  saveFileAs: (source, suggestedName) => invokeIpc(DESKTOP_IPC.saveFileAs, source, suggestedName),
  getUpdaterState: () => invokeIpc(DESKTOP_IPC.getUpdaterState),
  subscribeUpdaterState: (listener) => subscribeIpc(DESKTOP_IPC.updaterState, listener),
  checkForDesktopUpdate: () => invokeIpc(DESKTOP_IPC.checkForDesktopUpdate),
  showDesktopUpdate: () => invokeIpc(DESKTOP_IPC.showDesktopUpdate),
  submitNewTask: (prompt, options, draft) => invokeIpc(DESKTOP_IPC.submitNewTask, prompt, options, draft),
  submitToSession: (sessionId, prompt, options) => invokeIpc(DESKTOP_IPC.submitToSession, sessionId, prompt, options),
  abortSession: (sessionId, options) => invokeIpc(DESKTOP_IPC.abortSession, sessionId, options),
  resolveToolApprovalForSession: (sessionId, id, decision) =>
    invokeIpc(DESKTOP_IPC.resolveToolApprovalForSession, sessionId, id, decision),
  provideSecretInput: (requestId, value) => invokeIpc(DESKTOP_IPC.provideSecretInput, requestId, value),
  takeoverReady: (sessionId, id) => invokeIpc(DESKTOP_IPC.takeoverReady, sessionId, id),
  getAgentNotificationMute: (agentId) => invokeIpc(DESKTOP_IPC.getAgentNotificationMute, agentId),
  setAgentNotificationMute: (agentId, muted) => invokeIpc(DESKTOP_IPC.setAgentNotificationMute, agentId, muted),
  resyncSessionState: (sessionId) => ipcRenderer.send(DESKTOP_IPC.sessionStateResync, sessionId),
  subscribeSessionState: (listener) => {
    const decoders = new Map<string, ReturnType<typeof createSnapshotDeltaDecoder>>();
    const receive = (_event: Electron.IpcRendererEvent, update: DesktopSessionStateWireUpdate): void => {
      const sessionId = String(update?.sessionId || '');
      if (!sessionId) return;
      let decoder = decoders.get(sessionId);
      if (!decoder) {
        decoder = createSnapshotDeltaDecoder();
        decoders.set(sessionId, decoder);
      }
      const decoded = decoder.decode(update.wire);
      if (!decoded.ok) {
        decoder.reset();
        try {
          ipcRenderer.send(DESKTOP_IPC.sessionStateResync, sessionId);
        } catch {
          /* the next full snapshot recovers */
        }
        return;
      }
      if (update.wire === null) decoders.delete(sessionId);
      listener({
        sessionId,
        snapshot: decoded.snapshot as SessionSnapshot,
        ...(update.readTraceId ? { readTraceId: update.readTraceId } : {}),
        frameSource: update.frameSource,
        ...(update.laneEnd ? { laneEnd: update.laneEnd } : {}),
        ...(typeof update.contentRevision === 'number' ? { contentRevision: update.contentRevision } : {}),
      } satisfies DesktopSessionStateUpdate);
    };
    ipcRenderer.on(DESKTOP_IPC.sessionState, receive);
    return () => {
      decoders.clear();
      ipcRenderer.removeListener(DESKTOP_IPC.sessionState, receive);
    };
  },
  inheritSession: (sourceSessionId, selection, options) =>
    invokeIpc(DESKTOP_IPC.inheritSession, sourceSessionId, selection ?? null, options ?? null),
  listProviderModels: (options) => invokeIpc(DESKTOP_IPC.listProviderModels, options),
  setModelRoute: (selection, sessionId) => invokeIpc(DESKTOP_IPC.setModelRoute, selection, sessionId),
  setFast: (enabled, sessionId) => invokeIpc(DESKTOP_IPC.setFast, enabled, sessionId),
  readSettings: () => invokeIpc(DESKTOP_IPC.readSettings),
  updateSetting: (key, enabled) => invokeIpc(DESKTOP_IPC.updateSetting, key, enabled),
  setNotificationVolume: (volume) => invokeIpc(DESKTOP_IPC.setNotificationVolume, volume),
  previewNotificationSound: () => invokeIpc(DESKTOP_IPC.previewNotificationSound),
  subscribeSettingsChanged: (listener) => subscribeIpc(DESKTOP_IPC.settingsChanged, listener),
  readActivityRailPins: () => invokeIpc(DESKTOP_IPC.readActivityRailPins),
  updateActivityRailPins: (pins, initializeIfMissing) =>
    invokeIpc(DESKTOP_IPC.updateActivityRailPins, pins, initializeIfMissing),
  subscribeActivityRailPins: (listener) => subscribeIpc(DESKTOP_IPC.activityRailPinsChanged, listener),
  notifyProviderModelsChanged: (origin) => {
    void invokeIpc(DESKTOP_IPC.notifyProviderModelsChanged, origin).catch(() => {});
  },
  subscribeProviderModelsChanged: (listener) => subscribeIpc(DESKTOP_IPC.providerModelsChanged, listener),
  getZoomFactor: () => invokeIpc(DESKTOP_IPC.getZoomFactor),
  setZoomFactor: (factor) => invokeIpc(DESKTOP_IPC.setZoomFactor, factor),
  applyTitleBarTheme: (theme, systemPreference) =>
    invokeIpc(DESKTOP_IPC.applyTitleBarTheme, theme, systemPreference === true),
  setTitleBarDim: (dim) => invokeIpc(DESKTOP_IPC.setTitleBarDim, dim),
  listSystemFonts: () => invokeIpc(DESKTOP_IPC.listSystemFonts),
  onZoomFactorChanged: (listener) => subscribeIpc(DESKTOP_IPC.zoomFactorChanged, listener),
  onNotificationOpenSession: (listener) => subscribeIpc(DESKTOP_IPC.notificationOpenSession, listener),
  onBrowserOpenRequested: (listener) => subscribeIpc(DESKTOP_IPC.browserOpenRequested, listener),
  onTerminalRunRequested: (listener) => subscribeIpc(DESKTOP_IPC.terminalRunRequested, listener),
  claimTerminalRun: (requestId) => invokeIpc(DESKTOP_IPC.terminalRunClaim, requestId),
  onVisualizeChanged: (listener) => subscribeIpc(DESKTOP_IPC.visualizeChanged, listener),
  visualizeState: () => invokeIpc(DESKTOP_IPC.visualizeState),
  visualizeCommand: (command) => invokeIpc(DESKTOP_IPC.visualizeCommand, command),
  visualizePaneText: (sessionId, tabId, index) => invokeIpc(DESKTOP_IPC.visualizePaneText, sessionId, tabId, index),
  visualizeFeedbackAttach: (sessionId, tabId) => invokeIpc(DESKTOP_IPC.visualizeFeedbackAttach, sessionId, tabId),
  visualizeCaptureRect: (rect) => invokeIpc(DESKTOP_IPC.visualizeCaptureRect, rect),
  visualizeConsumeGesture: (target) => invokeIpc(DESKTOP_IPC.visualizeConsumeGesture, target),
  visualizePanelSize: (size) => invokeIpc(DESKTOP_IPC.visualizePanelSize, size),
  onBrowserSessionReleased: (listener) => subscribeIpc(DESKTOP_IPC.browserSessionReleased, listener),
  browserSetActiveGuest: (sessionId, webContentsId, active) =>
    invokeIpc(DESKTOP_IPC.browserSetActiveGuest, sessionId, webContentsId, active),
  browserReleasePage: (pageId) => invokeIpc(DESKTOP_IPC.browserReleasePage, pageId),
  ...createBrowserTextureBridge(),
  browserPageControl: (sessionId, input) => invokeIpc(DESKTOP_IPC.browserPageControl, sessionId, input),
  browserPageMetadata: (sessionId) => invokeIpc(DESKTOP_IPC.browserPageMetadata, sessionId),
  browserPresentNative: (sessionId, rect) => invokeIpc(DESKTOP_IPC.browserPresentNative, sessionId, rect),
  browserConfigureGuestViewport: (sessionId, webContentsId, config) =>
    invokeIpc(DESKTOP_IPC.browserConfigureGuestViewport, sessionId, webContentsId, config),
  onBrowserGuestViewportChanged: (listener) => subscribeIpc(DESKTOP_IPC.browserGuestViewportChanged, listener),
  onBrowserRemoteViewerChanged: (listener) => subscribeIpc(DESKTOP_IPC.browserRemoteViewerChanged, listener),
  onBrowserFullscreenChanged: (listener) => subscribeIpc(DESKTOP_IPC.browserFullscreenChanged, listener),
  onBrowserApproval: (listener) => subscribeIpc(DESKTOP_IPC.browserApproval, listener),
  browserApprovalDecide: (id, decision, reason) => invokeIpc(DESKTOP_IPC.browserApprovalDecide, id, decision, reason),
  browserProfileImportSources: () => invokeIpc(DESKTOP_IPC.browserProfileImportSources),
  browserProfileImportStart: (request) => invokeIpc(DESKTOP_IPC.browserProfileImportStart, request),
  onBrowserProfileImportProgress: (listener) => subscribeIpc(DESKTOP_IPC.browserProfileImportProgress, listener),
  browserHistorySearch: (query) => invokeIpc(DESKTOP_IPC.browserHistorySearch, query),
  browserCredentialSuggestions: (sessionId) => invokeIpc(DESKTOP_IPC.browserCredentialSuggestions, sessionId),
  browserCredentialFill: (sessionId, credentialId) =>
    invokeIpc(DESKTOP_IPC.browserCredentialFill, sessionId, credentialId),
  browserSignedInSites: () => invokeIpc(DESKTOP_IPC.browserSignedInSites),
  browserSignOutSite: (site) => invokeIpc(DESKTOP_IPC.browserSignOutSite, site),
  browserClearSignIns: () => invokeIpc(DESKTOP_IPC.browserClearSignIns),
  browserLoginOpen: (sessionId, id) => invokeIpc(DESKTOP_IPC.browserLoginOpen, sessionId, id),
  browserLoginStatus: (sessionId, id) => invokeIpc(DESKTOP_IPC.browserLoginStatus, sessionId, id),
  browserPageIdentity: (url, options) => invokeIpc(DESKTOP_IPC.browserPageIdentity, url, options?.preview === true),
  onBrowserPageIdentityChanged: (listener) => subscribeIpc(DESKTOP_IPC.browserPageIdentityChanged, listener),
  invokeCapability: (request) => invokeIpc(DESKTOP_IPC.invokeCapability, request),
  readCapabilities: (requests) => invokeIpc(DESKTOP_IPC.readCapabilities, requests),
  // Byte lane for gallery media: a plain URL the DOM fetches itself (cached
  // by Chromium, range-able for video), never an IPC base64 payload.
  mediaUrl: (assetId, variant) =>
    `mixdog-media://asset/${encodeURIComponent(assetId)}?variant=${encodeURIComponent(variant || 'original')}`,
  quit: () => invokeIpc(DESKTOP_IPC.quit),
};

// A held token for a file outside every Project can lose its grant (the
// oldest of the capped grants is dropped): such a refusal re-grants the file
// through `resolveLocalPaths` and retries once, so a held link keeps opening.
contextBridge.exposeInMainWorld('mixdogDesktop', Object.freeze(withApiFileGrantRefresh(api)));
