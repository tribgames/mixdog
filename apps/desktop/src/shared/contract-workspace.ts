// Sessions, projects, workspaces, editor, LSP, renderer diagnostics, boot,
// workspace text search, local files and document previews.
import type { DesktopSessionWorkspace } from './contract-worktree';
import type { RoutineProvenance } from '../../../../src/runtime/agent/orchestrator/session/routine-result.mjs';

/** A schedule's or webhook's run result, as routine-result.mjs normalizes it. */
export type { RoutineProvenance };

export type DesktopSessionClassification = 'task' | 'project' | null;

/** Pairing card data for Settings → Connection (QRs pre-rendered as SVG in
 *  the main process so the renderer needs no QR dependency). */
export interface DesktopRemoteClientInfo {
  id: string;
  name: string;
  platform: string;
  browser: string;
  createdAt: number;
  lastSeenAt: number;
  online: boolean;
  /** Unpair requested but not yet acknowledged by the relay; still paired there. */
  pendingRemoval?: boolean;
  /** Local nickname set on this PC; shown instead of `name` when present. */
  alias?: string;
}

export interface DesktopRemoteAccessInfo {
  /** The pairing URL the QR encodes. Never shown in the UI. */
  relayBrowserUrl: string;
  relayBrowserQrSvg: string;
  /** QR of `<relay origin>/app`: the Mixdog app install page. The Phone
   *  segment shows it beside the 6-digit code. */
  relayAppQrSvg: string;
  /** Where a browser enters a 6-digit code (relay origin + /connect). Shown as
   *  plain text. */
  relayConnectUrl: string;
  clients: DesktopRemoteClientInfo[];
  /** False while "Use this PC from other devices" is off: no relay link, so
   *  the URLs are empty and `clients` is the last list seen. */
  enabled?: boolean;
}

/** "Use this PC from other devices" and this PC's name as other devices see it. */
export interface DesktopRemoteAccessSettings {
  enabled: boolean;
  /** Saved PC name, or `defaultName` when none is saved. */
  name: string;
  /** The OS hostname. */
  defaultName: string;
}

/** The 6-digit code of an open Settings → Connection screen. */
export interface DesktopRemotePairCode {
  /** Six digits, no separator. */
  code: string;
  expiresAt: number;
}

/** The relay cannot issue codes (older relay): show no code, say why. */
export interface DesktopRemotePairCodeUnsupported {
  unsupported: true;
}

/** An installed web app asking this desktop for access. It arrives with no
 *  credential — approving it here is what creates one. */
export interface DesktopRemoteClientClaim {
  claimId: string;
  clientId: string;
  name: string;
  platform: string;
  browser: string;
  /** Another Mixdog desktop app's remote window is asking. */
  desktop?: boolean;
  /** QR/route, or a relay-redeemed 6-digit code. Absent from older hosts. */
  method?: 'qr' | 'code' | 'retry';
  /** When the request arrived on this desktop (epoch ms). */
  requestedAt?: number;
  expiresAt: number;
}

/** A saved "Connect to another PC" host on this machine. */
export interface DesktopRemoteHost {
  id: string;
  name: string;
  /** The host's pairing link: the relay origin plus its device route. */
  url: string;
  addedAt: number;
  lastConnectedAt: number | null;
  /** Whether its window is open right now. */
  open: boolean;
  /** Whether the host's desktop is connected to its relay right now. Absent
   *  when the relay could not be asked. */
  online?: boolean;
}

/** A group room as its log session's catalog row carries it. */
export interface DesktopAgentRoomSummary {
  id: string;
  name: string;
  /** Member agent ids in speaking order. */
  members: string[];
  maxRounds: number;
  maxMessages: number;
  /** Members also see each other's tool output, not only their words. */
  shareTools: boolean;
  /** Who said the last line: an agent id, or 'user'. */
  lastSpeaker?: string;
  /** The last line said (the user's or a member's words), for the list row. */
  lastPreview?: string;
  /** Display names by member agent id, as the host last resolved them. */
  memberNames?: Record<string, string>;
  /** Members are speaking right now. */
  running?: boolean;
}

