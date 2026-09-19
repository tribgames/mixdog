// Sessions, projects, workspaces, editor, LSP, renderer diagnostics, boot,
// workspace text search, local files and document previews.

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
}

export interface DesktopRemoteAccessInfo {
  relayBrowserUrl: string;
  relayBrowserQrSvg: string;
  clients: DesktopRemoteClientInfo[];
}

/** An installed web app asking this desktop for access. It arrives with no
 *  credential — approving it here is what creates one. */
export interface DesktopRemoteClientClaim {
  claimId: string;
  clientId: string;
  name: string;
  platform: string;
  browser: string;
  expiresAt: number;
}

export interface DesktopSessionSummary {
  id: string;
  preview: string;
  title: string;
  updatedAt: number;
  /** User-visible conversation activity; unlike updatedAt, lifecycle-only
   *  resume/detach saves do not advance this timestamp. */
  activityAt?: number;
  /** User/assistant message count — the unread dot keys off GROWTH here, not
   *  updatedAt, so housekeeping saves never re-dot an already-checked session. */
  messageCount: number;
  /** Host-persisted read cursor shared by desktop and paired mobile surfaces. */
  readMessageCount?: number;
  /** Monotonic cursor revision; advances for completion-only reads too. */
  readRevision?: number;
  cwd: string;
  classification: DesktopSessionClassification;
  projectPath: string | null;
  /** Fresh cross-process turn heartbeat; independent of which session is selected. */
  working?: boolean;
  /** Fresh heartbeat from this session's Lead, excluding child-agent work. */
  leadWorking?: boolean;
  /** Fresh heartbeat from a running child agent owned by this lead session. */
  agentWorking?: boolean;
  /** Archive: hidden from Recent, restorable; file stays on disk. */
  archived?: boolean;
  /** Automation origin: present on schedule/webhook runner sessions so the
   *  sidebar groups them under Automations instead of Recent. */
  sourceType?: 'schedule' | 'webhook';
  /** Schedule/webhook name — the Automations row label. */
  sourceName?: string;
  /** Automation delivery mode: 'channel'-only runs hide from Automations
   *  (they surface on the messaging channel; the session lands in Archived). */
  sourceDelivery?: 'app' | 'channel' | 'both';
  /** Last known route of this session. The catalog row is the FIRST-FRAME
   *  source for pane chrome: naming the model must not wait for a lane
   *  snapshot, a peek, or pane focus. */
  provider?: string;
  model?: string;
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

export type DesktopRendererDiagnostic =
  | DesktopRendererFailureDiagnostic
  | DesktopRendererLongTaskDiagnostic
  | DesktopRendererComposerActionDiagnostic
  | import('./transcript-read-diagnostics').TranscriptReadDiagnostic;

export interface DesktopBootContext {
  bootId: string;
  processStartedAt: number;
  scenario?: string;
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
