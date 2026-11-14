// Which half of DesktopApi each member lives on once the renderer talks to the core directly.
//
// DIRECT_KEYS are composed in the renderer over its own core connection. HOST_KEYS stay on the
// preload (Electron and OS methods, plus members another area moves later). OPTIONAL_UNPROVIDED
// are the members of DesktopApi the Electron preload does not supply (remote-surface members and
// the two boot values that are injected beside the table).
//
// Completeness is a type error: DESKTOP_API_COMPLETE fails to compile when a DesktopApi member is
// in no group, or a listed key is not a DesktopApi member. A key in two groups is caught by the
// test, not by the type system.

import type {
  DesktopApi,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopCapabilityRequest,
  DesktopCapabilityResult,
} from './contract';
import type { DesktopTerminalRunRequest } from './terminal-command';

export const DIRECT_KEYS = {
  sessions: [
    'renameSession', 'continueSessionInModel', 'scheduleQuotaResume', 'cancelQuotaResume', 'stopShellJob',
    'releaseShellJob', 'viewerDevice', 'getTaskWorkspace', 'setSessionArchived', 'openAgentHome',
    'resetAgentHome', 'listAgentMemory', 'deleteAgentMemory', 'agentRoomAction', 'setSessionFavorite',
    'setSessionProject', 'listProviderModels', 'setModelRoute', 'setFast', 'subscribeRelayPayloadRefused',
    'listSessions', 'markSessionRead', 'subscribeSessions', 'listAgentPool', 'searchSessionContent',
    'subscribeAgentPool', 'getQuotaAutoResume', 'setQuotaAutoResume', 'deleteSession', 'prefetchSession',
    'readTranscriptHistory', 'setVisibleSessions', 'getSnapshot', 'subscribeState', 'readSessionAttachment',
    'submitNewTask', 'submitToSession', 'abortSession', 'resolveToolApprovalForSession',
    'resyncSessionState', 'subscribeSessionState', 'inheritSession',
  ] as const,
  files: [
    'readEditorSettings', 'startProject', 'startProjectTask', 'startTask', 'listProjects', 'addProject',
    'renameProject', 'removeProject', 'searchWorkspaceText', 'replaceWorkspaceText', 'searchProjectFiles',
    'libreOfficeStatus', 'installLibreOffice', 'githubStarStatus', 'starGithub', 'submitFeedback',
    'listProjectDir', 'previewProjectFile', 'captureFileSnapshot', 'previewDocumentFile',
    'previewDocumentPages', 'readEditorBackup', 'writeEditorBackup', 'deleteEditorBackup', 'statProjectFile',
    'createProjectEntry', 'renameProjectEntry', 'trashProjectEntry', 'moveProjectEntry', 'copyProjectEntry',
    'codeGraphQuery', 'lspDocument', 'lspRequest', 'lspApplyWorkspaceEdit', 'projectRecovery',
    'readProjectFile', 'writeProjectFile', 'readLocalFile', 'folderWatch', 'folderUnwatch',
    'subscribeFolderChanges', 'subscribeLspDiagnostics', 'subscribeLspStatus',
  ] as const,
  scm: [
    'gitCliStatus', 'installGitCli', 'githubCliStatus', 'installGithubCli', 'githubCliLoginStart',
    'githubCliLoginStatus', 'githubCliLoginOpenBrowser', 'githubCliLoginCancel', 'githubCliLogout',
    'githubCliAccount', 'gitGlobalConfig', 'setGitGlobalConfig', 'gitStatus', 'gitBranches',
    'gitRenameBranch', 'gitDeleteBranch', 'gitDiff', 'gitApplyPatch', 'gitStage', 'gitUnstage', 'gitIgnore',
    'gitCommit', 'gitCommitPaths', 'gitAmend', 'gitUndoLastCommit', 'gitStash', 'gitStashPop',
    'gitStashList', 'gitStashApply', 'gitStashDrop', 'ghPrList', 'githubRequest', 'ghPrDefaultBranch',
    'ghPrCreate', 'ghPrView', 'ghPrCheckout', 'ghPrMerge', 'ghPrDiff', 'gitPush', 'gitFetch', 'gitPull',
    'gitSync', 'gitContinue', 'gitAbortOperation', 'gitRevert', 'gitLog', 'gitShow', 'gitShowDiff',
    'gitRequestContext', 'gitShowFile', 'gitResetToCommit', 'gitRevertCommit', 'gitCherryPickCommit',
    'gitCreateTag', 'gitDeleteTag', 'gitReview', 'gitReviewDiff', 'gitReviewDiffs',
  ] as const,
  terminal: [
    'termProfiles', 'termWrite', 'termResize', 'termDispose', 'termFocus', 'claimTerminalRun', 'termEnsure',
    'termAttach', 'termAcknowledge', 'subscribeTermData', 'subscribeTermSizeOwner', 'termActivity',
    'subscribeTermActivity', 'onTerminalRunRequested',
  ] as const,
  settings: [
    'readSettings', 'updateSetting', 'subscribeSettingsChanged', 'readActivityRailPins',
    'updateActivityRailPins', 'subscribeActivityRailPins', 'notifyProviderModelsChanged',
    'subscribeProviderModelsChanged', 'setNotificationVolume', 'setSessionRetention',
    'setBrowserPermissions', 'setNotificationPreferences', 'listConversationNotifications',
    'setConversationNotification', 'subscribeTurnReviewChanged', 'subscribeOrchestrationModeChanged',
    'readMarkdownDefaultView', 'writeMarkdownDefaultView', 'rotateRemoteAccess', 'revokeRemoteAccessClient',
    'setRemoteAccessEnabled', 'setRemotePcName', 'setRemoteClientAlias', 'resolveRemoteClientClaim',
    'getRemotePairCode', 'getRemoteAccessInfo', 'subscribeRemoteClientClaim', 'getRemoteAccessSettings',
    'subscribeRemoteAccessSettings', 'listRemoteClientClaims',
  ] as const,
  capabilities: [
    'invokeCapability', 'readCapabilities',
  ] as const,
  sections: [
    'sections',
  ] as const,
} as const;

