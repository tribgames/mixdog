import type {
  DesktopAbortOptions,
  DesktopAgentPoolRow,
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
  renameProject(projectPath: string, alias: string): unknown;
  removeProject(projectPath: string): unknown;
  listProjectDir(projectPath: string, relDir: string): unknown;
  readProjectTextFile(projectPath: string, relPath: string): unknown;
  writeProjectTextFile(
    projectPath: string,
    relPath: string,
    content: string,
    expectedContent: string,
    encoding?: import('./project-files').ProjectTextEncoding,
  ): unknown;
  statProjectFile(projectPath: string, relPath: string): unknown;
  createProjectEntry(projectPath: string, relDir: string, name: string, directory: boolean): unknown;
  renameProjectEntry(projectPath: string, relPath: string, newName: string): unknown;
  moveProjectEntry(projectPath: string, relPath: string, targetDirRel: string): unknown;
  copyProjectEntry(projectPath: string, relPath: string, targetDirRel: string): unknown;
  projectEntryPath(projectPath: string, relPath: string): Promise<string>;
  codeGraphQuery(projectPath: string, mode: 'find_symbol' | 'references' | 'symbols', query: string): unknown;
  listSessions(): Promise<DesktopSessionSummary[]>;
  listAgentPool(): Promise<DesktopAgentPoolRow[]>;
  renameSession(sessionId: string, title: string): unknown;
  setSessionArchived(sessionId: string, archived: boolean): unknown;
  deleteSession(sessionId: string): unknown;
  prefetchSession(sessionId: string): Promise<boolean>;
  /** Read-only pane peek: publish a one-shot lane frame for an idle session. */
  peekSession?(sessionId: string): Promise<boolean>;
  /** Keep every currently visible pane attached to its external live owner. */
  setVisibleSessions?(sessionIds: string[]): Promise<boolean>;
  searchProjectFiles(projectIdOrWorkspaceId: string, query: string, limit?: number): Promise<string[]>;
  submitNewTask(
    prompt: DesktopPromptContent,
    options?: DesktopSubmitOptions,
    draft?: DesktopNewTaskDraft,
  ): Promise<DesktopNewTaskSubmitResult>;
  /** Split panes use daemon-owned session addresses directly. Pane actions
   *  never fall back to whichever session happens to be focused. */
  subscribeSessionStates(listener: (update: DesktopSessionStateUpdate) => void): () => void;
  submitToSession(
    sessionId: string,
    prompt: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ): Promise<boolean>;
  abortSession(sessionId: string, options?: DesktopAbortOptions): unknown;
  resolveToolApprovalForSession(
    sessionId: string,
    id: string,
    decision: ToolApprovalDecision,
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
    sessionId?: string,
  ): Promise<DesktopCapabilityResult<T>>;
  readCapabilities(
    requests: ReadonlyArray<DesktopCapabilityReadRequest>,
  ): Promise<DesktopCapabilityReadResult[]>;
  /** Non-UI desktop service domains (Git, files, LSP, PTY) hosted by the
   * singleton daemon. Product hosts never execute these domains locally. */
  invokeDesktopOperation(method: string, args?: unknown[]): Promise<unknown>;
  subscribeDesktopEvents?(
    listener: (event: { name: string; value: unknown }) => void,
  ): () => void;
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
  'listAgentPool',
  'renameSession',
  'setSessionArchived',
  'deleteSession',
  'prefetchSession',
  'peekSession',
  'setVisibleSessions',
  'searchProjectFiles',
  'submitNewTask',
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

export type DesktopServiceMethod = typeof DESKTOP_SERVICE_METHODS[number];

export interface SerializableDesktopServiceOptions {
  userDataPath: string;
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  rendererDir?: string;
  runtimeRoot?: string;
}
