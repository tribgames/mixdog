import type {
  DesktopAbortOptions,
  DesktopAgentMemoryEntry,
  DesktopAgentPoolRow,
  DesktopSessionContentMatch,
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopCapabilityResult,
  DesktopModelCatalogOptions,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopNewTaskDraft,
  DesktopNewTaskSubmitResult,
  DesktopProjectSummary,
  DesktopPromptContent,
  DesktopSessionSummary,
  DesktopSessionStateUpdate,
  DesktopSubmitOptions,
  SessionSnapshot,
  ToolApprovalDecision,
} from '../shared/contract';
import type { SessionFinalAnswer } from './session-final-answer';

export interface DesktopService {
  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void;
  subscribeSessions(listener: (sessions: DesktopSessionSummary[]) => void): () => void;
  subscribeAgentPool(listener: (agents: DesktopAgentPoolRow[]) => void): () => void;
  getSnapshot(): SessionSnapshot;
  startProject(projectPath: string): Promise<SessionSnapshot>;
  startProjectTask(projectPath: string): Promise<SessionSnapshot>;
  startTask(): Promise<SessionSnapshot>;
  listProjects(): Promise<DesktopProjectSummary[]>;
  addProject(projectPath: string): unknown;
  projectDirectory(projectPath: string): Promise<string>;
  projectRecoveryDirectory?(projectPath: string): Promise<string>;
  renameProject(projectPath: string, alias: string): unknown;
  removeProject(projectPath: string): unknown;
  listProjectDir(projectPath: string, relDir: string): unknown;
  readProjectTextFile(projectPath: string, relPath: string): unknown;
  writeProjectTextFile(
    projectPath: string,
    relPath: string,
    content: string,
    expectedContent: string,
    encoding?: import('./project-files').ProjectTextEncoding
  ): unknown;
  statProjectFile(projectPath: string, relPath: string): unknown;
  createProjectEntry(projectPath: string, relDir: string, name: string, directory: boolean): unknown;
  renameProjectEntry(projectPath: string, relPath: string, newName: string): unknown;
  moveProjectEntry(projectPath: string, relPath: string, targetDirRel: string): unknown;
  copyProjectEntry(projectPath: string, relPath: string, targetDirRel: string): unknown;
  projectEntryPath(projectPath: string, relPath: string): Promise<string>;
  codeGraphQuery(projectPath: string, mode: 'find_symbol' | 'references' | 'symbols', query: string): unknown;
  listSessions(): Promise<DesktopSessionSummary[]>;
  /** `signal` stops the read when aborted (rejects with the signal's reason);
   *  it is local to the caller and never travels over the service IPC. */
  readSessionFinalAnswer(
    sessionId: string,
    startedAt: number,
    signal?: AbortSignal
  ): Promise<SessionFinalAnswer | null>;
  /** Base64 of a stored attachment blob; null when it is permanently unreadable. */
  readAttachmentImage(attachmentRef: string): Promise<string | null>;
  /** The session's transcript as this host holds it (the window its views
   *  were sent), read without publishing when nothing is held. Host-only:
   *  a paired device's full-output reads and its attachment lookups. */
  readSessionTranscript?(sessionId: string): Promise<SessionSnapshot>;
  markSessionRead(sessionId: string, messageCount: number, consumedUnread?: boolean): Promise<boolean>;
  listAgentPool(): Promise<DesktopAgentPoolRow[]>;
  searchSessionContent(query: string): Promise<DesktopSessionContentMatch[]>;
  renameSession(sessionId: string, title: string): unknown;
  continueSessionInModel(sessionId: string, route: DesktopModelSelection): Promise<boolean>;
  scheduleQuotaResume(sessionId: string): Promise<boolean>;
  cancelQuotaResume(sessionId: string): Promise<boolean>;
  stopShellJob(sessionId: string, taskId: string): Promise<{ stopped: boolean; error?: string }>;
  releaseShellJob(sessionId: string, taskId: string): Promise<{ released: boolean; error?: string }>;
  getQuotaAutoResume(): Promise<boolean>;
  setQuotaAutoResume(enabled: boolean): Promise<boolean>;
  setSessionArchived(sessionId: string, archived: boolean): unknown;
  /** The agent contact's one home thread (agent-home-sessions.ts). */
  openAgentHome(agentId: string): Promise<{ sessionId: string }>;
  resetAgentHome(agentId: string): Promise<{ sessionId: string; archivedSessionId: string | null }>;
  /** An agent's own memory pool for its profile (agent-memory.ts). */
  listAgentMemory(agentId: string): Promise<DesktopAgentMemoryEntry[]>;
  deleteAgentMemory(agentId: string, entry: Pick<DesktopAgentMemoryEntry, 'id' | 'indexRevision'>): Promise<void>;
  /** Group rooms (agent-rooms.ts): create, update, continue, leave, remove. */
  agentRoomAction(action: string, args: unknown[]): Promise<unknown>;
  setSessionFavorite(sessionId: string, favorite: boolean): unknown;
  setSessionProject(sessionId: string, projectPath: string): unknown;
  deleteSession(sessionId: string): unknown;
  prefetchSession(sessionId: string, transcriptItemLimit?: number, readTraceId?: string): Promise<boolean>;
  /** Transport-only recovery: capture current projections after refreshing
   * every requested lane, even when the daemon reports unchanged content. */
  replaySessionStates?(sessionIds: string[], deliver: (updates: DesktopSessionStateUpdate[]) => void): Promise<void>;
  /** Ask the service to forget its delta baseline for one session and re-emit a full frame. */
  requestSessionStateResync?(sessionId: string): void;
  /** Keep every currently visible pane attached to its external live owner. */
  setVisibleSessions?(sessionIds: string[]): Promise<boolean>;
  /** `legacyTranscript`: the source cannot page transcript history (an old
   *  phone build) and keeps receiving the 512-item page. */
  setVisibleSessionsForSource?(sourceId: string, sessionIds: string[], legacyTranscript?: boolean): Promise<boolean>;
  searchProjectFiles(
    projectIdOrWorkspaceId: string,
    query: string,
    limit?: number,
    includeIgnored?: boolean,
    includeDirectories?: boolean,
    consumer?: string
  ): Promise<string[]>;
  submitNewTask(
    prompt: DesktopPromptContent,
    options?: DesktopSubmitOptions,
    draft?: DesktopNewTaskDraft
  ): Promise<DesktopNewTaskSubmitResult>;
  /** /inherit — copy one session's conversation into a NEW session id running
   *  on the supplied route; the source session is left untouched. */
  inheritSession(
    sourceSessionId: string,
    route?: DesktopModelSelection | null,
    options?: { compact: boolean } | null
  ): Promise<{ sessionId: string; snapshot: SessionSnapshot | null }>;
  /** Split panes use daemon-owned session addresses directly. Pane actions
   *  never fall back to whichever session happens to be focused. */
  subscribeSessionStates(listener: (update: DesktopSessionStateUpdate) => void): () => void;
  submitToSession(sessionId: string, prompt: DesktopPromptContent, options?: DesktopSubmitOptions): Promise<boolean>;
  abortSession(sessionId: string, options?: DesktopAbortOptions): unknown;
  resolveToolApprovalForSession(
    sessionId: string,
    id: string,
    decision: ToolApprovalDecision
  ): boolean | Promise<boolean>;
  listProviderModels(options?: DesktopModelCatalogOptions): Promise<DesktopModelOption[]>;
  /** Optional sessionId targets a pane; omitted routes through the control
   *  session for settings that are not owned by a conversation. */
  setModelRoute(selection: DesktopModelSelection, sessionId?: string): Promise<SessionSnapshot>;
  setFast(enabled: boolean, sessionId?: string): Promise<SessionSnapshot>;
  invokeCapability<T = unknown>(
    capability: DesktopCapability,
    args?: unknown[],
    /** Session the issuing surface paints; omitted = control session. */
    sessionId?: string
  ): Promise<DesktopCapabilityResult<T>>;
  readCapabilities(requests: ReadonlyArray<DesktopCapabilityReadRequest>): Promise<DesktopCapabilityReadResult[]>;
  /** Non-UI desktop service domains (Git, files, LSP, PTY) hosted by the
   * singleton daemon. Product hosts never execute these domains locally. */
  invokeDesktopOperation(method: string, args?: unknown[]): Promise<unknown>;
  subscribeDesktopEvents?(listener: (event: { name: string; value: unknown }) => void): () => void;
  perfLog(line: string): void;
  dispose(): Promise<void>;
}