export interface DesktopSessionSummary {
  id: string;
  /** Presentation classification only; all sessions share lifecycle operations. */
  agentSession?: boolean;
  preview: string;
  title: string;
  updatedAt: number;
  /** User-visible conversation activity; unlike updatedAt, lifecycle-only
   *  resume/detach saves do not advance this timestamp. */
  activityAt?: number;
  /** User/assistant message count — the unread dot keys off GROWTH here, not
   *  updatedAt, so housekeeping saves never re-dot an already-checked session. */
  messageCount: number;
  /** Places (in `messageCount` numbering) of the last incoming chat messages of
   *  a bot home / room log; the unread pill counts those past the read cursor
   *  (shared/incoming-tail.ts). Absent when unknown. */
  incomingTail?: number[];
  /** Host-persisted read cursor shared by desktop and paired mobile surfaces. */
  readMessageCount?: number;
  /** Monotonic cursor revision; advances for completion-only reads too. */
  readRevision?: number;
  cwd: string;
  classification: DesktopSessionClassification;
  projectPath: string | null;
  /** The daemon's in-memory run state has a turn of this session (or its agents) in flight; independent of which session is selected. */
  working?: boolean;
  /** The daemon is running this session's own Lead turn, excluding child-agent work. */
  leadWorking?: boolean;
  /** The daemon is running a child agent owned by this lead session. */
  agentWorking?: boolean;
  /** Archive: hidden from Recent, restorable; file stays on disk. */
  archived?: boolean;
  /** Favorite: pinned to the Favorites section above Recent. */
  favorite?: boolean;
  /** The agent whose home thread this is: shown as that agent's contact in
   *  the Agents pane, never in the session lists. */
  agentHome?: string;
  /** That home's bot was deleted: the chat stays to read, never to send. */
  agentDeleted?: boolean;
  /** The agent that created this coding task session (session create): the
   *  Agents pane lists it under that agent's contact. */
  taskAgent?: string;
  /** Where `taskAgent` created it: its own chat (`home`), a group room, or a
   *  schedule/webhook run; absent when not recorded (an older session). Only a
   *  `home` task acts as the bot for Browser Use approvals. */
  taskFrom?: 'home' | 'room' | 'run';
  /** 'agent' for a Lead created as an agent (an agent home, a room member, an
   *  agent's schedule/webhook run: session/agent-mode.mjs); absent = coding. */
  sessionMode?: 'agent';
  /** A group room's log (agent-rooms.ts): listed as that room in the Agents
   *  pane, never in the session lists. */
  agentRoom?: DesktopAgentRoomSummary;
  /** The last user or assistant message, one line; contact rows show it. */
  lastMessagePreview?: string;
  /** Set when that line is a schedule's or webhook's result
   *  (routine-result.mjs): the row labels it from this, never from its text. */
  lastMessageRoutine?: RoutineProvenance;
  /** Automation origin: present on schedule/webhook runner sessions so the
   *  sidebar groups them under Automations instead of Recent. */
  sourceType?: 'schedule' | 'webhook';
  /** Schedule/webhook name — the Automations row label. */
  sourceName?: string;
  /** Last known route of this session. The catalog row is the FIRST-FRAME
   *  source for pane chrome: naming the model must not wait for a lane
   *  snapshot, a peek, or pane focus. */
  provider?: string;
  model?: string;
  /** Creation time; orders the forks of one original ("fork N"). */
  createdAt?: number;
  /** Session this one was forked (inherited) from; absent on older sessions. */
  inheritedFromSessionId?: string;
  /** The Lead's workspace: where it executes (`cwd`, possibly a managed
   *  worktree) under its registered Project. Absent while it never moved. */
  workspace?: DesktopSessionWorkspace;
}

export interface DesktopProjectSummary {
  name: string;
  path: string;
  alias: string | null;
}

export interface DesktopWorkspaceFolder {
  path: string;
  name?: string;
}

export interface DesktopWorkspace {
  kind: 'empty' | 'folder' | 'workspace';
  name: string;
  workspaceFile?: string;
  folders: DesktopWorkspaceFolder[];
}

export interface DesktopEditorSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  wordWrap: 'off' | 'on' | 'wordWrapColumn' | 'bounded';
  wordWrapColumn: number;
  renderWhitespace: 'none' | 'boundary' | 'selection' | 'trailing' | 'all';
  minimapEnabled: boolean;
  stickyScrollEnabled: boolean;
  bracketPairColorization: boolean;
  bracketPairGuides: boolean | 'active';
  inlayHintsEnabled: 'off' | 'on' | 'offUnlessPressed' | 'onUnlessPressed';
  formatOnSave: boolean;
  formatOnPaste: boolean;
  formatOnType: boolean;
  /** View a Markdown file opens in when it has no remembered mode. */
  markdownDefaultView: 'preview' | 'rich' | 'source';
  tabSize: number;
  insertSpaces: boolean;
  detectIndentation: boolean;
}