export const HOST_KEYS = {
  electron: [
    'routeAutoEffort', 'requestLinuxInputAccess', 'computerReadiness', 'approvePcAccess',
    'openComputerPermissionSettings', 'folderPathForFile', 'reportScreenSessions', 'getDesktopPetConfig',
    'setDesktopPetEnabled', 'setDesktopPetOption', 'setDesktopPetScale', 'resetDesktopPetPosition',
    'subscribeDesktopPetConfig', 'subscribeDesktopPetOpenSettings', 'subscribeDesktopPetAppLayout',
    'publishDesktopPet', 'publishDesktopPetComposer', 'publishDesktopPetTheme', 'publishDesktopPetLayers',
    'publishDesktopPetAvailable', 'rendererDiagnostic', 'rendererReady', 'acknowledgeWhatsNew',
    'readPaneLayoutFile', 'writePaneLayoutFile', 'getUpdaterState', 'subscribeUpdaterState',
    'checkForDesktopUpdate', 'showDesktopUpdate', 'previewNotificationSound', 'getZoomFactor',
    'setZoomFactor', 'applyTitleBarTheme', 'setTitleBarDim', 'listSystemFonts', 'onZoomFactorChanged',
    'onBrowserOpenRequested', 'onVisualizeChanged', 'visualizeState', 'visualizeCommand',
    'visualizePaneText', 'visualizeFeedbackAttach', 'visualizeCaptureRect', 'visualizeConsumeGesture',
    'visualizePanelSize', 'onBrowserSessionReleased', 'browserSetActiveGuest', 'browserPanelShown',
    'browserReleasePage', 'browserPageControl', 'browserPageMetadata', 'browserPresentNative',
    'browserConfigureGuestViewport', 'onBrowserGuestViewportChanged', 'onBrowserRemoteViewerChanged',
    'onBrowserFullscreenChanged', 'onBrowserApproval', 'browserApprovalDecide',
    'browserProfileImportSources', 'browserProfileImportStart', 'onBrowserProfileImportProgress',
    'browserCookieAutoImportStatus', 'browserCookieAutoImportConfigure', 'browserCookieAutoImportForgetKey',
    'browserHistorySearch', 'browserCredentialSuggestions', 'browserCredentialFill', 'browserSignedInSites',
    'browserSignOutSite', 'browserClearSignIns', 'browserVaultLogins', 'browserVaultSave',
    'browserVaultDelete', 'browserLinkedSignIns', 'browserLinkedSignInDelete', 'browserLoginOpen',
    'browserLoginStatus', 'browserPageIdentity', 'onBrowserPageIdentityChanged', 'mediaUrl', 'quit',
    'browserPageFrame', 'browserPresentTexture', 'browserDiscardTexture', 'perfLog',
  ] as const,
  mixed: [
    'chooseProject', 'chooseFile', 'chooseConversationImportFile', 'subscribeConversationImportProgress',
    'chooseFiles', 'chooseWorkspace', 'saveWorkspace', 'openProjectInExplorer', 'openMediaAsset',
    'openMediaFolder', 'openExternal', 'openLocalFileLink', 'localPageUrl', 'resolveLocalPaths',
    'openServerDownload', 'subscribeDesktopNotices', 'renameRemoteHost', 'listRemoteHosts',
    'connectRemoteHostByCode', 'openRemoteHost', 'forgetRemoteHost', 'revealFile', 'openFilePath',
    'openAttachmentImage', 'readAttachmentThumbnail', 'openAttachmentFile', 'stageAttachmentFile',
    'saveFileAs', 'getNotificationPreferences', 'sendTestNotification', 'onNotificationOpenSession',
  ] as const,
  otherArea: [
    'listServerDirectories', 'serverUploadBegin', 'serverUploadChunk', 'serverUploadCommit',
    'serverUploadAbort', 'serverDownloadBegin', 'serverDownloadStep', 'serverDownloadFinish',
    'serverDownloadAbort', 'serverTrashInfo', 'provideSecretInput', 'takeoverReady',
  ] as const,
  ssh: [
    'subscribeShowConnectionSettings', 'sshListHosts', 'sshRenameHost', 'sshForgetHost', 'sshOpenHost',
    'sshConfigHosts', 'sshInspectHostKey', 'sshConnect', 'sshCancel', 'sshAskpassReply', 'sshCleanupHost',
    'sshUpdateHostSettings', 'sshServerLogins', 'sshServerLoginBegin', 'sshServerLoginStatus',
    'subscribeSshServerLoginUpdated', 'sshServerLoginComplete', 'sshServerLoginCancel',
    'sshServerLoginSaveKey', 'sshServerLoginLogout', 'sshServerLoginRemoveCustom', 'subscribeSshAskpass',
    'sshDiagnosticsLog', 'sshDiagnosticsCopy', 'sshServerLog', 'subscribeSshCleanupProgress',
    'subscribeSshProgress', 'getConnectionLink', 'subscribeConnectionLink', 'subscribeConnectionNotice',
    'retryConnection', 'retryConnectionNow', 'closeConnectionWindow', 'openConnectionSettings',
    'getReopenServerWindows', 'setReopenServerWindows', 'subscribeServerRestoreProgress',
    'getServerRestoreProgress', 'listServerPorts', 'subscribeHostListsChanged', 'subscribeServerPorts',
    'forwardServerPort', 'stopServerPortForward', 'dismissServerPort', 'openServerPortInBrowser',
    'subscribeConnectionSignIn',
  ] as const,
} as const;

