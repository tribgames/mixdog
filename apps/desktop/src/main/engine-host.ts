import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { appendFileSync, watch, type FSWatcher } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopCapabilityResult,
  DesktopEngineState,
  DesktopModelCatalogOptions,
  DesktopSessionSummary,
  DesktopProjectSummary,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopPromptContent,
  DesktopSubmitOptions,
  EngineSnapshot,
  ToolApprovalDecision,
} from '../shared/contract';
import { DESKTOP_CAPABILITIES } from '../shared/contract';
import {
  generatedSessionTitle,
  isGeneratedSessionTitleNoise,
  isSyntheticSessionDisplayText,
  normalizeSessionTitle,
  promptTitle,
  stripInjectedDisplayText,
  stripSessionEnvelope,
} from '../shared/session-title.mjs';
import { desktopSessionSummaries, desktopSnapshot } from './desktop-state';
import { searchProjectDirectory } from './project-file-search';
import type { MixdogEngine, SnapshotListener, EngineFactory, EngineHostOptions, DesktopProjectPreferences, MixdogProject, MixdogProjectsModule, DesktopSessionMetadataFile, DesktopSessionScope, DesktopOAuthFlow, StatuslineSegmentsModule, MixdogSessionStoreModule } from "./engine-host-support";
import { EMPTY_PROJECT_PREFERENCES, DESKTOP_CAPABILITY_SET, ENGINE_PUBLICATION_INTERVAL_MS, SESSIONS_CHANGED_DEBOUNCE_MS, DESKTOP_PERF_ENABLED, ENGINE_PREWARM_DELAY_MS, DESKTOP_TRANSCRIPT_ITEM_LIMIT, SHELL_JOBS_ACTIVE_POLL_INTERVAL_MS, SHELL_JOBS_IDLE_POLL_INTERVAL_MS, normalizedProviderModels, engineModuleUrl, projectsModuleUrl, sessionStoreModuleUrl, statuslineSegmentsModuleUrl, requiredApplicationPath, normalizedProjectKey, matchingProjectPath, withoutMatchingProject, projectAlias, recordValue, normalizedMarker, hasExplicitInternalMarker, isInternalTranscriptItem, removeInternalToolDisplayMetadata, sanitizeTranscriptItem, sanitizedItemClone, activeToolsFromSummary, projectedAgentEntry, projectDesktopLiveWorkState, copySnapshot, shellJobsPollDelay, copyCapabilityValue, TERMINAL_AGENT_STATUS } from "./engine-host-support";
export * from "./engine-host-support";

export class EngineHost {
  private engine: MixdogEngine | null = null;
  private currentProject: string | null = null;
  private recentProjects: string[] = [];
  private unsubscribeEngine: (() => void) | null = null;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly sessionListeners = new Set<(sessions: DesktopSessionSummary[]) => void>();
  private sessionsWatcher: FSWatcher | null = null;
  private sessionsWatchedDir: string | null = null;
  private sessionsChangedTimer: ReturnType<typeof setTimeout> | null = null;
  private transition: Promise<void> = Promise.resolve();
  private readonly userDataPath: string | null;
  private readonly getUserDataPath: (() => string) | null;
  private readonly createEngineOverride: EngineFactory | null;
  private readonly loadProjectsModule: () => Promise<MixdogProjectsModule>;
  private readonly loadSessionStoreOverride: (() => Promise<MixdogSessionStoreModule>) | null;
  private sessionStoreModule: Promise<MixdogSessionStoreModule> | null = null;
  private readonly packaged: boolean;
  private readonly resourcesPath: string;
  private readonly appPath: string | undefined;
  private projectPreferences: DesktopProjectPreferences | null = null;
  private sessionTitles: Record<string, string> | null = null;
  private sessionNames: Record<string, string> | null = null;
  private sessionArchived: Record<string, number> | null = null;
  private sessionTitleWrite: Promise<void> = Promise.resolve();
  private engineWorkspace: string | null = null;
  private engineDesktopSession: DesktopSessionScope | null = null;
  private pendingFastPreference: boolean | null = null;
  private publicationHoldDepth = 0;
  private publicationPending = false;
  private publicationPendingSnapshot: EngineSnapshot | undefined;
  private publicationTimer: NodeJS.Timeout | null = null;
  private engineWarmupTimer: NodeJS.Timeout | null = null;
  private shellJobsTimer: NodeJS.Timeout | null = null;
  private shellJobsPollDelayMs = 0;
  private shellJobsModule: Promise<StatuslineSegmentsModule> | null = null;
  private shellJobs = { count: 0, elapsedLabel: '' };
  private readonly oauthFlows = new Map<string, DesktopOAuthFlow>();
  private oauthFlowSequence = 0;
  private engineModulePreloaded = false;
  private readonly searchProjectDirectory: typeof searchProjectDirectory;

