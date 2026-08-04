import type {
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
  EngineSnapshot,
  ToolApprovalDecision,
} from '../shared/contract';

export interface DesktopEngineHost {
  subscribe(listener: (snapshot: EngineSnapshot) => void): () => void;
  subscribeSessions(listener: (sessions: DesktopSessionSummary[]) => void): () => void;
  subscribeAgentPool(listener: (agents: DesktopAgentPoolRow[]) => void): () => void;
  getSnapshot(): EngineSnapshot;
  startProject(projectPath: string): Promise<EngineSnapshot>;
  startProjectTask(projectPath: string): Promise<EngineSnapshot>;
  startTask(): Promise<EngineSnapshot>;
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
  resumeSession(sessionId: string): Promise<EngineSnapshot>;
  searchProjectFiles(projectIdOrWorkspaceId: string, query: string, limit?: number): Promise<string[]>;
  submit(prompt: DesktopPromptContent, options?: DesktopSubmitOptions): Promise<boolean>;
  submitNewTask(
    prompt: DesktopPromptContent,
    options?: DesktopSubmitOptions,
    draft?: DesktopNewTaskDraft,
  ): Promise<DesktopNewTaskSubmitResult>;
  abort(): unknown;
  resolveToolApproval(id: string, decision: ToolApprovalDecision): boolean | Promise<boolean>;
  /** Split panes: live snapshot lanes + session-addressed engine operations
   *  over the pooled engines (active or parked). Optional so partial test
   *  hosts and older embedders remain valid DesktopEngineHost values. */
  subscribeSessionStates?(listener: (update: DesktopSessionStateUpdate) => void): () => void;
  submitToSession?(
    sessionId: string,
    prompt: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ): Promise<boolean>;
  abortSession?(sessionId: string): unknown;
  resolveToolApprovalForSession?(
    sessionId: string,
    id: string,
    decision: ToolApprovalDecision,
  ): boolean | Promise<boolean>;
  listProviderModels(options?: DesktopModelCatalogOptions): Promise<DesktopModelOption[]>;
  setModelRoute(selection: DesktopModelSelection): Promise<EngineSnapshot>;
  setFast(enabled: boolean): Promise<EngineSnapshot>;
  invokeCapability<T = unknown>(
    capability: DesktopCapability,
    args?: unknown[],
  ): Promise<DesktopCapabilityResult<T>>;
  readCapabilities(
    requests: ReadonlyArray<DesktopCapabilityReadRequest>,
  ): Promise<DesktopCapabilityReadResult[]>;
  perfLog(line: string): void;
  dispose(): Promise<void>;
}

export const ENGINE_HOST_RPC_METHODS = [
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
  'resumeSession',
  'searchProjectFiles',
  'submit',
  'submitNewTask',
  'abort',
  'resolveToolApproval',
  'submitToSession',
  'abortSession',
  'resolveToolApprovalForSession',
  'listProviderModels',
  'setModelRoute',
  'setFast',
  'invokeCapability',
  'readCapabilities',
  'perfLog',
  'dispose',
] as const;

export type EngineHostRpcMethod = typeof ENGINE_HOST_RPC_METHODS[number];

export interface SerializableEngineHostOptions {
  userDataPath: string;
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  runtimeRoot?: string;
}
