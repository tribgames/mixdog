import type { GithubRequest, GithubResult } from '../../../../src/runtime/github/contract.mjs';
import type {
  DesktopAbortOptions,
  DesktopAgentPoolRow,
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
  DesktopBrowserCredentialFillResult,
  DesktopBrowserCredentialSuggestion,
  DesktopBrowserDataClearResult,
  DesktopBrowserDataScope,
  DesktopBrowserGuestViewportChange,
  DesktopBrowserHistoryEntry,
  DesktopBrowserImportProgress,
  DesktopBrowserImportRequest,
  DesktopBrowserImportResult,
  DesktopBrowserImportSource,
  DesktopBrowserOpenRequest,
  DesktopBrowserPageControl,
  DesktopBrowserPageFrame,
  DesktopBrowserPageResample,
  DesktopBrowserRemoteViewerChange,
  DesktopBrowserViewportConfig,
  DesktopRemoteBrowserControl,
  DesktopRemoteBrowserFrame,
} from './contract-browser';
import type {
  DesktopGitBranch,
  DesktopGitCliStatus,
  DesktopGitCommitDetails,
  DesktopGitGlobalConfig,
  DesktopGitGlobalConfigKey,
  DesktopGitIgnoreScope,
  DesktopGitLogEntry,
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
  DesktopRemoteClientClaim,
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
export * from './contract-session';
export * from './contract-capabilities';
export * from './contract-settings';
export * from './contract-browser';
export * from './contract-git';
export * from './contract-workspace';

export type { GithubRequest, GithubResult } from '../../../../src/runtime/github/contract.mjs';

/** Small, last-writer-wins UI projection shared by Electron and paired web
 * clients. Pane geometry remains local; `selection` is the first visual pane. */
export interface DesktopApi {
  /** Immutable process timeline identity injected before renderer modules run. */
  readonly bootContext?: DesktopBootContext;
  chooseProject(): Promise<string | null>;
  chooseFile?(defaultPath?: string | null): Promise<{
    projectPath: string;
    relPath: string;
    accessToken?: string;
  } | null>;
  chooseFiles?(defaultPath?: string | null): Promise<DesktopLocalPathEntry[] | null>;
  chooseWorkspace?(): Promise<DesktopWorkspace | null>;
  saveWorkspace?(workspaceFile: string | null, folders: DesktopWorkspaceFolder[]): Promise<DesktopWorkspace | null>;
  readEditorSettings?(projectPath: string, relPath: string, workspaceFile?: string): Promise<DesktopEditorSettings>;
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
  /** Desktop-only chat link opener, confined to the conversation's Project:
   *  documents launch their OS app, folders open in the file manager, and
   *  text files come back as 'editor' for the renderer to open itself. */
  openLocalFileLink?(projectPath: string, href: string): Promise<'file' | 'folder' | 'editor'>;
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
  libreOfficeStatus?(): Promise<DesktopLibreOfficeStatus>;
  installLibreOffice?(): Promise<DesktopLibreOfficeStatus>;
  githubCliStatus?(): Promise<DesktopGithubCliStatus>;
  installGithubCli?(): Promise<DesktopGithubCliStatus>;
  githubCliLoginStart?(): Promise<DesktopGithubCliLoginFlow>;
  githubCliLoginStatus?(flowId: string): Promise<DesktopGithubCliLoginFlow>;
  githubCliLoginCancel?(flowId: string): Promise<void>;
  githubCliLogout?(): Promise<DesktopGithubCliStatus>;
  githubCliAccount?(): Promise<DesktopGithubCliAccount>;
  /** Settings → Git: global git identity/defaults (`git config --global`). */
  gitGlobalConfig?(): Promise<DesktopGitGlobalConfig>;
  setGitGlobalConfig?(key: DesktopGitGlobalConfigKey, value: string): Promise<DesktopGitGlobalConfig>;
  renameProject(projectPath: string, alias: string): Promise<void>;
  removeProject(projectPath: string): Promise<void>;
  /** Instructions editor (Projects page). `projectPath: null` targets the
   *  common instructions file (data/instructions.md → "# Common Instructions");
   *  a project path targets `<project>/.mixdog/instructions.md`
   *  ("# Project Instructions", injected at session start). Optional: the
   *  remote shim omits both and the UI hides the editor. */
  readInstructions?(projectPath: string | null): Promise<string>;
  writeInstructions?(
    projectPath: string | null,
    content: string,
    expectedContent?: string
  ): Promise<{ backupPath: string } | void>;
  /** Dock Files tab: lazy per-directory listing. */
  listProjectDir?(projectPath: string, relDir: string): Promise<DesktopDirEntry[]>;
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
   *  ask for the rest as it scrolls. */
  previewDocumentPages?(
    projectPath: string,
    relPath: string,
    accessToken?: string,
    options?: { pages?: number[]; maxWidth?: number }
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
  trashProjectEntry?(projectPath: string, relPath: string): Promise<void>;
  /** Explorer DnD / cut-paste: move an entry into another project folder. */
  moveProjectEntry?(projectPath: string, relPath: string, targetDirRel: string): Promise<void>;
  /** Explorer copy-paste: copy an entry; collisions get "name copy" names. */
  copyProjectEntry?(projectPath: string, relPath: string, targetDirRel: string): Promise<{ name: string }>;
  /** Absolute path of an OS-native dropped File (webUtils.getPathForFile). */
  folderPathForFile?(file: File): string;
  /** Resolve trusted local paths for file-tab opening and internal drag/drop. */
  resolveLocalPaths?(paths: string[]): Promise<DesktopLocalPathEntry[]>;
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
  subscribeAgentPool?(listener: (agents: DesktopAgentPoolRow[]) => void): () => void;
  renameSession(sessionId: string, title: string): Promise<void>;
  setSessionArchived?(sessionId: string, archived: boolean): Promise<void>;
  deleteSession(sessionId: string): Promise<SessionSnapshot>;
  /** /inherit — copy this conversation into a NEW session id that runs on the
   *  supplied (currently selected) model. The source session is left as it is,
   *  so both transcripts continue from the same point. */
  inheritSession(
    sourceSessionId: string,
    route?: DesktopModelSelection | null
  ): Promise<{ sessionId: string; snapshot: SessionSnapshot | null }>;
  /** Settings → Connection: pairing QRs + URLs for the phone remote. Only
   *  the in-process desktop implements it (null while the bridge is off);
   *  the remote shim omits it — a phone never needs its own pairing card. */
  getRemoteAccessInfo?(): Promise<DesktopRemoteAccessInfo | null>;
  /** Settings → Connection: revoke every paired phone by minting a new
   *  pairing token and restarting the bridge/relay legs. */
  rotateRemoteAccess?(): Promise<DesktopRemoteAccessInfo | null>;
  /** Settings → Connection: revoke one browser while preserving every other
   *  browser's individual credential. */
  revokeRemoteAccessClient?(clientId: string): Promise<DesktopRemoteAccessInfo | null>;
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
  searchProjectFiles(projectIdOrWorkspaceId: string, query: string, limit?: number): Promise<string[]>;
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
  /** Fire-and-forget renderer perf timing line (MIXDOG_DESKTOP_PERF=1 only). */
  perfLog?(line: string): void;
  /** Privacy-bounded renderer failure/performance evidence; user content is never sent. */
  rendererDiagnostic?(diagnostic: DesktopRendererDiagnostic): void;
  /** First React commit signal — main defers window.show until it lands. */
  rendererReady?(): void;
  /** Dock terminal: create or reattach the shared PTY (main-process owned). */
  termEnsure?(id: string | null, cwd?: string | null, shell?: string | null): Promise<{ id: string; replay: string }>;
  termWrite?(id: string, data: string): void;
  termResize?(id: string, cols: number, rows: number): void;
  termAcknowledge?(id: string, charCount: number): void;
  termDispose?(id: string): Promise<void>;
  subscribeTermData?(listener: (event: { id: string; data: string }) => void): () => void;
  /** Shells detected on this machine for the terminal strip's picker. */
  termProfiles?(): Promise<Array<{ id: string; label: string; path: string; default?: boolean }>>;
  /** Dock Git panel: plain git CLI over the active project directory. */
  gitStatus?(cwd: string, options?: DesktopGitStatusOptions): Promise<DesktopGitStatus>;
  gitBranches?(cwd: string): Promise<DesktopGitBranch[]>;
  gitCheckoutBranch?(cwd: string, branch: string, remote?: boolean): Promise<string>;
  gitCreateBranch?(cwd: string, branch: string): Promise<string>;
  gitRenameBranch?(cwd: string, branch: string, nextBranch: string): Promise<string>;
  gitDeleteBranch?(cwd: string, branch: string): Promise<string>;
  /** Merge `branch` into the checked-out branch; conflicts reject with detail. */
  gitMergeBranch?(cwd: string, branch: string): Promise<string>;
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
  gitCheckoutCommit?(cwd: string, hash: string): Promise<string>;
  gitCreateBranchAtCommit?(cwd: string, branch: string, hash: string): Promise<string>;
  /** Review pane: cumulative diff of the working tree vs merge-base(origin default branch, HEAD). */
  gitReview?(cwd: string): Promise<{
    base: string;
    files: Array<{
      path: string;
      status: string;
      additions: number;
      deletions: number;
      untracked: boolean;
      uncommitted: boolean;
    }>;
  }>;
  gitReviewDiff?(cwd: string, path: string, untracked?: boolean): Promise<string>;
  /** Review file context menu: OS-level reveal/open for a project-relative file. */
  revealFile?(cwd: string, path: string, accessToken?: string): Promise<void>;
  openFilePath?(cwd: string, path: string, accessToken?: string): Promise<void>;
  /** Transcript attachment chip: hand a submitted image to the OS viewer. The
   *  renderer holds those bytes only as a session-lifetime preview data URL, so
   *  they travel here and the main process owns the temp file. */
  openAttachmentImage?(dataUrl: string, name?: string): Promise<void>;
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
  /** Per-session live snapshot lane covering every pooled session runtime. */
  subscribeSessionState(listener: (update: DesktopSessionStateUpdate) => void): () => void;
  listProviderModels(options?: DesktopModelCatalogOptions): Promise<DesktopModelOption[]>;
  /** sessionId addresses a pane. Omitted routes through the control session
   *  for settings that are not owned by a conversation. */
  setModelRoute(selection: DesktopModelSelection, sessionId?: string): Promise<SessionSnapshot>;
  setFast(enabled: boolean, sessionId?: string): Promise<SessionSnapshot>;
  readSettings(): Promise<DesktopSettings>;
  updateSetting(key: DesktopSettingKey, enabled: boolean): Promise<DesktopSettings>;
  getZoomFactor(): Promise<number>;
  setZoomFactor(factor: number): Promise<number>;
  onZoomFactorChanged(listener: (factor: number) => void): () => void;
  /** Agent browser bridge (desktop host only): retain the owning session's
   *  Browser surface and optionally reveal its dock for a foreground call. */
  onBrowserOpenRequested?(listener: (request: DesktopBrowserOpenRequest) => void): () => void;
  /** Runtime unload frees pixels but retains the session's dock selection. */
  onBrowserSessionReleased?(listener: (sessionId: string, reason?: 'unloaded' | 'gone') => void): () => void;
  /** Bind one persistent guest to its owning conversation session. */
  browserSetActiveGuest?(sessionId: string, webContentsId: number, active: boolean): Promise<void>;
  browserPageFrame?(
    sessionId: string,
    previousFrameId?: string
  ): Promise<DesktopBrowserPageFrame | DesktopBrowserPageResample>;
  browserPresentTexture?(sessionId: string, textureId: string, canvasId: string): void;
  browserDiscardTexture?(sessionId: string): void;
  browserPageControl?(sessionId: string, input: DesktopBrowserPageControl): Promise<void>;
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
  /** Local Chrome profile import into the isolated Browser Use partition.
   *  Secrets stay in main/native processes; renderer receives metadata/counts. */
  browserProfileImportSources?(): Promise<DesktopBrowserImportSource[]>;
  browserProfileImportStart?(request: DesktopBrowserImportRequest): Promise<DesktopBrowserImportResult>;
  onBrowserProfileImportProgress?(listener: (progress: DesktopBrowserImportProgress) => void): () => void;
  browserHistorySearch?(query: string): Promise<DesktopBrowserHistoryEntry[]>;
  /** Reclaim what the shared Browser Use partition accumulated on disk. Each
   *  scope is answered on its own so a partial result is never reported as a
   *  clean sweep: cache is free to lose, site data and cookies are not. */
  browserClearData?(scopes: DesktopBrowserDataScope[]): Promise<DesktopBrowserDataClearResult>;
  /** Current session's Browser Use page only. Passwords never cross this API. */
  browserCredentialSuggestions?(sessionId: string): Promise<DesktopBrowserCredentialSuggestion[]>;
  browserCredentialFill?(sessionId: string, credentialId: string): Promise<DesktopBrowserCredentialFillResult>;
  /** Paired web app: pixels and bounded human input target the desktop's
   * current Browser Use guest, preserving its cookies and agent-visible page. */
  remoteBrowserFrame?(sessionId: string, previousFrameId?: string): Promise<DesktopRemoteBrowserFrame>;
  remoteBrowserControl?(sessionId: string, input: DesktopRemoteBrowserControl): Promise<void>;
  /** systemPreference keeps DWM on 'system' so OS theme tracking survives. */
  applyTitleBarTheme(theme: string, systemPreference?: boolean): Promise<void>;
  /** Scrim-composited WCO caption colors while a fullscreen modal is open;
   *  null restores the theme band. */
  setTitleBarDim(dim: { color: string; symbolColor: string } | null): Promise<void>;
  invokeCapability<T = unknown>(request: DesktopCapabilityRequest): Promise<DesktopCapabilityResult<T>>;
  readCapabilities(requests: DesktopCapabilityReadRequest[]): Promise<DesktopCapabilityReadResult[]>;
  /** Direct URL for one media asset/rendition, or '' when this host has no
   *  media transport. Gallery bytes ride THIS url (cacheable, range-able),
   *  never the RPC lane. */
  mediaUrl?(assetId: string, variant?: string): string;
  quit(): Promise<void>;
}
