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
  DesktopTranscriptHistoryPage,
  DesktopTranscriptHistoryRequest,
  DesktopShellStopResult,
  SessionSnapshot,
  ToolApprovalDecision,
} from '../shared/contract';
import type { DesktopService, DesktopServiceMethod } from './desktop-service-contract';
import type { CapabilityLane } from './protocol/capability-route';
import type { OperationLane } from './protocol/desktop-operation-route';
import type { ServiceLane } from './protocol/service-route';
import type { SessionLane } from './protocol/session-lane';
import { filterSessionIds } from './desktop-state';
import { DESKTOP_NOTICE_EVENT, type DesktopNotice, readDesktopNotice } from '../shared/desktop-notice';
import type { SessionFinalAnswer } from './session-final-answer';

interface DesktopServiceClientOptions {
  initialSnapshot?: SessionSnapshot;
  /** The connection's core: every session capability, desktop operation and service method is a request of it. */
  capabilityLane: CapabilityLane;
  operationLane: OperationLane;
  serviceLane: ServiceLane;
  /** The connection's sessions: the catalog and the followed threads' states it pushes, and the chat calls whose answer is
   *  made from more than one reply (protocol/session-lane.ts). */
  sessionLane: SessionLane;
  onDiagnostic?(event: string, data: Record<string, unknown>): void;
}

const HELD_NOTICE_LIMIT = 20;

export function displayExitCode(code: number): string {
  // 0xE0000008 is Chromium's kOomExceptionCode; 134 is a V8 fatal error (abort).
  if (code === 0xe0000008 || code === -536870904) {
    return `${code === -536870904 ? code : '0xE0000008'} (out of memory)`;
  }
  if (code === 134) return '134 (V8 fatal error (JavaScript heap out of memory))';
  if (process.platform === 'win32' && Number.isSafeInteger(code) && code >= 0x80000000 && code <= 0xffffffff) {
    return `0x${code.toString(16).padStart(8, '0').toUpperCase()}`;
  }
  return String(code);
}

export class DesktopServiceClient implements DesktopService {
  private readonly listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private readonly agentPoolListeners = new Set<(agents: DesktopAgentPoolRow[]) => void>();
  private readonly desktopEventListeners = new Set<(event: { name: string; value: unknown }) => void>();
  private readonly noticeListeners = new Set<(notice: DesktopNotice) => void>();
  /** Notices that arrived while no window listened (one per key, bounded). */
  private heldNotices: DesktopNotice[] = [];
  private cachedSnapshot: SessionSnapshot;
  private visibleSessionIds: string[] = [];
  private visibleSessionVersion = 0;
  private disposed = false;

  constructor(private readonly options: DesktopServiceClientOptions) {
    this.cachedSnapshot = options.initialSnapshot ?? null;
  }

  /** Settles at once: the connection's core connection is opened by the connection that owns this client. */
  start(): Promise<void> {
    return this.disposed ? Promise.reject(new Error('Mixdog desktop service client is disposed.')) : Promise.resolve();
  }

