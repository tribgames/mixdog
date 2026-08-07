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
  DesktopSessionStateUpdate,
  DesktopSessionSummary,
  DesktopSubmitOptions,
  SessionSnapshot,
  ToolApprovalDecision,
} from '../shared/contract';
import type { DesktopService } from './desktop-service-contract';

// MIXDOG_JITTER_PROBE: '1' = streaming/follow pass, 'entry' = cold-entry and
// tool-toggle pass, 'keys' = keyboard paging pass, 'switch' = rapid session
// switching, warm paint handoff, and side-panel geometry pass, 'width' = the
// window-width rewrap pass.
function jitterProbeEnabled(): boolean {
  const mode = String(process.env.MIXDOG_JITTER_PROBE || '');
  return mode === '1' || mode === 'entry' || mode === 'keys' || mode === 'switch'
    || mode === 'width';
}

// The capture profile is a presentation-only fake. It intentionally implements
// the same client contract without importing a session runtime or service host.
export const CAPTURE_SETTINGS_VALUES: Record<string, unknown> = {
  getProfile: {
    title: 'Capture',
    language: 'system',
    languages: [{ id: 'system', label: 'System' }],
  },
  getAutoClear: { enabled: true, idleMs: 3_600_000, providerDefaults: [] },
  getCompactionSettings: { auto: true },
  getRecapSettings: { enabled: true },
  getChannelSettings: { enabled: true },
  isRemoteEnabled: false,
  getChannelWorkerStatus: { running: false },
  getChannelSetup: {
    provider: 'discord',
    discord: { authenticated: false, status: 'Not connected' },
    telegram: { authenticated: false, status: 'Not connected' },
    webhook: { status: 'Not configured' },
    channel: {},
    webhooks: [],
  },
  getVoiceStatus: {
    installed: false,
    enabled: false,
    components: { whisper: false, model: false, ffmpeg: false },
  },
  listWorkflows: [{ id: 'solo', name: 'Solo', active: true }],
  listOutputStyles: {
    configured: 'default',
    current: { id: 'default', label: 'Default' },
    styles: [{ id: 'default', label: 'Default' }, { id: 'minimal', label: 'Minimal' }],
  },
  getSearchRoute: { provider: 'openai', model: 'gpt-capture', effort: 'high', fast: true },
  listSearchModels: [{
    provider: 'openai',
    model: 'gpt-capture',
    display: 'Capture',
    effortOptions: [{ value: 'high', label: 'High' }],
    fastCapable: true,
    fastPreferred: true,
  }],
  getProviderSetup: {
    api: [
      { id: 'openai', name: 'OpenAI', authenticated: true, stored: true, status: 'Connected' },
      { id: 'anthropic', name: 'Anthropic', authenticated: false, status: 'Not connected' },
    ],
    oauth: [{ id: 'openai-oauth', name: 'OpenAI OAuth', authenticated: true, status: 'Connected' }],
    local: [{
      id: 'ollama',
      name: 'Ollama',
      detected: true,
      enabled: true,
      status: 'Enabled',
      baseURL: 'http://127.0.0.1:11434/v1',
    }],
  },
  mcpStatus: {
    connectedCount: 1,
    configuredCount: 1,
    failedCount: 0,
    servers: [{ name: 'capture-docs', status: 'connected', toolCount: 3, enabled: true }],
  },
  pluginsStatus: {
    count: 1,
    plugins: [{
      id: 'capture-plugin',
      name: 'Capture plugin',
      version: '1.0.0',
      root: 'C:\\capture\\plugin',
      mcpScript: 'scripts/mcp.mjs',
      mcpServerName: 'capture-plugin-mcp',
      mcpEnabled: true,
    }],
  },
  hooksStatus: {
    ruleCount: 1,
    rules: [{ index: 0, tool: 'shell', action: 'ask', enabled: true }],
  },
  skillsStatus: {
    count: 1,
    skills: [{ name: 'capture-skill', description: 'Capture layout skill', source: 'built-in' }],
  },
  getDisabledSkills: { disabled: [] },
  listAgents: [{
    id: 'lead',
    name: 'Lead',
    route: { provider: 'openai', model: 'gpt-capture', effort: 'high', fast: true },
  }],
  getUpdateSettings: { currentVersion: 'capture', latestVersion: 'capture', autoUpdate: false },
  getUpdateStatus: { phase: 'idle' },
  getTurnReviewDiff: {
    supported: true,
    files: [],
    patch: '',
    agents: [{
      sessionId: 'capture-worker',
      agent: 'worker',
      tag: 'worker-1',
      patch: [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,4 +1,4 @@',
        '-const retries = 1;',
        '+const retries = 3;',
        '',
      ].join('\n'),
    }],
  },
};

