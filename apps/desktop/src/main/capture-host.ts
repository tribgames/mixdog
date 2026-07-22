import type { EngineSnapshot, DesktopCapability, DesktopCapabilityReadRequest, DesktopCapabilityReadResult, DesktopCapabilityResult, DesktopModelOption, DesktopSessionSummary } from '../shared/contract';
import { EngineHost } from './engine-host';

// EngineHost.listSessions() lazily starts the runtime engine. The isolated
// capture profile cannot contain sessions, so avoid provider/runtime startup
// while retaining the exact production host and secure IPC handler shape.
export const CAPTURE_SETTINGS_VALUES: Record<string, unknown> = {
  getProfile: {
    title: 'Capture',
    language: 'system',
    languages: [{ id: 'system', label: 'System' }],
  },
  getAutoClear: { enabled: true, idleMs: 3_600_000, providerDefaults: [] },
  getCompactionSettings: { auto: true },
  getMemorySettings: { enabled: true },
  getChannelSettings: { enabled: true },
  isRemoteEnabled: false,
  getChannelWorkerStatus: { running: false },
  getChannelSetup: {
    backend: 'discord',
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
};

export class CaptureEngineHost extends EngineHost {
  private captureTheme = 'basic';
  private jitterStoredSnapshot: EngineSnapshot = null;
  private jitterLiveSnapshot: EngineSnapshot = null;

  prepareJitterRemoteResume(stored: EngineSnapshot, live: EngineSnapshot): void {
    this.jitterStoredSnapshot = stored;
    this.jitterLiveSnapshot = live;
  }

  override async listSessions(): Promise<DesktopSessionSummary[]> {
    if (process.env.MIXDOG_JITTER_PROBE === '1') {
      return [{
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
    }
    return [];
  }

  override async resumeSession(sessionId: string): Promise<EngineSnapshot> {
    if (process.env.MIXDOG_JITTER_PROBE !== '1' || sessionId !== 'probe_session_b') {
      return super.resumeSession(sessionId);
    }
    const stored = this.jitterStoredSnapshot as Record<string, unknown> | null;
    const live = this.jitterLiveSnapshot as Record<string, unknown> | null;
    if (!stored || !live || stored.sessionId !== sessionId || live.sessionId !== sessionId) {
      throw new Error('Jitter probe remote resume snapshots are not prepared.');
    }
    // Model EngineHost's real held-publication boundary: the persisted restore
    // exists first, but resume resolves only after live-share supplies FULL.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 180));
    this.publish(this.jitterLiveSnapshot);
    return this.jitterLiveSnapshot;
  }

  // Keep model-route rows fully populated without starting the isolated
  // runtime engine, so phone alignment covers model, effort, and fast controls.
  override async listProviderModels(): Promise<DesktopModelOption[]> {
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
  override async startTask() {
    return this.getSnapshot();
  }

  override getSnapshot() {
    return {
      ...(super.getSnapshot() || {}),
      toasts: [{ id: 'capture-toast', tone: 'error', text: 'Capture stacking check' }],
    };
  }

  override async readCapabilities(
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

  override async invokeCapability<T = unknown>(
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
}
