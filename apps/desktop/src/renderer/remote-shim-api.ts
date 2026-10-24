// The DesktopApi surface of a browser: each method forwards over the relay
// socket (or degrades to a browser equivalent).
import type { DesktopApi, DesktopCapabilityRequest, DesktopCapabilityResult } from '../shared/contract';
import type { ProjectRecoveryRequest } from '../shared/project-recovery';
import {
  FILE_DOWNLOAD_REMOTE_METHODS,
  FileDownloadError,
  type FileDownloadApi,
  type FileDownloadChunk,
  type FileDownloadFinished,
  type FileDownloadGrant,
  type FileDownloadTransfer,
} from '../shared/file-downloads';
import { browserProfile, newBrowserId } from './remote-browser-identity';
import { LEGACY_HOST_FALLBACKS, REMOTE_BROWSER_FALLBACKS } from './remote-browser-fallbacks';
import { recoverableCreation } from './recoverable-creation';
import { REMOTE_VISUALIZE_LANE, type VisualizeCommandResult, type VisualizeSessionState } from '../shared/visualize';
import { createRemotePreviewApi, readRemoteVisualizePane, readRemoteVisualizePaneText } from './remote-file-preview';
import { storedGrantSources, withFileGrantRefresh } from './remote-file-grant-refresh';
import { openRemoteExternalLink } from './remote-external-link';
import { mediaLaneSupported, remoteMediaLaneUrl } from './remote-media-lane';
import { VISIBLE_SESSIONS_STORAGE_KEY, MAX_RESTORED_VISIBLE_SESSIONS } from './remote-shim-state';
import type { RemoteShimContext } from './remote-shim-state';

type GatedKey =
  | 'previewProjectFile'
  | 'captureFileSnapshot'
  | 'localPageSource'
  | 'localPageUrl'
  | 'githubCliLoginOpenBrowser'
  | 'ghPrList'
  | 'ghPrDefaultBranch'
  | 'ghPrCreate'
  | 'ghPrView'
  | 'ghPrCheckout'
  | 'ghPrMerge'
  | 'ghPrDiff';

type BrowserGatedKey =
  | 'remoteBrowserTabs'
  | 'remoteBrowserOpenTab'
  | 'remoteBrowserCloseTab'
  | 'onRemoteBrowserTabs'
  | 'browserHistorySearch'
  | 'browserCredentialSuggestions'
  | 'browserCredentialFill'
  | 'browserProfileImportSources'
  | 'browserProfileImportStart'
  | 'onBrowserProfileImportProgress';