export const DESKTOP_SERVICE_METHODS = [
  'startProject',
  'startProjectTask',
  'startTask',
  'listProjects',
  'addProject',
  'projectDirectory',
  'projectRecoveryDirectory',
  'renameProject',
  'removeProject',
  'listProjectDir',
  'readProjectTextFile',
  'writeProjectTextFile',
  'statProjectFile',
  'createProjectEntry',
  'renameProjectEntry',
  'moveProjectEntry',
  'copyProjectEntry',
  'projectEntryPath',
  'codeGraphQuery',
  'listSessions',
  'readSessionFinalAnswer',
  'readAttachmentImage',
  'readSessionTranscript',
  'markSessionRead',
  'listAgentPool',
  'searchSessionContent',
  'renameSession',
  'continueSessionInModel',
  'scheduleQuotaResume',
  'cancelQuotaResume',
  'stopShellJob',
  'releaseShellJob',
  'getQuotaAutoResume',
  'setQuotaAutoResume',
  'setSessionArchived',
  'openAgentHome',
  'resetAgentHome',
  'listAgentMemory',
  'deleteAgentMemory',
  'agentRoomAction',
  'setSessionFavorite',
  'setSessionProject',
  'deleteSession',
  'prefetchSession',
  'setVisibleSessions',
  'searchProjectFiles',
  'submitNewTask',
  'inheritSession',
  'submitToSession',
  'abortSession',
  'resolveToolApprovalForSession',
  'listProviderModels',
  'setModelRoute',
  'setFast',
  'invokeCapability',
  'readCapabilities',
  'invokeDesktopOperation',
  'perfLog',
] as const;

export type DesktopServiceMethod = (typeof DESKTOP_SERVICE_METHODS)[number];

export interface SerializableDesktopServiceOptions {
  userDataPath: string;
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  /** This desktop build's version; reported on the relay leg so the relay can
   *  serve paired phones the web renderer release that matches it. */
  appVersion?: string;
  rendererDir?: string;
  runtimeRoot?: string;
}
