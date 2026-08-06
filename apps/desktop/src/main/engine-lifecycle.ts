// Engine lifecycle, extracted from EngineHost: park/activate of running
// session engines, dispose paths, navigation-safe engine replacement
// (switchContext fast path + full boot), and engine-module preloading. All
// host state (engine ref, workspace/scope markers, watchers, publication)
// flows through injected callbacks; the park registry and accepted-submit
// guards are shared by reference because resume/submit rollback paths in the
// host also read them.
import { performance } from 'node:perf_hooks';

import type { MixdogEngine, EngineFactory, DesktopSessionScope } from './engine-host-support';
import { DESKTOP_PERF_ENABLED, engineModuleUrl } from './engine-host-support';
import type { createShellJobsPoller } from './shell-jobs-poller';

export type ParkedEngine = {
  engine: MixdogEngine;
  workspace: string;
  desktopSession: DesktopSessionScope | null;
};

export type AcceptedSubmitGuard = {
  sessionId: string;
  structureRevision: unknown;
  itemsLength: number;
  lastItemId: unknown;
};

export type EngineLifecycleDeps = {
  getEngine(): MixdogEngine | null;
  setEngine(engine: MixdogEngine | null): void;
  requireEngine(): MixdogEngine;
  getEngineWorkspace(): string | null;
  setEngineWorkspace(workspace: string | null): void;
  getEngineDesktopSession(): DesktopSessionScope | null;
  setEngineDesktopSession(scope: DesktopSessionScope | null): void;
  clearCurrentProject(): void;
  parkedEngines: Map<string, ParkedEngine>;
  acceptedSubmitGuards: WeakMap<MixdogEngine, AcceptedSubmitGuard>;
  sessionLanes: {
    attach(engine: MixdogEngine): void;
    detach(engine: MixdogEngine): void;
    replay(engine: MixdogEngine): void;
  };
  cancelOAuthFlows(): void;
  cancelScheduledPublication(): void;
  shellJobsPoller: ReturnType<typeof createShellJobsPoller>;
  stopSessionsWatcher(): void;
  ensureSessionsWatcher(): void;
  publish(): void;
  publishEngineEvent(): void;
  onEngineReady(engine: MixdogEngine, options?: { forResume?: boolean }): void;
  perfLog(line: string): void;
  withPublicationsHeld<T>(action: () => Promise<T>): Promise<T>;
  createEngineOverride: EngineFactory | null;
  packaged: boolean;
  resourcesPath: string;
  appPath: string | undefined;
};

export function engineHasActiveWork(
  engine: MixdogEngine,
  acceptedSubmitGuards: WeakMap<MixdogEngine, AcceptedSubmitGuard>,
): boolean {
  const state = engine.getState();
  const sessionId = String(state?.sessionId || '');
  if (!sessionId) {
    acceptedSubmitGuards.delete(engine);
    return false;
  }
  if (state?.busy === true || state?.commandBusy === true
    || (Array.isArray(state?.queued) && state.queued.length > 0)) {
    return true;
  }
  const guard = acceptedSubmitGuards.get(engine);
  if (!guard) return false;
  const items = Array.isArray(state.items) ? state.items : [];
  const lastItem = items.at(-1);
  const lastItemId = lastItem && typeof lastItem === 'object'
    ? (lastItem as Record<string, unknown>).id ?? null
    : null;
  const submissionProgressed = guard.sessionId !== sessionId
    || guard.structureRevision !== (state.structureRevision ?? null)
    || guard.itemsLength !== items.length
    || guard.lastItemId !== lastItemId;
  if (submissionProgressed) {
    acceptedSubmitGuards.delete(engine);
    return false;
  }
  return true;
}

