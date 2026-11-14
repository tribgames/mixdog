// The HOST half of the desktop bridge: Electron and OS methods the renderer reaches through the preload
// (window.mixdogDesktopHost). Built from the preload's own deps so it can be exercised without Electron.
import type { IpcRenderer, WebUtils } from 'electron';

import { DESKTOP_IPC, type DesktopCapabilityReadRequest, type DesktopCapabilityRequest } from '../shared/contract';
import type { DesktopHostApi } from '../shared/desktop-api-split';
import { DESKTOP_PET_IPC, desktopPetAppLayout } from '../shared/desktop-pet';
import { type DesktopNotice, readDesktopNotice } from '../shared/desktop-notice';
import type { createBrowserTextureBridge } from './browser-texture';
import { createHeldChannel } from './held-ipc';

export interface HostApiDeps {
  invokeIpc<T>(channel: string, ...args: unknown[]): Promise<T>;
  subscribeIpc<Args extends unknown[]>(channel: string, listener: (...args: Args) => void): () => void;
  ipcRenderer: IpcRenderer;
  webUtils: WebUtils;
  /** The GPU-texture methods stay in the isolated preload: it builds them (browser-texture.ts) and hands them in. */
  browserTexture: ReturnType<typeof createBrowserTextureBridge>;
}

