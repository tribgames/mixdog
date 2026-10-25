import type { GithubRequest, GithubResult } from '../../../../src/runtime/github/contract.mjs';
import type { FileDownloadApi } from './file-downloads';
import type { ProjectRecoveryRequest, ProjectRecoveryResponse } from './project-recovery';
import type { FileLaunchConfirmation, LocalLinkOpened } from './local-files';
import type { DesktopFeedbackInput, DesktopFeedbackReceipt } from './contract-feedback';
import type {
  DesktopComputerInputAccess,
  DesktopComputerPermissionPane,
  DesktopComputerReadiness,
} from './contract-computer';
import type {
  DesktopAbortOptions,
  DesktopAgentPoolRow,
  DesktopSessionContentMatch,
  DesktopModelCatalogOptions,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopNewTaskDraft,
  DesktopNewTaskSubmitResult,
  DesktopPromptContent,
  DesktopSessionStateUpdate,
  DesktopSubmitOptions,
  DesktopUpdaterState,
  SessionSnapshot,
  ToolApprovalDecision,
} from './contract-session';
import type {
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopCapabilityRequest,
  DesktopCapabilityResult,
} from './contract-capabilities';
import type { DesktopSettingKey, DesktopSettings } from './contract-settings';
import type {
  DesktopPetAppLayout,
  DesktopPetComposer,
  DesktopPetConfig,
  DesktopPetLayers,
  DesktopPetOption,
  DesktopPetState,
  DesktopPetTheme,
} from './desktop-pet';
import type { ConversationImportJob } from './contract-import';
import type { ActivityRailPinsState } from './activity-rail-pins';
import type { ProviderModelsChange } from './provider-models';
import type { SettingsChange } from './settings-changed';
import type { HostDisplayPreferences } from './host-display-preferences';
import type { TerminalSizeOwnerEvent } from './terminal-size-owner';
import type { TerminalActivityEvent } from './terminal-activity';
import type { DesktopTerminalRunRequest } from './terminal-command';
import type {
  DesktopVisualizeEvent,
  DesktopVisualizeTabCommand,
  VisualizeCommandResult,
  VisualizePaneSource,
  VisualizePaneText,
  VisualizeRemoteExport,
  VisualizeSessionState,
} from './visualize';
import type {
  DesktopSshAskpass,
  DesktopSshCleanupProgress,
  DesktopSshCleanupRequest,
  DesktopSshLogView,
  DesktopSshServerLog,
  DesktopSshCleanupResult,
  DesktopSshConfigHost,
  DesktopSshConnectRequest,
  DesktopSshConnectResult,
  DesktopSshHost,
  DesktopSshHostSettings,
  DesktopSshInspection,
  DesktopSshProgress,
} from './contract-ssh';
import type {
  DesktopBrowserCredentialFillResult,
  DesktopBrowserCredentialSuggestion,
  DesktopBrowserSignedInSite,
  DesktopBrowserLoginStatus,
  DesktopBrowserGuestViewportChange,
  DesktopBrowserHistoryEntry,
  DesktopBrowserImportProgress,
  DesktopBrowserImportRequest,
  DesktopBrowserImportResult,
  DesktopBrowserImportSource,
  DesktopBrowserOpenRequest,
  DesktopBrowserPageControl,
  DesktopBrowserPageFrame,
  DesktopBrowserPageIdentity,
  DesktopBrowserPageResample,
  DesktopBrowserRemoteViewerChange,
  DesktopBrowserFullscreenChange,
  DesktopBrowserTabControlResult,
  DesktopBrowserViewportConfig,
  DesktopRemoteBrowserControl,
  DesktopRemoteBrowserStreamFrame,
  DesktopRemoteBrowserStreamOptions,
  DesktopRemoteBrowserTab,
} from './contract-browser';
import type {
  DesktopGitBranch,
  DesktopGitCliStatus,
  DesktopGitCommitDetails,
  DesktopGitGlobalConfig,
  DesktopGitGlobalConfigKey,
  DesktopGitIgnoreScope,
  DesktopGitLogEntry,
  DesktopGitRequestContext,
  DesktopGitReview,
  DesktopGitReviewDiffRequest,
  DesktopGitReviewDiffs,
  DesktopGitReviewSource,
  DesktopGitStashEntry,
  DesktopGitStatus,
  DesktopGitStatusOptions,
  DesktopGithubCliAccount,
  DesktopGithubCliLoginFlow,
  DesktopGithubCliStatus,
  DesktopLibreOfficeStatus,
  DesktopPullRequestCategory,
  DesktopPullRequestCreateInput,
  DesktopPullRequestDetail,
  DesktopPullRequestEntry,
} from './contract-git';
import type {
  DesktopBootContext,
  DesktopConnectionIdentity,
  DesktopDirEntry,
  DesktopDocumentPreviewPages,
  DesktopEditorBackup,
  DesktopEditorSettings,
  DesktopLocalFileData,
  DesktopLocalPathEntry,
  DesktopLspDiagnosticEvent,
  DesktopLspDocumentInput,
  DesktopLspRequestInput,
  DesktopLspRequestResult,
  DesktopLspServerState,
  DesktopLspStatusEvent,
  DesktopProjectSummary,
  DesktopRemoteAccessInfo,
  DesktopRemoteAccessSettings,
  DesktopRemoteClientClaim,
  DesktopRemoteHost,
  DesktopRemotePairCode,
  DesktopRemotePairCodeUnsupported,
  DesktopRendererDiagnostic,
  DesktopSessionSummary,
  DesktopTextFileEncoding,
  DesktopWorkspace,
  DesktopWorkspaceFolder,
  DesktopWorkspaceTextReplaceResult,
  DesktopWorkspaceTextSearchOptions,
  DesktopWorkspaceTextSearchResult,
  DesktopWorkspaceTextWrite,
} from './contract-workspace';

export * from './contract-ipc';
export * from './contract-feedback';
export * from './contract-session';
export * from './contract-capabilities';
export * from './contract-settings';
export * from './activity-rail-pins';
export * from './provider-models';
export * from './settings-changed';
export * from './contract-browser';
export * from './contract-git';
export * from './contract-computer';
export * from './contract-workspace';
export * from './contract-worktree';
export * from './contract-import';
export * from './contract-ssh';
export * from './contract-connection-link';

export type { GithubRequest, GithubResult } from '../../../../src/runtime/github/contract.mjs';

/** One entry of an agent's own memory pool: `id` and `indexRevision` address
 *  it for a delete (the pool's list version; a stale one is refused). */
export interface DesktopAgentMemoryEntry {
  id: number;
  indexRevision: string;
  summary: string;
}

/** Small, last-writer-wins UI projection shared by Electron and paired web
 * clients. Pane geometry remains local; `selection` is the first visual pane. */