export function createEngineLifecycle(deps: EngineLifecycleDeps) {
  let unsubscribeEngine: (() => void) | null = null;
  let engineModulePreloaded = false;

  function handleEngineEvent(): void {
    deps.publishEngineEvent();
    deps.shellJobsPoller.onEngineEvent();
  }

  function currentEngineIsRunning(): boolean {
    const current = deps.getEngine();
    if (!current) return false;
    return engineHasActiveWork(current, deps.acceptedSubmitGuards);
  }

  /** force: park a view that is merely IDLE too. With the engine pool in the
   *  daemon there is no "active engine" to recycle — a view that already
   *  paints a session keeps it, so navigation never re-points someone else's
   *  pane (blank pane / lost model / jumping transcript on focus changes). */
  function parkCurrentEngine({ force = false } = {}): string | null {
    if (!force && !currentEngineIsRunning()) return null;
    const current = deps.requireEngine();
    const sessionId = String(current.getState()?.sessionId || '');
    if (!sessionId) return null;
    const workspace = deps.getEngineWorkspace();
    if (!workspace) throw new Error('Active engine workspace is unavailable.');
    if (deps.parkedEngines.has(sessionId)) {
      throw new Error('Active session already has a parked engine.');
    }
    deps.cancelOAuthFlows();
    deps.cancelScheduledPublication();
    deps.shellJobsPoller.stop();
    deps.stopSessionsWatcher();
    try {
      unsubscribeEngine?.();
    } catch (error) {
      console.error('Failed to unsubscribe from the Mixdog engine:', error);
    }
    unsubscribeEngine = null;
    deps.setEngine(null);
    deps.setEngineWorkspace(null);
    const desktopSession = deps.getEngineDesktopSession();
    deps.setEngineDesktopSession(null);
    deps.parkedEngines.set(sessionId, { engine: current, workspace, desktopSession });
    // Replay after ownership moves to the parked pool so a pane cannot miss
    // the handoff when no engine state event accompanies the ownership move.
    deps.sessionLanes.replay(current);
    return sessionId;
  }

  function activateParkedEngine(sessionId: string): MixdogEngine {
    const parked = deps.parkedEngines.get(sessionId);
    if (!parked) {
      // Name what IS parked: a rollback that cannot find its target used to
      // report only that something was missing.
      const available = [...deps.parkedEngines.keys()].join(', ') || 'none';
      throw new Error(`Parked session engine is unavailable: ${sessionId} (parked: ${available}).`);
    }
    const previousCwd = process.cwd();
    process.chdir(parked.workspace);
    deps.setEngine(parked.engine);
    deps.setEngineWorkspace(parked.workspace);
    deps.setEngineDesktopSession(parked.desktopSession);
    try {
      unsubscribeEngine = parked.engine.subscribe(() => handleEngineEvent());
      deps.shellJobsPoller.start();
      deps.ensureSessionsWatcher();
    } catch (error) {
      deps.setEngine(null);
      deps.setEngineWorkspace(null);
      deps.setEngineDesktopSession(null);
      unsubscribeEngine = null;
      process.chdir(previousCwd);
      throw error;
    }
    deps.parkedEngines.delete(sessionId);
    deps.onEngineReady(parked.engine, { forResume: true });
    return parked.engine;
  }

  async function disposeAllEngines(reason: string): Promise<void> {
    let firstError: unknown = null;
    try {
      await disposeCurrent(reason);
    } catch (error) {
      firstError = error;
    }
    const parked = [...deps.parkedEngines.values()];
    deps.parkedEngines.clear();
    for (const { engine } of parked) {
      deps.sessionLanes.detach(engine);
    }
    const settled = await Promise.allSettled(
      parked.map(({ engine }) => engine.dispose(reason)),
    );
    for (const result of settled) {
      if (result.status === 'rejected') firstError ??= result.reason;
    }
    if (firstError) throw firstError;
  }

  // keepBackgroundWork: engine swaps while the desktop app stays alive must
  // not reap the process-global background registries (shared tasks, shell
  // jobs, bash sessions) that other live/parked sessions still own. Only the
  // app-shutdown path (disposeAllEngines) performs the full reap.
  async function disposeCurrent(reason: string, options?: { keepBackgroundWork?: boolean }): Promise<void> {
    deps.cancelOAuthFlows();
    const current = deps.getEngine();
    deps.setEngine(null);
    deps.shellJobsPoller.stop();
    deps.stopSessionsWatcher();
    deps.setEngineWorkspace(null);
    deps.setEngineDesktopSession(null);
    try {
      unsubscribeEngine?.();
    } catch (error) {
      // A broken unsubscribe must not retain the engine by preventing disposal.
      console.error('Failed to unsubscribe from the Mixdog engine:', error);
    }
    unsubscribeEngine = null;
    if (current) {
      deps.sessionLanes.detach(current);
      await current.dispose(reason, options);
    }
  }

  /** User-facing navigation must only detach a running conversation from the
   *  window. Keep its engine alive until the user explicitly stops/deletes it
   *  or the app shuts down, regardless of whether the destination is another
   *  session, a fresh task, or a project context. */
  async function replaceEngineForNavigation(
    cwd: string,
    desktopSession: DesktopSessionScope | null,
    reason: string,
  ): Promise<MixdogEngine> {
    const parkedOutgoingId = parkCurrentEngine();
    try {
      return await replaceEngine(cwd, desktopSession, reason);
    } catch (error) {
      if (parkedOutgoingId) activateParkedEngine(parkedOutgoingId);
      throw error;
    }
  }

  async function loadEngine(options: Record<string, unknown>): Promise<MixdogEngine> {
    if (deps.createEngineOverride) return deps.createEngineOverride(options);
    const importStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    // Keep the engine external to the desktop bundle. Production resolves the
    // curated runtime resource; development resolves the same source tree.
    const engineModule = (await import(
      /* @vite-ignore */ engineModuleUrl(deps.packaged, deps.resourcesPath, deps.appPath)
    )) as {
      createEngineSession(options?: Record<string, unknown>): Promise<MixdogEngine>;
    };
    const createStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    const engine = await engineModule.createEngineSession(options);
    if (DESKTOP_PERF_ENABLED) {
      deps.perfLog(`engine-load import=${(createStarted - importStarted).toFixed(0)}ms create=${(performance.now() - createStarted).toFixed(0)}ms`);
    }
    return engine;
  }

  // The engine module graph (the whole TUI runtime) dominates a cold boot.
  // Importing it ahead of the first real boot is side-effect free (no engine
  // state, no cwd change) and turns the later load into a module-cache hit.
  function preloadEngineModule(): void {
    if (deps.createEngineOverride || engineModulePreloaded) return;
    engineModulePreloaded = true;
    const started = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    try {
      void import(
        /* @vite-ignore */ engineModuleUrl(deps.packaged, deps.resourcesPath, deps.appPath)
      ).then((engineModule: {
        preloadSessionRuntimeModule?: () => void;
        preloadKeychainSecrets?: () => void;
      }) => {
        // Pull the runtime graph in during idle startup as well: leaving it to
        // the first engine creation put a ~250ms import inside the transition
        // lock, where the user's first session click waits for it.
        engineModule?.preloadSessionRuntimeModule?.();
        // Same for the Windows DPAPI batch: started here it overlaps window
        // creation instead of the first project switch, which awaited it.
        engineModule?.preloadKeychainSecrets?.();
        if (DESKTOP_PERF_ENABLED) {
          deps.perfLog(`engine-module-preload ms=${(performance.now() - started).toFixed(0)}`);
        }
      }).catch(() => {
        // The authoritative boot path reports real load failures.
        engineModulePreloaded = false;
      });
    } catch {
      // URL resolution failures surface on the authoritative boot path.
      engineModulePreloaded = false;
    }
  }

  async function replaceEngine(
    cwd: string,
    desktopSession: DesktopSessionScope | null,
    reason: string,
    options: { forResume?: boolean } = {},
  ): Promise<MixdogEngine> {
    // Live-engine switches: mid-switch engine events still carry the OUTGOING
    // session's transcript, and the publication throttle forwarded them to
    // renderers (user: the old script flashed inside a fresh + draft before
    // the settled snapshot replaced it). Hold publications so only the
    // post-switch state is published. Cold boots stay unheld so first-boot
    // progress keeps streaming.
    if (!deps.getEngine()) return await replaceEngineNow(cwd, desktopSession, reason, options);
    return await deps.withPublicationsHeld(
      () => replaceEngineNow(cwd, desktopSession, reason, options),
    );
  }

  async function replaceEngineNow(
    cwd: string,
    desktopSession: DesktopSessionScope | null,
    reason: string,
    options: { forResume?: boolean } = {},
  ): Promise<MixdogEngine> {
    deps.clearCurrentProject();
    const current = deps.getEngine();
    const previousCwd = process.cwd();
    if (current?.switchContext) {
      deps.cancelOAuthFlows();
      const outgoingSessionId = String(current.getState?.()?.sessionId || '');
      process.chdir(cwd);
      try {
        const switchStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
        if (await current.switchContext({
          cwd,
          desktopSession,
          ...(options.forResume ? { forResume: true } : {}),
        }) !== true) {
          throw new Error('Engine context switch was rejected.');
        }
        // Attached-viewer engines (CLI-owned sessions opened as followers)
        // settle their state ASYNCHRONOUSLY after switchContext resolves: an
        // immediate getSnapshot() still cloned the OUTGOING session, so the
        // invoke result and the held-release publication resurrected the old
        // transcript inside a fresh draft for a few frames (measured: stale
        // for ~35ms; user saw the old script flash after the view switched).
        // Wait — bounded — until the engine reflects the reset.
        if (outgoingSessionId) {
          const settleDeadline = Date.now() + 500;
          while (String(current.getState?.()?.sessionId || '') === outgoingSessionId
            && Date.now() < settleDeadline) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
        if (DESKTOP_PERF_ENABLED) {
          deps.perfLog(`engine-switch-context ms=${(performance.now() - switchStarted).toFixed(0)} cwd=${cwd}`);
        }
        deps.setEngineWorkspace(cwd);
        deps.setEngineDesktopSession(desktopSession);
        deps.publish();
        deps.onEngineReady(current, { forResume: options.forResume === true });
        return current;
      } catch {
        process.chdir(previousCwd);
        try {
          await disposeCurrent(`${reason}-context-recovery`, { keepBackgroundWork: true });
        } finally {
          deps.publish();
        }
      }
    } else {
      try {
        await disposeCurrent(reason, { keepBackgroundWork: true });
      } finally {
        deps.publish();
      }
    }
    process.chdir(cwd);
    let nextEngine: MixdogEngine;
    const engineStartedAt = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    try {
      nextEngine = await loadEngine({
        remote: false,
        cwd,
        ...(desktopSession ? { desktopSession } : {}),
      });
    } catch (error) {
      process.chdir(previousCwd);
      throw error;
    }
    if (DESKTOP_PERF_ENABLED) {
      deps.perfLog(`engine-create reason=${reason} ms=${(performance.now() - engineStartedAt).toFixed(0)}`);
    }
    deps.setEngine(nextEngine);
    deps.setEngineWorkspace(cwd);
    deps.setEngineDesktopSession(desktopSession);
    try {
      unsubscribeEngine = nextEngine.subscribe(() => handleEngineEvent());
      deps.shellJobsPoller.start();
      deps.ensureSessionsWatcher();
    } catch (error) {
      process.chdir(previousCwd);
      try {
        await disposeCurrent(`${reason}-subscribe-failed`, { keepBackgroundWork: true });
      } catch (cleanupError) {
        console.error('Failed to dispose an engine after subscription setup failed:', cleanupError);
      }
      throw error;
    }
    deps.sessionLanes.attach(nextEngine);
    deps.onEngineReady(nextEngine, { forResume: options.forResume === true });
    return nextEngine;
  }

  return {
    currentEngineIsRunning,
    parkCurrentEngine,
    activateParkedEngine,
    disposeAllEngines,
    disposeCurrent,
    replaceEngineForNavigation,
    replaceEngine,
    // Background view for a session the active engine does not hold. The
    // daemon adopts an already-hosted session, so this costs a mirror.
    loadEngine,
    preloadEngineModule,
  };
}