  constructor(options: EngineHostOptions = {}) {
    this.userDataPath = options.userDataPath ?? null;
    this.getUserDataPath = options.getUserDataPath ?? null;
    this.createEngineOverride = options.createEngine ?? null;
    this.packaged = options.packaged === true;
    this.resourcesPath = options.resourcesPath ?? process.resourcesPath;
    this.appPath = options.appPath;
    this.searchProjectDirectory = options.searchProjectDirectory ?? searchProjectDirectory;
    this.loadSessionStoreOverride = options.loadSessionStore ?? null;
    this.loadProjectsModule = options.loadProjects ?? (async () => import(
      /* @vite-ignore */ projectsModuleUrl(this.packaged, this.resourcesPath, this.appPath)
    ) as Promise<MixdogProjectsModule>);
    if (!this.packaged && !this.createEngineOverride) requiredApplicationPath(this.appPath);
    // Start compiling the runtime graph while Chromium is still bringing the
    // window up: the first engine boot then starts from a warm module cache.
    setTimeout(() => this.preloadEngineModule(), 0)?.unref?.();
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeSessions(listener: (sessions: DesktopSessionSummary[]) => void): () => void {
    this.sessionListeners.add(listener);
    this.ensureSessionsWatcher();
    return () => { this.sessionListeners.delete(listener); };
  }

  // Sidebar freshness: watch the on-disk session store so activity from ANY
  // mixdog process (channel workers, schedules, another window) pushes a fresh
  // catalog instead of waiting out the renderer's safety-net poll.
  private ensureSessionsWatcher(): void {
    if (this.sessionListeners.size === 0) return;
    const dir = String(this.engine?.sessionStoreDir?.() || '');
    if (!dir || this.sessionsWatchedDir === dir) return;
    this.stopSessionsWatcher();
    try {
      const watcher = watch(dir, { persistent: false }, (_event, filename) => {
        // Session JSON changes update titles/counts; heartbeat create/touch/
        // delete changes cross-process working state. Both are catalog-visible
        // and the existing debounce absorbs duplicate fs events.
        const changed = String(filename || '');
        if (changed && !changed.endsWith('.json') && !changed.endsWith('.hb')) return;
        this.scheduleSessionsChanged();
      });
      watcher.on('error', () => this.stopSessionsWatcher());
      this.sessionsWatcher = watcher;
      this.sessionsWatchedDir = dir;
    } catch {
      // The store directory may not exist until the first session save; the
      // next ensure call (engine swap / listSessions) retries.
    }
  }

  private stopSessionsWatcher(): void {
    try { this.sessionsWatcher?.close(); } catch { /* already closed */ }
    this.sessionsWatcher = null;
    this.sessionsWatchedDir = null;
    if (this.sessionsChangedTimer) {
      clearTimeout(this.sessionsChangedTimer);
      this.sessionsChangedTimer = null;
    }
  }

  private scheduleSessionsChanged(): void {
    if (this.sessionListeners.size === 0 || this.sessionsChangedTimer) return;
    this.sessionsChangedTimer = setTimeout(() => {
      this.sessionsChangedTimer = null;
      void this.emitSessionsChanged();
    }, SESSIONS_CHANGED_DEBOUNCE_MS);
    this.sessionsChangedTimer.unref?.();
  }

  private async emitSessionsChanged(): Promise<void> {
    try {
      const rows = await this.listSessions();
      for (const listener of [...this.sessionListeners]) {
        try { listener(rows); } catch { /* subscriber fault must not break others */ }
      }
    } catch {
      // Listing is best-effort here; the renderer poll remains the safety net.
    }
  }

  getSnapshot(): EngineSnapshot {
    const cloneStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    const snapshot = desktopSnapshot(copySnapshot(this.engine), this.currentProject, this.recentProjects);
    if (DESKTOP_PERF_ENABLED) {
      const ms = performance.now() - cloneStarted;
      if (ms >= 5) {
        const items = Array.isArray(snapshot?.items) ? snapshot.items.length : 0;
        this.perfLog(`snapshot-clone ms=${ms.toFixed(1)} items=${items}`);
      }
    }
    const sessionId = String(snapshot?.sessionId || '');
    const desktopSessionTitle = sessionId
      ? this.sessionNames?.[sessionId] || this.sessionTitles?.[sessionId]
      : '';
    const decorated = {
      ...snapshot,
      ...(desktopSessionTitle ? { desktopSessionTitle } : {}),
      shellJobs: { ...this.shellJobs },
    };
    if (this.pendingFastPreference === null) return decorated;
    // Engine session state can lag one event-loop turn behind an applied Fast
    // preference. Keep overriding the snapshot until the engine reflects it,
    // then drop the pending marker instead of hard-failing the mutation.
    if (typeof snapshot?.fast === 'boolean' && snapshot.fast === this.pendingFastPreference) {
      this.pendingFastPreference = null;
      return decorated;
    }
    return { ...decorated, fast: this.pendingFastPreference };
  }

  async startProject(projectPath: string): Promise<EngineSnapshot> {
    const requestedPath = projectPath.trim();
    if (!requestedPath) throw new TypeError('A project folder is required.');

    let result: EngineSnapshot = null;
    await this.exclusive(async () => {
      await this.loadSessionTitles();
      const projectStore = await this.loadProjectsModule();
      const canonicalPath = await realpath(requestedPath);
      const info = await stat(canonicalPath);
      if (!info.isDirectory()) throw new TypeError('The selected project is not a directory.');

      await this.replaceEngine(canonicalPath, {
        classification: 'project',
        projectPath: canonicalPath,
      }, 'desktop-project-switch');
      this.currentProject = canonicalPath;
      const registered = projectStore.addProject(canonicalPath);
      if (!registered) throw new Error('Unable to register the selected project.');
      projectStore.touchProjectSelected(registered.path);
      const preferences = await this.loadProjectPreferences();
      preferences.hidden = withoutMatchingProject(preferences.hidden, registered.path);
      await this.saveProjectPreferences(projectStore);
      this.recentProjects = this.registeredProjects(projectStore)
        .map((project) => project.path)
        .slice(0, 12);
      // Return the same decorated state that is published. Returning the raw
      // engine snapshot here lets a renderer invoke response overwrite the
      // navigation metadata from the richer state publication.
      result = this.getSnapshot();
      this.publish();
    });
    return result;
  }

  async startProjectTask(projectPath: string): Promise<EngineSnapshot> {
    const requestedPath = projectPath.trim();
    if (!requestedPath) throw new TypeError('A project folder is required.');
    let result: EngineSnapshot = null;
    const started = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    let stageNote = '';
    const stage = (label: string, from: number) => {
      if (DESKTOP_PERF_ENABLED) stageNote += ` ${label}=${(performance.now() - from).toFixed(0)}ms`;
    };
    await this.exclusive(async () => {
      let stageStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
      await this.loadSessionTitles();
      stage('titles', stageStarted);
      stageStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
      const projectStore = await this.loadProjectsModule();
      stage('projects-module', stageStarted);
      stageStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
      const registered = this.knownProject(projectStore, requestedPath);
      stage('known-project', stageStarted);
      stageStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
      const canonicalPath = await this.canonicalDirectory(registered.path);
      stage('canonical', stageStarted);
      stageStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
      await this.replaceEngine(canonicalPath, {
        classification: 'project',
        projectPath: canonicalPath,
      }, 'desktop-new-project-task');
      stage('replace-engine', stageStarted);
      stageStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
      this.currentProject = canonicalPath;
      projectStore.touchProjectSelected(registered.path);
      this.recentProjects = this.registeredProjects(projectStore)
        .map((project) => project.path)
        .slice(0, 12);
      result = this.getSnapshot();
      this.publish();
      stage('finalize', stageStarted);
    });
    if (DESKTOP_PERF_ENABLED) {
      this.perfLog(`start-project-task total=${(performance.now() - started).toFixed(0)}ms${stageNote}`);
    }
    return result;
  }

  async listProjects(): Promise<DesktopProjectSummary[]> {
    let projects: DesktopProjectSummary[] = [];
    await this.exclusive(async () => {
      const projectStore = await this.loadProjectsModule();
      const registered = this.registeredProjects(projectStore);
      const preferences = await this.loadProjectPreferences();
      projects = registered
        .map((project) => ({
          name: project.name,
          path: project.path,
          alias: projectAlias(preferences.aliases, project.path),
          pinned: matchingProjectPath(preferences.pinned, project.path) !== null,
        }))
        // Array#sort is stable. Explicitly pinned projects move to the front,
        // while both groups retain the core projects.json recency order.
        .sort((a, b) => Number(b.pinned) - Number(a.pinned));
      this.recentProjects = registered.map((project) => project.path).slice(0, 12);
    });
    return projects;
  }

  async projectDirectory(projectPath: string): Promise<string> {
    let directory = '';
    await this.exclusive(async () => {
      const projectStore = await this.loadProjectsModule();
      const registered = this.knownProject(projectStore, projectPath);
      directory = await this.canonicalDirectory(registered.path);
    });
    return directory;
  }

  async renameProject(projectPath: string, alias: string): Promise<void> {
    const displayAlias = alias.trim();
    if (displayAlias.length > 120 || /[\u0000-\u001f\u007f]/.test(displayAlias)) {
      throw new TypeError('Project name is invalid.');
    }
    await this.exclusive(async () => {
      const projectStore = await this.loadProjectsModule();
      const known = this.knownProject(projectStore, projectPath).path;
      const renamed = projectStore.renameProject(known, displayAlias);
      if (!renamed) throw new Error('Project is not available.');
      const preferences = await this.loadProjectPreferences();
      for (const candidate of Object.keys(preferences.aliases)) {
        if (normalizedProjectKey(candidate) === normalizedProjectKey(known)) {
          delete preferences.aliases[candidate];
        }
      }
      if (displayAlias) preferences.aliases[known] = displayAlias;
      await this.saveProjectPreferences(projectStore);
    });
  }

  async setProjectPinned(projectPath: string, pinned: boolean): Promise<void> {
    await this.exclusive(async () => {
      const projectStore = await this.loadProjectsModule();
      const known = this.knownProject(projectStore, projectPath).path;
      const preferences = await this.loadProjectPreferences();
      preferences.pinned = pinned
        ? [known, ...withoutMatchingProject(preferences.pinned, known)]
        : withoutMatchingProject(preferences.pinned, known);
      await this.saveProjectPreferences(projectStore);
    });
  }

  async removeProject(projectPath: string): Promise<void> {
    await this.exclusive(async () => {
      const projectStore = await this.loadProjectsModule();
      const known = this.knownProject(projectStore, projectPath).path;
      if (projectStore.removeProject(known) !== true) {
        throw new Error('Project is not available.');
      }
      const preferences = await this.loadProjectPreferences();
      preferences.hidden = [known, ...withoutMatchingProject(preferences.hidden, known)];
      preferences.pinned = withoutMatchingProject(preferences.pinned, known);
      await this.saveProjectPreferences(projectStore);
      this.recentProjects = this.registeredProjects(projectStore)
        .map((project) => project.path)
        .slice(0, 12);
    });
  }

  async startTask(): Promise<EngineSnapshot> {
    let result: EngineSnapshot = null;
    await this.exclusive(async () => {
      await this.loadSessionTitles();
      const workspace = await this.taskWorkspace();
      await this.replaceEngine(workspace, {
        classification: 'task',
        projectPath: null,
      }, 'desktop-new-task');
      this.currentProject = null;
      result = this.getSnapshot();
      this.publish();
    });
    return result;
  }

  async listSessions(): Promise<DesktopSessionSummary[]> {
    // Cold sidebar listing must not construct the full runtime — and must not
    // QUEUE behind one either. Startup model-catalog hydration can hold the
    // transition lock for a multi-second engine boot, so the engine-free
    // sidecar read runs OUTSIDE `exclusive` and paints the session list
    // immediately (user: session list is dead slow on first boot). Explicit
    // test engines retain the historical path unless they also provide a
    // store override.
    if (!this.engine && (this.loadSessionStoreOverride || !this.createEngineOverride)) {
      try {
        await this.loadSessionTitles();
        const store = await this.loadSessionStoreModule();
        const rows = store.listStoredSessionSummaries({ rebuildIfMissing: true });
        const summaries = this.sessionSummaries(false, rows);
        this.scheduleEngineWarmup();
        this.ensureSessionsWatcher();
        return summaries;
      } catch {
        // A missing/corrupt lightweight module falls back to the authoritative
        // engine path instead of leaving the session browser empty.
      }
    }
    let summaries: DesktopSessionSummary[] = [];
    await this.exclusive(async () => {
      await this.loadSessionTitles();
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-session-browser');
      }
      // Once warm, refresh authoritatively so cross-process activity remains
      // visible through the existing engine/store ownership boundary.
      summaries = this.sessionSummaries(true);
    });
    this.ensureSessionsWatcher();
    return summaries;
  }

