// The DesktopApi surface of a browser: each method forwards over the relay
// socket (or degrades to a browser equivalent).
import type { DesktopApi, DesktopCapabilityRequest, DesktopCapabilityResult } from '../shared/contract';
import { browserProfile, newBrowserId } from './remote-browser-identity';
import { LEGACY_HOST_FALLBACKS, REMOTE_BROWSER_FALLBACKS } from './remote-browser-fallbacks';
import { recoverableCreation } from './recoverable-creation';
import { createRemotePreviewApi } from './remote-file-preview';
import { mediaLaneSupported, remoteMediaLaneUrl } from './remote-media-lane';
import { VISIBLE_SESSIONS_STORAGE_KEY, MAX_RESTORED_VISIBLE_SESSIONS } from './remote-shim-state';
import type { RemoteShimContext } from './remote-shim-state';

type GatedKey =
  | 'previewProjectFile'
  | 'localPageSource'
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

export const createRemoteApi =(ctx: RemoteShimContext): DesktopApi => {
  const {
    stateListeners,
    sessionsCatalog,
    agentsCatalog,
    sessionInbox,
    termListeners,
    folderChangeListeners,
    lspDiagnosticsListeners,
    lspStatusListeners,
    viewSync,
    viewSyncSessionIds,
    sessionSetKey,
    currentToken,
    connect,
    laneSubscription,
    call,
    readCatalog,
    fire,
  } = ctx;
  const parity = (): boolean => ctx.peerRemoteParity === true;
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
  const api: Omit<DesktopApi, GatedKey> = {
    // Desktop-only OS integrations become inert or degrade to browser
    // equivalents (remote-browser-fallbacks.ts); everything below forwards over
    // the relay socket.
    ...REMOTE_BROWSER_FALLBACKS,
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
    onRemoteBrowserFrame: (listener) => {
      ctx.remoteBrowserFrameListeners.add(listener);
      return () => {
        ctx.remoteBrowserFrameListeners.delete(listener);
      };
    },
    onBrowserOpenRequested: (listener) => {
      ctx.browserOpenListeners.add(listener);
      return () => {
        ctx.browserOpenListeners.delete(listener);
      };
    },
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
    resolveLocalPaths: (paths) => call('resolveLocalPaths', [paths]),
    readLocalFile: (path) => call('readLocalFile', [path]),
    listSessions: () => readCatalog(sessionsCatalog, 'listSessions'),
    markSessionRead: (sessionId, messageCount, consumedUnread) =>
      call<boolean>('markSessionRead', [sessionId, messageCount, consumedUnread]),
    subscribeSessions: (listener) => sessionsCatalog.subscribe(listener),
    listAgentPool: () => readCatalog(agentsCatalog, 'listAgentPool'),
    searchSessionContent: (query) => call('searchSessionContent', [query]),
    subscribeAgentPool: (listener) => agentsCatalog.subscribe(listener),
    renameSession: (sessionId, title) => call('renameSession', [sessionId, title]),
    setSessionArchived: (sessionId: string, archived: boolean) => call('setSessionArchived', [sessionId, archived]),
    setSessionFavorite: (sessionId: string, favorite: boolean) => call('setSessionFavorite', [sessionId, favorite]),
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
    searchProjectFiles: (projectIdOrWorkspaceId, query, limit, includeIgnored) =>
      call('searchProjectFiles', [projectIdOrWorkspaceId, query, limit, includeIgnored === true]),
    getSnapshot: () => call('getSnapshot'),
    subscribeState: (listener) => {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    termEnsure: (id, cwd, shell) => call('termEnsure', [id, cwd ?? null, shell ?? null]),
    termProfiles: () => call('termProfiles'),
    termWrite: (id, data) => fire('termWrite', [id, data]),
    termResize: (id, cols, rows) => fire('termResize', [id, cols, rows]),
    termDispose: (id) => call('termDispose', [id]),
    subscribeTermData: (listener) => laneSubscription('terminal', termListeners, listener),
    gitStatus: (cwd, options) => call('gitStatus', [cwd, options]),
    gitBranches: (cwd) => call('gitBranches', [cwd]),
    gitCheckoutBranch: (cwd, branch, remote) => call('gitCheckoutBranch', [cwd, branch, remote === true]),
    gitCreateBranch: (cwd, branch) => call('gitCreateBranch', [cwd, branch]),
    gitRenameBranch: (cwd, branch, nextBranch) => call('gitRenameBranch', [cwd, branch, nextBranch]),
    gitDeleteBranch: (cwd, branch) => call('gitDeleteBranch', [cwd, branch]),
    gitMergeBranch: (cwd, branch) => call('gitMergeBranch', [cwd, branch]),
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
    // The confirmation flag is part of the call: dropping it made every
    // confirmed dirty `--mixed` reset ask again on the main side.
    gitResetToCommit: (cwd, hash, mode, confirmedDirty) =>
      call('gitResetToCommit', [cwd, hash, mode, confirmedDirty === true]),
    gitRevertCommit: (cwd, hash) => call('gitRevertCommit', [cwd, hash]),
    gitCherryPickCommit: (cwd, hash) => call('gitCherryPickCommit', [cwd, hash]),
    gitCreateTag: (cwd, tag, hash) => call('gitCreateTag', [cwd, tag, hash]),
    gitDeleteTag: (cwd, tag) => call('gitDeleteTag', [cwd, tag]),
    gitCheckoutCommit: (cwd, hash) => call('gitCheckoutCommit', [cwd, hash]),
    gitCreateBranchAtCommit: (cwd, branch, hash) => call('gitCreateBranchAtCommit', [cwd, branch, hash]),
    gitReview: (cwd) => call('gitReview', [cwd]),
    gitReviewDiff: (cwd, path, untracked) => call('gitReviewDiff', [cwd, path, untracked === true]),
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
    libreOfficeStatus: () => call('libreOfficeStatus'),
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
    subscribeUpdaterState: (listener) => {
      if (!parity()) return LEGACY_HOST_FALLBACKS.subscribeUpdaterState(listener);
      ctx.updaterListeners.add(listener);
      return () => {
        ctx.updaterListeners.delete(listener);
      };
    },
    trashProjectEntry: (projectPath, relPath) =>
      parity() ? call('trashProjectEntry', [projectPath, relPath]) : LEGACY_HOST_FALLBACKS.trashProjectEntry(),
    browserReleasePage: (pageId) =>
      parity() ? call('browserReleasePage', [pageId]) : LEGACY_HOST_FALLBACKS.browserReleasePage(),
    submitNewTask: (prompt, options, draft) => {
      const stable = { ...options, id: options?.id || newBrowserId() };
      return recoverableCreation(
        () => call('submitNewTask', [prompt, stable, draft ?? {}]),
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
    subscribeSessionState: (listener) => sessionInbox.subscribe(listener),
    inheritSession: (sourceSessionId, selection, options) =>
      call('inheritSession', [sourceSessionId, selection ?? null, options ?? null]),
    listProviderModels: (options) => call('listProviderModels', [options]),
    setModelRoute: (selection, sessionId) => call('setModelRoute', [selection, sessionId]),
    setFast: (enabled, sessionId) => call('setFast', [enabled, sessionId]),
    readSettings: () => call('readSettings'),
    updateSetting: (key, enabled) => call('updateSetting', [key, enabled]),
    readActivityRailPins: () => call('readActivityRailPins'),
    updateActivityRailPins: (pins) => call('updateActivityRailPins', [pins]),
    subscribeActivityRailPins: (listener) => {
      ctx.activityRailPinsListeners.add(listener);
      return () => {
        ctx.activityRailPinsListeners.delete(listener);
      };
    },
    notifyProviderModelsChanged: (origin) => fire('notifyProviderModelsChanged', [origin]),
    subscribeProviderModelsChanged: (listener) => {
      ctx.providerModelsListeners.add(listener);
      return () => {
        ctx.providerModelsListeners.delete(listener);
      };
    },
    invokeCapability: <T = unknown>(request: DesktopCapabilityRequest) =>
      call<DesktopCapabilityResult<T>>('invokeCapability', [request]),
    readCapabilities: (requests) => call('readCapabilities', [requests]),
    // Gallery bytes ride HTTP, not this socket: the browser caches tiles and
    // asks for byte ranges when a clip seeks. A host that does not serve the
    // lane answers 404 and the caller falls back to the RPC payload.
    // Always present: settings pages subscribe once at mount, possibly before
    // the handshake. An older host simply never emits the event.
    subscribeSettingsChanged: (listener) => {
      ctx.settingsChangedListeners.add(listener);
      return () => {
        ctx.settingsChangedListeners.delete(listener);
      };
    },
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
    githubCliLoginOpenBrowser: (flowId) => call('githubCliLoginOpenBrowser', [flowId]),
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
  // The remote browser pane's extras follow their own flag: a host that
  // predates `browserParity` leaves them absent and the pane keeps one stream.
  const browserGated: Pick<DesktopApi, BrowserGatedKey> = {
    remoteBrowserTabs: (watch) => call('browserRemoteTabs', [watch]),
    remoteBrowserOpenTab: (url) => call('browserRemoteTabOpen', [url]),
    remoteBrowserCloseTab: (id) => call('browserRemoteTabClose', [id]),
    onRemoteBrowserTabs: (listener) => {
      ctx.remoteBrowserTabListeners.add(listener);
      return () => {
        ctx.remoteBrowserTabListeners.delete(listener);
      };
    },
    browserHistorySearch: (query) => call('browserHistorySearch', [query]),
    browserCredentialSuggestions: (sessionId) => call('browserCredentialSuggestions', [sessionId]),
    browserCredentialFill: (sessionId, credentialId) => call('browserCredentialFill', [sessionId, credentialId]),
    browserProfileImportSources: () => call('browserProfileImportSources'),
    browserProfileImportStart: (request) => call('browserProfileImportStart', [request]),
    onBrowserProfileImportProgress: (listener) => {
      ctx.browserImportProgressListeners.add(listener);
      return () => {
        ctx.browserImportProgressListeners.delete(listener);
      };
    },
  };
  for (const key of Object.keys(browserGated) as BrowserGatedKey[]) {
    Object.defineProperty(api, key, {
      enumerable: true,
      get: () => (ctx.peerBrowserParity === true ? browserGated[key] : undefined),
    });
  }
  return api as DesktopApi;
};
