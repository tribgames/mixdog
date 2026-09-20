import type {
  DesktopLspCapabilities,
  DesktopLspDiagnosticEvent,
  DesktopLspServerState,
  DesktopLspStatusEvent,
} from '../shared/contract';
import type { CapabilityResolver, LanguageServerSpec, ServerSession } from './language-server-types';

export function sessionKey(root: string, spec: LanguageServerSpec): string {
  const normalized = process.platform === 'win32' ? root.toLocaleLowerCase() : root;
  return `${normalized}\0${spec.id}`;
}

export function publicState(
  spec: LanguageServerSpec | null,
  status: DesktopLspServerState['status'],
  detail?: string,
  capabilities?: DesktopLspCapabilities
): DesktopLspServerState {
  return {
    available: status === 'ready',
    status,
    server: spec?.name || '',
    ...(detail ? { detail } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

interface LanguageServerStateOptions {
  specFor: (root: string, languageId: string) => Promise<LanguageServerSpec | null>;
  capabilitiesWithDynamicRegistrations: CapabilityResolver;
}

export class LanguageServerState {
  private readonly sessions = new Map<string, ServerSession>();
  private readonly starting = new Map<string, Promise<ServerSession | null>>();
  private readonly states = new Map<string, DesktopLspServerState>();
  private readonly missingUntil = new Map<string, number>();
  private readonly restartFailures = new Map<string, { count: number; retryAt: number }>();
  private readonly diagnosticListeners = new Set<(event: DesktopLspDiagnosticEvent) => void>();
  private readonly statusListeners = new Set<(event: DesktopLspStatusEvent) => void>();

  constructor(private readonly options: LanguageServerStateOptions) {}

  specFor(root: string, languageId: string): Promise<LanguageServerSpec | null> {
    return this.options.specFor(root, languageId);
  }

  session(key: string): ServerSession | undefined {
    return this.sessions.get(key);
  }

  setSession(key: string, session: ServerSession): void {
    this.sessions.set(key, session);
  }

  deleteSession(key: string): void {
    this.sessions.delete(key);
  }

  startingPromise(key: string): Promise<ServerSession | null> | undefined {
    return this.starting.get(key);
  }

  setStarting(key: string, promise: Promise<ServerSession | null>): void {
    this.starting.set(key, promise);
  }

  clearStarting(key: string): void {
    this.starting.delete(key);
  }

  isMissing(key: string): boolean {
    return (this.missingUntil.get(key) || 0) > Date.now();
  }

  markMissing(key: string, until: number): void {
    this.missingUntil.set(key, until);
  }

  isRestartCoolingDown(key: string): boolean {
    return (this.restartFailures.get(key)?.retryAt || 0) > Date.now();
  }

  recordRestartFailure(key: string): number {
    const count = Math.min(6, (this.restartFailures.get(key)?.count ?? 0) + 1);
    const delayMs = Math.min(30_000, 1_000 * 2 ** (count - 1));
    this.restartFailures.set(key, { count, retryAt: Date.now() + delayMs });
    return delayMs;
  }

  clearRestartFailures(key: string): void {
    this.restartFailures.delete(key);
  }

  state(key: string): DesktopLspServerState | undefined {
    return this.states.get(key);
  }

  setState(key: string, state: DesktopLspServerState): void {
    this.states.set(key, state);
  }

  activeSessions(): ServerSession[] {
    return [...this.sessions.values()];
  }

  clearSessions(): void {
    this.sessions.clear();
  }

  subscribeDiagnostics(listener: (event: DesktopLspDiagnosticEvent) => void): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  subscribeStatus(listener: (event: DesktopLspStatusEvent) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  emitStatus(
    projectPath: string,
    languageId: string,
    spec: LanguageServerSpec | null,
    status: DesktopLspServerState['status'],
    detail?: string,
    capabilities?: DesktopLspCapabilities,
    relPath?: string
  ): DesktopLspServerState {
    const state = publicState(spec, status, detail, capabilities);
    if (spec) this.states.set(sessionKey(projectPath, spec), state);
    const event: DesktopLspStatusEvent = {
      projectPath,
      languageId,
      ...(relPath ? { relPath } : {}),
      ...state,
    };
    for (const listener of this.statusListeners) listener(event);
    return state;
  }

  emitDiagnostics(event: DesktopLspDiagnosticEvent): void {
    for (const listener of this.diagnosticListeners) listener(event);
  }

  refreshCapabilities(session: ServerSession): void {
    const emittedLanguages = new Set<string>();
    for (const [uri, document] of session.documents) {
      const capabilities = this.options.capabilitiesWithDynamicRegistrations(
        session.baseCapabilities,
        session.registrations.values(),
        document.languageId,
        uri
      );
      emittedLanguages.add(document.languageId);
      this.emitStatus(
        session.projectPath,
        document.languageId,
        session.spec,
        'ready',
        undefined,
        capabilities,
        document.relPath
      );
    }
    for (const languageId of session.languageIds) {
      if (emittedLanguages.has(languageId)) continue;
      const capabilities = this.options.capabilitiesWithDynamicRegistrations(
        session.baseCapabilities,
        session.registrations.values(),
        languageId
      );
      this.emitStatus(session.projectPath, languageId, session.spec, 'ready', undefined, capabilities);
    }
  }
}