  private scheduleEngineWarmup(): void {
    if (this.engine || this.engineWarmupTimer) return;
    if (DESKTOP_PERF_ENABLED) this.perfLog('engine-prewarm scheduled');
    this.engineWarmupTimer = setTimeout(() => {
      this.engineWarmupTimer = null;
      void this.exclusive(async () => {
        if (this.engine) {
          if (DESKTOP_PERF_ENABLED) this.perfLog('engine-prewarm skipped=engine-already-live');
          return;
        }
        const started = DESKTOP_PERF_ENABLED ? performance.now() : 0;
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-engine-prewarm');
        if (DESKTOP_PERF_ENABLED) {
          this.perfLog(`engine-prewarm total=${(performance.now() - started).toFixed(0)}ms`);
        }
      }).catch((error: unknown) => {
        // Prewarm is opportunistic; the first resume retains the cold path.
        if (DESKTOP_PERF_ENABLED) {
          this.perfLog(`engine-prewarm failed=${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }, ENGINE_PREWARM_DELAY_MS);
    this.engineWarmupTimer.unref?.();
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('session id is invalid.');
    const normalized = normalizeSessionTitle(title, '');
    if (!normalized) throw new TypeError('Session title is invalid.');
    await this.exclusive(async () => {
      await this.loadSessionTitles();
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-session-rename');
      }
      if (!this.sessionSummaries().some((session) => session.id === sessionId)) {
        throw new Error('Session is not available.');
      }
      this.sessionNames![sessionId] = normalized;
      await this.queueSessionTitleWrite();
      if (String(this.engine?.getState()?.sessionId || '') === sessionId) this.publish();
    });
  }

  // Archive: hide from Recent without touching the on-disk
  // session file. Persisted in desktop-session-metadata.json — the optimistic
  // renderer flip previously had NO backend, so the next catalog push
  // resurrected every archived row (user bug).
  async setSessionArchived(sessionId: string, archived: boolean): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('session id is invalid.');
    let changed = false;
    await this.exclusive(async () => {
      await this.loadSessionTitles();
      const map = this.sessionArchived
        ?? (this.sessionArchived = Object.create(null) as Record<string, number>);
      const has = Object.prototype.hasOwnProperty.call(map, sessionId);
      if (archived === has) return;
      if (archived) map[sessionId] = Date.now();
      else delete map[sessionId];
      changed = true;
      await this.queueSessionTitleWrite();
    });
    // Reconcile every window through the normal catalog push channel.
    if (changed) this.scheduleSessionsChanged();
  }

  async deleteSession(sessionId: string): Promise<EngineSnapshot> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('session id is invalid.');
    let result: EngineSnapshot = null;
    await this.exclusive(async () => {
      await this.withPublicationsHeld(async () => {
        await this.loadSessionTitles();
        if (!this.engine) {
          const workspace = await this.taskWorkspace();
          await this.replaceEngine(workspace, {
            classification: 'task',
            projectPath: null,
          }, 'desktop-session-delete');
        }
        const engine = this.requireEngine();
        const state = engine.getState();
        if (state.busy === true || state.commandBusy === true) {
          throw new Error('Engine is busy.');
        }
        let rawSessions = engine.listSessions() || [];
        let available = desktopSessionSummaries(
          rawSessions,
          String(state.sessionId || ''),
          this.sessionTitles || {},
          this.sessionNames || {},
        ).some((session) => session.id === sessionId);
        if (!available) {
          rawSessions = engine.listSessions({ refreshFromStorage: true }) || [];
          available = desktopSessionSummaries(
            rawSessions,
            String(state.sessionId || ''),
            this.sessionTitles || {},
            this.sessionNames || {},
          ).some((session) => session.id === sessionId);
        }
        if (!available) throw new Error('Session is not available.');
        if (await engine.deleteSession(sessionId) !== true) {
          throw new Error('Session could not be deleted.');
        }
        const hadMetadata = Object.prototype.hasOwnProperty.call(this.sessionTitles, sessionId)
          || Object.prototype.hasOwnProperty.call(this.sessionNames, sessionId)
          || Object.prototype.hasOwnProperty.call(this.sessionArchived || {}, sessionId);
        delete this.sessionTitles![sessionId];
        delete this.sessionNames![sessionId];
        if (this.sessionArchived) delete this.sessionArchived[sessionId];
        if (hadMetadata) await this.queueSessionTitleWrite();
        result = this.getSnapshot();
        this.publish();
      });
    });
    return result;
  }

  async searchProjectFiles(
    projectIdOrWorkspaceId: string,
    query: string,
    limit = 50,
  ): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new TypeError('File search limit is invalid.');
    }
    const requested = projectIdOrWorkspaceId.trim();
    if (!requested) throw new TypeError('Project or workspace id is invalid.');
    if (typeof query !== 'string' || query.length > 1_024) {
      throw new TypeError('File search query is invalid.');
    }
    let root = '';
    await this.exclusive(async () => {
      const active = this.currentProject ?? this.engineWorkspace;
      if (!active || normalizedProjectKey(active) !== normalizedProjectKey(requested)) {
        throw new Error('Project or workspace is not active.');
      }
      root = await this.canonicalDirectory(active);
    });
    const results = await this.searchProjectDirectory(root, query, limit);
    await this.exclusive(async () => {
      const active = this.currentProject ?? this.engineWorkspace;
      if (!active || normalizedProjectKey(active) !== normalizedProjectKey(root)) {
        throw new Error('Project or workspace changed during file search.');
      }
    });
    return results;
  }

  async listProviderModels(options: DesktopModelCatalogOptions = {}): Promise<DesktopModelOption[]> {
    const started = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    await this.exclusive(async () => {
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-model-selector');
      }
    });
    const engine = this.requireEngine();
    if (DESKTOP_PERF_ENABLED) {
      this.perfLog(`model-catalog engine-ready ms=${(performance.now() - started).toFixed(0)}`);
    }
    // Catalog reads run OUTSIDE the host transition lock. The secrets-aware
    // full load is network-bound and used to hold `exclusive` for its entire
    // duration, so a session clicked during startup hydration queued behind it
    // (user: the first session open takes far too long). The engine reference
    // is captured under the lock; the core joins/caches concurrent catalog
    // reads, and a catalog rejection after a context switch surfaces through
    // the picker's inline failure path instead of blocking navigation.
    let models: DesktopModelOption[] = [];
    {
      const refresh = options.force === true || options.refresh === true;
      if (refresh) {
        models = normalizedProviderModels(await engine.listProviderModels({ force: true, quick: false }));
      } else if (options.quick === true) {
        // Match the TUI picker: seed the authoritative secrets-aware request
        // before reading quick route rows so the following full desktop read
        // joins this core promise instead of starting a second network load.
        try {
          void Promise.resolve(engine.listProviderModels({ quick: false })).catch((error: unknown) => {
            console.warn('Desktop model catalog background refresh failed:', error);
          });
        } catch (error) {
          // Quick rows remain useful, but a synchronous setup failure should
          // still be diagnosable rather than disappearing into the warmup path.
          console.warn('Desktop model catalog background refresh could not start:', error);
        }
        models = normalizedProviderModels(await engine.listProviderModels({ quick: true }));
      } else {
        // A quick request starts the core's advisory no-secrets warmup. If a
        // full request arrives while that warmup is in flight, the first call
        // can legally join it and receive its partial provider set. A second
        // non-quick read is free when the first call was authoritative (the
        // core cache answers it), while after an advisory warmup it starts the
        // required secrets-aware load. This keeps the desktop catalog aligned
        // with /model without forcing a network refresh on every open.
        await engine.listProviderModels({ quick: false });
        models = normalizedProviderModels(await engine.listProviderModels({ quick: false }));
      }
    }
    if (DESKTOP_PERF_ENABLED) {
      this.perfLog(`model-catalog total ms=${(performance.now() - started).toFixed(0)} quick=${options.quick === true}`);
    }
    return models;
  }

  async setModelRoute(selection: DesktopModelSelection): Promise<EngineSnapshot> {
    let result: EngineSnapshot = null;
    await this.exclusive(async () => {
      const engine = this.requireEngine();
      const state = engine.getState();
      // Match the TUI: a model change during an active turn is a preference for
      // the next session and must not rewrite the in-flight session. Concurrent
      // command mutations remain blocked.
      if (state.commandBusy === true) {
        throw new Error('Engine is busy.');
      }
      const model = normalizedProviderModels(await engine.listProviderModels({ quick: false }))
        .find((option) => option.provider === selection.provider && option.model === selection.model);
      if (!model) throw new Error('Selected provider/model is unavailable.');
      if (selection.effort !== undefined &&
        !model.effortOptions.some((option) => option.value === selection.effort)) {
        throw new Error('Selected effort is unavailable.');
      }
      if (selection.fast === true && !model.fastCapable) {
        throw new Error('Fast mode is unavailable for the selected provider/model.');
      }
      const latestState = engine.getState();
      if (latestState.commandBusy === true) {
        throw new Error('Engine is busy.');
      }
      // Preserve the engine's route contract: model changes are next-session
      // preferences unless the engine itself decides the current empty session
      // can safely adopt them. Rewriting a live route invalidates its provider-
      // keyed prompt cache.
      if (await engine.setRoute(selection) !== true) {
        throw new Error('Engine is busy.');
      }
      const routeState = engine.getState();
      // A successful route mutation supersedes any pristine Fast-only choice.
      // Keep an explicit route Fast value for the no-session renderer; when
      // omitted, let the engine's newly persisted route own the next session.
      this.pendingFastPreference = !routeState.sessionId && typeof selection.fast === 'boolean'
        ? selection.fast
        : null;
      result = this.getSnapshot();
      this.publish();
    });
    return result;
  }

  async setFast(enabled: boolean): Promise<EngineSnapshot> {
    let result: EngineSnapshot = null;
    await this.exclusive(async () => {
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-fast-preference');
      }
      const engine = this.requireEngine();
      const state = engine.getState();
      if (state.busy === true || state.commandBusy === true) {
        throw new Error('Engine is busy.');
      }
      // The runtime owns capability resolution (including metadata that may
      // have arrived after the last renderer snapshot), so its setFast return
      // value is authoritative. A stale desktop fastCapable field must not
      // prevent the backend from applying a valid stored preference.
      const applied = await engine.setFast(enabled);
      if (applied !== enabled) {
        const latest = engine.getState();
        if (latest.busy === true || latest.commandBusy === true) {
          throw new Error('Engine is busy.');
        }
        throw new Error('Fast mode preference was not applied.');
      }
      const latest = engine.getState();
      const hasActiveSession = Boolean(latest.sessionId);
      // The route API is authoritative: `applied === enabled` here. Session-
      // derived state may lag one event-loop turn (or not exist yet), so a
      // mismatch is reconciled via the pending override instead of throwing —
      // the previous hard error surfaced as a user-facing toast on a state
      // race even though the preference was applied successfully.
      const reflected = hasActiveSession
        && typeof latest.fast === 'boolean' && latest.fast === applied;
      this.pendingFastPreference = reflected ? null : applied;
      result = this.getSnapshot();
      this.publish();
    });
    return result;
  }

  async resumeSession(sessionId: string): Promise<EngineSnapshot> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('session id is invalid.');
    let result: EngineSnapshot = null;
    const totalStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    let stageNote = '';
    await this.exclusive(async () => {
      await this.withPublicationsHeld(async () => {
        await this.loadSessionTitles();
        if (!this.engine) {
          const workspace = await this.taskWorkspace();
          await this.replaceEngine(workspace, {
            classification: 'task',
            projectPath: null,
          }, 'desktop-session-browser');
        }
        if (String(this.engine?.getState()?.sessionId || '') === sessionId) {
          result = this.getSnapshot();
          return;
        }
        let rawSessions = this.engine?.listSessions() || [];
        let selected = desktopSessionSummaries(
          rawSessions,
          String(this.engine?.getState()?.sessionId || ''),
        ).find((row) => row.id === sessionId);
        // Session navigation is populated from this same cached catalog. Only
        // rescan storage if the requested row is absent (for example, a session
        // created by another process since the sidebar was loaded).
        if (!selected) {
          rawSessions = this.engine?.listSessions({ refreshFromStorage: true }) || [];
          selected = desktopSessionSummaries(
            rawSessions,
            String(this.engine?.getState()?.sessionId || ''),
          ).find((row) => row.id === sessionId);
        }
        if (!selected) throw new Error('Session is not available.');
        const rawSelected = rawSessions.find((row) => String(row.id || '') === sessionId);
        const storedDesktop = rawSelected?.desktopSession && typeof rawSelected.desktopSession === 'object'
          ? rawSelected.desktopSession as Record<string, unknown>
          : null;
        const isDesktopManaged = storedDesktop?.classification === 'task' ||
          storedDesktop?.classification === 'project';

        const workspace = selected.classification === 'task'
          ? await this.taskWorkspace()
          : await this.canonicalDirectory(selected.projectPath || selected.cwd);
        const desktopSession: DesktopSessionScope = selected.classification === 'project'
          ? { classification: 'project', projectPath: workspace }
          : { classification: 'task', projectPath: null };
        // Legacy CLI/TUI Lead sessions intentionally resume without a desktop
        // capability marker. The core then follows its historical resume path;
        // desktop-created rows still pass their durable marker and retain the
        // cross-class tamper guard.
        const targetDesktopSession = isDesktopManaged ? desktopSession : null;
        const sameManagedContext = Boolean(this.engine && this.engineWorkspace === workspace && (
          targetDesktopSession === null
            ? this.engineDesktopSession === null
            : this.engineDesktopSession?.classification === targetDesktopSession.classification &&
              this.engineDesktopSession?.projectPath === targetDesktopSession.projectPath
        ));
        const nextEngine = sameManagedContext
          ? this.requireEngine()
          : await (async () => {
            const replaceStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
            const engine = await this.replaceEngine(workspace, targetDesktopSession, 'desktop-session-resume');
            if (DESKTOP_PERF_ENABLED) stageNote += ` replace-engine=${(performance.now() - replaceStarted).toFixed(0)}ms`;
            return engine;
          })();
        const resumeStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
        if (await nextEngine.resume(sessionId, {
          transcriptItemLimit: DESKTOP_TRANSCRIPT_ITEM_LIMIT,
        }) !== true) {
          if (!sameManagedContext) await this.disposeCurrent('desktop-session-resume-failed');
          throw new Error('Session could not be resumed.');
        }
        if (DESKTOP_PERF_ENABLED) stageNote += ` engine-resume=${(performance.now() - resumeStarted).toFixed(0)}ms`;
        // Fork-on-resume: resuming a session actively driven by another live
        // process opens a transcript fork under a fresh id. The engine marks
        // it via sessionForkedFrom — accept the fork as a successful resume of
        // the clicked session; any other id mismatch remains a hard failure.
        const resumedState = nextEngine.getState();
        const resumedId = String(resumedState?.sessionId || '');
        const resumedForkedFrom = String(resumedState?.sessionForkedFrom || '');
        if (resumedId !== sessionId && resumedForkedFrom !== sessionId) {
          if (!sameManagedContext) await this.disposeCurrent('desktop-session-resume-mismatch');
          throw new Error('Session resume returned an unexpected session.');
        }
        this.currentProject = selected.classification === 'project' ? workspace : null;
        this.rememberCurrentSessionTitle();
        result = this.getSnapshot();
        // The result is already a detached, renderer-safe snapshot. Reuse it
        // for the held publication instead of cloning a long transcript twice.
        this.publish(result);
      });
    });
    if (DESKTOP_PERF_ENABLED) {
      this.perfLog(`resume-session id=${sessionId} total=${(performance.now() - totalStarted).toFixed(0)}ms${stageNote}`);
    }
    return result;
  }

  async prefetchSession(sessionId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('session id is invalid.');
    let prefetched = false;
    const started = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    await this.exclusive(async () => {
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-session-prefetch');
      }
      prefetched = await Promise.resolve(this.engine?.prefetchSession?.(sessionId)) === true;
    });
    if (DESKTOP_PERF_ENABLED) {
      this.perfLog(`prefetch-session id=${sessionId} ok=${prefetched} total=${(performance.now() - started).toFixed(0)}ms`);
    }
    return prefetched;
  }

  async submit(prompt: DesktopPromptContent, options: DesktopSubmitOptions = {}): Promise<boolean> {
    const hasText = typeof prompt === 'string'
      ? Boolean(prompt.trim())
      : prompt.some((part) => part.type === 'image' || part.type === 'file' ||
        (part.type === 'text' && Boolean(part.text.trim())));
    if (!hasText) return false;
    let accepted = false;
    await this.exclusive(async () => {
      const engine = this.requireEngine();
      // A blank desktop task owns only its workspace and route preferences.
      // Materialize the persisted runtime session at the first real submit so
      // merely opening a task or changing its model never writes/tombstones an
      // empty system/tool prompt.
      if (!String(engine.getState()?.sessionId || '')) {
        if (await engine.newSession() !== true) {
          throw new Error('Unable to create a task session for the first message.');
        }
        await this.applyPendingFastPreference(engine);
      }
      accepted = engine.submit(prompt, options);
      if (accepted) {
        const sessionId = String(engine.getState()?.sessionId || '');
        this.rememberSessionTitle(sessionId, promptTitle(prompt, options.displayText || ''));
      }
      this.publish();
    });
    return accepted;
  }

  async invokeCapability<T = unknown>(
    capability: DesktopCapability,
    args: unknown[] = [],
  ): Promise<DesktopCapabilityResult<T>> {
    if (!DESKTOP_CAPABILITY_SET.has(capability)) {
      throw new TypeError('Desktop capability is unavailable.');
    }
    if (capability === 'getOAuthProviderLoginStatus' ||
      capability === 'completeOAuthProviderLogin' || capability === 'cancelOAuthProviderLogin') {
      return this.invokeOAuthCapability<T>(capability, args);
    }
    // Read-only provider/status probes must not hold the transition lock for
    // their network round-trips. Startup hydration fires getProviderSetup the
    // moment the window is up and it held `exclusive` for ~5s, so the user's
    // first session click queued behind it (user: first open takes forever).
    // The engine lease is still acquired under the lock; the probe itself
    // neither mutates session state nor needs a publication (readCapabilities
    // follows the same read-only rationale).
    if (capability === 'getProviderSetup' || capability === 'getUsageDashboard'
      || capability === 'getTurnReviewDiff') {
      await this.exclusive(async () => {
        if (this.engine) return;
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, `desktop-capability-${capability}`);
      });
      const engine = this.requireEngine();
      const method = engine[capability];
      if (typeof method !== 'function') {
        throw new Error(`The active Mixdog engine does not support ${capability}.`);
      }
      const started = DESKTOP_PERF_ENABLED ? performance.now() : 0;
      const rawValue = await (method as (...values: unknown[]) => unknown).apply(engine, args);
      if (DESKTOP_PERF_ENABLED) {
        this.perfLog(`capability-unlocked ${capability} ms=${(performance.now() - started).toFixed(0)}`);
      }
      return { value: copyCapabilityValue(rawValue) as T, snapshot: this.getSnapshot() };
    }
    let result: DesktopCapabilityResult<T> = { value: undefined as T, snapshot: null };
    await this.exclusive(async () => {
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, `desktop-capability-${capability}`);
      }
      const engine = this.requireEngine();
      const method = engine[capability];
      if (typeof method !== 'function') {
        throw new Error(`The active Mixdog engine does not support ${capability}.`);
      }
      const rawValue = await (method as (...values: unknown[]) => unknown).apply(engine, args);
      const value = capability === 'beginOAuthProviderLogin'
        ? this.registerOAuthFlow(rawValue)
        : rawValue;
      // A run-now schedule spawns a fresh visible session; name it after the
      // schedule so Recent shows "daily-briefing" instead of a prompt slice.
      if (capability === 'runScheduleNow') {
        const run = rawValue as { sessionId?: unknown; name?: unknown } | null;
        const scheduleSessionId = String(run?.sessionId || '');
        const scheduleName = String(run?.name || '');
        if (scheduleSessionId && scheduleName) {
          await this.loadSessionTitles();
          this.rememberSessionTitle(scheduleSessionId, scheduleName);
        }
      }
      result = { value: copyCapabilityValue(value) as T, snapshot: this.getSnapshot() };
      this.publish();
    });
    return result;
  }

  async readCapabilities(
    requests: ReadonlyArray<DesktopCapabilityReadRequest>,
  ): Promise<DesktopCapabilityReadResult[]> {
    await this.exclusive(async () => {
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-capability-read');
      }
    });
    const engine = this.requireEngine();
    const started = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    const results: DesktopCapabilityReadResult[] = [];
    // The batch runs OUTSIDE the transition lock: startup settings hydration
    // held `exclusive` for its entire multi-second read sweep, so the first
    // session click queued behind it (user: first open takes far too long).
    // Reads stay ordered in one sequential sweep — some getters lazily warm
    // shared caches, so parallel execution would turn a UI optimization into
    // a new backend concurrency contract. If a context switch lands mid-sweep,
    // the affected getters surface per-request errors instead of blocking
    // navigation.
    for (const request of requests) {
      try {
        const method = engine[request.capability];
        if (typeof method !== 'function') {
          throw new Error(`The active Mixdog engine does not support ${request.capability}.`);
        }
        const rawValue = await (method as (...values: unknown[]) => unknown)
          .apply(engine, request.args || []);
        results.push({ ok: true, value: copyCapabilityValue(rawValue) });
      } catch (reason) {
        results.push({
          ok: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    }
    if (DESKTOP_PERF_ENABLED) {
      this.perfLog(`capability-read batch=${requests.length} ms=${(performance.now() - started).toFixed(0)}`);
    }
    // Read-only settings inspection neither mutates visible engine state nor
    // publishes it. This avoids cloning and serializing a long transcript
    // twice for every row in a settings section.
    return results;
  }

  abort(): unknown {
    return this.requireEngine().abort();
  }

  resolveToolApproval(id: string, decision: ToolApprovalDecision): boolean {
    return this.requireEngine().resolveToolApproval(id, decision);
  }

  async dispose(): Promise<void> {
    if (this.engineWarmupTimer) {
      clearTimeout(this.engineWarmupTimer);
      this.engineWarmupTimer = null;
    }
    await this.exclusive(async () => this.disposeCurrent('desktop-dispose'));
    await this.sessionTitleWrite;
    this.cancelScheduledPublication();
    this.stopShellJobsPolling();
    this.publish();
    this.listeners.clear();
    this.sessionListeners.clear();
  }

  private requireEngine(): MixdogEngine {
    if (!this.engine) throw new Error('No Mixdog project is active.');
    return this.engine;
  }

  private async applyPendingFastPreference(engine: MixdogEngine): Promise<void> {
    const preference = this.pendingFastPreference;
    if (preference === null) return;
    const current = engine.getState();
    if (typeof current.fast === 'boolean' && current.fast === preference) {
      this.pendingFastPreference = null;
      return;
    }
    const applied = await engine.setFast(preference);
    if (applied !== preference) {
      throw new Error('Fast mode preference was not applied to the new session.');
    }
    const latest = engine.getState();
    if (typeof latest.fast === 'boolean' && latest.fast !== preference) {
      throw new Error('Fast mode preference was not reflected by the new session.');
    }
    this.pendingFastPreference = null;
  }

  protected publish(snapshot?: EngineSnapshot): void {
    this.cancelScheduledPublication();
    if (this.publicationHoldDepth > 0) {
      this.publicationPending = true;
      this.publicationPendingSnapshot = snapshot;
      return;
    }
    this.publishNow(snapshot);
  }

  private publishEngineEvent(): void {
    if (this.publicationHoldDepth > 0) {
      this.publicationPending = true;
      // An engine event after a prepared snapshot means that prepared value
      // may be stale. Fall back to a fresh snapshot when the hold is released.
      this.publicationPendingSnapshot = undefined;
      return;
    }
    if (this.listeners.size === 0 || this.publicationTimer) return;
    this.publicationTimer = setTimeout(() => {
      this.publicationTimer = null;
      if (this.publicationHoldDepth > 0) {
        this.publicationPending = true;
        this.publicationPendingSnapshot = undefined;
        return;
      }
      this.publishNow();
    }, ENGINE_PUBLICATION_INTERVAL_MS);
    this.publicationTimer.unref?.();
  }

  private cancelScheduledPublication(): void {
    if (!this.publicationTimer) return;
    clearTimeout(this.publicationTimer);
    this.publicationTimer = null;
  }

  private publishNow(snapshot?: EngineSnapshot): void {
    // Once a window has released its subscription, engine events have nowhere
    // to go. Avoid cloning a potentially long transcript until another window
    // subscribes.
    if (this.listeners.size === 0) return;
    const publishStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    const published = snapshot === undefined ? this.getSnapshot() : snapshot;
    for (const listener of this.listeners) listener(published);
    if (DESKTOP_PERF_ENABLED) {
      const ms = performance.now() - publishStarted;
      if (ms >= 10) this.perfLog(`publish ms=${ms.toFixed(1)}`);
    }
  }

  perfLog(line: string): void {
    if (!DESKTOP_PERF_ENABLED) return;
    try {
      appendFileSync(join(this.userDataRoot(), 'desktop-perf.log'), `${new Date().toISOString()} ${line}\n`);
    } catch { /* diagnostics only */ }
  }

  private async withPublicationsHeld<T>(action: () => Promise<T>): Promise<T> {
    this.publicationHoldDepth += 1;
    try {
      return await action();
    } finally {
      this.publicationHoldDepth -= 1;
      if (this.publicationHoldDepth === 0 && this.publicationPending) {
        this.publicationPending = false;
        const snapshot = this.publicationPendingSnapshot;
        this.publicationPendingSnapshot = undefined;
        this.publishNow(snapshot);
      }
    }
  }

  private async disposeCurrent(reason: string): Promise<void> {
    this.cancelOAuthFlows();
    const current = this.engine;
    this.engine = null;
    this.stopShellJobsPolling();
    this.stopSessionsWatcher();
    this.shellJobs = { count: 0, elapsedLabel: '' };
    this.engineWorkspace = null;
    this.engineDesktopSession = null;
    try {
      this.unsubscribeEngine?.();
    } catch (error) {
      // A broken unsubscribe must not retain the engine by preventing disposal.
      console.error('Failed to unsubscribe from the Mixdog engine:', error);
    }
    this.unsubscribeEngine = null;
    if (current) await current.dispose(reason);
  }

  private registerOAuthFlow(value: unknown): Record<string, unknown> {
    const started = recordValue(value);
    if (!started) throw new Error('OAuth provider did not return a login flow.');
    const provider = String(started.provider || '').trim();
    if (!provider) throw new Error('OAuth provider login is missing its provider id.');
    const id = `oauth_${Date.now().toString(36)}_${(++this.oauthFlowSequence).toString(36)}`;
    const flow: DesktopOAuthFlow = {
      id,
      provider,
      url: typeof started.url === 'string' ? started.url : null,
      manualUrl: typeof started.manualUrl === 'string' ? started.manualUrl : null,
      state: 'pending',
      result: null,
      error: null,
      completeCode: typeof started.completeCode === 'function'
        ? started.completeCode as (code: string) => Promise<unknown>
        : undefined,
      cancel: typeof started.cancel === 'function' ? started.cancel as () => unknown : undefined,
      timeout: setTimeout(() => {
        const current = this.oauthFlows.get(id);
        if (!current) return;
        this.cancelOAuthFlow(current, 'expired');
        this.oauthFlows.delete(id);
      }, 10 * 60 * 1_000),
    };
    flow.timeout.unref?.();
    this.oauthFlows.set(id, flow);
    const waitForCallback = started.waitForCallback;
    if (waitForCallback && typeof (waitForCallback as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(waitForCallback).then((result) => {
        const current = this.oauthFlows.get(id);
        if (!current || current.state !== 'pending' || !result) return;
        current.state = 'complete';
        current.result = true;
      }).catch((error) => {
        const current = this.oauthFlows.get(id);
        if (!current || current.state !== 'pending') return;
        current.state = 'failed';
        current.error = error instanceof Error ? error.message : String(error);
      });
    }
    return this.oauthFlowStatus(flow);
  }

  private async invokeOAuthCapability<T>(
    capability: 'getOAuthProviderLoginStatus' | 'completeOAuthProviderLogin' | 'cancelOAuthProviderLogin',
    args: unknown[],
  ): Promise<DesktopCapabilityResult<T>> {
    const id = String(args[0] || '').trim();
    if (!/^oauth_[a-z0-9_]+$/i.test(id)) throw new TypeError('OAuth flow id is invalid.');
    const flow = this.oauthFlows.get(id);
    if (!flow) throw new Error('OAuth login flow is no longer available.');
    if (capability === 'completeOAuthProviderLogin') {
      if (!flow.completeCode) throw new Error('This OAuth provider does not accept a manual code.');
      const code = String(args[1] || '').trim();
      if (!code || code.length > 16_384) throw new TypeError('OAuth code is invalid.');
      try {
        const completed = await flow.completeCode(code);
        flow.result = Boolean(completed);
        flow.state = completed ? 'complete' : 'failed';
        flow.error = completed ? null : 'OAuth code did not complete the login.';
      } catch (error) {
        flow.state = 'failed';
        flow.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    } else if (capability === 'cancelOAuthProviderLogin') {
      try { await flow.cancel?.(); } finally {
        flow.state = 'cancelled';
        clearTimeout(flow.timeout);
      }
    }
    const value = this.oauthFlowStatus(flow) as T;
    if (capability === 'cancelOAuthProviderLogin') this.oauthFlows.delete(id);
    this.publish();
    return { value, snapshot: this.getSnapshot() };
  }

  private oauthFlowStatus(flow: DesktopOAuthFlow): Record<string, unknown> {
    return {
      flowId: flow.id,
      provider: flow.provider,
      url: flow.url,
      manualUrl: flow.manualUrl,
      state: flow.state,
      completed: flow.state === 'complete',
      error: flow.error,
      manualCodeSupported: Boolean(flow.completeCode),
    };
  }

  private cancelOAuthFlows(): void {
    for (const flow of this.oauthFlows.values()) {
      clearTimeout(flow.timeout);
      this.cancelOAuthFlow(flow, 'disposed');
    }
    this.oauthFlows.clear();
  }

  private cancelOAuthFlow(flow: DesktopOAuthFlow, reason: string): void {
    try {
      const result = flow.cancel?.();
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).catch((error: unknown) => {
          console.warn(`OAuth flow could not be ${reason}:`, error);
        });
      }
    } catch (error) {
      console.warn(`OAuth flow could not be ${reason}:`, error);
    }
  }

  private async taskWorkspace(): Promise<string> {
    const root = this.userDataPath ?? this.getUserDataPath?.();
    if (!root) throw new Error('Electron userData path is unavailable.');
    const workspace = join(root, 'workspace', 'unclassified');
    await mkdir(workspace, { recursive: true });
    return realpath(workspace);
  }

  private async canonicalDirectory(input: string): Promise<string> {
    if (!input) throw new TypeError('Session workspace is unavailable.');
    const canonical = await realpath(input);
    if (!(await stat(canonical)).isDirectory()) throw new TypeError('Session workspace is not a directory.');
    return canonical;
  }

  private userDataRoot(): string {
    const root = this.userDataPath ?? this.getUserDataPath?.();
    if (!root) throw new Error('Electron userData path is unavailable.');
    return root;
  }

  private async loadProjectPreferences(): Promise<DesktopProjectPreferences> {
    if (this.projectPreferences) return this.projectPreferences;
    let parsed: Partial<DesktopProjectPreferences> = {};
    try {
      parsed = JSON.parse(await readFile(join(this.userDataRoot(), 'desktop-projects.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Desktop project preferences could not be loaded.');
      }
    }
    const strings = (value: unknown) => Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry)).slice(0, 50)
      : [];
    const aliases = parsed.aliases && typeof parsed.aliases === 'object'
      ? Object.fromEntries(Object.entries(parsed.aliases).filter(([path, alias]) =>
        Boolean(path) && typeof alias === 'string' && alias.length <= 120).slice(0, 200))
      : {};
    this.projectPreferences = {
      version: 2,
      aliases,
      pinned: [...new Set(strings(parsed.pinned))],
      hidden: [...new Set(strings(parsed.hidden))],
    };
    return this.projectPreferences;
  }

  private async saveProjectPreferences(projectStore?: MixdogProjectsModule): Promise<void> {
    if (!this.projectPreferences) return;
    if (projectStore) {
      const registeredPaths = this.registeredProjects(projectStore).map((project) => project.path);
      this.projectPreferences.pinned = this.projectPreferences.pinned.filter((candidate) =>
        matchingProjectPath(registeredPaths, candidate) !== null);
      // `hidden` is retained only as a legacy desktop tombstone. A path that
      // the shared core store currently registers must always be visible.
      this.projectPreferences.hidden = this.projectPreferences.hidden.filter((candidate) =>
        matchingProjectPath(registeredPaths, candidate) === null);
    }
    const root = this.userDataRoot();
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'desktop-projects.json'),
      `${JSON.stringify(this.projectPreferences, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  private registeredProjects(projectStore: MixdogProjectsModule): MixdogProject[] {
    const listed = projectStore.listProjects();
    if (!Array.isArray(listed)) return [];
    return listed.flatMap((entry): MixdogProject[] => {
      if (!entry || typeof entry !== 'object') return [];
      const path = typeof entry.path === 'string' ? entry.path.trim() : '';
      if (!path || !isAbsolute(path)) return [];
      const name = typeof entry.name === 'string' && entry.name.trim()
        ? entry.name.trim()
        : path;
      return [{
        name,
        path,
        addedAt: Number(entry.addedAt) || 0,
        ...(Number(entry.lastSelectedAt) > 0
          ? { lastSelectedAt: Number(entry.lastSelectedAt) }
          : {}),
      }];
    });
  }

  private knownProject(projectStore: MixdogProjectsModule, projectPath: string): MixdogProject {
    const requested = projectPath.trim();
    if (!requested) throw new Error('Project is not available.');
    const resolved = projectStore.resolveProjectPath?.(requested) || resolve(requested);
    const key = normalizedProjectKey(resolved);
    const project = this.registeredProjects(projectStore)
      .find((entry) => normalizedProjectKey(entry.path) === key);
    if (!project) throw new Error('Project is not available.');
    return project;
  }

  private async loadEngine(options: Record<string, unknown>): Promise<MixdogEngine> {
    if (this.createEngineOverride) return this.createEngineOverride(options);
    const importStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    // Keep the engine external to the desktop bundle. Production resolves the
    // curated runtime resource; development resolves the same source tree.
    const engineModule = (await import(
      /* @vite-ignore */ engineModuleUrl(this.packaged, this.resourcesPath, this.appPath)
    )) as {
      createEngineSession(options?: Record<string, unknown>): Promise<MixdogEngine>;
    };
    const createStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    const engine = await engineModule.createEngineSession(options);
    if (DESKTOP_PERF_ENABLED) {
      this.perfLog(`engine-load import=${(createStarted - importStarted).toFixed(0)}ms create=${(performance.now() - createStarted).toFixed(0)}ms`);
    }
    return engine;
  }

  // The engine module graph (the whole TUI runtime) dominates a cold boot.
  // Importing it ahead of the first real boot is side-effect free (no engine
  // state, no cwd change) and turns the later load into a module-cache hit.
  private preloadEngineModule(): void {
    if (this.createEngineOverride || this.engineModulePreloaded) return;
    this.engineModulePreloaded = true;
    const started = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    try {
      void import(
        /* @vite-ignore */ engineModuleUrl(this.packaged, this.resourcesPath, this.appPath)
      ).then(() => {
        if (DESKTOP_PERF_ENABLED) {
          this.perfLog(`engine-module-preload ms=${(performance.now() - started).toFixed(0)}`);
        }
      }).catch(() => {
        // The authoritative boot path reports real load failures.
        this.engineModulePreloaded = false;
      });
    } catch {
      // URL resolution failures surface on the authoritative boot path.
      this.engineModulePreloaded = false;
    }
  }

  private loadSessionStoreModule(): Promise<MixdogSessionStoreModule> {
    this.sessionStoreModule ??= this.loadSessionStoreOverride
      ? this.loadSessionStoreOverride()
      : import(
        /* @vite-ignore */ sessionStoreModuleUrl(this.packaged, this.resourcesPath, this.appPath)
      ) as Promise<MixdogSessionStoreModule>;
    return this.sessionStoreModule;
  }

  private async replaceEngine(
    cwd: string,
    desktopSession: DesktopSessionScope | null,
    reason: string,
  ): Promise<MixdogEngine> {
    this.currentProject = null;
    const current = this.engine;
    const previousCwd = process.cwd();
    if (current?.switchContext) {
      this.cancelOAuthFlows();
      process.chdir(cwd);
      try {
        const switchStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
        if (await current.switchContext({ cwd, desktopSession }) !== true) {
          throw new Error('Engine context switch was rejected.');
        }
        if (DESKTOP_PERF_ENABLED) {
          this.perfLog(`engine-switch-context ms=${(performance.now() - switchStarted).toFixed(0)} cwd=${cwd}`);
        }
        this.engineWorkspace = cwd;
        this.engineDesktopSession = desktopSession;
        this.publish();
        return current;
      } catch {
        process.chdir(previousCwd);
        try {
          await this.disposeCurrent(`${reason}-context-recovery`);
        } finally {
          this.publish();
        }
      }
    } else {
      try {
        await this.disposeCurrent(reason);
      } finally {
        this.publish();
      }
    }
    process.chdir(cwd);
    let nextEngine: MixdogEngine;
    try {
      nextEngine = await this.loadEngine({
        remote: false,
        cwd,
        ...(desktopSession ? { desktopSession } : {}),
      });
    } catch (error) {
      process.chdir(previousCwd);
      throw error;
    }
    this.engine = nextEngine;
    this.engineWorkspace = cwd;
    this.engineDesktopSession = desktopSession;
    try {
      this.unsubscribeEngine = nextEngine.subscribe(() => this.handleEngineEvent());
      this.startShellJobsPolling();
      this.ensureSessionsWatcher();
    } catch (error) {
      process.chdir(previousCwd);
      try {
        await this.disposeCurrent(`${reason}-subscribe-failed`);
      } catch (cleanupError) {
        console.error('Failed to dispose an engine after subscription setup failed:', cleanupError);
      }
      throw error;
    }
    return nextEngine;
  }

  private startShellJobsPolling(): void {
    this.stopShellJobsPolling();
    this.scheduleShellJobsPoll(true);
  }

  private handleEngineEvent(): void {
    this.publishEngineEvent();
    const desiredDelay = shellJobsPollDelay(this.engine?.getState() || null, this.shellJobs.count);
    if (!this.shellJobsTimer || desiredDelay < this.shellJobsPollDelayMs) {
      this.scheduleShellJobsPoll(true);
    }
  }

  private scheduleShellJobsPoll(immediate = false): void {
    if (!this.engine) return;
    if (this.shellJobsTimer) clearTimeout(this.shellJobsTimer);
    this.shellJobsPollDelayMs = shellJobsPollDelay(this.engine.getState(), this.shellJobs.count);
    this.shellJobsTimer = setTimeout(
      () => {
        this.shellJobsTimer = null;
        void this.pollShellJobs();
      },
      immediate ? 0 : this.shellJobsPollDelayMs,
    );
    this.shellJobsTimer.unref?.();
  }

  private async pollShellJobs(): Promise<void> {
    // Attached-viewer sessions mirror the OWNER's pid (live-share frames):
    // shell jobs in the registry are owned by that process, not this one.
    const engineState = this.engine?.getState();
    const ownerPid = Number(engineState?.ownerClientHostPid || engineState?.clientHostPid) || 0;
    if (!ownerPid) {
      this.scheduleShellJobsPoll();
      return;
    }
    try {
      this.shellJobsModule ??= import(
        /* @vite-ignore */ statuslineSegmentsModuleUrl(this.packaged, this.resourcesPath, this.appPath)
      ) as Promise<StatuslineSegmentsModule>;
      const module = await this.shellJobsModule;
      const value = module.shellJobsStatus({ clientHostPid: ownerPid });
      const next = {
        count: Math.max(0, Number(value?.count) || 0),
        elapsedLabel: String(value?.elapsedLabel || ''),
      };
      if (next.count !== this.shellJobs.count || next.elapsedLabel !== this.shellJobs.elapsedLabel) {
        this.shellJobs = next;
        this.publishEngineEvent();
      }
    } catch {
      // The status strip is optional; engine activity remains publishable if
      // the external runtime module is unavailable.
    } finally {
      this.scheduleShellJobsPoll();
    }
  }

  private stopShellJobsPolling(): void {
    if (!this.shellJobsTimer) return;
    clearInterval(this.shellJobsTimer);
    this.shellJobsTimer = null;
    this.shellJobsPollDelayMs = 0;
  }

  private sessionSummaries(
    refreshFromStorage = false,
    rowsOverride?: Array<Record<string, unknown>>,
  ): DesktopSessionSummary[] {
    const currentId = String(this.engine?.getState()?.sessionId || '');
    const rows = rowsOverride
      ?? this.engine?.listSessions(refreshFromStorage ? { refreshFromStorage: true } : undefined)
      ?? [];
    const summaries = desktopSessionSummaries(
      rows,
      currentId,
      this.sessionTitles || {},
      this.sessionNames || {},
    );
    const archived = this.sessionArchived;
    if (!archived) return summaries;
    return summaries.map((row) => (
      Object.prototype.hasOwnProperty.call(archived, row.id) ? { ...row, archived: true } : row
    ));
  }

  private async loadSessionTitles(): Promise<Record<string, string>> {
    if (this.sessionTitles && this.sessionNames && this.sessionArchived) return this.sessionTitles;
    let parsed: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(
        await readFile(join(this.userDataRoot(), 'desktop-session-metadata.json'), 'utf8'),
      );
      if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
        parsed = value as Record<string, unknown>;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw new Error('Desktop session metadata could not be loaded.');
      }
    }
    let generatedMetadataChanged = false;
    const normalizedMap = (source: unknown, generated = false): Record<string, string> => {
      const result = Object.create(null) as Record<string, string>;
      if (!source || typeof source !== 'object' || Array.isArray(source)) return result;
      for (const [id, value] of Object.entries(source)) {
        if (!/^[A-Za-z0-9_-]+$/.test(id) || typeof value !== 'string') continue;
        const title = generated
          ? generatedSessionTitle(value, '')
          : normalizeSessionTitle(value, '');
        if (generated && title !== value.trim()) generatedMetadataChanged = true;
        if (title) result[id] = title;
      }
      return result;
    };
    // Pre-v2 metadata is a dev-era artifact: start clean instead of carrying a
    // shape-migration path.
    const legacy = parsed.version !== 2;
    this.sessionTitles = legacy
      ? Object.create(null) as Record<string, string>
      : normalizedMap(parsed.titles, true);
    this.sessionNames = legacy
      ? Object.create(null) as Record<string, string>
      : normalizedMap(parsed.names);
    const archivedMap = Object.create(null) as Record<string, number>;
    const archivedRaw = legacy ? null : parsed.archived;
    if (archivedRaw && typeof archivedRaw === 'object' && !Array.isArray(archivedRaw)) {
      for (const [id, value] of Object.entries(archivedRaw as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
        const at = Number(value);
        if (Number.isFinite(at) && at > 0) archivedMap[id] = at;
      }
    }
    this.sessionArchived = archivedMap;
    if (!legacy && generatedMetadataChanged) await this.queueSessionTitleWrite();
    return this.sessionTitles;
  }

  private rememberCurrentSessionTitle(): void {
    const state = this.engine?.getState();
    const firstUser = Array.isArray(state?.items)
      ? state.items.find((item) => {
        if (!item || typeof item !== 'object') return false;
        const candidate = item as Record<string, unknown>;
        return candidate.kind === 'user' &&
          !isGeneratedSessionTitleNoise(candidate.text) &&
          Boolean(generatedSessionTitle(candidate.text, ''));
      }) as Record<string, unknown> | undefined
      : undefined;
    const firstUserText = String(firstUser?.text || '');
    this.rememberSessionTitle(
      String(state?.sessionId || ''),
      generatedSessionTitle(firstUserText, /\[Image\b/i.test(firstUserText) ? '[Image]' : ''),
    );
  }

  private rememberSessionTitle(sessionId: string, title: string): void {
    if (!this.sessionTitles || !/^[A-Za-z0-9_-]+$/.test(sessionId) ||
      this.sessionNames?.[sessionId] || this.sessionTitles[sessionId]) return;
    const normalized = generatedSessionTitle(title, '');
    if (!normalized) return;
    this.sessionTitles[sessionId] = normalized;
    void this.queueSessionTitleWrite();
  }

  private queueSessionTitleWrite(): Promise<void> {
    const titles = Object.fromEntries(Object.entries(this.sessionTitles || {}));
    const names = Object.fromEntries(Object.entries(this.sessionNames || {}));
    const archived = Object.fromEntries(Object.entries(this.sessionArchived || {}));
    this.sessionTitleWrite = this.sessionTitleWrite.then(async () => {
      const root = this.userDataRoot();
      await mkdir(root, { recursive: true });
      const target = join(root, 'desktop-session-metadata.json');
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      try {
        const metadata: DesktopSessionMetadataFile = {
          version: 2,
          titles,
          names,
          // Only when non-empty: keeps the no-archive file shape (and its
          // exact-match tests) unchanged.
          ...(Object.keys(archived).length ? { archived } : {}),
        };
        await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    }).catch((error: unknown) => {
      console.error('Failed to persist desktop session metadata:', error);
    });
    return this.sessionTitleWrite;
  }

  private async exclusive(action: () => Promise<void>): Promise<void> {
    // Perf triage (MIXDOG_DESKTOP_PERF=1): any action holding the transition
    // lock long enough to delay a session click gets attributed by caller.
    const instrumented = DESKTOP_PERF_ENABLED
      ? (() => {
        const caller = (new Error().stack || '').split('\n')
          .slice(2, 4).map((line) => line.trim()).join(' <- ');
        return async () => {
          const started = performance.now();
          try {
            await action();
          } finally {
            const ms = performance.now() - started;
            if (ms >= 300) this.perfLog(`exclusive-hold ms=${ms.toFixed(0)} by=${caller}`);
          }
        };
      })()
      : action;
    const run = this.transition.then(instrumented, instrumented);
    this.transition = run.catch(() => undefined);
    await run;
  }
}