export const OPTIONAL_UNPROVIDED = [
  'bootContext', 'connection', 'localPageSource', 'listHostDirectories', 'fileDownloads',
  'readTranscriptItem', 'pushPublicKey', 'registerPushSubscription', 'removePushSubscription',
  'openSessionAttachment', 'readHostDisplayPreferences', 'visualizePaneSource', 'visualizePaneInline',
  'visualizePanePages', 'visualizeExport', 'onBrowserApprovalSessions', 'remoteBrowserStream',
  'remoteBrowserStreamAck', 'onRemoteBrowserFrame', 'remoteBrowserControl', 'remoteBrowserDrive',
  'remoteBrowserSessionTabs', 'remoteTermSizeOwner', 'remoteUsageRequests', 'remoteBrowserTabs',
  'remoteBrowserOpenTab', 'remoteBrowserCloseTab', 'onRemoteBrowserTabs',
] as const;

export type DirectGroup = keyof typeof DIRECT_KEYS;
export type DirectKey<G extends DirectGroup = DirectGroup> = (typeof DIRECT_KEYS)[G][number];
export type HostGroup = keyof typeof HOST_KEYS;
export type HostKey = (typeof HOST_KEYS)[HostGroup][number];
export type UnprovidedKey = (typeof OPTIONAL_UNPROVIDED)[number];

type Classified = DirectKey | HostKey | UnprovidedKey;
type Unclassified = Exclude<keyof DesktopApi, Classified>;
type NotAMember = Exclude<Classified, keyof DesktopApi>;

/** Does not compile while a DesktopApi member is unclassified or a listed key is not a member. */
export const DESKTOP_API_COMPLETE: [Unclassified, NotAMember] extends [never, never] ? true : never = true;

/** Members the host side adds beyond DesktopApi. */
export interface DesktopHostExtras {
  enableAllowAllActions(): Promise<DesktopCapabilityResult>;
  observeSignIn(capability: string, args: unknown[], value: unknown): void;
  invokePcQuotaCapability(request: DesktopCapabilityRequest): Promise<DesktopCapabilityResult>;
  readPcQuotaCapabilities(requests: DesktopCapabilityReadRequest[]): Promise<DesktopCapabilityReadResult[]>;
  /** The reveals main's own agent `terminal` bridge asks for (the loopback bridge lives in main, so the core never sees them);
   *  the core's own terminal opens reach the window over its core link. `onTerminalRunRequested` listens to both. */
  onHostTerminalRunRequested(listener: (request: DesktopTerminalRunRequest) => void): () => void;
}

/** What window.mixdogDesktopHost exposes: the HOST half of DesktopApi plus the extras. */
export type DesktopHostApi = Pick<DesktopApi, HostKey> & DesktopHostExtras;