/** Dock Files tab: one directory level of a registered project. */
export interface DesktopDirEntry {
  name: string;
  dir: boolean;
}

export type DesktopLspDocumentKind = 'open' | 'change' | 'save' | 'close';

export interface DesktopLspDocumentInput {
  kind: DesktopLspDocumentKind;
  projectPath: string;
  relPath: string;
  languageId: string;
  version: number;
  content?: string;
}

export interface DesktopLspCapabilities {
  completion: boolean;
  completionResolve: boolean;
  completionTriggerCharacters: string[];
  signatureHelp: boolean;
  signatureHelpTriggerCharacters: string[];
  signatureHelpRetriggerCharacters: string[];
  hover: boolean;
  declaration: boolean;
  definition: boolean;
  typeDefinition: boolean;
  implementation: boolean;
  references: boolean;
  documentHighlight: boolean;
  linkedEditingRange: boolean;
  documentSymbol: boolean;
  codeLens: boolean;
  codeLensResolve: boolean;
  rename: boolean;
  prepareRename: boolean;
  codeAction: boolean;
  codeActionResolve: boolean;
  codeActionKinds: string[];
  formatting: boolean;
  rangeFormatting: boolean;
  onTypeFormatting: boolean;
  onTypeFormattingTriggerCharacters: string[];
  documentLink: boolean;
  documentLinkResolve: boolean;
  documentColor: boolean;
  foldingRange: boolean;
  selectionRange: boolean;
  semanticTokens: boolean;
  semanticTokensRange: boolean;
  semanticTokensDelta: boolean;
  semanticTokensLegend: {
    tokenTypes: string[];
    tokenModifiers: string[];
  };
  inlayHint: boolean;
  inlayHintResolve: boolean;
  callHierarchy: boolean;
  /** LSP `workspace/symbol` — project-wide symbol search (Mixdog is
   *  project-scoped; "workspace" is wire-protocol naming only). */
  workspaceSymbol: boolean;
  executeCommand: boolean;
}

export interface DesktopLspServerState {
  available: boolean;
  status: 'unsupported' | 'starting' | 'ready' | 'missing' | 'error' | 'stopped';
  server: string;
  detail?: string;
  capabilities?: DesktopLspCapabilities;
}

export interface DesktopLspPosition {
  line: number;
  character: number;
}

export interface DesktopLspRange {
  start: DesktopLspPosition;
  end: DesktopLspPosition;
}

export interface DesktopLspDiagnostic {
  range: DesktopLspRange;
  severity?: number;
  code?: string | number | { value: string | number };
  source?: string;
  message: string;
  tags?: number[];
}

export interface DesktopLspDiagnosticEvent {
  projectPath: string;
  relPath: string;
  uri: string;
  server: string;
  diagnostics: DesktopLspDiagnostic[];
}

export interface DesktopLspStatusEvent extends DesktopLspServerState {
  projectPath: string;
  languageId: string;
  relPath?: string;
}

export const DESKTOP_LSP_REQUEST_METHODS = [
  'textDocument/completion',
  'completionItem/resolve',
  'textDocument/signatureHelp',
  'textDocument/hover',
  'textDocument/definition',
  'textDocument/typeDefinition',
  'textDocument/declaration',
  'textDocument/implementation',
  'textDocument/references',
  'textDocument/documentHighlight',
  'textDocument/linkedEditingRange',
  'textDocument/documentSymbol',
  'textDocument/codeLens',
  'codeLens/resolve',
  'textDocument/prepareRename',
  'textDocument/rename',
  'textDocument/codeAction',
  'codeAction/resolve',
  'textDocument/formatting',
  'textDocument/rangeFormatting',
  'textDocument/onTypeFormatting',
  'textDocument/documentLink',
  'documentLink/resolve',
  'textDocument/documentColor',
  'textDocument/colorPresentation',
  'textDocument/foldingRange',
  'textDocument/selectionRange',
  'textDocument/semanticTokens/full',
  'textDocument/semanticTokens/full/delta',
  'textDocument/semanticTokens/range',
  'textDocument/inlayHint',
  'inlayHint/resolve',
  'textDocument/prepareCallHierarchy',
  'callHierarchy/incomingCalls',
  'callHierarchy/outgoingCalls',
  'workspace/symbol',
  'workspace/executeCommand',
] as const;