  getSnapshot(): SessionSnapshot {
    return this.cachedSnapshot;
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Work that dies with the core: sessions running turns or agents plus the host's background shell jobs. */
  runningWorkCount(): number | null {
    return null;
  }

  subscribeSessions(listener: (sessions: DesktopSessionSummary[]) => void): () => void {
    return this.options.sessionLane.subscribeSessions(listener);
  }

  subscribeAgentPool(listener: (agents: DesktopAgentPoolRow[]) => void): () => void {
    this.agentPoolListeners.add(listener);
    return () => this.agentPoolListeners.delete(listener);
  }

  subscribeSessionStates(listener: (update: DesktopSessionStateUpdate) => void): () => void {
    return this.options.sessionLane.subscribeSessionStates(listener);
  }

  requestSessionStateResync(sessionId: string): void {
    this.options.sessionLane.requestSessionStateResync(sessionId);
  }

  /** Node's host published a start call's blank snapshot as its shell snapshot (session-host-lifecycle.ts `publishShell`). */
  private async startShell(method: 'startProject' | 'startProjectTask' | 'startTask', args: unknown[]): Promise<SessionSnapshot> {
    const snapshot = await this.invoke<SessionSnapshot>(method, args);
    this.cachedSnapshot = snapshot;
    for (const listener of [...this.listeners]) listener(snapshot);
    return snapshot;
  }

  subscribeDesktopEvents(listener: (event: { name: string; value: unknown }) => void): () => void {
    this.desktopEventListeners.add(listener);
    return () => this.desktopEventListeners.delete(listener);
  }

  subscribeDesktopNotices(listener: (notice: DesktopNotice) => void): () => void {
    this.noticeListeners.add(listener);
    const held = this.heldNotices;
    this.heldNotices = [];
    for (const notice of held) listener(notice);
    return () => this.noticeListeners.delete(listener);
  }

  /** The service raised each notice once and counts it delivered here, so one
   *  arriving before any window (or between windows) waits for the next. */
  private receiveNotice(value: unknown): void {
    const notice = readDesktopNotice(value);
    if (!notice) return;
    if (this.noticeListeners.size > 0) {
      for (const listener of this.noticeListeners) listener(notice);
      return;
    }
    this.heldNotices = [...this.heldNotices.filter((held) => held.key !== notice.key), notice].slice(
      -HELD_NOTICE_LIMIT
    );
  }

  private invoke<T>(method: DesktopServiceMethod, args: unknown[] = [], _timeoutMs?: number, signal?: AbortSignal): Promise<T> {
    return this.options.serviceLane.call<T>(method, args, signal);
  }

  private invokeRead<T>(method: DesktopServiceMethod, args: unknown[] = [], signal?: AbortSignal): Promise<T> {
    return this.invoke<T>(method, args, undefined, signal);
  }

  startProject(projectPath: string): Promise<SessionSnapshot> {
    return this.startShell('startProject', [projectPath]);
  }
  startProjectTask(projectPath: string): Promise<SessionSnapshot> {
    return this.startShell('startProjectTask', [projectPath]);
  }
  startTask(): Promise<SessionSnapshot> {
    return this.startShell('startTask', []);
  }
  listProjects(): Promise<DesktopProjectSummary[]> {
    return this.invokeRead('listProjects');
  }
  addProject(projectPath: string): Promise<unknown> {
    return this.invoke('addProject', [projectPath]);
  }
  projectRecoveryDirectory(projectPath: string): Promise<string> {
    return this.invokeRead('projectRecoveryDirectory', [projectPath]);
  }

  projectDirectory(projectPath: string): Promise<string> {
    return this.invokeRead('projectDirectory', [projectPath]);
  }
  renameProject(projectPath: string, alias: string): Promise<unknown> {
    return this.invoke('renameProject', [projectPath, alias]);
  }
  removeProject(projectPath: string): Promise<unknown> {
    return this.invoke('removeProject', [projectPath]);
  }
  listProjectDir(projectPath: string, relDir: string): Promise<unknown> {
    return this.invokeRead('listProjectDir', [projectPath, relDir]);
  }
  readProjectTextFile(projectPath: string, relPath: string): Promise<unknown> {
    return this.invokeRead('readProjectTextFile', [projectPath, relPath]);
  }
  writeProjectTextFile(
    projectPath: string,
    relPath: string,
    content: string,
    expectedContent: string,
    encoding?: import('../shared/project-text-encoding').ProjectTextEncoding
  ): Promise<unknown> {
    return this.invoke('writeProjectTextFile', [projectPath, relPath, content, expectedContent, encoding]);
  }
  statProjectFile(projectPath: string, relPath: string): Promise<unknown> {
    return this.invokeRead('statProjectFile', [projectPath, relPath]);
  }
  createProjectEntry(projectPath: string, relDir: string, name: string, directory: boolean): Promise<unknown> {
    return this.invoke('createProjectEntry', [projectPath, relDir, name, directory]);
  }
  renameProjectEntry(projectPath: string, relPath: string, newName: string): Promise<unknown> {
    return this.invoke('renameProjectEntry', [projectPath, relPath, newName]);
  }
  moveProjectEntry(projectPath: string, relPath: string, targetDirRel: string): Promise<unknown> {
    return this.invoke('moveProjectEntry', [projectPath, relPath, targetDirRel]);
  }
  copyProjectEntry(projectPath: string, relPath: string, targetDirRel: string): Promise<unknown> {
    return this.invoke('copyProjectEntry', [projectPath, relPath, targetDirRel]);
  }
  projectEntryPath(projectPath: string, relPath: string): Promise<string> {
    return this.invokeRead('projectEntryPath', [projectPath, relPath]);
  }
  codeGraphQuery(projectPath: string, mode: 'find_symbol' | 'references' | 'symbols', query: string): Promise<unknown> {
    return this.invokeRead('codeGraphQuery', [projectPath, mode, query]);
  }
  listSessions(): Promise<DesktopSessionSummary[]> {
    return this.options.sessionLane.listSessions();
  }
  markSessionRead(sessionId: string, messageCount: number, consumedUnread = false): Promise<boolean> {
    return this.invoke('markSessionRead', [sessionId, messageCount, consumedUnread]);
  }
  searchSessionContent(query: string): Promise<DesktopSessionContentMatch[]> {
    return this.invokeRead('searchSessionContent', [query]);
  }
  listAgentPool(): Promise<DesktopAgentPoolRow[]> {
    return this.invoke('listAgentPool');
  }
  renameSession(sessionId: string, title: string): Promise<unknown> {
    return this.options.capabilityLane.renameSession(sessionId, title);
  }
  continueSessionInModel(sessionId: string, route: DesktopModelSelection): Promise<boolean> {
    return this.invoke('continueSessionInModel', [sessionId, route]);
  }
  scheduleQuotaResume(sessionId: string): Promise<boolean> {
    return this.invoke('scheduleQuotaResume', [sessionId]);
  }
  cancelQuotaResume(sessionId: string): Promise<boolean> {
    return this.invoke('cancelQuotaResume', [sessionId]);
  }
  stopShellJob(sessionId: string, taskId: string): Promise<DesktopShellStopResult> {
    return this.options.capabilityLane.stopShellJob(sessionId, taskId);
  }
  releaseShellJob(sessionId: string, taskId: string): Promise<{ released: boolean; error?: string }> {
    return this.options.capabilityLane.releaseShellJob(sessionId, taskId);
  }
  getQuotaAutoResume(): Promise<boolean> {
    return this.options.capabilityLane.getQuotaAutoResume();
  }
  getTaskWorkspace(): Promise<string> {
    return this.invoke('getTaskWorkspace', []);
  }
  setQuotaAutoResume(enabled: boolean): Promise<boolean> {
    return this.options.capabilityLane.setQuotaAutoResume(enabled);
  }
  readAttachmentImage(attachmentRef: string, maxBytes?: number): Promise<string | null> {
    return this.invokeRead('readAttachmentImage', maxBytes === undefined ? [attachmentRef] : [attachmentRef, maxBytes]);
  }
  /** The provenance behind attachment opens and file grants: main's IPC
   *  checks a request against the transcript the service holds. */
  readSessionTranscript(sessionId: string): Promise<SessionSnapshot> {
    return this.options.sessionLane.readSessionTranscript(sessionId);
  }
  /** The whole stored conversation, compaction-archived rows included. */
  readSessionHistory(sessionId: string): Promise<SessionSnapshot | null> {
    return this.options.sessionLane.readSessionHistory(sessionId);
  }

  readSessionFinalAnswer(
    sessionId: string,
    startedAt: number,
    signal?: AbortSignal
  ): Promise<SessionFinalAnswer | null> {
    return this.invokeRead('readSessionFinalAnswer', [sessionId, startedAt], signal);
  }
  setSessionFavorite(sessionId: string, favorite: boolean): Promise<unknown> {
    return this.options.capabilityLane.setSessionFavorite(sessionId, favorite);
  }

  setSessionProject(sessionId: string, projectPath: string): Promise<unknown> {
    return this.options.capabilityLane.setSessionProject(sessionId, projectPath);
  }

  setSessionArchived(sessionId: string, archived: boolean): Promise<unknown> {
    return this.options.capabilityLane.setSessionArchived(sessionId, archived);
  }
  openAgentHome(agentId: string): Promise<{ sessionId: string }> {
    return this.invoke('openAgentHome', [agentId]);
  }
  resetAgentHome(agentId: string): Promise<{ sessionId: string; archivedSessionId: string | null }> {
    return this.invoke('resetAgentHome', [agentId]);
  }
  listAgentMemory(agentId: string): Promise<DesktopAgentMemoryEntry[]> {
    return this.invoke('listAgentMemory', [agentId]);
  }
  deleteAgentMemory(agentId: string, entry: Pick<DesktopAgentMemoryEntry, 'id' | 'indexRevision'>): Promise<void> {
    return this.invoke('deleteAgentMemory', [agentId, entry]);
  }
  agentRoomAction(action: string, args: unknown[]): Promise<unknown> {
    return this.invoke('agentRoomAction', [action, args]);
  }
  deleteSession(sessionId: string): Promise<unknown> {
    return this.options.capabilityLane.deleteSession(sessionId);
  }
  prefetchSession(sessionId: string, transcriptItemLimit?: number, readTraceId?: string): Promise<boolean> {
    return this.options.sessionLane.prefetchSession(sessionId, transcriptItemLimit, readTraceId);
  }
  async readTranscriptHistory(
    sessionId: string,
    request: DesktopTranscriptHistoryRequest
  ): Promise<DesktopTranscriptHistoryPage> {
    return (await this.options.sessionLane.chat()).readTranscriptHistory(sessionId, request);
  }
  setVisibleSessions(sessionIds: string[]): Promise<boolean> {
    this.visibleSessionIds = filterSessionIds(sessionIds);
    return this.invokeRead('setVisibleSessions', [this.visibleSessionIds, ++this.visibleSessionVersion]);
  }
  searchProjectFiles(
    projectIdOrWorkspaceId: string,
    query: string,
    limit = 50,
    includeIgnored = false,
    includeDirectories = false,
    consumer?: string
  ): Promise<string[]> {
    return this.invokeRead('searchProjectFiles', [
      projectIdOrWorkspaceId,
      query,
      limit,
      includeIgnored,
      includeDirectories,
      consumer,
    ]);
  }
  async submitNewTask(
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions = {},
    draft: DesktopNewTaskDraft = {}
  ): Promise<DesktopNewTaskSubmitResult> {
    return (await this.options.sessionLane.chat()).submitNewTask(prompt, options, draft);
  }
  async inheritSession(
    sourceSessionId: string,
    route?: DesktopModelSelection | null,
    options?: { compact: boolean } | null
  ): Promise<{ sessionId: string; snapshot: SessionSnapshot | null }> {
    return (await this.options.sessionLane.chat()).inheritSession(sourceSessionId, route ?? null, options ?? null);
  }
  submitToSession(
    sessionId: string,
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions = {}
  ): Promise<boolean> {
    return this.invoke('submitToSession', [sessionId, prompt, options]);
  }
  abortSession(sessionId: string, options: DesktopAbortOptions = {}): Promise<unknown> {
    return this.invoke('abortSession', [sessionId, options]);
  }
  resolveToolApprovalForSession(sessionId: string, id: string, decision: ToolApprovalDecision): Promise<boolean> {
    // A decision is keyed by its approval id, so sending it again is safe (an
    // already-settled id answers false). The service restarts itself when a
    // stalled daemon times its call out; the answer the user gave must wait
    // for that restart instead of surfacing as a failed, then cancelled, ask.
    // A core connection answers the server request the card shows (capability-route.ts `resolveToolApproval`).
    return this.options.capabilityLane.resolveToolApproval(sessionId, id, decision as unknown as Record<string, unknown>);
  }
  async listProviderModels(options: DesktopModelCatalogOptions = {}): Promise<DesktopModelOption[]> {
    return (await this.options.sessionLane.chat()).listProviderModels(options);
  }
  setModelRoute(selection: DesktopModelSelection, sessionId?: string): Promise<SessionSnapshot> {
    return this.invoke('setModelRoute', [selection, sessionId]);
  }
  setFast(enabled: boolean, sessionId?: string): Promise<SessionSnapshot> {
    return this.invoke('setFast', [enabled, sessionId]);
  }
  invokeCapability<T = unknown>(
    capability: DesktopCapability,
    args: unknown[] = [],
    sessionId?: string
  ): Promise<DesktopCapabilityResult<T>> {
    return this.options.capabilityLane.invoke<T>(capability, args, sessionId);
  }
  readCapabilities(requests: ReadonlyArray<DesktopCapabilityReadRequest>): Promise<DesktopCapabilityReadResult[]> {
    return this.options.capabilityLane.read(requests);
  }
  /** An event this process raises for its own windows, as the Node service's broadcast reached them (a core connection
   *  has no Node service to send it). */
  emitDesktopEvent(name: string, value: unknown): void {
    if (name === DESKTOP_NOTICE_EVENT) this.receiveNotice(value);
    for (const listener of [...this.desktopEventListeners]) listener({ name, value });
  }
  invokeDesktopOperation(method: string, args: unknown[] = []): Promise<unknown> {
    return this.options.operationLane.invoke(method, args);
  }
  /** Fire-and-forget: no wait for the reply. */
  notifyDesktopOperation(method: string, args: unknown[] = []): void {
    void this.options.operationLane.invoke(method, args).catch(() => {
      /* fire-and-forget: the caller never reads a reply */
    });
  }
  perfLog(line: string): void {
    void this.invoke('perfLog', [line]).catch(() => {
      /* diagnostics only */
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.options.sessionLane.dispose();
    this.agentPoolListeners.clear();
    this.desktopEventListeners.clear();
    this.noticeListeners.clear();
    this.visibleSessionIds = [];
  }
}