export function createHostApi({ invokeIpc, subscribeIpc, ipcRenderer, webUtils, browserTexture }: HostApiDeps): DesktopHostApi {
  // Listening starts with the preload, not with the renderer's first effect: a
  // click that reveals a window still loading must not be lost to that gap.
  const notificationOpenSessions = createHeldChannel<string>();
  ipcRenderer.on(DESKTOP_IPC.notificationOpenSession, (_event, sessionId: string) =>
    notificationOpenSessions.push(sessionId)
  );
  // Each notice is raised once, so every one sent before the toast region
  // subscribes is held for it, not only the newest.
  const heldNotices: DesktopNotice[] = [];
  const noticeListeners = new Set<(notice: DesktopNotice) => void>();
  ipcRenderer.on(DESKTOP_IPC.desktopNotice, (_event, value: unknown) => {
    const notice = readDesktopNotice(value);
    if (!notice) return;
    if (noticeListeners.size === 0) heldNotices.push(notice);
    else for (const listener of [...noticeListeners]) listener(notice);
  });

  return {
    // This app's own host always takes per-route Auto reasoning.
    routeAutoEffort: true,
    chooseProject: () => invokeIpc(DESKTOP_IPC.chooseProject),
    chooseFile: (defaultPath) => invokeIpc(DESKTOP_IPC.chooseFile, defaultPath),
    chooseConversationImportFile: () => invokeIpc(DESKTOP_IPC.chooseConversationImportFile),
    subscribeConversationImportProgress: (listener) => subscribeIpc(DESKTOP_IPC.conversationImportProgress, listener),
    chooseFiles: (defaultPath) => invokeIpc(DESKTOP_IPC.chooseFiles, defaultPath),
    chooseWorkspace: () => invokeIpc(DESKTOP_IPC.chooseWorkspace),
    saveWorkspace: (workspaceFile, folders) => invokeIpc(DESKTOP_IPC.saveWorkspace, workspaceFile, folders),
    openProjectInExplorer: (projectPath) => invokeIpc(DESKTOP_IPC.openProjectInExplorer, projectPath),
    openMediaAsset: (assetId) => invokeIpc(DESKTOP_IPC.openMediaAsset, assetId),
    openMediaFolder: (assetId) => invokeIpc(DESKTOP_IPC.openMediaFolder, assetId),
    openExternal: (url) => invokeIpc(DESKTOP_IPC.openExternal, url),
    openLocalFileLink: (projectPath, href, confirmedPath) =>
      invokeIpc(DESKTOP_IPC.openLocalFileLink, projectPath, href, confirmedPath),
    localPageUrl: (projectPath, relPath, accessToken) =>
      invokeIpc(DESKTOP_IPC.localPageUrl, projectPath, relPath, accessToken),
    requestLinuxInputAccess: () => invokeIpc(DESKTOP_IPC.requestLinuxInputAccess),
    computerReadiness: () => invokeIpc(DESKTOP_IPC.computerReadiness),
    approvePcAccess: () => invokeIpc(DESKTOP_IPC.approvePcAccess),
    openComputerPermissionSettings: (pane) => invokeIpc(DESKTOP_IPC.openComputerPermissionSettings, pane),
    // File.path was removed in modern Electron; webUtils resolves native drops.
    folderPathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
    resolveLocalPaths: (paths, sessionId, options) => invokeIpc(DESKTOP_IPC.resolveLocalPaths, paths, sessionId, options),
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
    subscribeDesktopNotices: (listener) => {
      noticeListeners.add(listener);
      for (const notice of heldNotices.splice(0)) listener(notice);
      return () => {
        noticeListeners.delete(listener);
      };
    },
    renameRemoteHost: (id, name) => invokeIpc(DESKTOP_IPC.renameRemoteHost, id, name),
    listRemoteHosts: () => invokeIpc(DESKTOP_IPC.listRemoteHosts),
    connectRemoteHostByCode: (code) => invokeIpc(DESKTOP_IPC.connectRemoteHostByCode, code),
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
    subscribeSshServerLoginUpdated: (listener) => subscribeIpc(DESKTOP_IPC.sshServerLoginUpdated, listener),
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
    listServerPorts: () => invokeIpc(DESKTOP_IPC.serverPortsList),
    subscribeHostListsChanged: (listener) => subscribeIpc(DESKTOP_IPC.hostListsChanged, () => listener()),
    subscribeServerPorts: (listener) => subscribeIpc(DESKTOP_IPC.serverPortsChanged, listener),
    forwardServerPort: (remotePort, localPort) => invokeIpc(DESKTOP_IPC.serverPortForward, remotePort, localPort ?? null),
    stopServerPortForward: (remotePort) => invokeIpc(DESKTOP_IPC.serverPortStop, remotePort),
    dismissServerPort: (port) => invokeIpc(DESKTOP_IPC.serverPortDismiss, port),
    openServerPortInBrowser: (remotePort) => invokeIpc(DESKTOP_IPC.serverPortOpen, remotePort),
    subscribeConnectionSignIn: (listener) => subscribeIpc(DESKTOP_IPC.connectionSignIn, listener),
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
    readPaneLayoutFile: () => ipcRenderer.sendSync(DESKTOP_IPC.readPaneLayoutFile),
    writePaneLayoutFile: (layout) => ipcRenderer.send(DESKTOP_IPC.writePaneLayoutFile, layout),
    revealFile: (cwd, path, accessToken) => invokeIpc(DESKTOP_IPC.revealFile, cwd, path, accessToken),
    openFilePath: (cwd, path, accessToken, confirmedPath) =>
      invokeIpc(DESKTOP_IPC.openFilePath, cwd, path, accessToken, confirmedPath),
    openAttachmentImage: (dataUrl, name) => invokeIpc(DESKTOP_IPC.openAttachmentImage, dataUrl, name),
    readAttachmentThumbnail: (attachmentRef) => invokeIpc(DESKTOP_IPC.readAttachmentThumbnail, attachmentRef),
    openAttachmentFile: (dataUrl, name) => invokeIpc(DESKTOP_IPC.openAttachmentFile, dataUrl, name),
    stageAttachmentFile: (dataUrl, name) => invokeIpc(DESKTOP_IPC.stageAttachmentFile, dataUrl, name),
    saveFileAs: (source, suggestedName) => invokeIpc(DESKTOP_IPC.saveFileAs, source, suggestedName),
    getUpdaterState: () => invokeIpc(DESKTOP_IPC.getUpdaterState),
    subscribeUpdaterState: (listener) => subscribeIpc(DESKTOP_IPC.updaterState, listener),
    checkForDesktopUpdate: () => invokeIpc(DESKTOP_IPC.checkForDesktopUpdate),
    showDesktopUpdate: (confirmed) => invokeIpc(DESKTOP_IPC.showDesktopUpdate, confirmed === true),
    provideSecretInput: (requestId, value) => invokeIpc(DESKTOP_IPC.provideSecretInput, requestId, value),
    takeoverReady: (sessionId, id) => invokeIpc(DESKTOP_IPC.takeoverReady, sessionId, id),
    getNotificationPreferences: () => invokeIpc(DESKTOP_IPC.getNotificationPreferences),
    sendTestNotification: (deviceId) => invokeIpc(DESKTOP_IPC.sendTestNotification, deviceId),
    previewNotificationSound: () => invokeIpc(DESKTOP_IPC.previewNotificationSound),
    getZoomFactor: () => invokeIpc(DESKTOP_IPC.getZoomFactor),
    setZoomFactor: (factor) => invokeIpc(DESKTOP_IPC.setZoomFactor, factor),
    applyTitleBarTheme: (theme, systemPreference) =>
      invokeIpc(DESKTOP_IPC.applyTitleBarTheme, theme, systemPreference === true),
    setTitleBarDim: (dim) => invokeIpc(DESKTOP_IPC.setTitleBarDim, dim),
    listSystemFonts: () => invokeIpc(DESKTOP_IPC.listSystemFonts),
    onZoomFactorChanged: (listener) => subscribeIpc(DESKTOP_IPC.zoomFactorChanged, listener),
    onNotificationOpenSession: (listener) => notificationOpenSessions.subscribe(listener),
    onBrowserOpenRequested: (listener) => subscribeIpc(DESKTOP_IPC.browserOpenRequested, listener),
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
    browserPanelShown: (sessionId, shown, pane) => invokeIpc(DESKTOP_IPC.browserPanelShown, sessionId, shown, pane),
    browserReleasePage: (pageId) => invokeIpc(DESKTOP_IPC.browserReleasePage, pageId),
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
    browserCookieAutoImportStatus: () => invokeIpc(DESKTOP_IPC.browserCookieAutoImportStatus),
    browserCookieAutoImportConfigure: (request) => invokeIpc(DESKTOP_IPC.browserCookieAutoImportConfigure, request),
    browserCookieAutoImportForgetKey: () => invokeIpc(DESKTOP_IPC.browserCookieAutoImportForgetKey),
    browserHistorySearch: (query) => invokeIpc(DESKTOP_IPC.browserHistorySearch, query),
    browserCredentialSuggestions: (sessionId) => invokeIpc(DESKTOP_IPC.browserCredentialSuggestions, sessionId),
    browserCredentialFill: (sessionId, credentialId, fillId) =>
      invokeIpc(DESKTOP_IPC.browserCredentialFill, sessionId, credentialId, fillId),
    browserSignedInSites: () => invokeIpc(DESKTOP_IPC.browserSignedInSites),
    browserSignOutSite: (site) => invokeIpc(DESKTOP_IPC.browserSignOutSite, site),
    browserClearSignIns: () => invokeIpc(DESKTOP_IPC.browserClearSignIns),
    browserVaultLogins: () => invokeIpc(DESKTOP_IPC.browserVaultLogins),
    browserVaultSave: (input) => invokeIpc(DESKTOP_IPC.browserVaultSave, input),
    browserVaultDelete: (id) => invokeIpc(DESKTOP_IPC.browserVaultDelete, id),
    browserLinkedSignIns: () => invokeIpc(DESKTOP_IPC.browserLinkedSignIns),
    browserLinkedSignInDelete: (id) => invokeIpc(DESKTOP_IPC.browserLinkedSignInDelete, id),
    browserLoginOpen: (sessionId, id) => invokeIpc(DESKTOP_IPC.browserLoginOpen, sessionId, id),
    browserLoginStatus: (sessionId, id) => invokeIpc(DESKTOP_IPC.browserLoginStatus, sessionId, id),
    browserPageIdentity: (url, options) => invokeIpc(DESKTOP_IPC.browserPageIdentity, url, options?.preview === true),
    onBrowserPageIdentityChanged: (listener) => subscribeIpc(DESKTOP_IPC.browserPageIdentityChanged, listener),
    // Byte lane for gallery media: a plain URL the DOM fetches itself (cached
    // by Chromium, range-able for video), never an IPC base64 payload.
    mediaUrl: (assetId, variant) =>
      `mixdog-media://asset/${encodeURIComponent(assetId)}?variant=${encodeURIComponent(variant || 'original')}`,
    quit: () => invokeIpc(DESKTOP_IPC.quit),
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
    ...browserTexture,
    enableAllowAllActions: () => invokeIpc(DESKTOP_IPC.enableAllowAllActions),
    observeSignIn: (capability, args, value) => {
      void invokeIpc(DESKTOP_IPC.observeSignIn, { capability, args }, value).catch(() => {});
    },
    invokePcQuotaCapability: (request: DesktopCapabilityRequest) => invokeIpc(DESKTOP_IPC.pcQuotaInvoke, request),
    readPcQuotaCapabilities: (requests: DesktopCapabilityReadRequest[]) =>
      invokeIpc(DESKTOP_IPC.pcQuotaRead, requests),
  };
}