export interface DesktopApi {
  /** Local Electron runtime platform; absent on paired web clients. */
  readonly platform?: string;
  projectRecovery?(projectPath: string, request: ProjectRecoveryRequest): Promise<ProjectRecoveryResponse>;
  /** Immutable process timeline identity injected before renderer modules run. */
  readonly bootContext?: DesktopBootContext;
  /** The daemon connection this Electron window drives; absent on remote
   *  surfaces (phone, browser, another PC's window). */
  readonly connection?: DesktopConnectionIdentity;
  /** The host accepts per-route Auto reasoning: `autoEffort` in model
   *  selections and `+noauto` automation model refs. Absent on an older
   *  remote host, which rejects both. */
  readonly routeAutoEffort?: boolean;
  chooseProject(): Promise<string | null>;
  /** Native open-file dialog for a `.jsonl` conversation export; the chosen path or null. */
  chooseConversationImportFile?(): Promise<string | null>;
  /** Fires with each changed conversation-import job snapshot while a job is active. */
  subscribeConversationImportProgress?(listener: (job: ConversationImportJob) => void): () => void;
  chooseFile?(defaultPath?: string | null): Promise<{
    /** The file's path on this PC. */
    absolutePath?: string;
    projectPath: string;
    relPath: string;
    accessToken?: string;
  } | null>;
  chooseFiles?(defaultPath?: string | null): Promise<DesktopLocalPathEntry[] | null>;
  chooseWorkspace?(): Promise<DesktopWorkspace | null>;
  saveWorkspace?(workspaceFile: string | null, folders: DesktopWorkspaceFolder[]): Promise<DesktopWorkspace | null>;
  readEditorSettings?(projectPath: string, relPath: string, workspaceFile?: string): Promise<DesktopEditorSettings>;
  readMarkdownDefaultView?(): Promise<DesktopEditorSettings['markdownDefaultView']>;
  writeMarkdownDefaultView?(
    view: DesktopEditorSettings['markdownDefaultView']
  ): Promise<DesktopEditorSettings['markdownDefaultView']>;
  startProject(projectPath: string): Promise<SessionSnapshot>;
  startProjectTask(projectPath: string): Promise<SessionSnapshot>;
  startTask(): Promise<SessionSnapshot>;
  listProjects(): Promise<DesktopProjectSummary[]>;
  /** Register a folder without entering it (Projects page add dialog). */
  addProject(projectPath: string): Promise<void>;
  openProjectInExplorer(projectPath: string): Promise<void>;
  openMediaAsset?(assetId: string): Promise<void>;
  openMediaFolder?(assetId: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  submitFeedback?(input: DesktopFeedbackInput): Promise<DesktopFeedbackReceipt>;
  /** Desktop-only chat link opener, confined to the conversation's Project:
   *  documents launch their OS app, folders open in the file manager, and
   *  text files come back as 'editor' for the renderer to open itself. */
  openLocalFileLink?(
    projectPath: string,
    href: string,
    confirmedPath?: string
  ): Promise<LocalLinkOpened | FileLaunchConfirmation>;
  /** Desktop-only: a loopback http address that serves a local web page (and
   *  the web assets beside it) for the session browser pane. */
  localPageUrl?(projectPath: string, relPath: string, accessToken?: string): Promise<string>;
  /** Remote-only counterpart of `localPageUrl`: a self-contained HTML document
   *  (relative assets inlined over the encrypted RPC lane) for a sandboxed
   *  `srcdoc` frame, since a browser cannot reach the host's loopback server. */
  localPageSource?(projectPath: string, relPath: string, accessToken?: string): Promise<string>;
  /** Settings → About: gh-CLI star state for the mixdog repo. Desktop-only;
   *  the remote shim omits both and the Star button falls back to the repo
   *  link. */
  githubStarStatus?(): Promise<{ available: boolean; starred: boolean }>;
  starGithub?(): Promise<{ starred: boolean }>;
  /** Settings → Git: GitHub CLI status, guided install, and device-flow
   *  login/logout. Desktop-only; the remote shim omits the whole family. */
  gitCliStatus?(): Promise<DesktopGitCliStatus>;
  installGitCli?(): Promise<DesktopGitCliStatus>;
  /** Extensions → Office: LibreOffice dependency probe + guided install. */
  libreOfficeStatus?(refresh?: boolean): Promise<DesktopLibreOfficeStatus>;
  installLibreOffice?(): Promise<DesktopLibreOfficeStatus>;
  /** Extensions → Computer Use: what this OS still needs before the tool runs
   *  fully (Linux capabilities, macOS grants). Desktop-only. */
  computerReadiness?(): Promise<DesktopComputerReadiness>;
  requestLinuxInputAccess?(): Promise<DesktopComputerInputAccess>;
  openComputerPermissionSettings?(pane: DesktopComputerPermissionPane): Promise<void>;
  githubCliStatus?(): Promise<DesktopGithubCliStatus>;
  installGithubCli?(): Promise<DesktopGithubCliStatus>;
  githubCliLoginStart?(): Promise<DesktopGithubCliLoginFlow>;
  githubCliLoginStatus?(flowId: string): Promise<DesktopGithubCliLoginFlow>;
  /** Lets gh open the device page; false when it already did. With
   *  `openBrowser: false` (remote client) the host opens nothing. */
  githubCliLoginOpenBrowser?(flowId: string, options?: { openBrowser?: boolean }): Promise<boolean>;
  githubCliLoginCancel?(flowId: string): Promise<void>;
  githubCliLogout?(): Promise<DesktopGithubCliStatus>;
  githubCliAccount?(): Promise<DesktopGithubCliAccount>;
  /** Settings → Git: global git identity/defaults (`git config --global`). */
  gitGlobalConfig?(): Promise<DesktopGitGlobalConfig>;
  setGitGlobalConfig?(key: DesktopGitGlobalConfigKey, value: string): Promise<DesktopGitGlobalConfig>;
  renameProject(projectPath: string, alias: string): Promise<void>;
  removeProject(projectPath: string): Promise<void>;
  /** Dock Files tab: lazy per-directory listing. */
  listProjectDir?(projectPath: string, relDir: string): Promise<DesktopDirEntry[]>;
  /** Remote add-project browser: subfolders of an absolute host directory
   *  ('' = the host's home). Directories only; needs no registered project. */
  listHostDirectories?(path: string): Promise<{ path: string; folders: string[]; truncated: boolean }>;
  /** Server-window folder picker: subfolders (git marker, hidden ones only on
   *  request) of an absolute directory on this window's own connection
   *  ('' = the user's home there). */
  listServerDirectories?(
    path: string,
    includeHidden?: boolean
  ): Promise<{ path: string; entries: Array<{ name: string; git: boolean }>; truncated: boolean }>;
  /** Server window: a file of this PC streamed in chunks into the server's
   *  attachment staging folder (`scope` = the session, or a draft). */
  serverUploadBegin?(
    name: string,
    size: number,
    scope: string
  ): Promise<{ uploadId: string; chunkBytes: number; maxBytes: number }>;
  serverUploadChunk?(uploadId: string, offset: number, bytes: Uint8Array): Promise<{ received: number }>;
  serverUploadCommit?(uploadId: string): Promise<DesktopLocalPathEntry>;
  serverUploadAbort?(uploadId: string): Promise<boolean>;
  /** Server window: "download to this PC", one ranged read per step. */
  serverDownloadBegin?(
    projectPath: string,
    relPath: string,
    accessToken?: string
  ): Promise<{ downloadId: string; name: string; size: number }>;
  serverDownloadStep?(downloadId: string): Promise<{ received: number; size: number; done: boolean }>;
  serverDownloadFinish?(downloadId: string): Promise<{ path: string }>;
  serverDownloadAbort?(downloadId: string): Promise<boolean>;
  /** Opens a file this window downloaded from its server with this PC's app. */
  openServerDownload?(path: string, confirmedPath?: string): Promise<void | FileLaunchConfirmation>;
  /** Server window: whether deleting in this project can use the server's trash. */
  serverTrashInfo?(projectPath: string): Promise<{ available: boolean; path: string }>;
  /** Editor tab: project file IO (traversal-guarded in main). */
  readProjectFile?(
    projectPath: string,
    relPath: string,
    accessToken?: string
  ): Promise<{
    content: string;
    mtimeMs: number;
    binary: boolean;
    tooLarge: boolean;
    /** Oversized or invalidly encoded text: viewable, never saved. */
    readOnly?: boolean;
    readOnlyReason?: 'encoding';
    encoding: DesktopTextFileEncoding;
  }>;
  previewProjectFile?(
    projectPath: string,
    relPath: string,
    accessToken?: string
  ): Promise<{
    url: string;
    kind: 'image' | 'pdf' | 'audio' | 'video';
    mime: string;
    mtimeMs: number;
    size: number;
  }>;
  /** A small picture (data URL, at most 640 px wide) of a local HTML or image
   *  file of the project, rendered off screen by the host. Fails for anything
   *  outside the project, other file types, and files that render too slowly. */
  captureFileSnapshot?(
    projectPath: string,
    relPath: string,
    accessToken?: string
  ): Promise<{ dataUrl: string; mtimeMs: number; size: number }>;
  /** Office document shown through the in-app PDF viewer, converting it once
   *  per revision. Electron only: the URL is a local protocol URL, which is
   *  exactly why a paired phone gets pages instead. */
  previewDocumentFile?(
    projectPath: string,
    relPath: string,
    accessToken?: string
  ): Promise<{
    url: string;
    kind: 'pdf';
    mime: string;
    format: string;
    mtimeMs: number;
    size: number;
  }>;
  /** Rasterized pages of the same conversion, for a surface that cannot
   *  display a PDF at all. The reply carries the page count so the viewer can
   *  ask for the rest as it scrolls. `password` opens a password-protected
   *  document for this one request; later page requests need none. */
  previewDocumentPages?(
    projectPath: string,
    relPath: string,
    accessToken?: string,
    options?: { pages?: number[]; maxWidth?: number; password?: string }
  ): Promise<DesktopDocumentPreviewPages>;
  writeProjectFile?(
    projectPath: string,
    relPath: string,
    content: string,
    expectedContent: string,
    accessToken?: string,
    encoding?: DesktopTextFileEncoding
  ): Promise<{ mtimeMs: number }>;
  readEditorBackup?(projectPath: string, relPath: string, accessToken?: string): Promise<DesktopEditorBackup | null>;
  writeEditorBackup?(
    projectPath: string,
    relPath: string,
    content: string,
    expectedContent: string,
    accessToken?: string
  ): Promise<DesktopEditorBackup>;
  deleteEditorBackup?(projectPath: string, relPath: string, accessToken?: string): Promise<void>;
  statProjectFile?(
    projectPath: string,
    relPath: string,
    accessToken?: string
  ): Promise<{ mtimeMs: number; size: number }>;
  createProjectEntry?(projectPath: string, relDir: string, name: string, dir: boolean): Promise<void>;
  renameProjectEntry?(projectPath: string, relPath: string, newName: string): Promise<void>;
  /** A server window's daemon moves the entry to the server's trash, or with
   *  `permanent` (asked for explicitly) deletes it for good. */
  trashProjectEntry?(projectPath: string, relPath: string, options?: { permanent?: boolean }): Promise<void>;
  /** Explorer DnD / cut-paste: move an entry into another project folder. */
  moveProjectEntry?(projectPath: string, relPath: string, targetDirRel: string): Promise<void>;
  /** Explorer copy-paste: copy an entry; collisions get "name copy" names. */
  copyProjectEntry?(projectPath: string, relPath: string, targetDirRel: string): Promise<{ name: string }>;
  /** Absolute path of an OS-native dropped File (webUtils.getPathForFile). */
  folderPathForFile?(file: File): string;
  /** Resolve trusted local paths for file-tab opening and internal drag/drop.
   *  On a remote surface a path outside every registered project resolves
   *  only when an assistant reply links it: in `sessionId`'s transcript when
   *  given, otherwise in a conversation this device currently views. */
  resolveLocalPaths?(paths: string[], sessionId?: string): Promise<DesktopLocalPathEntry[]>;
  /** Remote surfaces only: downloads of host files to this device
   *  (shared/file-downloads.ts). Absent on the desktop app. */
  fileDownloads?: FileDownloadApi;
  /** Read one local file for an existing attachment flow; capped in main. */
  readLocalFile?(path: string): Promise<DesktopLocalFileData>;
  /** Live refresh: watch a directory (refcounted) and stream change pings. */
  folderWatch?(dir: string, recursive?: boolean): Promise<void>;
  folderUnwatch?(dir: string, recursive?: boolean): Promise<void>;
  subscribeFolderChanges?(listener: (dir: string) => void): () => void;
  /** Monaco definition/reference/document-symbol providers via code_graph. */
  codeGraphQuery?(projectPath: string, mode: 'find_symbol' | 'references' | 'symbols', query: string): Promise<string>;
  /** Dynamic project language servers. Unsupported or missing servers quietly
   *  return unavailable so Monaco/code_graph remain the fallback. */
  lspDocument?(input: DesktopLspDocumentInput): Promise<DesktopLspServerState>;
  lspRequest?(input: DesktopLspRequestInput): Promise<DesktopLspRequestResult>;
  lspApplyWorkspaceEdit?(projectPath: string, writes: DesktopWorkspaceTextWrite[]): Promise<void>;
  subscribeLspDiagnostics?(listener: (event: DesktopLspDiagnosticEvent) => void): () => void;
  subscribeLspStatus?(listener: (event: DesktopLspStatusEvent) => void): () => void;
  /** The relay refused an oversize frame this desktop sent and named no
   *  client. Surfaced to the user; it blames no call and reaches no phone. */
  subscribeRelayPayloadRefused?(listener: (detail: { bytes: number | null; limit: number | null }) => void): () => void;
  listSessions(): Promise<DesktopSessionSummary[]>;
  /** Persist and fan out a read cursor. `consumedUnread` covers a completion
   *  marker whose message count did not advance. */
  markSessionRead?(sessionId: string, messageCount: number, consumedUnread?: boolean): Promise<boolean>;
  /** Push channel: fires with a fresh catalog whenever the on-disk session
   *  store changes (any mixdog process). Renderers fall back to their
   *  safety-net poll when the host does not provide it (remote shim). */
  subscribeSessions?(listener: (sessions: DesktopSessionSummary[]) => void): () => void;
  /** Event-driven process-global agent lifecycle pool. */
  listAgentPool?(): Promise<DesktopAgentPoolRow[]>;
  /** Full-text search over session message content. */
  searchSessionContent?(query: string): Promise<DesktopSessionContentMatch[]>;
  subscribeAgentPool?(listener: (agents: DesktopAgentPoolRow[]) => void): () => void;
  renameSession(sessionId: string, title: string): Promise<void>;
  /** Switches an existing session to `route` in place (quota exhausted); starts no turn. */
  continueSessionInModel(sessionId: string, route: DesktopModelSelection): Promise<boolean>;
  /** Arms the session's auto-resume at its quota reset time. */
  scheduleQuotaResume(sessionId: string): Promise<boolean>;
  /** Drops a waiting auto-resume; the session stays stopped. */
  cancelQuotaResume(sessionId: string): Promise<boolean>;
  /** Stops one running background shell job of the session through its
   *  runtime (the task tool's cancel). `stopped` is true only when the job was
   *  actually cancelled; unknown, finished or failed cancels carry `error`. */
  stopShellJob?(sessionId: string, taskId: string): Promise<{ stopped: boolean; error?: string }>;
  /** Explicit "Release anyway" for a shell job whose termination is
   *  unconfirmed: drops its workspace hold in the owning runtime. The caller
   *  confirms with the user first. */
  releaseShellJob?(sessionId: string, taskId: string): Promise<{ released: boolean; error?: string }>;
  /** Whether quota-stopped sessions resume by themselves at reset (default true). */
  getQuotaAutoResume(): Promise<boolean>;
  /** The device name this window's own actions are stamped with (the host's
   *  name locally, the paired client's name on a remote surface). */
  viewerDevice?(): Promise<string>;
  /** Remote surface only: the uncapped output of one tool row whose output the
   *  host cut for the phone (`remoteOutputTruncated`); null when it is gone. */
  readTranscriptItem?(
    sessionId: string,
    itemId: string
  ): Promise<{ id: string; result?: unknown; rawResult?: unknown; uiDiff?: unknown; withheld?: true } | null>;
  setQuotaAutoResume(enabled: boolean): Promise<boolean>;
  setSessionArchived?(sessionId: string, archived: boolean): Promise<void>;
  /** The agent contact's one home thread, resolved by the host from the agent
   *  id and created on its first open; the same id on every device. */
  openAgentHome?(agentId: string): Promise<{ sessionId: string }>;
  /** "대화 새로 시작": the same home id, now empty; the conversation so far is
   *  kept archived under `archivedSessionId` (null when it had no turns). */
  resetAgentHome?(agentId: string): Promise<{ sessionId: string; archivedSessionId: string | null }>;
  /** "이 에이전트가 기억하는 것": the agent's own memory pool, every entry. */
  listAgentMemory?(agentId: string): Promise<DesktopAgentMemoryEntry[]>;
  /** Delete one entry of the agent's own memory (a list's `id`/`indexRevision`). */
  deleteAgentMemory?(agentId: string, entry: Pick<DesktopAgentMemoryEntry, 'id' | 'indexRevision'>): Promise<void>;
  /** Group rooms: `create` ({ name, members }) → `{ sessionId, roomId }`,
   *  `update` (roomId, patch), `continue` (roomId) runs another bounded
   *  batch, `leave` (roomId) archives it, `remove` (roomId) deletes it. */
  agentRoomAction?(action: string, args: unknown[]): Promise<unknown>;
  setSessionFavorite?(sessionId: string, favorite: boolean): Promise<void>;
  /** Move a session to a registered project path ('' = no project, the task
   *  workspace) by changing its working folder. Refused while its turn runs
   *  or while it works in a managed worktree. */
  setSessionProject?(sessionId: string, projectPath: string): Promise<void>;
  deleteSession(sessionId: string): Promise<SessionSnapshot>;
  /** /inherit — copy this conversation into a NEW session id that runs on the
   *  supplied (currently selected) model. The source session is left as it is,
   *  so both transcripts continue from the same point. */
  inheritSession(
    sourceSessionId: string,
    route?: DesktopModelSelection | null,
    options?: { compact: boolean } | null
  ): Promise<{ sessionId: string; snapshot: SessionSnapshot | null }>;
  /** Settings → Connection: pairing QRs + URLs for the phone remote. Only
   *  the in-process desktop implements it (null while the bridge is off);
   *  the remote shim omits it — a phone never needs its own pairing card. */
  /** `activate: false` only reads: it never starts the relay or activates
   *  remote access on an install that has not used it yet. Default true. */
  getRemoteAccessInfo?(options?: { activate?: boolean }): Promise<DesktopRemoteAccessInfo | null>;
  /** Settings → Connection: revoke every paired phone by minting a new
   *  pairing token and restarting the bridge/relay legs. */
  rotateRemoteAccess?(): Promise<DesktopRemoteAccessInfo | null>;
  /** Settings → Connection: revoke one browser while preserving every other
   *  browser's individual credential. */
  revokeRemoteAccessClient?(clientId: string): Promise<DesktopRemoteAccessInfo | null>;
  /** "Use this PC from other devices" and this PC's name. `defaultName` is the OS hostname. */
  getRemoteAccessSettings?(): Promise<DesktopRemoteAccessSettings>;
  /** Off closes the relay link (no codes, no claims) but keeps paired devices. */
  setRemoteAccessEnabled?(enabled: boolean): Promise<DesktopRemoteAccessSettings>;
  /** Trimmed, max 64 chars; empty resets to `defaultName`. */
  setRemotePcName?(name: string): Promise<DesktopRemoteAccessSettings>;
  /** Fires when the switch or the PC name changes. */
  subscribeRemoteAccessSettings?(listener: (settings: DesktopRemoteAccessSettings) => void): () => void;
  /** Local nickname for a paired device on this PC; empty clears it. Refetch
   *  `getRemoteAccessInfo` for the updated list. */
  setRemoteClientAlias?(clientId: string, alias: string): Promise<void>;
  /** Local alias for a saved PC; empty resets to the name it announced. */
  renameRemoteHost?(id: string, name: string): Promise<void>;
  /** "Connect to another PC": hosts saved on this machine. Native desktop only. */
  listRemoteHosts?(): Promise<DesktopRemoteHost[]>;
  /** Redeems the main PC's 6-digit code, saves that host and opens its remote
   *  window, which asks the host for approval. */
  connectRemoteHostByCode?(code: string): Promise<DesktopRemoteHost>;
  /** Settings → Connection → Connect to this PC: the 6-digit code. 'ensure'
   *  returns the live one (minting it if needed), 'renew' replaces it, and
   *  'release' withdraws it when the screen closes. */
  getRemotePairCode?(
    action: 'ensure' | 'renew' | 'release'
  ): Promise<DesktopRemotePairCode | DesktopRemotePairCodeUnsupported | null>;
  /** A remote window's PC switcher asked this machine to show Settings →
   *  Connection → Connect to another PC. */
  subscribeShowConnectionSettings?(listener: () => void): () => void;
  /** Opens (or focuses) a saved host's remote window. */
  openRemoteHost?(id: string): Promise<DesktopRemoteHost[]>;
  /** Closes the host's window and clears its stored pairing. */
  forgetRemoteHost?(id: string): Promise<DesktopRemoteHost[]>;
  /** SSH servers saved on this machine (Settings → Connection, PC menu). */
  sshListHosts?(): Promise<DesktopSshHost[]>;
  /** Local name of a saved SSH server. */
  sshRenameHost?(id: string, name: string): Promise<DesktopSshHost[]>;
  /** Removes only the saved entry; the server and its window are untouched. */
  sshForgetHost?(id: string): Promise<DesktopSshHost[]>;
  /** Opens (or focuses) a saved server's window. A failure comes back as a result, not a rejection. */
  sshOpenHost?(id: string): Promise<DesktopSshConnectResult>;
  /** Host aliases of ~/.ssh/config (wildcard patterns skipped). */
  sshConfigHosts?(): Promise<DesktopSshConfigHost[]>;
  /** Reads the server's host key, compares it with this PC's known_hosts and
   *  opens an attempt (main-minted `attemptId`) that the calls below name. */
  sshInspectHostKey?(target: string): Promise<DesktopSshInspection>;
  /** Connects the inspected address, saves the server and opens its window. Progress arrives through `subscribeSshProgress`. */
  sshConnect?(request: DesktopSshConnectRequest): Promise<DesktopSshConnectResult>;
  sshCancel?(attemptId: string): Promise<void>;
  /** Answers a question ssh asked (passphrase, password, one-time code); null cancels it. */
  sshAskpassReply?(attemptId: string, requestId: string, secret: string | null): Promise<void>;
  /** Removes Mixdog from a saved server over ssh (optionally with its work history), then optionally forgets the entry. */
  sshCleanupHost?(id: string, request: DesktopSshCleanupRequest): Promise<DesktopSshCleanupResult>;
  /** Per-server settings: folder, login key file, auto-reconnect. */
  sshUpdateHostSettings?(id: string, settings: DesktopSshHostSettings): Promise<DesktopSshHost[]>;
  subscribeSshAskpass?(listener: (request: DesktopSshAskpass) => void): () => void;
  /** `ref`: a saved server's id or an address; a server window always gets its own server. */
  sshDiagnosticsLog?(ref: string): Promise<DesktopSshLogView>;
  /** The text to copy for a bug report: app, OS, ssh version, the redacted ssh -G summary and the last log lines. */
  sshDiagnosticsCopy?(ref: string): Promise<string>;
  /** The last 200 lines of the server's daemon.log. */
  sshServerLog?(ref: string): Promise<DesktopSshServerLog>;
  subscribeSshCleanupProgress?(listener: (progress: DesktopSshCleanupProgress) => void): () => void;
  subscribeSshProgress?(listener: (progress: DesktopSshProgress) => void): () => void;
  /** The provider logins stored on a saved server (its window must be attached with server accounts). */
  sshServerLogins?(id: string): Promise<import('./contract-ssh').DesktopSshServerLogins>;
  /** Starts a subscription login on the server and opens it in this PC's browser. */
  sshServerLoginBegin?(id: string, provider: string): Promise<import('./contract-ssh').DesktopSshServerLoginFlow>;
  sshServerLoginStatus?(id: string, flowId: string): Promise<import('./contract-ssh').DesktopSshServerLoginFlow>;
  /** Completes a pending login with the address the browser was redirected to. */
  sshServerLoginComplete?(
    id: string,
    flowId: string,
    redirectUrl: string
  ): Promise<import('./contract-ssh').DesktopSshServerLoginFlow>;
  sshServerLoginCancel?(id: string, flowId: string): Promise<void>;
  /** Stores an API key on the server. */
  sshServerLoginSaveKey?(id: string, provider: string, key: string): Promise<void>;
  /** Removes a provider login from the server. */
  sshServerLoginLogout?(id: string, provider: string): Promise<void>;
  /** Deletes a custom provider (and its models) from the server. */
  sshServerLoginRemoveCustom?(id: string, provider: string): Promise<void>;
  /** A server window's link to its daemon; null in this PC's window. */
  getConnectionLink?(): Promise<import('./contract-connection-link').DesktopConnectionLinkView | null>;
  subscribeConnectionLink?(
    listener: (view: import('./contract-connection-link').DesktopConnectionLinkView) => void
  ): () => void;
  subscribeConnectionNotice?(
    listener: (notice: import('./contract-connection-link').DesktopConnectionNotice) => void
  ): () => void;
  /** Reconnects this server window now; a stopped connection is opened again. */
  retryConnection?(): Promise<void>;
  /** Runs the waiting reconnect attempt now instead of after its countdown. */
  retryConnectionNow?(): Promise<void>;
  /** Closes this server window (detaches; the server keeps running). */
  closeConnectionWindow?(): Promise<void>;
  /** Shows Settings → Connection in this PC's window. */
  openConnectionSettings?(): Promise<void>;
  /** "Reopen server windows when the app starts" (this PC's window only). */
  getReopenServerWindows?(): Promise<boolean>;
  setReopenServerWindows?(enabled: boolean): Promise<boolean>;
  subscribeServerRestoreProgress?(
    listener: (progress: import('./contract-connection-link').DesktopServerRestoreProgress) => void
  ): () => void;
  /** The reopenings still running or failed when this window subscribed. */
  getServerRestoreProgress?(): Promise<import('./contract-connection-link').DesktopServerRestoreProgress[]>;
  /** Server window's Ports panel; `rescan` false returns the last scan. */
  listServerPorts?(rescan?: boolean): Promise<import('./contract-server-ports').DesktopServerPortsView>;
  subscribeServerPorts?(listener: (view: import('./contract-server-ports').DesktopServerPortsView) => void): () => void;
  /** Forwards a server port to 127.0.0.1 on this PC (the same number when free, unless `localPort` is given). */
  forwardServerPort?(
    remotePort: number,
    localPort?: number | null
  ): Promise<import('./contract-server-ports').DesktopPortForward>;
  stopServerPortForward?(remotePort: number): Promise<void>;
  dismissServerPort?(port: number): Promise<void>;
  /** Opens http://127.0.0.1:<local>/ of an active forward in this PC's default browser. */
  openServerPortInBrowser?(remotePort: number): Promise<void>;
  /** This PC's window: a server window needs the user's connect attempt
   *  (sign in again, or confirm a changed host key). */
  subscribeConnectionSignIn?(listener: (server: { id: string; name: string; target: string }) => void): () => void;
  /** Web Push. Only the relay shim implements these — an Electron window has
   *  the taskbar/dock signal instead, and its absence is what hides the
   *  notification toggle outside the web app. */
  pushPublicKey?(): Promise<string>;
  registerPushSubscription?(input: { endpoint: string; p256dh: string; auth: string }): Promise<boolean>;
  removePushSubscription?(endpoint: string): Promise<boolean>;
  /** A web app with no credential is asking to connect. Only the in-process
   *  desktop implements these: the approval has to happen where the user is. */
  subscribeRemoteClientClaim?(listener: (claim: DesktopRemoteClientClaim) => void): () => void;
  listRemoteClientClaims?(): Promise<DesktopRemoteClientClaim[]>;
  resolveRemoteClientClaim?(claimId: string, approved: boolean): Promise<boolean>;
  prefetchSession?(sessionId: string, transcriptItemLimit?: number, readTraceId?: string): Promise<boolean>;
  /** Replay a visible lane after its read ACK arrived without a renderer baseline. */
  resyncSessionState?(sessionId: string): void;
  /** Register every visible session for owner-pipe mirroring. */
  setVisibleSessions?(sessionIds: string[]): Promise<boolean>;
  /** `includeIgnored` also searches gitignored folders (chat file links);
   *  `includeDirectories` also returns folders as `path/` (@-mentions). */
  searchProjectFiles(
    projectIdOrWorkspaceId: string,
    query: string,
    limit?: number,
    includeIgnored?: boolean,
    includeDirectories?: boolean
  ): Promise<string[]>;
  searchWorkspaceText?(
    projectPath: string,
    options: DesktopWorkspaceTextSearchOptions
  ): Promise<DesktopWorkspaceTextSearchResult>;
  replaceWorkspaceText?(
    projectPath: string,
    options: DesktopWorkspaceTextSearchOptions,
    replacement: string,
    relPaths?: string[]
  ): Promise<DesktopWorkspaceTextReplaceResult>;
  getSnapshot(): Promise<SessionSnapshot>;
  subscribeState(listener: (snapshot: SessionSnapshot) => void): () => void;
  /** Fire-and-forget: the sessions this window paints right now (one active
   *  tab per pane). A completion in one of them is not notified while the
   *  window is focused; every other session still notifies. */
  reportScreenSessions?(sessionIds: string[]): void;
  /** Desktop pet (this PC's app window only): the setting, its changes from
   *  the pet's own menu, and the followed session's state for the pet. */
  getDesktopPetConfig?(): Promise<DesktopPetConfig>;
  setDesktopPetEnabled?(enabled: boolean): Promise<DesktopPetConfig>;
  setDesktopPetOption?(name: DesktopPetOption, value: boolean): Promise<DesktopPetConfig>;
  /** The bot's size in percent (DESKTOP_PET_SCALES). */
  setDesktopPetScale?(scale: number): Promise<DesktopPetConfig>;
  resetDesktopPetPosition?(): Promise<DesktopPetConfig>;
  subscribeDesktopPetConfig?(listener: (config: DesktopPetConfig) => void): () => void;
  /** The pet menu's Settings item asks this window for Settings → Bots. */
  subscribeDesktopPetOpenSettings?(listener: () => void): () => void;
  /** Where the composer-pinned bot stands: over the transcript's column,
   *  and the width it takes at the composer's right end. */
  subscribeDesktopPetAppLayout?(listener: (layout: DesktopPetAppLayout) => void): () => void;
  publishDesktopPet?(state: DesktopPetState): void;
  /** The focused pane's composer card and its island pill's centre line
   *  (CSS px), or null when no card shows. */
  publishDesktopPetComposer?(composer: DesktopPetComposer | null): void;
  /** The app's chat look for the overlay. */
  publishDesktopPetTheme?(theme: DesktopPetTheme): void;
  /** The app's open floating layers: a backdrop modal hides the overlay, the rest cut it. */
  publishDesktopPetLayers?(layers: DesktopPetLayers): void;
  /** Whether the representative bot exists (the overlay needs it). */
  publishDesktopPetAvailable?(available: boolean): void;
  /** Fire-and-forget renderer perf timing line (MIXDOG_DESKTOP_PERF=1 only). */
  perfLog?(line: string): void;
  /** Privacy-bounded renderer failure/performance evidence; user content is never sent. */
  rendererDiagnostic?(diagnostic: DesktopRendererDiagnostic): void;
  /** First React commit signal — main defers window.show until it lands. */
  rendererReady?(): void;
  /** The running version's What's new notice was shown (or has no notes): main retires its pending announcement. */
  acknowledgeWhatsNew?(version: string): void;
  /** Dock terminal: create or reattach the shared PTY (main-process owned). */
  termEnsure?(
    id: string | null,
    cwd?: string | null,
    shell?: string | null
  ): Promise<{ id: string; replay: string; sizeOwner?: { cols: number; rows: number; own: boolean } }>;
  termWrite?(id: string, data: string): void;
  /** `phoneOwner`: the phone showing this terminal owns the PTY size (a
   *  non-positive size releases it); other views follow instead of fitting. */
  termResize?(id: string, cols: number, rows: number, phoneOwner?: boolean): void;
  termAcknowledge?(id: string, charCount: number): void;
  termDispose?(id: string): Promise<void>;
  subscribeTermData?(listener: (event: { id: string; data: string }) => void): () => void;
  /** A phone claimed, released or lost a PTY's size; other views follow or re-fit. */
  subscribeTermSizeOwner?(listener: (event: TerminalSizeOwnerEvent) => void): () => void;
  /** Every live terminal whose command activity is known (integrated shells). */
  termActivity?(): Promise<TerminalActivityEvent[]>;
  /** This view shows `id` focused (renewed while it stays so) or left it. */
  termFocus?(id: string, focused: boolean): void;
  subscribeTermActivity?(listener: (event: TerminalActivityEvent) => void): () => void;
  /** Shells detected on this machine for the terminal strip's picker. */
  termProfiles?(): Promise<Array<{ id: string; label: string; path: string; default?: boolean }>>;
  /** Dock Git panel: plain git CLI over the active project directory. */
  gitStatus?(cwd: string, options?: DesktopGitStatusOptions): Promise<DesktopGitStatus>;
  gitBranches?(cwd: string): Promise<DesktopGitBranch[]>;
  gitRenameBranch?(cwd: string, branch: string, nextBranch: string): Promise<string>;
  gitDeleteBranch?(cwd: string, branch: string): Promise<string>;
  gitDiff?(cwd: string, path: string, staged?: boolean, worktreeOnly?: boolean, untracked?: boolean): Promise<string>;
  gitApplyPatch?(cwd: string, path: string, patch: string, reverse?: boolean): Promise<void>;
  gitStage?(cwd: string, paths: string[]): Promise<void>;
  gitUnstage?(cwd: string, paths: string[]): Promise<void>;
  /**
   * `scope: 'extension'` writes the unanchored `*<ext>` rule derived from the
   * path's own extension; omitted/`'file'` keeps the rooted literal path.
   */
  gitIgnore?(cwd: string, path: string, scope?: DesktopGitIgnoreScope): Promise<void>;
  gitCommit?(cwd: string, message: string): Promise<string>;
  /**
   * Commit only `paths` (`git commit -m <message> -- <paths>`): every other
   * index entry survives untouched and each listed path commits its worktree
   * content, so the caller never stages or unstages around a commit.
   */
  gitCommitPaths?(cwd: string, message: string, paths: string[]): Promise<string>;
  gitAmend?(cwd: string, message?: string): Promise<string>;
  gitUndoLastCommit?(cwd: string): Promise<string>;
  gitStash?(cwd: string, message?: string): Promise<string>;
  gitStashPop?(cwd: string): Promise<string>;
  gitStashList?(cwd: string): Promise<DesktopGitStashEntry[]>;
  gitStashApply?(cwd: string, ref: string): Promise<string>;
  gitStashDrop?(cwd: string, ref: string): Promise<string>;
  ghPrList?(cwd: string): Promise<DesktopPullRequestCategory[]>;
  githubRequest?(cwd: string, input: GithubRequest): Promise<GithubResult>;
  ghPrDefaultBranch?(cwd: string): Promise<string>;
  ghPrCreate?(cwd: string, input: DesktopPullRequestCreateInput): Promise<DesktopPullRequestEntry>;
  ghPrView?(cwd: string, number: number): Promise<DesktopPullRequestDetail>;
  ghPrCheckout?(cwd: string, number: number): Promise<string>;
  ghPrMerge?(cwd: string, number: number, method: 'merge' | 'squash' | 'rebase'): Promise<string>;
  ghPrDiff?(cwd: string, number: number): Promise<string>;
  gitPush?(cwd: string): Promise<string>;
  gitFetch?(cwd: string): Promise<string>;
  gitPull?(cwd: string): Promise<string>;
  gitSync?(cwd: string): Promise<string>;
  gitContinue?(cwd: string): Promise<string>;
  gitAbortOperation?(cwd: string): Promise<string>;
  gitRevert?(cwd: string, path: string, untracked: boolean, mode?: 'worktree' | 'all'): Promise<void>;
  gitLog?(cwd: string, query?: string, skip?: number, limit?: number): Promise<DesktopGitLogEntry[]>;
  gitShow?(cwd: string, hash: string): Promise<DesktopGitCommitDetails>;
  gitShowDiff?(cwd: string, hash: string, path: string): Promise<string>;
  /** Island Git request: read-only snapshot of status, diffs, history and the branch's PR. */
  gitRequestContext?(cwd: string, input: { paths: string[]; base: string }): Promise<DesktopGitRequestContext>;
  /** Diff tab editor mode: file content at `HEAD`/`:0`/commit (null if absent). */
  gitShowFile?(cwd: string, rev: string, path: string): Promise<string | null>;
  /**
   * History context menu, gated narrowly: only
   * cherry-pick refuses on top of a live operation or a dirty worktree
   * (naming the files), checkout/branch carry safe local changes across, and
   * revert is left to git. A conflicted cherry-pick/revert stays resolvable
   * through `gitContinue`/`gitAbortOperation`.
   *
   * `--hard` reset refuses a dirty worktree outright. `--mixed` reset rewrites
   * the index — staged work becomes unstaged — so it REPORTS a dirty worktree
   * (message naming the files, `code: 'git-reset-dirty-worktree'`) instead of
   * doing it silently; pass `confirmedDirty` once the user has confirmed.
   */
  gitResetToCommit?(
    cwd: string,
    hash: string,
    mode: 'soft' | 'mixed' | 'hard',
    confirmedDirty?: boolean
  ): Promise<string>;
  gitRevertCommit?(cwd: string, hash: string): Promise<string>;
  gitCherryPickCommit?(cwd: string, hash: string): Promise<string>;
  gitCreateTag?(cwd: string, tag: string, hash: string): Promise<string>;
  gitDeleteTag?(cwd: string, tag: string): Promise<string>;
  /** Check out `hash` itself: a detached HEAD. */
  /**
   * Changes view: the working tree (incl. untracked) vs merge-base(default branch, HEAD)
   * for `branch` (default), or vs `HEAD` for `uncommitted`. Paths are repo-root-relative.
   */
  gitReview?(cwd: string, source?: DesktopGitReviewSource): Promise<DesktopGitReview>;
  gitReviewDiff?(cwd: string, path: string, untracked?: boolean, source?: DesktopGitReviewSource): Promise<string>;
  /** Batch `gitReviewDiff` (at most 512 files): one git diff plus untracked reads. */
  gitReviewDiffs?(
    cwd: string,
    files: DesktopGitReviewDiffRequest[],
    source?: DesktopGitReviewSource
  ): Promise<DesktopGitReviewDiffs>;
  /** Review file context menu: OS-level reveal/open for a project-relative file. */
  revealFile?(cwd: string, path: string, accessToken?: string): Promise<void>;
  openFilePath?(
    cwd: string,
    path: string,
    accessToken?: string,
    confirmedPath?: string
  ): Promise<void | FileLaunchConfirmation>;
  /** Transcript attachment chip: hand a submitted image to the OS viewer. The
   *  renderer holds those bytes only as a session-lifetime preview data URL, so
   *  they travel here and the main process owns the temp file. */
  openAttachmentImage?(dataUrl: string, name?: string): Promise<void>;
  /** Image data URL of a stored attachment blob by its content-addressed ref,
   *  for a thumbnail: downscaled (longest side ≤ 320 px) on the desktop, the
   *  bounded original for a paired phone; null when missing, unreadable or not
   *  an image. */
  readAttachmentThumbnail?(attachmentRef: string): Promise<string | null>;
  /** An attachment a message of this session carries, by id (the content hash
   *  recorded in the message metadata, or an older image's own reference),
   *  read from the host's attachment store as a `data:` URL. Rejects for an id
   *  the session's transcript does not name. Desktop windows only. */
  readSessionAttachment?(
    sessionId: string,
    attachmentId: string
  ): Promise<{ name: string; mimeType: string; size: number; dataUrl: string }>;
  /** A paired device: opens that attachment through the remote file preview —
   *  a staged file on the PC plus a one-file grant scoped to the session
   *  (`accessToken`), like any previewable file row. */
  openSessionAttachment?(sessionId: string, attachmentId: string): Promise<DesktopLocalPathEntry>;
  /** Any `data:` attachment → OS app, keeping the (safe) extension of `name`. */
  openAttachmentFile?(dataUrl: string, name: string): Promise<void>;
  /** Writes a `data:` attachment to the temp dir and returns a one-file access
   *  grant, so the editor pane can open it like a chat file link. */
  stageAttachmentFile?(dataUrl: string, name: string): Promise<DesktopLocalPathEntry>;
  /** Save an http(s) or data URL through a save dialog; false when cancelled. */
  saveFileAs?(source: string, suggestedName?: string): Promise<boolean>;
  getUpdaterState(): Promise<DesktopUpdaterState>;
  subscribeUpdaterState(listener: (state: DesktopUpdaterState) => void): () => void;
  checkForDesktopUpdate(): Promise<DesktopUpdaterState>;
  showDesktopUpdate(): Promise<DesktopUpdaterState>;
  /** Atomically materialize a renderer-only draft and accept its first prompt. */
  submitNewTask(
    prompt: DesktopPromptContent,
    options?: DesktopSubmitOptions,
    draft?: DesktopNewTaskDraft
  ): Promise<DesktopNewTaskSubmitResult>;
  /** Split panes: prompt/abort/approvals addressed to any pooled live
   *  session (active or parked), keyed by sessionId. */
  submitToSession(sessionId: string, prompt: DesktopPromptContent, options?: DesktopSubmitOptions): Promise<boolean>;
  abortSession(sessionId: string, options?: DesktopAbortOptions): Promise<unknown>;
  resolveToolApprovalForSession(sessionId: string, id: string, decision: ToolApprovalDecision): Promise<boolean>;
  /** Secret input card: hands the value to this PC's main process for the
   *  request id; it is filled into the target field and never leaves this
   *  PC. Desktop only (absent on paired remote clients). */
  provideSecretInput?(requestId: string, value: string): Promise<boolean>;
  /** Resolves true once the agent is stopped for takeover `id` (its commands
   *  refused, in-flight work drained), false when it ends first. Desktop only. */
  takeoverReady?(sessionId: string, id: string): Promise<boolean>;
  /** Per-agent push mute (profile panel, contact menu): pushes only. */
  getAgentNotificationMute(agentId: string): Promise<boolean>;
  setAgentNotificationMute(agentId: string, muted: boolean): Promise<boolean>;
  /** Per-session live snapshot lane covering every pooled session runtime. */
  subscribeSessionState(listener: (update: DesktopSessionStateUpdate) => void): () => void;
  listProviderModels(options?: DesktopModelCatalogOptions): Promise<DesktopModelOption[]>;
  /** sessionId addresses a pane. Omitted routes through the control session
   *  for settings that are not owned by a conversation. */
  setModelRoute(selection: DesktopModelSelection, sessionId?: string): Promise<SessionSnapshot>;
  setFast(enabled: boolean, sessionId?: string): Promise<SessionSnapshot>;
  readSettings(): Promise<DesktopSettings>;
  updateSetting(key: DesktopSettingKey, enabled: boolean): Promise<DesktopSettings>;
  /** Desktop-only: notification sound volume in percent. */
  setNotificationVolume?(volume: number): Promise<DesktopSettings>;
  /** Desktop-only: play the notification sound at the saved volume. */
  previewNotificationSound?(): Promise<string>;
  /** A desktop setting or the global Git identity was written (here or on the host). */
  subscribeSettingsChanged?(listener: (change: SettingsChange) => void): () => void;
  /** Remote clients only: the host window's theme preference and UI language. */
  readHostDisplayPreferences?(): Promise<HostDisplayPreferences | null>;
  readActivityRailPins(): Promise<ActivityRailPinsState | null>;
  /** Only Electron seeds a missing shared value from its existing local pins. */
  updateActivityRailPins(pins: string[], initializeIfMissing?: boolean): Promise<ActivityRailPinsState>;
  subscribeActivityRailPins(listener: (state: ActivityRailPinsState) => void): () => void;
  /** Fire-and-forget: tell every window and paired client the provider model list changed. */
  notifyProviderModelsChanged(origin: string): void;
  subscribeProviderModelsChanged(listener: (change: ProviderModelsChange) => void): () => void;
  getZoomFactor(): Promise<number>;
  setZoomFactor(factor: number): Promise<number>;
  onZoomFactorChanged(listener: (factor: number) => void): () => void;
  /** Desktop host only: the user clicked a "task finished" OS notification. */
  onNotificationOpenSession?(listener: (sessionId: string) => void): () => void;
  /** Agent browser bridge (desktop host only): retain the owning session's
   *  Browser surface and optionally reveal its dock for a foreground call. */
  onBrowserOpenRequested?(listener: (request: DesktopBrowserOpenRequest) => void): () => void;
  /** Agent `terminal` tool (desktop host only): reveal a session's terminal
   *  dock, opening a tab and entering `command` when it has none. */
  onTerminalRunRequested?(listener: (request: DesktopTerminalRunRequest) => void): () => void;
  /** Agent `terminal` tool: true while the tool call still waits on this
   *  request, which makes the renderer's entering of its command final. */
  claimTerminalRun?(requestId: string): Promise<boolean>;
  /** Agent `visualize` tool (desktop host only): a session's side-panel tabs
   *  changed, a reveal was asked for, or a web URL goes to the browser panel. */
  onVisualizeChanged?(listener: (event: DesktopVisualizeEvent) => void): () => void;
  /** Every session's visualize tabs, for a renderer that (re)loads. */
  visualizeState?(): Promise<VisualizeSessionState[]>;
  /** The user picked or closed a visualize tab (or exported it, or picked
   *  an entry of the session's list); an export answers with where it went. */
  visualizeCommand?(command: DesktopVisualizeTabCommand): Promise<VisualizeCommandResult | void>;
  /** The source text of a displayed visualize pane (an HTML file; the host
   *  caps it), for the panel's source view. */
  visualizePaneText?(sessionId: string, tabId: string, index: number): Promise<VisualizePaneText>;
  /** Paired web app only: one visualize pane's content, fetched over the
   *  encrypted RPC lane (pane URLs name the host's loopback servers). */
  visualizePaneSource?(sessionId: string, tabId: string, index: number): Promise<VisualizePaneSource>;
  /** Paired web app only: a PDF or Office pane rasterized to page images
   *  (a phone cannot show a PDF in a frame). */
  visualizePanePages?(
    sessionId: string,
    tabId: string,
    index: number,
    options: { pages: number[]; maxWidth?: number }
  ): Promise<DesktopDocumentPreviewPages>;
  /** Paired web app only: render displayed pane `pane` as PNG / PDF on the
   *  host and answer with the download source this device redeems. */
  visualizeExport?(
    sessionId: string,
    tabId: string,
    format: 'png' | 'pdf',
    pane: number
  ): Promise<VisualizeRemoteExport>;
  /** Desktop only: run the feedback page script (Comment pins, `data-choice`
   *  picks) in a visualize tab's loaded HTML panes. */
  visualizeFeedbackAttach?(sessionId: string, tabId: string): Promise<void>;
  /** Desktop only: base64 PNG of an area of this window (CSS px), a pin's crop. */
  visualizeCaptureRect?(rect: { x: number; y: number; width: number; height: number }): Promise<string>;
  /** Desktop only: spend one real user gesture main saw inside this pane on
   *  a `data-choice` pick; false when there is none. */
  visualizeConsumeGesture?(target: { sessionId: string; tabId: string; pane: number }): Promise<boolean>;
  /** Desktop only: the visualize side panel's content size (CSS px), so the
   *  agent's off-screen `inspect` / `check` lay pages out at it. */
  visualizePanelSize?(size: { width: number; height: number }): Promise<void>;
  /** Runtime unload frees pixels but retains the session's dock selection. */
  onBrowserSessionReleased?(listener: (sessionId: string, reason?: 'unloaded' | 'gone') => void): () => void;
  /** Bind one persistent guest to its owning conversation session. */
  browserSetActiveGuest?(sessionId: string, webContentsId: number, active: boolean): Promise<void>;
  /** Free the page behind a closed main-workspace browser tab. */
  browserReleasePage?(pageId: string): Promise<void>;
  browserPageFrame?(
    sessionId: string,
    previousFrameId?: string
  ): Promise<DesktopBrowserPageFrame | DesktopBrowserPageResample>;
  browserPresentTexture?(sessionId: string, textureId: string, canvasId: string): void;
  browserDiscardTexture?(sessionId: string): void;
  browserPageControl?(
    sessionId: string,
    input: DesktopBrowserPageControl
  ): Promise<DesktopBrowserTabControlResult | void>;
  /** Page facts without pixels, while the page is natively presented. */
  browserPageMetadata?(sessionId: string): Promise<DesktopBrowserPageFrame>;
  /** Present the session's page natively over `rect` (CSS pixels of this
   *  window), or park it with null. `enabled` is false when the host does not
   *  present pages natively; the pane then keeps its pixel display. */
  browserPresentNative?(
    sessionId: string,
    rect: { x: number; y: number; width: number; height: number } | null
  ): Promise<{ enabled: boolean; shown: boolean }>;
  /** Apply pane-owned device emulation to the exact visible Browser guest. */
  browserConfigureGuestViewport?(
    sessionId: string,
    webContentsId: number,
    config: DesktopBrowserViewportConfig
  ): Promise<void>;
  /** The visible guest's device metrics changed — by the pane's own picker or
   *  by the agent's emulate command. `viewport` is null when metrics were
   *  cleared. The pane draws a centered device frame at this size. */
  onBrowserGuestViewportChanged?(listener: (change: DesktopBrowserGuestViewportChange) => void): () => void;
  /** A phone started or stopped viewing a session's guest through the relay.
   *  A guest parked off-window produces no frames, so its capture hangs; the
   *  renderer keeps a remotely viewed guest inside the window while active. */
  onBrowserRemoteViewerChanged?(listener: (change: DesktopBrowserRemoteViewerChange) => void): () => void;
  /** A session's shown page entered or left element fullscreen; the window is
   *  fullscreen meanwhile and the pane fills it. */
  onBrowserFullscreenChanged?(listener: (change: DesktopBrowserFullscreenChange) => void): () => void;
  /** Local Chrome profile import into the isolated Browser Use partition.
   *  Secrets stay in main/native processes; renderer receives metadata/counts. */
  /** A Browser Use submit/post/upload awaiting this person's one-time answer
   *  (shown as an in-app card), or `closed` once it is answered or expired. */
  onBrowserApproval?(
    listener: (
      prompt:
        | { id: string; closed: true }
        /** The person chose "always allow" but it could not be saved: it ran once. */
        | { id: string; saveFailed: true }
        | {
            id: string;
            closed?: false;
            action: string;
            url: string;
            sessionId: string;
            /** The top-level chat the card docks in (a sub-agent's root chat). */
            surfaceSessionId?: string;
            /** The bot whose own chat asks (its face on the card); '' otherwise. */
            agentId?: string;
            /** The asking bot's or session's name; '' when it could not be resolved. */
            requester: string;
            target: string;
            paths: string[];
            /** Upload only: the page's origin, the origin of the frame document
             *  that receives the files ('' = not confirmed), and each file
             *  (`outside`: beyond the session's working directory and Downloads). */
            origin?: string;
            receiverOrigin?: string;
            files?: Array<{ name: string; path: string; size: number; outside: boolean }>;
            /** Set when a standing "always allow" may be recorded for this bot
             *  and these kinds of step (`submit`, `post`, `upload`); null = it only asks once. */
            remember: { kinds: Array<'submit' | 'post' | 'upload' | 'confirm'> } | null;
          }
    ) => void
  ): () => void;
  /** A paired device only: the sessions with a Browser Use approval waiting on
   *  the PC, now and after each change. Marks only; it is answered on the PC. */
  onBrowserApprovalSessions?(listener: (sessionIds: string[]) => void): () => void;
  /** `reason`: a denial's note for the asking agent (what to do instead). */
  browserApprovalDecide?(id: string, decision: 'once' | 'always' | 'deny', reason?: string): Promise<void>;
  browserProfileImportSources?(): Promise<DesktopBrowserImportSource[]>;
  browserProfileImportStart?(request: DesktopBrowserImportRequest): Promise<DesktopBrowserImportResult>;
  onBrowserProfileImportProgress?(listener: (progress: DesktopBrowserImportProgress) => void): () => void;
  browserHistorySearch?(query: string): Promise<DesktopBrowserHistoryEntry[]>;
  /** Current session's Browser Use page only. Passwords never cross this API. */
  browserCredentialSuggestions?(sessionId: string): Promise<DesktopBrowserCredentialSuggestion[]>;
  browserCredentialFill?(sessionId: string, credentialId: string): Promise<DesktopBrowserCredentialFillResult>;
  /** "로그인 유지 중인 사이트": site names and cookie counts, never values. */
  browserSignedInSites?(): Promise<DesktopBrowserSignedInSite[]>;
  /** 로그아웃: that site's cookies and page storage. */
  browserSignOutSite?(site: string): Promise<number>;
  /** 전체 지우기: every sign-in, all site storage and the data imported from Chrome. */
  browserClearSignIns?(): Promise<void>;
  /** A login takeover's sign-in window, bound to takeover `id` of `sessionId`
   *  as this PC saw it: opens (or focuses) it once the agent is stopped and
   *  resolves with how it ended. Desktop only; a phone shows the pending state. */
  browserLoginOpen?(sessionId: string, id: string): Promise<DesktopBrowserLoginStatus>;
  browserLoginStatus?(sessionId: string, id: string): Promise<DesktopBrowserLoginStatus>;
  /** What the in-app browser saw of `url` (or of its site), or null.
   *  `preview`: a page card asks, so a missing thumbnail is fetched from the
   *  page's own preview and announced through onBrowserPageIdentityChanged. */
  browserPageIdentity?(url: string, options?: { preview?: boolean }): Promise<DesktopBrowserPageIdentity | null>;
  /** Identity facts changed for pages of `origin`. */
  onBrowserPageIdentityChanged?(listener: (origin: string) => void): () => void;
  /** Paired web app live view of the desktop's current Browser Use guest,
   * preserving its cookies and agent-visible page. Options start or renew the
   * session's pushed frame stream (renew within 2s while shown; the desktop
   * stops a stream not renewed for 4s); null stops it. */
  remoteBrowserStream?(sessionId: string, options: DesktopRemoteBrowserStreamOptions | null): Promise<void>;
  /** Acknowledge a displayed frame so the desktop sends the newest next one. */
  remoteBrowserStreamAck?(sessionId: string, seq: number): void;
  onRemoteBrowserFrame?(listener: (frame: DesktopRemoteBrowserStreamFrame) => void): () => void;
  remoteBrowserControl?(
    sessionId: string,
    input: DesktopRemoteBrowserControl
  ): Promise<DesktopBrowserTabControlResult | void>;
  /** Paired web app: the current host advertised `browserDrive` and takes the
   *  `viewport` control (the streamed page renders at the phone's size). */
  readonly remoteBrowserDrive?: boolean;
  /** Paired web app: the current host advertised `browserSessionTabs`, so a
   *  conversation browser's tabs arrive in its frames and `new-tab`,
   *  `select-tab` and `close-tab` controls are accepted. */
  readonly remoteBrowserSessionTabs?: boolean;
  /** Paired web app: the current host advertised `termSizeOwner` and honors
   *  the phone size-owner claim/release on `termResize`. Absent/false on an
   *  older host, where the phone sends plain fit resizes only. */
  readonly remoteTermSizeOwner?: boolean;
  /** Paired web app, host advertising `browserParity` only (absent otherwise,
   *  as are the history, saved-login and profile-import members above):
   *  the main-workspace browser tabs. `watch` starts or stops pushes to
   *  onRemoteBrowserTabs and, when starting, answers the current list. */
  remoteBrowserTabs?(watch: boolean): Promise<DesktopRemoteBrowserTab[]>;
  remoteBrowserOpenTab?(url: string): Promise<DesktopRemoteBrowserTab>;
  remoteBrowserCloseTab?(id: string): Promise<void>;
  onRemoteBrowserTabs?(listener: (tabs: DesktopRemoteBrowserTab[]) => void): () => void;
  /** systemPreference keeps DWM on 'system' so OS theme tracking survives. */
  applyTitleBarTheme(theme: string, systemPreference?: boolean): Promise<void>;
  /** Scrim-composited WCO caption colors while a fullscreen modal is open;
   *  null restores the theme band. */
  setTitleBarDim(dim: { color: string; symbolColor: string } | null): Promise<void>;
  /** Installed font families of THIS computer (Settings → Appearance); empty
   *  when the OS listing fails. Desktop app only. */
  listSystemFonts?(): Promise<string[]>;
  invokeCapability<T = unknown>(request: DesktopCapabilityRequest): Promise<DesktopCapabilityResult<T>>;
  readCapabilities(requests: DesktopCapabilityReadRequest[]): Promise<DesktopCapabilityReadResult[]>;
  /** Direct URL for one media asset/rendition, or '' when this host has no
   *  media transport. Gallery bytes ride THIS url (cacheable, range-able),
   *  never the RPC lane. */
  mediaUrl?(assetId: string, variant?: string): string;
  quit(): Promise<void>;
}
