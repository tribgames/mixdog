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
  chooseProject: () => ipcRenderer.invoke(DESKTOP_IPC.chooseProject),
  chooseFile: (defaultPath) => ipcRenderer.invoke(DESKTOP_IPC.chooseFile, defaultPath),
  chooseConversationImportFile: () => ipcRenderer.invoke(DESKTOP_IPC.chooseConversationImportFile),
  subscribeConversationImportProgress: (listener) => subscribeIpc(DESKTOP_IPC.conversationImportProgress, listener),
  chooseFiles: (defaultPath) => ipcRenderer.invoke(DESKTOP_IPC.chooseFiles, defaultPath),
  chooseWorkspace: () => ipcRenderer.invoke(DESKTOP_IPC.chooseWorkspace),
  saveWorkspace: (workspaceFile, folders) => ipcRenderer.invoke(DESKTOP_IPC.saveWorkspace, workspaceFile, folders),
  readEditorSettings: (projectPath, relPath, workspaceFile) =>
    ipcRenderer.invoke(DESKTOP_IPC.readEditorSettings, projectPath, relPath, workspaceFile),
  readMarkdownDefaultView: () => ipcRenderer.invoke(DESKTOP_IPC.readMarkdownDefaultView),
  writeMarkdownDefaultView: (view) => ipcRenderer.invoke(DESKTOP_IPC.writeMarkdownDefaultView, view),
  startProject: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.startProject, projectPath),
  startProjectTask: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.startProjectTask, projectPath),
  startTask: () => ipcRenderer.invoke(DESKTOP_IPC.startTask),
  listProjects: () => ipcRenderer.invoke(DESKTOP_IPC.listProjects),
  addProject: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.addProject, projectPath),
  openProjectInExplorer: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.openProjectInExplorer, projectPath),
  openMediaAsset: (assetId) => ipcRenderer.invoke(DESKTOP_IPC.openMediaAsset, assetId),
  openMediaFolder: (assetId) => ipcRenderer.invoke(DESKTOP_IPC.openMediaFolder, assetId),
  openExternal: (url) => ipcRenderer.invoke(DESKTOP_IPC.openExternal, url),
  submitFeedback: (input) => ipcRenderer.invoke(DESKTOP_IPC.submitFeedback, input),
  openLocalFileLink: (projectPath, href, confirmedPath) =>
    ipcRenderer.invoke(DESKTOP_IPC.openLocalFileLink, projectPath, href, confirmedPath),
  localPageUrl: (projectPath, relPath, accessToken) =>
    ipcRenderer.invoke(DESKTOP_IPC.localPageUrl, projectPath, relPath, accessToken),
  githubStarStatus: () => ipcRenderer.invoke(DESKTOP_IPC.githubStarStatus),
  starGithub: () => ipcRenderer.invoke(DESKTOP_IPC.starGithub),
  gitCliStatus: () => ipcRenderer.invoke(DESKTOP_IPC.gitCliStatus),
  installGitCli: () => ipcRenderer.invoke(DESKTOP_IPC.installGitCli),
  requestLinuxInputAccess: () => ipcRenderer.invoke(DESKTOP_IPC.requestLinuxInputAccess),
  libreOfficeStatus: () => ipcRenderer.invoke(DESKTOP_IPC.libreOfficeStatus),
  installLibreOffice: () => ipcRenderer.invoke(DESKTOP_IPC.installLibreOffice),
  computerReadiness: () => ipcRenderer.invoke(DESKTOP_IPC.computerReadiness),
  openComputerPermissionSettings: (pane) => ipcRenderer.invoke(DESKTOP_IPC.openComputerPermissionSettings, pane),
  githubCliStatus: () => ipcRenderer.invoke(DESKTOP_IPC.githubCliStatus),
  installGithubCli: () => ipcRenderer.invoke(DESKTOP_IPC.installGithubCli),
  githubCliLoginStart: () => ipcRenderer.invoke(DESKTOP_IPC.githubCliLoginStart),
  githubCliLoginStatus: (flowId) => ipcRenderer.invoke(DESKTOP_IPC.githubCliLoginStatus, flowId),
  githubCliLoginOpenBrowser: (flowId, options) =>
    ipcRenderer.invoke(DESKTOP_IPC.githubCliLoginOpenBrowser, flowId, options),
  githubCliLoginCancel: (flowId) => ipcRenderer.invoke(DESKTOP_IPC.githubCliLoginCancel, flowId),
  githubCliLogout: () => ipcRenderer.invoke(DESKTOP_IPC.githubCliLogout),
  githubCliAccount: () => ipcRenderer.invoke(DESKTOP_IPC.githubCliAccount),
  gitGlobalConfig: () => ipcRenderer.invoke(DESKTOP_IPC.gitGlobalConfig),
  setGitGlobalConfig: (key, value) => ipcRenderer.invoke(DESKTOP_IPC.setGitGlobalConfig, key, value),
  renameProject: (projectPath, alias) => ipcRenderer.invoke(DESKTOP_IPC.renameProject, projectPath, alias),
  removeProject: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.removeProject, projectPath),
  listProjectDir: (projectPath, relDir) => ipcRenderer.invoke(DESKTOP_IPC.listProjectDir, projectPath, relDir),
  // File.path was removed in modern Electron; webUtils resolves native drops.
  folderPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  resolveLocalPaths: (paths) => ipcRenderer.invoke(DESKTOP_IPC.resolveLocalPaths, paths),
  readLocalFile: (path) => ipcRenderer.invoke(DESKTOP_IPC.readLocalFile, path),
  folderWatch: (dir, recursive) => ipcRenderer.invoke(DESKTOP_IPC.folderWatch, dir, recursive === true),
  folderUnwatch: (dir, recursive) => ipcRenderer.invoke(DESKTOP_IPC.folderUnwatch, dir, recursive === true),
  listServerDirectories: (path, includeHidden) =>
    ipcRenderer.invoke(DESKTOP_IPC.listServerDirectories, path, includeHidden === true),
  serverUploadBegin: (name, size, scope) => ipcRenderer.invoke(DESKTOP_IPC.serverUploadBegin, name, size, scope),
  serverUploadChunk: (uploadId, offset, bytes) =>
    ipcRenderer.invoke(DESKTOP_IPC.serverUploadChunk, uploadId, offset, bytes),
  serverUploadCommit: (uploadId) => ipcRenderer.invoke(DESKTOP_IPC.serverUploadCommit, uploadId),
  serverUploadAbort: (uploadId) => ipcRenderer.invoke(DESKTOP_IPC.serverUploadAbort, uploadId),
  serverDownloadBegin: (projectPath, relPath, accessToken) =>
    ipcRenderer.invoke(DESKTOP_IPC.serverDownloadBegin, projectPath, relPath, accessToken),
  serverDownloadStep: (downloadId) => ipcRenderer.invoke(DESKTOP_IPC.serverDownloadStep, downloadId),
  serverDownloadFinish: (downloadId) => ipcRenderer.invoke(DESKTOP_IPC.serverDownloadFinish, downloadId),
  serverDownloadAbort: (downloadId) => ipcRenderer.invoke(DESKTOP_IPC.serverDownloadAbort, downloadId),
  openServerDownload: (path, confirmedPath) => ipcRenderer.invoke(DESKTOP_IPC.openServerDownload, path, confirmedPath),
  serverTrashInfo: (projectPath) => ipcRenderer.invoke(DESKTOP_IPC.serverTrashInfo, projectPath),
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
    ipcRenderer.invoke(DESKTOP_IPC.readProjectFile, projectPath, relPath, accessToken),
  previewProjectFile: (projectPath, relPath, accessToken) =>
    ipcRenderer.invoke(DESKTOP_IPC.previewProjectFile, projectPath, relPath, accessToken),
  captureFileSnapshot: (projectPath, relPath, accessToken) =>
    ipcRenderer.invoke(DESKTOP_IPC.captureFileSnapshot, projectPath, relPath, accessToken),
  previewDocumentFile: (projectPath, relPath, accessToken) =>
    ipcRenderer.invoke(DESKTOP_IPC.previewDocumentFile, projectPath, relPath, accessToken),
  previewDocumentPages: (projectPath, relPath, accessToken, options) =>
    ipcRenderer.invoke(DESKTOP_IPC.previewDocumentPages, projectPath, relPath, accessToken, options),
  writeProjectFile: (projectPath, relPath, content, expectedContent, accessToken, encoding) =>
    ipcRenderer.invoke(
      DESKTOP_IPC.writeProjectFile,
      projectPath,
      relPath,
      content,
      expectedContent,
      accessToken,
      encoding
    ),
  readEditorBackup: (projectPath, relPath, accessToken) =>
    ipcRenderer.invoke(DESKTOP_IPC.readEditorBackup, projectPath, relPath, accessToken),
  writeEditorBackup: (projectPath, relPath, content, expectedContent, accessToken) =>
    ipcRenderer.invoke(DESKTOP_IPC.writeEditorBackup, projectPath, relPath, content, expectedContent, accessToken),
  deleteEditorBackup: (projectPath, relPath, accessToken) =>
    ipcRenderer.invoke(DESKTOP_IPC.deleteEditorBackup, projectPath, relPath, accessToken),
  statProjectFile: (projectPath, relPath, accessToken) =>
    ipcRenderer.invoke(DESKTOP_IPC.statProjectFile, projectPath, relPath, accessToken),
  createProjectEntry: (projectPath, relDir, name, dir) =>
    ipcRenderer.invoke(DESKTOP_IPC.createProjectEntry, projectPath, relDir, name, dir),
  renameProjectEntry: (projectPath, relPath, newName) =>
    ipcRenderer.invoke(DESKTOP_IPC.renameProjectEntry, projectPath, relPath, newName),
  trashProjectEntry: (projectPath, relPath, options) =>
    options
      ? ipcRenderer.invoke(DESKTOP_IPC.trashProjectEntry, projectPath, relPath, options)
      : ipcRenderer.invoke(DESKTOP_IPC.trashProjectEntry, projectPath, relPath),
  moveProjectEntry: (projectPath, relPath, targetDirRel) =>
    ipcRenderer.invoke(DESKTOP_IPC.moveProjectEntry, projectPath, relPath, targetDirRel),
  copyProjectEntry: (projectPath, relPath, targetDirRel) =>
    ipcRenderer.invoke(DESKTOP_IPC.copyProjectEntry, projectPath, relPath, targetDirRel),
  codeGraphQuery: (projectPath, mode, symbol) =>
    ipcRenderer.invoke(DESKTOP_IPC.codeGraphQuery, projectPath, mode, symbol),
  lspDocument: (input) => ipcRenderer.invoke(DESKTOP_IPC.lspDocument, input),
  lspRequest: (input) => ipcRenderer.invoke(DESKTOP_IPC.lspRequest, input),
  lspApplyWorkspaceEdit: (projectPath, writes) =>
    ipcRenderer.invoke(DESKTOP_IPC.lspApplyWorkspaceEdit, projectPath, writes),
  subscribeLspDiagnostics: (listener) => subscribeIpc(DESKTOP_IPC.lspDiagnostics, listener),
  subscribeLspStatus: (listener) => subscribeIpc(DESKTOP_IPC.lspStatus, listener),
  listSessions: () => ipcRenderer.invoke(DESKTOP_IPC.listSessions),
  markSessionRead: (sessionId, messageCount, consumedUnread) =>
    ipcRenderer.invoke(DESKTOP_IPC.markSessionRead, sessionId, messageCount, consumedUnread),
  subscribeSessions: (listener) => subscribeIpc(DESKTOP_IPC.sessionsChanged, listener),
  listAgentPool: () => ipcRenderer.invoke(DESKTOP_IPC.listAgentPool),
  searchSessionContent: (query) => ipcRenderer.invoke(DESKTOP_IPC.searchSessionContent, query),
  subscribeAgentPool: (listener) => subscribeIpc(DESKTOP_IPC.agentPoolChanged, listener),
  renameSession: (sessionId, title) => ipcRenderer.invoke(DESKTOP_IPC.renameSession, sessionId, title),
  continueSessionInModel: (sessionId, route) =>
    ipcRenderer.invoke(DESKTOP_IPC.continueSessionInModel, sessionId, route),
  scheduleQuotaResume: (sessionId) => ipcRenderer.invoke(DESKTOP_IPC.scheduleQuotaResume, sessionId),
  cancelQuotaResume: (sessionId) => ipcRenderer.invoke(DESKTOP_IPC.cancelQuotaResume, sessionId),
  stopShellJob: (sessionId, taskId) => ipcRenderer.invoke(DESKTOP_IPC.stopShellJob, sessionId, taskId),
  getQuotaAutoResume: () => ipcRenderer.invoke(DESKTOP_IPC.getQuotaAutoResume),
  viewerDevice: () => ipcRenderer.invoke(DESKTOP_IPC.viewerDevice),
  setQuotaAutoResume: (enabled) => ipcRenderer.invoke(DESKTOP_IPC.setQuotaAutoResume, enabled),
  setSessionArchived: (sessionId, archived) => ipcRenderer.invoke(DESKTOP_IPC.setSessionArchived, sessionId, archived),
  setSessionFavorite: (sessionId, favorite) => ipcRenderer.invoke(DESKTOP_IPC.setSessionFavorite, sessionId, favorite),
  setSessionProject: (sessionId, projectPath) =>
    ipcRenderer.invoke(DESKTOP_IPC.setSessionProject, sessionId, projectPath),
  deleteSession: (sessionId) => ipcRenderer.invoke(DESKTOP_IPC.deleteSession, sessionId),
  getRemoteAccessInfo: (options) => ipcRenderer.invoke(DESKTOP_IPC.remoteAccessInfo, options),
  rotateRemoteAccess: () => ipcRenderer.invoke(DESKTOP_IPC.rotateRemoteAccess),
  revokeRemoteAccessClient: (clientId) => ipcRenderer.invoke(DESKTOP_IPC.revokeRemoteAccessClient, clientId),
  subscribeRemoteClientClaim: (listener) => subscribeIpc(DESKTOP_IPC.remoteClientClaim, listener),
  getRemoteAccessSettings: () => ipcRenderer.invoke(DESKTOP_IPC.getRemoteAccessSettings),
  setRemoteAccessEnabled: (enabled) => ipcRenderer.invoke(DESKTOP_IPC.setRemoteAccessEnabled, enabled),
  setRemotePcName: (name) => ipcRenderer.invoke(DESKTOP_IPC.setRemotePcName, name),
  subscribeRemoteAccessSettings: (listener) => subscribeIpc(DESKTOP_IPC.remoteAccessSettingsChanged, listener),
  setRemoteClientAlias: (clientId, alias) => ipcRenderer.invoke(DESKTOP_IPC.setRemoteClientAlias, clientId, alias),
  renameRemoteHost: (id, name) => ipcRenderer.invoke(DESKTOP_IPC.renameRemoteHost, id, name),
  listRemoteClientClaims: () => ipcRenderer.invoke(DESKTOP_IPC.listRemoteClientClaims),
  resolveRemoteClientClaim: (claimId, approved) =>
    ipcRenderer.invoke(DESKTOP_IPC.resolveRemoteClientClaim, claimId, approved),
  listRemoteHosts: () => ipcRenderer.invoke(DESKTOP_IPC.listRemoteHosts),
  connectRemoteHostByCode: (code) => ipcRenderer.invoke(DESKTOP_IPC.connectRemoteHostByCode, code),
  getRemotePairCode: (action) => ipcRenderer.invoke(DESKTOP_IPC.remotePairCode, action),
  subscribeShowConnectionSettings: (listener) => subscribeIpc(DESKTOP_IPC.showConnectionSettings, () => listener()),
  openRemoteHost: (id) => ipcRenderer.invoke(DESKTOP_IPC.openRemoteHost, id),
  forgetRemoteHost: (id) => ipcRenderer.invoke(DESKTOP_IPC.forgetRemoteHost, id),
  sshListHosts: () => ipcRenderer.invoke(DESKTOP_IPC.sshListHosts),
  sshRenameHost: (id, name) => ipcRenderer.invoke(DESKTOP_IPC.sshRenameHost, id, name),
  sshForgetHost: (id) => ipcRenderer.invoke(DESKTOP_IPC.sshForgetHost, id),
  sshOpenHost: (id) => ipcRenderer.invoke(DESKTOP_IPC.sshOpenHost, id),
  sshConfigHosts: () => ipcRenderer.invoke(DESKTOP_IPC.sshConfigHosts),
  sshInspectHostKey: (target) => ipcRenderer.invoke(DESKTOP_IPC.sshInspectHostKey, target),
  sshConnect: (request) => ipcRenderer.invoke(DESKTOP_IPC.sshConnect, request),
  sshCancel: (attemptId) => ipcRenderer.invoke(DESKTOP_IPC.sshCancel, attemptId),
  sshAskpassReply: (attemptId, requestId, secret) =>
    ipcRenderer.invoke(DESKTOP_IPC.sshAskpassReply, attemptId, requestId, secret),
  sshCleanupHost: (id, request) => ipcRenderer.invoke(DESKTOP_IPC.sshCleanupHost, id, request),
  sshUpdateHostSettings: (id, settings) => ipcRenderer.invoke(DESKTOP_IPC.sshUpdateHostSettings, id, settings),
  subscribeSshAskpass: (listener) => subscribeIpc(DESKTOP_IPC.sshAskpass, listener),
  sshDiagnosticsLog: (ref) => ipcRenderer.invoke(DESKTOP_IPC.sshDiagnosticsLog, ref),
  sshDiagnosticsCopy: (ref) => ipcRenderer.invoke(DESKTOP_IPC.sshDiagnosticsCopy, ref),
  sshServerLog: (ref) => ipcRenderer.invoke(DESKTOP_IPC.sshServerLog, ref),
  subscribeSshCleanupProgress: (listener) => subscribeIpc(DESKTOP_IPC.sshCleanupProgress, listener),
  subscribeSshProgress: (listener) => subscribeIpc(DESKTOP_IPC.sshProgress, listener),
  getConnectionLink: () => ipcRenderer.invoke(DESKTOP_IPC.connectionLinkGet),
  subscribeConnectionLink: (listener) => subscribeIpc(DESKTOP_IPC.connectionLinkState, listener),
  subscribeConnectionNotice: (listener) => subscribeIpc(DESKTOP_IPC.connectionNotice, listener),
  retryConnection: () => ipcRenderer.invoke(DESKTOP_IPC.connectionRetry),
  retryConnectionNow: () => ipcRenderer.invoke(DESKTOP_IPC.connectionRetryNow),
  closeConnectionWindow: () => ipcRenderer.invoke(DESKTOP_IPC.connectionCloseWindow),
  openConnectionSettings: () => ipcRenderer.invoke(DESKTOP_IPC.connectionOpenSettings),
  allowServerModelUse: () => ipcRenderer.invoke(DESKTOP_IPC.connectionAllowModelUse),
  getReopenServerWindows: () => ipcRenderer.invoke(DESKTOP_IPC.reopenServerWindowsGet),
  setReopenServerWindows: (enabled) => ipcRenderer.invoke(DESKTOP_IPC.reopenServerWindowsSet, enabled),
  subscribeServerRestoreProgress: (listener) => subscribeIpc(DESKTOP_IPC.serverRestoreProgress, listener),
  getServerRestoreProgress: () => ipcRenderer.invoke(DESKTOP_IPC.serverRestoreProgressGet),
  listServerPorts: (rescan) => ipcRenderer.invoke(DESKTOP_IPC.serverPortsList, rescan !== false),
  subscribeServerPorts: (listener) => subscribeIpc(DESKTOP_IPC.serverPortsChanged, listener),
  forwardServerPort: (remotePort, localPort) =>
    ipcRenderer.invoke(DESKTOP_IPC.serverPortForward, remotePort, localPort ?? null),
  stopServerPortForward: (remotePort) => ipcRenderer.invoke(DESKTOP_IPC.serverPortStop, remotePort),
  dismissServerPort: (port) => ipcRenderer.invoke(DESKTOP_IPC.serverPortDismiss, port),
  openServerPortInBrowser: (remotePort) => ipcRenderer.invoke(DESKTOP_IPC.serverPortOpen, remotePort),
  subscribeConnectionSignIn: (listener) => subscribeIpc(DESKTOP_IPC.connectionSignIn, listener),
  prefetchSession: (sessionId, transcriptItemLimit, readTraceId) =>
    ipcRenderer.invoke(DESKTOP_IPC.prefetchSession, sessionId, transcriptItemLimit, readTraceId),
  setVisibleSessions: (sessionIds) => ipcRenderer.invoke(DESKTOP_IPC.setVisibleSessions, sessionIds),
  searchProjectFiles: (projectIdOrWorkspaceId, query, limit, includeIgnored, includeDirectories) =>
    ipcRenderer.invoke(
      DESKTOP_IPC.searchProjectFiles,
      projectIdOrWorkspaceId,
      query,
      limit,
      includeIgnored,
      includeDirectories
    ),
  searchWorkspaceText: (projectPath, options) =>
    ipcRenderer.invoke(DESKTOP_IPC.searchWorkspaceText, projectPath, options),
  projectRecovery: (projectPath, request) => ipcRenderer.invoke(DESKTOP_IPC.projectRecovery, projectPath, request),
  replaceWorkspaceText: (projectPath, options, replacement, relPaths) =>
    ipcRenderer.invoke(DESKTOP_IPC.replaceWorkspaceText, projectPath, options, replacement, relPaths),
  getSnapshot: () => ipcRenderer.invoke(DESKTOP_IPC.getSnapshot),
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
  termEnsure: (id, cwd, shell) => ipcRenderer.invoke(DESKTOP_IPC.termEnsure, id, cwd ?? null, shell ?? null),
  termProfiles: () => ipcRenderer.invoke(DESKTOP_IPC.termProfiles),
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
  termDispose: (id) => ipcRenderer.invoke(DESKTOP_IPC.termDispose, id),
  subscribeTermData: (listener) => subscribeIpc(DESKTOP_IPC.termData, listener),
  subscribeTermSizeOwner: (listener) => subscribeIpc(DESKTOP_IPC.termSizeOwner, listener),
  gitStatus: (cwd, options) => ipcRenderer.invoke(DESKTOP_IPC.gitStatus, cwd, options),
  gitBranches: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitBranches, cwd),
  gitRenameBranch: (cwd, branch, nextBranch) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitRenameBranch, cwd, branch, nextBranch),
  gitDeleteBranch: (cwd, branch) => ipcRenderer.invoke(DESKTOP_IPC.gitDeleteBranch, cwd, branch),
  gitDiff: (cwd, path, staged, worktreeOnly, untracked) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitDiff, cwd, path, staged === true, worktreeOnly === true, untracked === true),
  gitApplyPatch: (cwd, path, patch, reverse) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitApplyPatch, cwd, path, patch, reverse === true),
  gitStage: (cwd, paths) => ipcRenderer.invoke(DESKTOP_IPC.gitStage, cwd, paths),
  gitUnstage: (cwd, paths) => ipcRenderer.invoke(DESKTOP_IPC.gitUnstage, cwd, paths),
  gitIgnore: (cwd, path, scope) => ipcRenderer.invoke(DESKTOP_IPC.gitIgnore, cwd, path, scope),
  gitCommit: (cwd, message) => ipcRenderer.invoke(DESKTOP_IPC.gitCommit, cwd, message),
  gitCommitPaths: (cwd, message, paths) => ipcRenderer.invoke(DESKTOP_IPC.gitCommitPaths, cwd, message, paths),
  gitAmend: (cwd, message) => ipcRenderer.invoke(DESKTOP_IPC.gitAmend, cwd, message),
  gitUndoLastCommit: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitUndoLastCommit, cwd),
  gitStash: (cwd, message) => ipcRenderer.invoke(DESKTOP_IPC.gitStash, cwd, message),
  gitStashPop: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitStashPop, cwd),
  gitStashList: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitStashList, cwd),
  gitStashApply: (cwd, ref) => ipcRenderer.invoke(DESKTOP_IPC.gitStashApply, cwd, ref),
  gitStashDrop: (cwd, ref) => ipcRenderer.invoke(DESKTOP_IPC.gitStashDrop, cwd, ref),
  ghPrList: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.ghPrList, cwd),
  githubRequest: (cwd, input) => ipcRenderer.invoke(DESKTOP_IPC.githubRequest, cwd, input),
  ghPrDefaultBranch: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.ghPrDefaultBranch, cwd),
  ghPrCreate: (cwd, input) => ipcRenderer.invoke(DESKTOP_IPC.ghPrCreate, cwd, input),
  ghPrView: (cwd, number) => ipcRenderer.invoke(DESKTOP_IPC.ghPrView, cwd, number),
  ghPrCheckout: (cwd, number) => ipcRenderer.invoke(DESKTOP_IPC.ghPrCheckout, cwd, number),
  ghPrMerge: (cwd, number, method) => ipcRenderer.invoke(DESKTOP_IPC.ghPrMerge, cwd, number, method),
  ghPrDiff: (cwd, number) => ipcRenderer.invoke(DESKTOP_IPC.ghPrDiff, cwd, number),
  gitPush: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitPush, cwd),
  gitFetch: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitFetch, cwd),
  gitPull: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitPull, cwd),
  gitSync: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitSync, cwd),
  gitContinue: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitContinue, cwd),
  gitAbortOperation: (cwd) => ipcRenderer.invoke(DESKTOP_IPC.gitAbortOperation, cwd),
  gitRevert: (cwd, path, untracked, mode) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitRevert, cwd, path, untracked === true, mode),
  gitLog: (cwd, query, skip, limit) => ipcRenderer.invoke(DESKTOP_IPC.gitLog, cwd, query, skip, limit),
  gitShow: (cwd, hash) => ipcRenderer.invoke(DESKTOP_IPC.gitShow, cwd, hash),
  gitShowDiff: (cwd, hash, path) => ipcRenderer.invoke(DESKTOP_IPC.gitShowDiff, cwd, hash, path),
  gitShowFile: (cwd, rev, path) => ipcRenderer.invoke(DESKTOP_IPC.gitShowFile, cwd, rev, path),
  // `confirmedDirty` is forwarded as the renderer sends it: it is a caller
  // contract (see ipc.ts's handler for why the main side does not demand
  // evidence), and the refusal it waives only unstages work — the destructive
  // `hard` mode has no such flag.
  gitResetToCommit: (cwd, hash, mode, confirmedDirty) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitResetToCommit, cwd, hash, mode, confirmedDirty),
  gitRevertCommit: (cwd, hash) => ipcRenderer.invoke(DESKTOP_IPC.gitRevertCommit, cwd, hash),
  gitCherryPickCommit: (cwd, hash) => ipcRenderer.invoke(DESKTOP_IPC.gitCherryPickCommit, cwd, hash),
  gitCreateTag: (cwd, tag, hash) => ipcRenderer.invoke(DESKTOP_IPC.gitCreateTag, cwd, tag, hash),
  gitDeleteTag: (cwd, tag) => ipcRenderer.invoke(DESKTOP_IPC.gitDeleteTag, cwd, tag),
  gitReview: (cwd, source) => ipcRenderer.invoke(DESKTOP_IPC.gitReview, cwd, source),
  gitReviewDiff: (cwd, path, untracked, source) =>
    ipcRenderer.invoke(DESKTOP_IPC.gitReviewDiff, cwd, path, untracked === true, source),
  gitReviewDiffs: (cwd, files, source) => ipcRenderer.invoke(DESKTOP_IPC.gitReviewDiffs, cwd, files, source),
  revealFile: (cwd, path, accessToken) => ipcRenderer.invoke(DESKTOP_IPC.revealFile, cwd, path, accessToken),
  openFilePath: (cwd, path, accessToken, confirmedPath) =>
    ipcRenderer.invoke(DESKTOP_IPC.openFilePath, cwd, path, accessToken, confirmedPath),
  openAttachmentImage: (dataUrl, name) => ipcRenderer.invoke(DESKTOP_IPC.openAttachmentImage, dataUrl, name),
  readAttachmentThumbnail: (attachmentRef) => ipcRenderer.invoke(DESKTOP_IPC.readAttachmentThumbnail, attachmentRef),
  openAttachmentFile: (dataUrl, name) => ipcRenderer.invoke(DESKTOP_IPC.openAttachmentFile, dataUrl, name),
  stageAttachmentFile: (dataUrl, name) => ipcRenderer.invoke(DESKTOP_IPC.stageAttachmentFile, dataUrl, name),
  saveFileAs: (source, suggestedName) => ipcRenderer.invoke(DESKTOP_IPC.saveFileAs, source, suggestedName),
  getUpdaterState: () => ipcRenderer.invoke(DESKTOP_IPC.getUpdaterState),
  subscribeUpdaterState: (listener) => subscribeIpc(DESKTOP_IPC.updaterState, listener),
  checkForDesktopUpdate: () => ipcRenderer.invoke(DESKTOP_IPC.checkForDesktopUpdate),
  showDesktopUpdate: () => ipcRenderer.invoke(DESKTOP_IPC.showDesktopUpdate),
  submitNewTask: (prompt, options, draft) => ipcRenderer.invoke(DESKTOP_IPC.submitNewTask, prompt, options, draft),
  submitToSession: (sessionId, prompt, options) =>
    ipcRenderer.invoke(DESKTOP_IPC.submitToSession, sessionId, prompt, options),
  abortSession: (sessionId, options) => ipcRenderer.invoke(DESKTOP_IPC.abortSession, sessionId, options),
  resolveToolApprovalForSession: (sessionId, id, decision) =>
    ipcRenderer.invoke(DESKTOP_IPC.resolveToolApprovalForSession, sessionId, id, decision),
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
    ipcRenderer.invoke(DESKTOP_IPC.inheritSession, sourceSessionId, selection ?? null, options ?? null),
  listProviderModels: (options) => ipcRenderer.invoke(DESKTOP_IPC.listProviderModels, options),
  setModelRoute: (selection, sessionId) => ipcRenderer.invoke(DESKTOP_IPC.setModelRoute, selection, sessionId),
  setFast: (enabled, sessionId) => ipcRenderer.invoke(DESKTOP_IPC.setFast, enabled, sessionId),
  readSettings: () => ipcRenderer.invoke(DESKTOP_IPC.readSettings),
  updateSetting: (key, enabled) => ipcRenderer.invoke(DESKTOP_IPC.updateSetting, key, enabled),
  setNotificationVolume: (volume) => ipcRenderer.invoke(DESKTOP_IPC.setNotificationVolume, volume),
  previewNotificationSound: () => ipcRenderer.invoke(DESKTOP_IPC.previewNotificationSound),
  subscribeSettingsChanged: (listener) => subscribeIpc(DESKTOP_IPC.settingsChanged, listener),
  readActivityRailPins: () => ipcRenderer.invoke(DESKTOP_IPC.readActivityRailPins),
  updateActivityRailPins: (pins, initializeIfMissing) =>
    ipcRenderer.invoke(DESKTOP_IPC.updateActivityRailPins, pins, initializeIfMissing),
  subscribeActivityRailPins: (listener) => subscribeIpc(DESKTOP_IPC.activityRailPinsChanged, listener),
  notifyProviderModelsChanged: (origin) => {
    void ipcRenderer.invoke(DESKTOP_IPC.notifyProviderModelsChanged, origin).catch(() => {});
  },
  subscribeProviderModelsChanged: (listener) => subscribeIpc(DESKTOP_IPC.providerModelsChanged, listener),
  getZoomFactor: () => ipcRenderer.invoke(DESKTOP_IPC.getZoomFactor),
  setZoomFactor: (factor) => ipcRenderer.invoke(DESKTOP_IPC.setZoomFactor, factor),
  applyTitleBarTheme: (theme, systemPreference) =>
    ipcRenderer.invoke(DESKTOP_IPC.applyTitleBarTheme, theme, systemPreference === true),
  setTitleBarDim: (dim) => ipcRenderer.invoke(DESKTOP_IPC.setTitleBarDim, dim),
  onZoomFactorChanged: (listener) => subscribeIpc(DESKTOP_IPC.zoomFactorChanged, listener),
  onNotificationOpenSession: (listener) => subscribeIpc(DESKTOP_IPC.notificationOpenSession, listener),
  onBrowserOpenRequested: (listener) => subscribeIpc(DESKTOP_IPC.browserOpenRequested, listener),
  onTerminalRunRequested: (listener) => subscribeIpc(DESKTOP_IPC.terminalRunRequested, listener),
  claimTerminalRun: (requestId) => ipcRenderer.invoke(DESKTOP_IPC.terminalRunClaim, requestId),
  onVisualizeChanged: (listener) => subscribeIpc(DESKTOP_IPC.visualizeChanged, listener),
  visualizeState: () => ipcRenderer.invoke(DESKTOP_IPC.visualizeState),
  visualizeCommand: (command) => ipcRenderer.invoke(DESKTOP_IPC.visualizeCommand, command),
  visualizePaneText: (sessionId, tabId, index) =>
    ipcRenderer.invoke(DESKTOP_IPC.visualizePaneText, sessionId, tabId, index),
  visualizeFeedbackAttach: (sessionId, tabId) =>
    ipcRenderer.invoke(DESKTOP_IPC.visualizeFeedbackAttach, sessionId, tabId),
  visualizeCaptureRect: (rect) => ipcRenderer.invoke(DESKTOP_IPC.visualizeCaptureRect, rect),
  visualizeConsumeGesture: (target) => ipcRenderer.invoke(DESKTOP_IPC.visualizeConsumeGesture, target),
  onBrowserSessionReleased: (listener) => subscribeIpc(DESKTOP_IPC.browserSessionReleased, listener),
  browserSetActiveGuest: (sessionId, webContentsId, active) =>
    ipcRenderer.invoke(DESKTOP_IPC.browserSetActiveGuest, sessionId, webContentsId, active),
  browserReleasePage: (pageId) => ipcRenderer.invoke(DESKTOP_IPC.browserReleasePage, pageId),
  ...createBrowserTextureBridge(),
  browserPageControl: (sessionId, input) => ipcRenderer.invoke(DESKTOP_IPC.browserPageControl, sessionId, input),
  browserPageMetadata: (sessionId) => ipcRenderer.invoke(DESKTOP_IPC.browserPageMetadata, sessionId),
  browserPresentNative: (sessionId, rect) => ipcRenderer.invoke(DESKTOP_IPC.browserPresentNative, sessionId, rect),
  browserConfigureGuestViewport: (sessionId, webContentsId, config) =>
    ipcRenderer.invoke(DESKTOP_IPC.browserConfigureGuestViewport, sessionId, webContentsId, config),
  onBrowserGuestViewportChanged: (listener) => subscribeIpc(DESKTOP_IPC.browserGuestViewportChanged, listener),
  onBrowserRemoteViewerChanged: (listener) => subscribeIpc(DESKTOP_IPC.browserRemoteViewerChanged, listener),
  browserProfileImportSources: () => ipcRenderer.invoke(DESKTOP_IPC.browserProfileImportSources),
  browserProfileImportStart: (request) => ipcRenderer.invoke(DESKTOP_IPC.browserProfileImportStart, request),
  onBrowserProfileImportProgress: (listener) => subscribeIpc(DESKTOP_IPC.browserProfileImportProgress, listener),
  browserHistorySearch: (query) => ipcRenderer.invoke(DESKTOP_IPC.browserHistorySearch, query),
  browserCredentialSuggestions: (sessionId) => ipcRenderer.invoke(DESKTOP_IPC.browserCredentialSuggestions, sessionId),
  browserCredentialFill: (sessionId, credentialId) =>
    ipcRenderer.invoke(DESKTOP_IPC.browserCredentialFill, sessionId, credentialId),
  browserPageIdentity: (url, options) =>
    ipcRenderer.invoke(DESKTOP_IPC.browserPageIdentity, url, options?.preview === true),
  onBrowserPageIdentityChanged: (listener) => subscribeIpc(DESKTOP_IPC.browserPageIdentityChanged, listener),
  invokeCapability: (request) => ipcRenderer.invoke(DESKTOP_IPC.invokeCapability, request),
  readCapabilities: (requests) => ipcRenderer.invoke(DESKTOP_IPC.readCapabilities, requests),
  // Byte lane for gallery media: a plain URL the DOM fetches itself (cached
  // by Chromium, range-able for video), never an IPC base64 payload.
  mediaUrl: (assetId, variant) =>
    `mixdog-media://asset/${encodeURIComponent(assetId)}?variant=${encodeURIComponent(variant || 'original')}`,
  quit: () => ipcRenderer.invoke(DESKTOP_IPC.quit),
};

contextBridge.exposeInMainWorld('mixdogDesktop', Object.freeze(api));