export type DesktopLspRequestMethod = (typeof DESKTOP_LSP_REQUEST_METHODS)[number];

export interface DesktopLspRequestInput {
  projectPath: string;
  relPath: string;
  languageId: string;
  method: DesktopLspRequestMethod;
  params?: Readonly<Record<string, unknown>>;
}

export interface DesktopLspRequestResult extends DesktopLspServerState {
  result?: unknown;
}

export interface DesktopWorkspaceTextWrite {
  relPath: string;
  content: string;
  expectedContent: string;
}

export type DesktopTextFileEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be';

export interface DesktopEditorBackup {
  content: string;
  expectedContent: string;
  updatedAt: number;
}

export interface DesktopRendererFailureDiagnostic {
  kind?: 'failure';
  /** `notice` is an error the user actually saw on screen (toast/banner),
   *  which otherwise vanishes without a trace when it auto-dismisses. */
  phase: 'boundary' | 'window-error' | 'unhandled-rejection' | 'notice' | 'console';
  errorName: string;
  fingerprint: string;
  /** Free text shown to the user; recorded only for notice/console phases. */
  message?: string;
  failureCode?: string;
  components?: string[];
  source?: string;
  line?: number;
  column?: number;
}

export interface DesktopRendererLongTaskDiagnostic {
  kind: 'long-task';
  durationMs: number;
}

export interface DesktopRendererComposerActionDiagnostic {
  kind: 'composer-action';
  action: 'submit' | 'restore-queue';
  source:
    | 'keyboard-enter'
    | 'form-submit'
    | 'slash-keyboard'
    | 'slash-click'
    | 'escape'
    | 'arrow-up'
    | 'queue-row'
    | 'voice-submit';
  turnBusy: boolean;
  queueCount: number;
  draftLength: number;
  composing: boolean;
  uptimeMs: number;
  targeted?: boolean;
}

export interface DesktopRendererWhatsNewDiagnostic {
  kind: 'whats-new';
  event: 'taken' | 'shown' | 'skipped' | 'failed';
  version: string;
  reason?: string;
  errorName?: string;
  message?: string;
}

export type DesktopRendererDiagnostic =
  | DesktopRendererFailureDiagnostic
  | DesktopRendererWhatsNewDiagnostic
  | DesktopRendererLongTaskDiagnostic
  | DesktopRendererComposerActionDiagnostic
  | import('./transcript-read-diagnostics').TranscriptReadDiagnostic;

export interface DesktopBootContext {
  bootId: string;
  processStartedAt: number;
  scenario?: string;
  /** This launch follows an app update (main-process record, not localStorage). */
  afterUpdate?: true;
}

/** The daemon connection a desktop window drives: this PC (`local`) or a
 *  server reached over ssh. Fixed for the window's lifetime. */
export interface DesktopConnectionIdentity {
  /** `'local'` for this PC, the saved SSH host id otherwise. */
  id: string;
  kind: 'local' | 'ssh';
  /** Display name: this PC's host name, or the saved server name. */
  name: string;
}

export interface DesktopWorkspaceTextSearchOptions {
  query: string;
  include?: string;
  exclude?: string;
  matchCase?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  maxResults?: number;
}

export interface DesktopWorkspaceTextMatch {
  line: number;
  column: number;
  endColumn: number;
  preview: string;
  matchText: string;
}

export interface DesktopWorkspaceTextFileResult {
  relPath: string;
  matches: DesktopWorkspaceTextMatch[];
}

export interface DesktopWorkspaceTextSearchResult {
  files: DesktopWorkspaceTextFileResult[];
  matchCount: number;
  limitHit: boolean;
}

export interface DesktopWorkspaceTextReplaceResult {
  filesChanged: number;
  replacements: number;
  paths: string[];
}

export interface DesktopLocalPathEntry {
  absolutePath: string;
  name: string;
  dir: boolean;
  size: number;
  projectPath?: string;
  relPath?: string;
  accessToken?: string;
}

export interface DesktopLocalFileData {
  name: string;
  size: number;
  mimeType: string;
  data: string;
}

/** One rasterized page of a converted Office document. */
export interface DesktopDocumentPreviewPage {
  page: number;
  width: number;
  height: number;
  mime: string;
  base64: string;
}

export interface DesktopDocumentPreviewPages {
  format: string;
  mtimeMs: number;
  size: number;
  pageCount: number;
  pages: DesktopDocumentPreviewPage[];
}