export class CaptureService implements DesktopService {
  private captureTheme = 'basic';
  private jitterStoredSnapshot: SessionSnapshot = null;
  private jitterLiveSnapshot: SessionSnapshot = null;
  private jitterColdSnapshot: SessionSnapshot = null;
  private snapshot: SessionSnapshot = {
    sessionId: '',
    items: [],
    queued: [],
    toasts: [],
    busy: false,
    commandBusy: false,
    spinner: null,
    cwd: process.cwd(),
  };
  private readonly listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private readonly sessionListeners = new Set<(sessions: DesktopSessionSummary[]) => void>();
  private readonly agentPoolListeners = new Set<(agents: DesktopAgentPoolRow[]) => void>();
  private readonly sessionStateListeners = new Set<(update: DesktopSessionStateUpdate) => void>();

  constructor(_options: unknown = {}) {}

  private publish(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
    const sessionId = String(snapshot?.sessionId || '');
    if (sessionId) {
      for (const listener of this.sessionStateListeners) {
        listener({ sessionId, snapshot, frameSource: 'live' });
      }
    }
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeSessions(listener: (sessions: DesktopSessionSummary[]) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  subscribeAgentPool(listener: (agents: DesktopAgentPoolRow[]) => void): () => void {
    this.agentPoolListeners.add(listener);
    return () => this.agentPoolListeners.delete(listener);
  }

  subscribeSessionStates(listener: (update: DesktopSessionStateUpdate) => void): () => void {
    this.sessionStateListeners.add(listener);
    return () => this.sessionStateListeners.delete(listener);
  }

  async startProject(projectPath: string): Promise<SessionSnapshot> {
    this.publish({ ...this.snapshot, cwd: projectPath });
    return this.snapshot;
  }

  async startProjectTask(projectPath: string): Promise<SessionSnapshot> {
    return this.startProject(projectPath);
  }

  async listProjects(): Promise<DesktopProjectSummary[]> { return []; }
  async addProject(): Promise<void> {}
  async projectDirectory(projectPath: string): Promise<string> { return projectPath; }
  async renameProject(): Promise<void> {}
  async removeProject(): Promise<void> {}
  async listProjectDir(): Promise<unknown> { return []; }
  async readProjectTextFile(): Promise<unknown> { return null; }
  async writeProjectTextFile(): Promise<unknown> { return null; }
  async statProjectFile(): Promise<unknown> { return null; }
  async createProjectEntry(): Promise<unknown> { return null; }
  async renameProjectEntry(): Promise<unknown> { return null; }
  async moveProjectEntry(): Promise<unknown> { return null; }
  async copyProjectEntry(): Promise<unknown> { return null; }
  async projectEntryPath(_projectPath: string, relPath: string): Promise<string> { return relPath; }
  async codeGraphQuery(): Promise<unknown> { return null; }
  async listAgentPool(): Promise<DesktopAgentPoolRow[]> { return []; }
  async renameSession(): Promise<void> {}
  async setSessionArchived(): Promise<void> {}
  async deleteSession(): Promise<SessionSnapshot> { return null; }
  async prefetchSession(): Promise<boolean> { return true; }
  async peekSession(): Promise<boolean> { return true; }
  async setVisibleSessions(): Promise<boolean> { return true; }
  async searchProjectFiles(): Promise<string[]> { return []; }
  async submit(): Promise<boolean> { return true; }
  async submitToSession(): Promise<boolean> { return true; }
  async abort(_options: DesktopAbortOptions = {}): Promise<{ aborted: boolean }> {
    return { aborted: true };
  }
  async abortSession(
    _sessionId: string,
    _options: DesktopAbortOptions = {},
  ): Promise<{ aborted: boolean }> {
    return { aborted: true };
  }
  resolveToolApproval(_id: string, _decision: ToolApprovalDecision): boolean { return true; }
  resolveToolApprovalForSession(
    _sessionId: string,
    _id: string,
    _decision: ToolApprovalDecision,
  ): boolean {
    return true;
  }

  async submitNewTask(
    _prompt: DesktopPromptContent,
    _options: DesktopSubmitOptions = {},
    _draft: DesktopNewTaskDraft = {},
  ): Promise<DesktopNewTaskSubmitResult> {
    const sessionId = `capture_${Date.now()}`;
    const snapshot = { ...this.snapshot, sessionId };
    this.publish(snapshot);
    return { accepted: true, sessionId, snapshot };
  }

  async setModelRoute(
    selection: DesktopModelSelection,
    _sessionId?: string,
  ): Promise<SessionSnapshot> {
    this.publish({ ...this.snapshot, ...selection });
    return this.snapshot;
  }

  async setFast(enabled: boolean, _sessionId?: string): Promise<SessionSnapshot> {
    this.publish({ ...this.snapshot, fast: enabled });
    return this.snapshot;
  }

  async invokeDesktopOperation(): Promise<unknown> {
    throw new Error('The capture harness has no daemon.');
  }

  prepareJitterRemoteResume(stored: SessionSnapshot, live: SessionSnapshot): void {
    this.jitterStoredSnapshot = stored;
    this.jitterLiveSnapshot = live;
  }

  // Cold-entry pass: a settled session with history, resumed through the real
  // sidebar → resumeSession path (a pushed snapshot for a foreign session id
  // never reaches a route).
  prepareJitterColdResume(snapshot: SessionSnapshot): void {
    this.jitterColdSnapshot = snapshot;
  }

  async listSessions(): Promise<DesktopSessionSummary[]> {
    if (jitterProbeEnabled()) {
      if (process.env.MIXDOG_JITTER_PROBE === 'switch') {
        return ['a', 'b', 'c'].map((suffix, index) => ({
          id: `probe_switch_${suffix}`,
          preview: `Switch ${suffix.toUpperCase()}`,
          title: `Switch ${suffix.toUpperCase()}`,
          updatedAt: Date.now() - index,
          messageCount: suffix === 'b' ? 96 : 1,
          cwd: process.cwd(),
          classification: 'task',
          projectPath: null,
          currentSession: false,
          working: false,
        }));
      }
      const sessions: DesktopSessionSummary[] = [{
        id: 'probe_session_b',
        preview: 'Remote streaming probe',
        title: 'Remote streaming probe',
        updatedAt: Date.now(),
        messageCount: 90,
        cwd: process.cwd(),
        classification: 'task',
        projectPath: null,
        currentSession: false,
        working: true,
      }];
      // The cold-history row belongs to the passes that resume it (entry,
      // keys, width). The streaming pass must not see it: an extra listed
      // session changes the layout it measures against.
      const mode = String(process.env.MIXDOG_JITTER_PROBE || '');
      if (mode === 'entry' || mode === 'keys' || mode === 'width') {
        sessions.push({
        id: 'probe_session_cold',
        preview: 'Cold history probe',
        title: 'Cold history probe',
        updatedAt: Date.now() - 60_000,
        messageCount: 84,
        cwd: process.cwd(),
        classification: 'task',
        projectPath: null,
        currentSession: false,
        working: true,
        });
      }
      return sessions;
    }
    return [];
  }

  async resumeSession(sessionId: string): Promise<SessionSnapshot> {
    if (process.env.MIXDOG_JITTER_PROBE === 'switch' && /^probe_switch_[abc]$/.test(sessionId)) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 180));
      const suffix = sessionId.slice(-1).toUpperCase();
      const longScript = `Switch B transcript\n\n\`\`\`ts\n${Array.from(
        { length: 320 },
        (_line, line) => `const switchLine${line} = ${line};`,
      ).join('\n')}\n\`\`\``;
      const items = suffix === 'B'
        ? Array.from({ length: 96 }, (_, index) => ({
            id: `${sessionId}-row-${index}`,
            kind: index % 2 === 0 ? 'user' : 'assistant',
            text: index === 95 ? longScript : `Switch B transcript row ${index}`,
          }))
        : suffix === 'A'
          ? Array.from({ length: 88 }, (_, index) => ({
              id: `${sessionId}-row-${index}`,
              kind: index % 2 === 0 ? 'user' : 'assistant',
              text: `Switch A transcript row ${index} ${'variable height '.repeat(index % 5)}`,
            }))
        : [{
            id: `${sessionId}-row`,
            kind: 'assistant',
            text: `Switch ${suffix} transcript`,
          }];
      const snapshot = {
        ...((this.snapshot || {}) as Record<string, unknown>),
        toasts: [],
        sessionId,
        busy: false,
        commandBusy: false,
        spinner: null,
        items,
        queued: [],
        streamingTail: null,
      } as SessionSnapshot;
      this.publish(snapshot);
      return snapshot;
    }
    if (jitterProbeEnabled() && sessionId === 'probe_session_cold') {
      if (!this.jitterColdSnapshot) throw new Error('Jitter probe cold snapshot is not prepared.');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
      this.publish(this.jitterColdSnapshot);
      return this.jitterColdSnapshot;
    }
    if (!jitterProbeEnabled() || sessionId !== 'probe_session_b') {
      return this.snapshot;
    }
    const stored = this.jitterStoredSnapshot as Record<string, unknown> | null;
    const live = this.jitterLiveSnapshot as Record<string, unknown> | null;
    if (!stored || !live || stored.sessionId !== sessionId || live.sessionId !== sessionId) {
      throw new Error('Jitter probe remote resume snapshots are not prepared.');
    }
    // Model the service's real held-publication boundary: the persisted restore
    // exists first, but resume resolves only after live-share supplies FULL.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 180));
    this.publish(this.jitterLiveSnapshot);
    return this.jitterLiveSnapshot;
  }

  // Keep model-route rows fully populated without starting the isolated
  // runtime engine, so phone alignment covers model, effort, and fast controls.
  async listProviderModels(_options: DesktopModelCatalogOptions = {}): Promise<DesktopModelOption[]> {
    return [{
      provider: 'openai',
      model: 'gpt-capture',
      display: 'Capture',
      effortOptions: [{ value: 'high', label: 'High' }],
      fastCapable: true,
      fastPreferred: true,
    }];
  }

  // New-task activation without booting the disabled engine: App renders
  // EMPTY_SNAPSHOT on the new-task tab until startTask succeeds, so the tool
  // showcase pass clicks New task and this override must resolve instantly.
  async startTask(): Promise<SessionSnapshot> {
    return this.getSnapshot();
  }

  getSnapshot(): SessionSnapshot {
    return {
      ...(this.snapshot || {}),
      toasts: [{ id: 'capture-toast', tone: 'error', text: 'Capture stacking check' }],
    };
  }

  async readCapabilities(
    requests: ReadonlyArray<DesktopCapabilityReadRequest>,
  ): Promise<DesktopCapabilityReadResult[]> {
    return requests.map((request) => {
      if (request.capability === 'listThemes') {
        return {
          ok: true,
          value: [
            { id: 'basic', label: 'Basic', description: 'Capture dark theme', current: this.captureTheme === 'basic' },
            { id: 'light', label: 'Light', description: 'Capture light theme', current: this.captureTheme === 'light' },
          ],
        };
      }
      if (request.capability === 'getTheme') return { ok: true, value: this.captureTheme };
      if (Object.prototype.hasOwnProperty.call(CAPTURE_SETTINGS_VALUES, request.capability)) {
        return { ok: true, value: CAPTURE_SETTINGS_VALUES[request.capability] };
      }
      return { ok: false, error: `${request.capability} is unavailable in UI capture.` };
    });
  }

  async invokeCapability<T = unknown>(
    capability: DesktopCapability,
    args: unknown[] = [],
  ): Promise<DesktopCapabilityResult<T>> {
    if (capability === 'setTheme') {
      this.captureTheme = String(args[0] || 'basic');
      return { value: this.captureTheme as T, snapshot: this.getSnapshot() };
    }
    // Dictation E2E: the fake Chromium media device feeds MediaRecorder; the
    // engine transcription is stubbed so the smoke validates the FULL renderer
    // chain (record → stop → base64 → IPC → draft append) hardware-free.
    if (capability === 'transcribeAudio') {
      const payload = args[0] as { data?: string; mimeType?: string } | undefined;
      if (!payload || typeof payload.data !== 'string' || payload.data.length < 512) {
        throw new Error('capture transcribeAudio received no recorded audio payload.');
      }
      return { value: 'dictation smoke transcript' as T, snapshot: this.getSnapshot() };
    }
    if (capability === 'getUpdateSettings') {
      return { value: { currentVersion: 'capture', autoUpdate: false } as T, snapshot: this.getSnapshot() };
    }
    if (capability === 'memoryControl') {
      return { value: '' as T, snapshot: this.getSnapshot() };
    }
    if (capability === 'checkForUpdate') {
      return {
        value: CAPTURE_SETTINGS_VALUES.getUpdateSettings as T,
        snapshot: this.getSnapshot(),
      };
    }
    if (capability === 'getTheme') {
      return { value: this.captureTheme as T, snapshot: this.getSnapshot() };
    }
    if (Object.prototype.hasOwnProperty.call(CAPTURE_SETTINGS_VALUES, capability)) {
      return {
        value: CAPTURE_SETTINGS_VALUES[capability] as T,
        snapshot: this.getSnapshot(),
      };
    }
    // The capture profile runs against an isolated MIXDOG_HOME, where a fresh
    // config reports onboarding as incomplete; the wizard would cover the UI
    // under capture. Captures always run as an already-onboarded desktop.
    if (capability === 'getOnboardingStatus') {
      return { value: { completed: true } as T, snapshot: this.getSnapshot() };
    }
    // Anything else (e.g. the settings preload's memoryControl read) would
    // boot the runtime engine; with every provider disabled in the isolated
    // profile that call never settles, so settings hydration stays pending
    // forever and engine-independent rows (Theme) remain disabled. Fail fast
    // instead — every capability consumer catches and falls back.
    void args;
    throw new Error(`${capability} is unavailable in UI capture.`);
  }

  subscribeDesktopEvents(): () => void { return () => {}; }
  perfLog(): void {}
  async dispose(): Promise<void> {
    this.listeners.clear();
    this.sessionListeners.clear();
    this.agentPoolListeners.clear();
    this.sessionStateListeners.clear();
  }
}