/** Adds `listener` to a host-event set; the returned function removes it. */
const listenOn = <T>(listeners: Set<T>, listener: T): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const createRemoteApi = (ctx: RemoteShimContext): DesktopApi => {
  const {
    stateListeners,
    sessionsCatalog,
    agentsCatalog,
    sessionInbox,
    termListeners,
    termSizeOwnerListeners,
    folderChangeListeners,
    lspDiagnosticsListeners,
    lspStatusListeners,
    viewSync,
    viewSyncSessionIds,
    sessionSetKey,
    currentToken,
    connect,
    laneSubscription,
    call: relayCall,
    readCatalog,
    fire,
  } = ctx;
  // A linked file's grant that ended under a held token is granted again once;
  // the records survive a reload in this device's pairing storage.
  const call = ctx.pairingKeys?.fileGrants
    ? withFileGrantRefresh(relayCall, storedGrantSources(localStorage, ctx.pairingKeys.fileGrants))
    : withFileGrantRefresh(relayCall);
  const parity = (): boolean => ctx.peerRemoteParity === true;
  // Per-route Auto reasoning follows its own flag: an older host's selection
  // validator rejects the unknown `autoEffort` key, so it never reaches one.
  const routeAutoEffort = (): boolean => ctx.peerRouteAutoEffort === true;
  const hostSelection = <T>(selection: T): T => {
    if (routeAutoEffort() || !selection || typeof selection !== 'object' || !('autoEffort' in selection)) {
      return selection;
    }
    const { autoEffort: _omitted, ...rest } = selection as T & { autoEffort?: unknown };
    return rest as T;
  };
  // The worker can only answer same-origin requests.
  const laneUrl = (assetId: string, variant?: string): string => {
    const base = ctx.serverBase || location.origin;
    return remoteMediaLaneUrl({
      base,
      token: currentToken() || null,
      sid: ctx.mediaSid,
      supported: base === location.origin && mediaLaneSupported(ctx.peerMediaE2ee),
      assetId,
      variant,
    });
  };
  // Host file downloads: thin RPC stubs (the UI and sinks build on them). A
  // host that did not advertise `fileDownloads` refuses as `host-too-old`
  // instead of answering `unknown method`.
  const downloadCall = <T>(method: string, params: unknown[]): Promise<T> =>
    ctx.peerFileDownloads === true
      ? call<T>(method, params)
      : Promise.reject(new FileDownloadError('host-too-old', 'Update Mixdog on the PC to download its files.'));
  const fileDownloads: FileDownloadApi = {
    available: () => ctx.peerFileDownloads === true,
    authorize: (request) => downloadCall<FileDownloadGrant>(FILE_DOWNLOAD_REMOTE_METHODS.authorize, [request]),
    begin: (grantId) => downloadCall<FileDownloadTransfer>(FILE_DOWNLOAD_REMOTE_METHODS.begin, [grantId]),
    readRange: (transferId, offset, length, version) =>
      downloadCall<FileDownloadChunk>(FILE_DOWNLOAD_REMOTE_METHODS.range, [transferId, offset, length, version]),
    finish: (transferId) => downloadCall<FileDownloadFinished>(FILE_DOWNLOAD_REMOTE_METHODS.finish, [transferId]),
    abort: (id) => downloadCall<boolean>(FILE_DOWNLOAD_REMOTE_METHODS.abort, [id]),
  };
  const api: Omit<DesktopApi, GatedKey> = {
    // Desktop-only OS integrations become inert or degrade to browser
    // equivalents (remote-browser-fallbacks.ts); everything below forwards over
    // the relay socket.
    ...REMOTE_BROWSER_FALLBACKS,
    // A loopback address names the PC: its browser shows it, streamed here.
    openExternal: (url) =>
      openRemoteExternalLink(url, {
        sessionId: () => ctx.lastVisibleSessionIds?.[0],
        ...(ctx.peerBrowserParity === true ? { openHostTab: (target) => call('browserRemoteTabOpen', [target]) } : {}),
        openHere: REMOTE_BROWSER_FALLBACKS.openExternal,
      }),
    submitFeedback: (input) => call('submitFeedback', [input]),
    // Web Push: the desktop mints the key, this browser subscribes with it and
    // sends the endpoint straight back through the encrypted socket, so the
    // relay never learns which device asked to be notified.
    pushPublicKey: () => call<string>('pushPublicKey'),
    registerPushSubscription: async (input) => {
      const profile = await browserProfile();
      return await call<boolean>('registerPushSubscription', [
        {
          ...input,
          clientId: ctx.browserId,
          label: [profile.browser, profile.platform].filter(Boolean).join(' · '),
        },
      ]);
    },
    removePushSubscription: (endpoint) => call<boolean>('removePushSubscription', [endpoint]),
    startProject: (projectPath) => call('startProject', [projectPath]),
    startProjectTask: (projectPath) => call('startProjectTask', [projectPath]),
    startTask: () => call('startTask'),
    listProjects: () => call('listProjects'),
    addProject: (projectPath) => call('addProject', [projectPath]),
    remoteBrowserStream: (sessionId, options) => call('browserRemoteStream', [sessionId, options]),
    remoteBrowserStreamAck: (sessionId, seq) => fire('browserRemoteStreamAck', [sessionId, seq]),
    onRemoteBrowserFrame: (listener) => listenOn(ctx.remoteBrowserFrameListeners, listener),
    onBrowserOpenRequested: (listener) => listenOn(ctx.browserOpenListeners, listener),
    remoteBrowserControl: (sessionId, input) => call('browserRemoteControl', [sessionId, input]),
    renameProject: (projectPath, alias) => call('renameProject', [projectPath, alias]),
    removeProject: (projectPath) => call('removeProject', [projectPath]),
    listProjectDir: (projectPath, relDir) => call('listProjectDir', [projectPath, relDir]),
    readProjectFile: (projectPath, relPath, accessToken) =>
      call('readProjectFile', [projectPath, relPath, accessToken ?? null]),
    statProjectFile: (projectPath, relPath, accessToken) =>
      call('statProjectFile', [projectPath, relPath, accessToken ?? null]),
    // No previewDocumentFile here on purpose: its answer is an Electron
    // protocol URL, which resolves to nothing in a browser. Pages are what a
    // phone can actually display, and they ride the encrypted lane.
    previewDocumentPages: (projectPath, relPath, accessToken, options) =>
      call('previewDocumentPages', [projectPath, relPath, accessToken ?? null, options ?? null]),
    writeProjectFile: (projectPath, relPath, content, expectedContent, accessToken, encoding) =>
      call('writeProjectFile', [projectPath, relPath, content, expectedContent, accessToken ?? null, encoding ?? null]),
    createProjectEntry: (projectPath, relDir, name, dir) =>
      call('createProjectEntry', [projectPath, relDir, name, dir === true]),
    renameProjectEntry: (projectPath, relPath, newName) => call('renameProjectEntry', [projectPath, relPath, newName]),
    moveProjectEntry: (projectPath, relPath, targetDirRel) =>
      call('moveProjectEntry', [projectPath, relPath, targetDirRel]),
    copyProjectEntry: (projectPath, relPath, targetDirRel) =>
      call('copyProjectEntry', [projectPath, relPath, targetDirRel]),
    readEditorSettings: (projectPath, relPath, workspaceFile) =>
      call('readEditorSettings', [projectPath, relPath, workspaceFile ?? null]),
    readEditorBackup: (projectPath, relPath, accessToken) =>
      call('readEditorBackup', [projectPath, relPath, accessToken ?? null]),
    writeEditorBackup: (projectPath, relPath, content, expectedContent, accessToken) =>
      call('writeEditorBackup', [projectPath, relPath, content, expectedContent, accessToken ?? null]),
    deleteEditorBackup: (projectPath, relPath, accessToken) =>
      call('deleteEditorBackup', [projectPath, relPath, accessToken ?? null]),
    codeGraphQuery: (projectPath, mode, query) => call('codeGraphQuery', [projectPath, mode, query]),
    searchWorkspaceText: (projectPath, options) => call('searchWorkspaceText', [projectPath, options]),
    replaceWorkspaceText: (projectPath, options, replacement, relPaths) =>
      call('replaceWorkspaceText', [projectPath, options, replacement, relPaths ?? null]),
    lspDocument: (input) => call('lspDocument', [input]),
    lspRequest: (input) => call('lspRequest', [input]),
    lspApplyWorkspaceEdit: (projectPath, writes) => call('lspApplyWorkspaceEdit', [projectPath, writes]),
    subscribeLspDiagnostics: (listener) => laneSubscription('editor', lspDiagnosticsListeners, listener),
    subscribeLspStatus: (listener) => laneSubscription('editor', lspStatusListeners, listener),
    saveWorkspace: (workspaceFile, folders) => call('saveWorkspace', [workspaceFile ?? null, folders]),
    folderWatch: (dir, recursive) => call('folderWatch', [dir, recursive === true]),
    folderUnwatch: (dir, recursive) => call('folderUnwatch', [dir, recursive === true]),
    subscribeFolderChanges: (listener) => laneSubscription('files', folderChangeListeners, listener),
    // Previews ride the encrypted RPC lane as ranged reads (the HTTP media
    // lane is disabled): blob: URLs for media, a srcdoc document for pages.
    resolveLocalPaths: (paths, sessionId) => call('resolveLocalPaths', sessionId ? [paths, sessionId] : [paths]),
    readLocalFile: (path) => call('readLocalFile', [path]),
    fileDownloads,
    openSessionAttachment: (sessionId, attachmentId) => call('attachmentOpen', [sessionId, attachmentId]),
    readAttachmentThumbnail: (attachmentRef) => call<string | null>('readAttachmentThumbnail', [attachmentRef]),
    listSessions: () => readCatalog(sessionsCatalog, 'listSessions'),
    markSessionRead: (sessionId, messageCount, consumedUnread) =>
      call<boolean>('markSessionRead', [sessionId, messageCount, consumedUnread]),
    subscribeSessions: (listener) => sessionsCatalog.subscribe(listener),
    listAgentPool: () => readCatalog(agentsCatalog, 'listAgentPool'),
    searchSessionContent: (query) => call('searchSessionContent', [query]),
    subscribeAgentPool: (listener) => agentsCatalog.subscribe(listener),
    renameSession: (sessionId, title) => call('renameSession', [sessionId, title]),
    continueSessionInModel: (sessionId, route) => call('continueSessionInModel', [sessionId, hostSelection(route)]),
    scheduleQuotaResume: (sessionId) => call('scheduleQuotaResume', [sessionId]),
    cancelQuotaResume: (sessionId) => call('cancelQuotaResume', [sessionId]),
    stopShellJob: (sessionId, taskId) => call('stopShellJob', [sessionId, taskId]),
    releaseShellJob: (sessionId, taskId) => call('releaseShellJob', [sessionId, taskId]),
    getQuotaAutoResume: () => call('getQuotaAutoResume', []),
    viewerDevice: () => call('viewerDevice', []),
    readTranscriptItem: (sessionId, itemId) => call('readTranscriptItem', [sessionId, itemId]),
    setQuotaAutoResume: (enabled) => call('setQuotaAutoResume', [enabled]),
    setSessionArchived: (sessionId: string, archived: boolean) => call('setSessionArchived', [sessionId, archived]),
    openAgentHome: (agentId: string) => call('openAgentHome', [agentId]),
    resetAgentHome: (agentId: string) => call('resetAgentHome', [agentId]),
    agentRoomAction: (action: string, args: unknown[]) => call('agentRoomAction', [action, args]),
    setSessionFavorite: (sessionId: string, favorite: boolean) => call('setSessionFavorite', [sessionId, favorite]),
    setSessionProject: (sessionId: string, projectPath: string) => call('setSessionProject', [sessionId, projectPath]),
    deleteSession: (sessionId) => call('deleteSession', [sessionId]),
    // Cold session lanes fill through a host-side read; the replay frame
    // arrives on the broadcast sessionState event like any live push.
    prefetchSession: (sessionId, transcriptItemLimit, readTraceId) =>
      call<boolean>('prefetchSession', [sessionId, transcriptItemLimit, ...(readTraceId ? [readTraceId] : [])]),
    setVisibleSessions: (sessionIds) => {
      const requested = [...sessionIds];
      ctx.lastVisibleSessionIds = requested;
      try {
        localStorage.setItem(
          VISIBLE_SESSIONS_STORAGE_KEY,
          JSON.stringify(ctx.lastVisibleSessionIds.slice(0, MAX_RESTORED_VISIBLE_SESSIONS))
        );
      } catch {
        /* the next launch simply waits for React, as before */
      }
      return connect().then(async () => {
        if (!ctx.peerViewSync) {
          // Legacy encrypted peers have no registration version. Keep their
          // old ordering guarantee here, not in every desktop pane.
          const run = ctx.legacyVisibleSessionsQueue
            .catch(() => undefined)
            .then(() =>
              ctx.lastVisibleSessionIds === requested ? call<boolean>('setVisibleSessions', [requested]) : true
            );
          ctx.legacyVisibleSessionsQueue = run;
          return run;
        }
        // Already named by the latest sync: wait for it instead of
        // downloading every catalog and transcript baseline again.
        if (sessionSetKey(viewSyncSessionIds()) === ctx.requestedViewSyncKey) await viewSync.ready();
        else await viewSync.request();
        return true;
      });
    },
    searchProjectFiles: (projectIdOrWorkspaceId, query, limit, includeIgnored, includeDirectories) =>
      call('searchProjectFiles', [
        projectIdOrWorkspaceId,
        query,
        limit,
        includeIgnored === true,
        includeDirectories === true,
      ]),
    getSnapshot: () => call('getSnapshot'),
    subscribeState: (listener) => listenOn(stateListeners, listener),
    termEnsure: (id, cwd, shell) => call('termEnsure', [id, cwd ?? null, shell ?? null]),
    termProfiles: () => call('termProfiles'),
    termWrite: (id, data) => fire('termWrite', [id, data]),
    termResize: (id, cols, rows, phoneOwner) => fire('termResize', [id, cols, rows, phoneOwner === true]),
    termDispose: (id) => call('termDispose', [id]),
    subscribeTermData: (listener) => laneSubscription('terminal', termListeners, listener),
    // Rides the terminal lane the output subscription already registers.
    subscribeTermSizeOwner: (listener) => listenOn(termSizeOwnerListeners, listener),
    // A host that predates terminal activity answers "unknown method": the
    // tabs then show no dots, which is what unknown means.
    termActivity: () => call('termActivity'),
    termFocus: (id, focused) => {
      void call('termFocus', [id, focused === true]).catch(() => {});
    },
    subscribeTermActivity: (listener) => laneSubscription('terminal', ctx.termActivityListeners, listener),
    gitStatus: (cwd, options) => call('gitStatus', [cwd, options]),
    gitBranches: (cwd) => call('gitBranches', [cwd]),
    gitRenameBranch: (cwd, branch, nextBranch) => call('gitRenameBranch', [cwd, branch, nextBranch]),
    gitDeleteBranch: (cwd, branch) => call('gitDeleteBranch', [cwd, branch]),
    gitDiff: (cwd, path, staged, worktreeOnly, untracked) =>
      call('gitDiff', [cwd, path, staged === true, worktreeOnly === true, untracked === true]),
    gitApplyPatch: (cwd, path, patch, reverse) => call('gitApplyPatch', [cwd, path, patch, reverse === true]),
    gitStage: (cwd, paths) => call('gitStage', [cwd, paths]),
    gitUnstage: (cwd, paths) => call('gitUnstage', [cwd, paths]),
    gitIgnore: (cwd, path, scope) => call('gitIgnore', [cwd, path, scope]),
    gitCommit: (cwd, message) => call('gitCommit', [cwd, message]),
    gitCommitPaths: (cwd, message, paths) => call('gitCommitPaths', [cwd, message, paths]),
    gitAmend: (cwd, message) => call('gitAmend', [cwd, message]),
    gitUndoLastCommit: (cwd) => call('gitUndoLastCommit', [cwd]),
    gitStash: (cwd, message) => call('gitStash', [cwd, message]),
    gitStashPop: (cwd) => call('gitStashPop', [cwd]),
    gitPush: (cwd) => call('gitPush', [cwd]),
    gitFetch: (cwd) => call('gitFetch', [cwd]),
    gitPull: (cwd) => call('gitPull', [cwd]),
    gitSync: (cwd) => call('gitSync', [cwd]),
    gitContinue: (cwd) => call('gitContinue', [cwd]),
    gitAbortOperation: (cwd) => call('gitAbortOperation', [cwd]),
    gitRevert: (cwd, path, untracked, mode) => call('gitRevert', [cwd, path, untracked === true, mode]),
    gitLog: (cwd, query, skip, limit) => call('gitLog', [cwd, query, skip, limit]),
    gitShow: (cwd, hash) => call('gitShow', [cwd, hash]),
    gitShowDiff: (cwd, hash, path) => call('gitShowDiff', [cwd, hash, path]),
    gitRequestContext: (cwd, input) => call('gitRequestContext', [cwd, input]),
    // The confirmation flag is part of the call: dropping it made every
    // confirmed dirty `--mixed` reset ask again on the main side.
    gitResetToCommit: (cwd, hash, mode, confirmedDirty) =>
      call('gitResetToCommit', [cwd, hash, mode, confirmedDirty === true]),
    gitRevertCommit: (cwd, hash) => call('gitRevertCommit', [cwd, hash]),
    gitCherryPickCommit: (cwd, hash) => call('gitCherryPickCommit', [cwd, hash]),
    gitCreateTag: (cwd, tag, hash) => call('gitCreateTag', [cwd, tag, hash]),
    gitDeleteTag: (cwd, tag) => call('gitDeleteTag', [cwd, tag]),
    gitReview: (cwd, source) => call('gitReview', [cwd, source]),
    gitReviewDiff: (cwd, path, untracked, source) => call('gitReviewDiff', [cwd, path, untracked === true, source]),
    gitReviewDiffs: (cwd, files, source) => call('gitReviewDiffs', [cwd, files, source]),
    gitStashList: (cwd) => call('gitStashList', [cwd]),
    gitStashApply: (cwd, ref) => call('gitStashApply', [cwd, ref]),
    gitStashDrop: (cwd, ref) => call('gitStashDrop', [cwd, ref]),
    gitShowFile: (cwd, rev, path) => call('gitShowFile', [cwd, rev, path]),
    gitGlobalConfig: () => call('gitGlobalConfig'),
    setGitGlobalConfig: (key, value) => call('setGitGlobalConfig', [key, value]),
    // gh runs on the desktop machine and its login is a DEVICE flow, so the
    // phone shows the same code and finishes it in its own browser.
    githubStarStatus: () => call('githubStarStatus'),
    starGithub: () => call('starGithub'),
    gitCliStatus: () => call('gitCliStatus'),
    installGitCli: () => call('installGitCli'),
    libreOfficeStatus: (refresh) => call('libreOfficeStatus', [refresh === true]),
    installLibreOffice: () => call('installLibreOffice'),
    githubCliStatus: () => call('githubCliStatus'),
    githubRequest: (cwd, input) => call('githubRequest', [cwd, input]),
    installGithubCli: () => call('installGithubCli'),
    githubCliLoginStart: () => call('githubCliLoginStart'),
    githubCliLoginStatus: (flowId) => call('githubCliLoginStatus', [flowId]),
    githubCliLoginCancel: (flowId) => call('githubCliLoginCancel', [flowId]),
    githubCliLogout: () => call('githubCliLogout'),
    githubCliAccount: () => call('githubCliAccount'),
    // The host machine's updater: these act on the computer running Mixdog.
    // A host without remoteParity answers none of them: keep the old inert
    // behavior for it.
    getUpdaterState: () => (parity() ? call('getUpdaterState') : LEGACY_HOST_FALLBACKS.getUpdaterState()),
    checkForDesktopUpdate: () =>
      parity() ? call('checkForDesktopUpdate') : LEGACY_HOST_FALLBACKS.checkForDesktopUpdate(),
    showDesktopUpdate: () => (parity() ? call('showDesktopUpdate') : LEGACY_HOST_FALLBACKS.showDesktopUpdate()),
    // Always registered: a page can mount before the handshake says whether the
    // host has remoteParity, and reconnects never re-subscribe. An older host
    // simply never emits the event.
    subscribeUpdaterState: (listener) => listenOn(ctx.updaterListeners, listener),
    // Marks only: the PC's last list at once, then each change. Nothing here
    // can see or answer the approval itself.
    onBrowserApprovalSessions: (listener) => {
      listener(ctx.browserApprovalSessionIds);
      return listenOn(ctx.browserApprovalSessionListeners, listener);
    },
    trashProjectEntry: (projectPath, relPath) =>
      parity() ? call('trashProjectEntry', [projectPath, relPath]) : LEGACY_HOST_FALLBACKS.trashProjectEntry(),
    browserReleasePage: (pageId) =>
      parity() ? call('browserReleasePage', [pageId]) : LEGACY_HOST_FALLBACKS.browserReleasePage(),
    submitNewTask: (prompt, options, draft) => {
      const stable = { ...options, id: options?.id || newBrowserId() };
      return recoverableCreation(
        () =>
          call('submitNewTask', [
            prompt,
            stable,
            draft?.route ? { ...draft, route: hostSelection(draft.route) } : (draft ?? {}),
          ]),
        async () => {
          if (document.visibilityState === 'hidden') {
            await new Promise<void>((resolve) => {
              const visible = () => {
                if (document.visibilityState === 'hidden') return;
                document.removeEventListener('visibilitychange', visible);
                resolve();
              };
              document.addEventListener('visibilitychange', visible);
            });
          }
          await connect();
          if (ctx.peerViewSync) await viewSync.request();
        }
      );
    },
    submitToSession: (sessionId, prompt, options) => {
      // An older host does not dedupe, so a retry could double-submit: send once.
      if (!parity()) return call('submitToSession', [sessionId, prompt, options]);
      // Stable id: the host dedupes by it, so replaying after a lost reply
      // cannot double-submit and the optimistic row keeps reconciling.
      const stable = { ...options, id: options?.id || newBrowserId() };
      return recoverableCreation(
        () => call('submitToSession', [sessionId, prompt, stable]),
        async () => {
          await connect();
          if (ctx.peerViewSync) await viewSync.request();
        }
      );
    },
    abortSession: (sessionId, options = {}) => call('abortSession', [sessionId, options]),
    resolveToolApprovalForSession: (sessionId, id, decision) =>
      call('resolveToolApprovalForSession', [sessionId, id, decision]),
    getAgentNotificationMute: (agentId) => call('getAgentNotificationMute', [agentId]),
    setAgentNotificationMute: (agentId, muted) => call('setAgentNotificationMute', [agentId, muted]),
    subscribeSessionState: (listener) => sessionInbox.subscribe(listener),
    inheritSession: (sourceSessionId, selection, options) =>
      call('inheritSession', [sourceSessionId, hostSelection(selection ?? null), options ?? null]),
    listProviderModels: (options) => call('listProviderModels', [options]),
    setModelRoute: (selection, sessionId) => call('setModelRoute', [hostSelection(selection), sessionId]),
    setFast: (enabled, sessionId) => call('setFast', [enabled, sessionId]),
    readSettings: () => call('readSettings'),
    updateSetting: (key, enabled) => call('updateSetting', [key, enabled]),
    readActivityRailPins: () => call('readActivityRailPins'),
    updateActivityRailPins: (pins) => call('updateActivityRailPins', [pins]),
    subscribeActivityRailPins: (listener) => listenOn(ctx.activityRailPinsListeners, listener),
    notifyProviderModelsChanged: (origin) => fire('notifyProviderModelsChanged', [origin]),
    subscribeProviderModelsChanged: (listener) => listenOn(ctx.providerModelsListeners, listener),
    invokeCapability: <T = unknown>(request: DesktopCapabilityRequest) =>
      call<DesktopCapabilityResult<T>>('invokeCapability', [request]),
    readCapabilities: (requests) => call('readCapabilities', [requests]),
    // Always present: settings pages subscribe once at mount, possibly before
    // the handshake. An older host simply never emits the event.
    subscribeSettingsChanged: (listener) => listenOn(ctx.settingsChangedListeners, listener),
    // An older host answers `unknown method`; the caller keeps its own defaults.
    readHostDisplayPreferences: () => call('readHostDisplayPreferences'),
    // Agent visualize panel. Always present (the store connects at mount,
    // possibly before the handshake); an older host is read as having no tabs
    // and never emits the lane's event.
    onVisualizeChanged: (listener) => laneSubscription(REMOTE_VISUALIZE_LANE, ctx.visualizeListeners, listener),
    visualizeState: async () => {
      await connect();
      return ctx.peerVisualize ? call<VisualizeSessionState[]>('visualizeState') : [];
    },
    visualizeCommand: async (command) => {
      await connect();
      if (!ctx.peerVisualize) return undefined;
      return (await call<VisualizeCommandResult | null>('visualizeCommand', [command])) ?? undefined;
    },
    visualizePaneText: async (sessionId, tabId, index) => {
      await connect();
      if (!ctx.peerVisualize) throw new Error('This desktop does not serve the visualize panel to remote devices.');
      return readRemoteVisualizePaneText(call, sessionId, tabId, index);
    },
    visualizePaneSource: async (sessionId, tabId, index) => {
      await connect();
      if (!ctx.peerVisualize) throw new Error('This desktop does not serve the visualize panel to remote devices.');
      // Media panes stream on the encrypted media lane when it answers.
      return readRemoteVisualizePane(call, sessionId, tabId, index, laneUrl, ctx.visualizePages);
    },
    visualizePanePages: async (sessionId, tabId, index, options) => {
      await connect();
      if (!ctx.peerVisualize) throw new Error('This desktop does not serve the visualize panel to remote devices.');
      return call('visualizePanePages', [sessionId, tabId, index, options]);
    },
    visualizeExport: async (sessionId, tabId, format, pane) => {
      await connect();
      // The export arrives as a download: a host without the lane cannot hand it over.
      if (!ctx.peerVisualize || !ctx.peerFileDownloads)
        throw new FileDownloadError('host-too-old', 'Update Mixdog on the PC to download its files.');
      return call('visualizeExport', [sessionId, tabId, format, pane]);
    },
    // Gallery bytes ride HTTP, not this socket: the browser caches tiles and
    // asks for byte ranges when a clip seeks. A host that does not serve the
    // lane answers 404 and the caller falls back to the RPC payload.
    // '' (no byte lane) unless the host serves the encrypted lane and the
    // service worker that decrypts it controls this page.
    mediaUrl: (assetId, variant) => laneUrl(assetId, variant),
  };
  // Presence-checked members: read as absent unless the CURRENT host
  // advertised remoteParity. Evaluated per read, because this object exists
  // before any handshake and a reconnect may land on a different host.
  const gated: Pick<DesktopApi, GatedKey> = {
    // Image/audio/video previews stream over the encrypted media lane when
    // the host offers it; otherwise they ride the RPC lane as ranged reads
    // into blob: URLs. Local pages become a srcdoc document.
    ...createRemotePreviewApi(call, laneUrl),
    // The PC's loopback address of a local page, for the PC's own browser pane
    // (a host that predates the method answers `unknown method`).
    localPageUrl: (projectPath, relPath, accessToken) =>
      call<string>('localPageUrl', [projectPath, relPath, accessToken ?? null]),
    githubCliLoginOpenBrowser: (flowId, options) => call('githubCliLoginOpenBrowser', [flowId, options]),
    ghPrList: (cwd) => call('ghPrList', [cwd]),
    ghPrDefaultBranch: (cwd) => call('ghPrDefaultBranch', [cwd]),
    ghPrCreate: (cwd, input) => call('ghPrCreate', [cwd, input]),
    ghPrView: (cwd, number) => call('ghPrView', [cwd, number]),
    ghPrCheckout: (cwd, number) => call('ghPrCheckout', [cwd, number]),
    ghPrMerge: (cwd, number, method) => call('ghPrMerge', [cwd, number, method]),
    ghPrDiff: (cwd, number) => call('ghPrDiff', [cwd, number]),
  };
  for (const key of Object.keys(gated) as GatedKey[]) {
    Object.defineProperty(api, key, {
      enumerable: true,
      get: () => (parity() ? gated[key] : undefined),
    });
  }
  Object.defineProperty(api, 'routeAutoEffort', { enumerable: true, get: routeAutoEffort });
  Object.defineProperty(api, 'projectRecovery', {
    enumerable: true,
    get: () =>
      ctx.peerProjectRecovery === true
        ? (project: string, request: ProjectRecoveryRequest) => call('projectRecovery', [project, request])
        : undefined,
  });
  // Read per access like the members below: a reconnect may reach a host that
  // predates `browserDrive`, and the pane must then never send `viewport`.
  Object.defineProperty(api, 'remoteBrowserDrive', { enumerable: true, get: () => ctx.peerBrowserDrive === true });
  // Read per access: a reconnect may reach a host without conversation tab controls.
  Object.defineProperty(api, 'remoteBrowserSessionTabs', {
    enumerable: true,
    get: () => ctx.peerBrowserSessionTabs === true,
  });
  // Read per access: a reconnect may reach a host that predates `termSizeOwner`.
  Object.defineProperty(api, 'remoteTermSizeOwner', { enumerable: true, get: () => ctx.peerTermSizeOwner === true });
  // Absent on a host that predates `hostDirectories`, so the folder browser
  // keeps its legacy fallback.
  Object.defineProperty(api, 'listHostDirectories', {
    enumerable: true,
    get: () => (ctx.peerHostDirectories === true ? (path: string) => call('listHostDirectories', [path]) : undefined),
  });
  // The remote browser pane's extras follow their own flag: a host that
  // predates `browserParity` leaves them absent and the pane keeps one stream.
  const browserGated: Pick<DesktopApi, BrowserGatedKey> = {
    remoteBrowserTabs: (watch) => call('browserRemoteTabs', [watch]),
    remoteBrowserOpenTab: (url) => call('browserRemoteTabOpen', [url]),
    remoteBrowserCloseTab: (id) => call('browserRemoteTabClose', [id]),
    onRemoteBrowserTabs: (listener) => listenOn(ctx.remoteBrowserTabListeners, listener),
    browserHistorySearch: (query) => call('browserHistorySearch', [query]),
    browserCredentialSuggestions: (sessionId) => call('browserCredentialSuggestions', [sessionId]),
    browserCredentialFill: (sessionId, credentialId) => call('browserCredentialFill', [sessionId, credentialId]),
    browserProfileImportSources: () => call('browserProfileImportSources'),
    browserProfileImportStart: (request) => call('browserProfileImportStart', [request]),
    onBrowserProfileImportProgress: (listener) => listenOn(ctx.browserImportProgressListeners, listener),
  };
  for (const key of Object.keys(browserGated) as BrowserGatedKey[]) {
    Object.defineProperty(api, key, {
      enumerable: true,
      get: () => (ctx.peerBrowserParity === true ? browserGated[key] : undefined),
    });
  }
  return api as DesktopApi;
};
