/**
 * Automatic cookie import from Chrome, while Chrome is closed.
 *
 * Chrome holds its Cookies database for as long as it runs, and a closed Chrome's
 * cookie store does not change, so a run happens only at two moments: shortly
 * after the app starts (or the setting is turned on) if Chrome is not running,
 * and when Chrome exits. "Chrome exited" is an event, not a poll: Chrome keeps
 * `lockfile` in its user-data folder open (delete-on-close) for as long as the
 * browser process lives, so its removal is the exit. Nothing is scheduled
 * periodically. The runs use the saved Chrome key and never raise a UAC prompt.
 * It is on by default but stays idle (no watch, no check) until a manual cookie
 * import of the bound profile has saved that key; a key that later stops
 * working makes the runs stop and ask for one manual import.
 */
import { existsSync, type FSWatcher, watch as watchFolder } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { writeJsonAtomicAsync } from '../../shared/core-src/runtime/shared/atomic-file.mjs';
import type { DesktopCookieAutoImportStatus } from '../../shared/contract';

/** Let the app finish starting before the first run (a one-shot deadline). */
export const START_DELAY_MS = 20_000;

/** What the last runs left behind: no cookie values, no key. */
export interface CookieAutoImportState {
  lastImportAt?: number;
  lastCount?: number;
  lastError?: string;
  /** Set when a run found no usable saved key; cleared by a successful manual import. */
  needsManualImport?: boolean;
  /** Profiles whose cookie import finished while a Chrome key was saved: the
   *  only evidence that an automatic run can read them without a prompt. */
  readyProfiles?: string[];
  /** Per profile, the Cookies database identity (`cookieStoreIdentity`) as it
   *  was when its last import succeeded: an automatic run is pointless while
   *  the database still looks the same. */
  importedStores?: Record<string, string>;
}

/** Chrome is running while its lock file exists. */
export function chromeLockHeld(lockFile: string): boolean {
  return existsSync(lockFile);
}

/** Calls `onExit` each time the lock file is removed (Chrome exited, closed or
 *  killed). Undefined when the folder cannot be watched. Returns the stop function.
 *  A watcher error, or nothing left to watch, ends the watching and calls
 *  `onStopped` once; nothing is re-armed until the caller watches again. */
export function watchChromeLock(
  lockFile: string,
  onExit: () => void,
  onStopped?: () => void,
  /** Test seam: the folder watcher. */
  watch: typeof watchFolder = watchFolder
): (() => void) | undefined {
  const folder = dirname(lockFile);
  const lockName = basename(lockFile).toLowerCase();
  const folderName = basename(folder).toLowerCase();
  let stopped = false;
  let held = existsSync(lockFile);
  let watcher: FSWatcher | undefined;
  let parentWatcher: FSWatcher | undefined;

  // The notification only says "something changed here" (Windows may leave out
  // the file name), so the lock file itself is asked. An exit is a held lock
  // that is gone now: repeated or unrelated notifications report nothing.
  const check = (): void => {
    const now = existsSync(lockFile);
    const wasHeld = held;
    held = now;
    if (wasHeld && !now) onExit();
  };
  const isLock = (name: string | Buffer | null): boolean => name == null || String(name).toLowerCase() === lockName;
  // A watcher error ends the watching for good (until the next arm): nothing is
  // re-armed from an error, so a failing watcher cannot loop.
  const giveUp = (): void => {
    if (stopped) return;
    stopped = true;
    watcher?.close();
    parentWatcher?.close();
    watcher = undefined;
    parentWatcher = undefined;
    onStopped?.();
  };
  const attach = (): boolean => {
    let created: FSWatcher;
    try {
      created = watch(folder, { persistent: false }, (_event, name) => {
        // Windows reports a deleted folder as events named with its own path, not as an error.
        if (!existsSync(folder)) reattach();
        else if (isLock(name)) check();
      });
    } catch {
      return false;
    }
    watcher = created;
    created.on('error', giveUp);
    return true;
  };
  // The folder is gone (or cannot be watched): its parent tells when it reappears.
  // Limit: if the parent is gone too, nothing is watched until the next arm.
  const watchParent = (): void => {
    let created: FSWatcher;
    try {
      created = watch(dirname(folder), { persistent: false }, (_event, name) => {
        if ((name == null || String(name).toLowerCase() === folderName) && existsSync(folder)) reattach();
      });
    } catch {
      giveUp(); // Nothing left to watch.
      return;
    }
    parentWatcher = created;
    created.on('error', giveUp);
  };
  // Event-driven only: the folder vanished or came back.
  const reattach = (): void => {
    watcher?.close();
    watcher = undefined;
    parentWatcher?.close();
    parentWatcher = undefined;
    if (stopped) return;
    check();
    if (!attach()) watchParent();
    else check();
  };

  if (!attach()) return undefined;
  return () => {
    stopped = true; // a stop requested from outside is not reported back
    watcher?.close();
    parentWatcher?.close();
  };
}

export type AutoCookieImportOutcome =
  | { state: 'imported'; count: number }
  | { state: 'skipped'; reason: 'chrome-running' | 'busy' | 'unchanged' }
  | { state: 'needs-manual-import' }
  | { state: 'failed'; error: string };

export interface CookieAutoImportSettings {
  enabled: boolean;
  profileId: string;
}

function storeIdentities(raw: Record<string, unknown>): Record<string, string> {
  const stores: Record<string, string> = {};
  for (const [profileId, identity] of Object.entries(raw)) {
    if (profileId && typeof identity === 'string' && identity) stores[profileId] = identity;
  }
  return stores;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class CookieAutoImportStateStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async read(): Promise<CookieAutoImportState> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== 'object') return {};
    const lastImportAt = finiteNumber(parsed.lastImportAt);
    const lastCount = finiteNumber(parsed.lastCount);
    return {
      ...(lastImportAt !== undefined ? { lastImportAt } : {}),
      ...(lastCount !== undefined ? { lastCount } : {}),
      ...(typeof parsed.lastError === 'string' && parsed.lastError ? { lastError: parsed.lastError } : {}),
      ...(parsed.needsManualImport === true ? { needsManualImport: true } : {}),
      ...(Array.isArray(parsed.readyProfiles)
        ? { readyProfiles: parsed.readyProfiles.filter((id): id is string => typeof id === 'string' && id !== '') }
        : {}),
      ...(parsed.importedStores && typeof parsed.importedStores === 'object'
        ? { importedStores: storeIdentities(parsed.importedStores as Record<string, unknown>) }
        : {}),
    };
  }

  private async merge(patch: { [Key in keyof CookieAutoImportState]: CookieAutoImportState[Key] | undefined }) {
    const merged: CookieAutoImportState = { ...(await this.read()), ...patch };
    if (!merged.needsManualImport) delete merged.needsManualImport;
    for (const key of Object.keys(merged) as Array<keyof CookieAutoImportState>) {
      if (merged[key] === undefined) delete merged[key];
    }
    await writeJsonAtomicAsync(this.file, merged);
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Merge `patch`; a field set to undefined (or false) is removed. */
  update(patch: { [Key in keyof CookieAutoImportState]: CookieAutoImportState[Key] | undefined }): Promise<void> {
    return this.enqueue(() => this.merge(patch));
  }

  /** A successful import: the status fields and, when known, the Cookies
   *  database identity measured before the cookies were read. */
  recordImport(
    profileId: string,
    patch: { lastImportAt: number; lastCount: number },
    storeIdentity: string | undefined
  ): Promise<void> {
    return this.enqueue(async () => {
      const stores = { ...(await this.read()).importedStores };
      if (storeIdentity === undefined) delete stores[profileId];
      else stores[profileId] = storeIdentity;
      await this.merge({ ...patch, lastError: undefined, needsManualImport: false, importedStores: stores });
    });
  }

  /** Record that `profileId` was imported while a Chrome key was saved. */
  markReady(profileId: string): Promise<void> {
    return this.enqueue(async () => {
      const ready = (await this.read()).readyProfiles ?? [];
      if (!ready.includes(profileId)) await this.merge({ readyProfiles: [...ready, profileId] });
    });
  }

  async clear(): Promise<void> {
    await this.queue;
    await rm(this.file, { force: true });
  }
}

/** One-shot deadlines only. */
export interface CookieAutoImportTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// Timers never keep the app alive.
const REAL_TIMERS: CookieAutoImportTimers = {
  setTimeout: (run, ms) => {
    const handle = setTimeout(run, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface CookieAutoImporterDeps {
  /** The persisted setting (the app's settings store). */
  settings: {
    read(): Promise<CookieAutoImportSettings>;
    write(next: CookieAutoImportSettings): Promise<CookieAutoImportSettings>;
  };
  state: Pick<CookieAutoImportStateStore, 'read' | 'update'>;
  /** One automatic import. Records its own outcome in `state`; never prompts. */
  run(profileId: string): Promise<AutoCookieImportOutcome>;
  /** A single check whether Chrome runs now. */
  chromeRunning(): Promise<boolean>;
  /** Calls `onExit` every time Chrome exits; returns the stop function, or
   *  undefined when it cannot be watched. `onStopped` is called if the watching
   *  ends by itself (not through the stop function). */
  watchChromeExit(onExit: () => void, onStopped: () => void): (() => void) | undefined;
  keyStatus(): Promise<{ available: boolean; saved: boolean }>;
  forgetKey(): Promise<void>;
  timers?: CookieAutoImportTimers;
  onError?(error: unknown): void;
}

export class CookieAutoImporter {
  private settings: CookieAutoImportSettings = { enabled: false, profileId: '' };
  private cancelStart: (() => void) | null = null;
  private unwatch: (() => void) | undefined;
  private stopped = false;
  private current: Promise<void> | null = null;
  /** Chrome exited while a run was going: one more run follows it, never alongside it. */
  private exitedDuringRun = false;
  private readonly timers: CookieAutoImportTimers;

  constructor(private readonly deps: CookieAutoImporterDeps) {
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** App start: read the saved setting; when on, the first run follows shortly. */
  async start(): Promise<void> {
    this.stopped = false;
    this.settings = await this.deps.settings.read();
    this.arm(START_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    this.disarm();
  }

  /** A manual cookie import of `profileId` finished. The first one fixes the
   *  automatic target (a profile the user chose in settings is kept), and it
   *  may have saved the key, so the Chrome-exit watch is set up now. */
  async manualImportDone(profileId: string): Promise<void> {
    if (!this.settings.profileId && profileId) {
      this.settings = await this.deps.settings.write({ enabled: this.settings.enabled, profileId });
    }
    await this.syncWatch();
  }

  async status(): Promise<DesktopCookieAutoImportStatus> {
    const [state, key] = await Promise.all([this.deps.state.read(), this.deps.keyStatus()]);
    // Errors and "needs one manual import" belong to a setup that once worked
    // (this profile was imported with a key). A state left by an earlier build,
    // or before the first manual import, says nothing: the migration is silent.
    const wasReady = this.settings.profileId !== '' && state.readyProfiles?.includes(this.settings.profileId) === true;
    return {
      enabled: this.settings.enabled,
      profileId: this.settings.profileId,
      keySaved: key.saved,
      keyStorageAvailable: key.available,
      running: this.current !== null,
      ...(wasReady && state.lastImportAt !== undefined ? { lastImportAt: state.lastImportAt } : {}),
      ...(wasReady && state.lastCount !== undefined ? { lastCount: state.lastCount } : {}),
      ...(wasReady && state.lastError ? { lastError: state.lastError } : {}),
      needsManualImport: wasReady && state.needsManualImport === true,
    };
  }

  /** Turn it on/off or pick another profile. Turning it on (or changing the
   *  profile) starts a run at once and forgets an earlier needs-manual-import state. */
  async configure(next: CookieAutoImportSettings): Promise<DesktopCookieAutoImportStatus> {
    const previous = this.settings;
    this.settings = await this.deps.settings.write(next);
    if (this.settings.enabled && (!previous.enabled || previous.profileId !== this.settings.profileId)) {
      await this.deps.state.update({ needsManualImport: false, lastError: undefined });
    }
    this.arm(0);
    return await this.status();
  }

  /** Forget the saved Chrome key. With automatic import on, the next import
   *  then needs one manual import, so say so now. */
  async forgetKey(): Promise<DesktopCookieAutoImportStatus> {
    const hadKey = (await this.deps.keyStatus()).saved;
    await this.deps.forgetKey();
    this.closeWatch();
    if (hadKey && this.settings.enabled) await this.deps.state.update({ needsManualImport: true });
    return await this.status();
  }

  private closeWatch(): void {
    this.unwatch?.();
    this.unwatch = undefined;
  }

  private disarm(): void {
    this.cancelStart?.();
    this.cancelStart = null;
    this.closeWatch();
  }

  private arm(firstRunDelayMs: number): void {
    this.disarm();
    if (!this.settings.enabled) return;
    const first = this.timers.setTimeout(() => void this.attempt(), firstRunDelayMs);
    this.cancelStart = () => this.timers.clearTimeout(first);
    void this.syncWatch();
  }

  /** The Chrome-exit watch exists exactly while the setting is on and the
   *  gate is open, so without a key nothing is watched. */
  private async syncWatch(): Promise<void> {
    let open = false;
    try {
      open = this.settings.enabled && (await this.importedBefore());
    } catch {
      // Unreadable key or state: treated as closed; the next import or start retries.
    }
    if (!open || this.stopped) return this.closeWatch();
    if (this.unwatch) return;
    // `stop` identifies this watcher: a late "stopped" from an older one must not clear a newer one.
    const mine: { stop?: () => void } = {};
    mine.stop = this.deps.watchChromeExit(
      () => {
        if (this.current) this.exitedDuringRun = true;
        else void this.attempt();
      },
      () => {
        // It ended by itself: no live watcher, so the next arm or manual import creates one.
        if (this.unwatch === mine.stop) this.unwatch = undefined;
      }
    );
    this.unwatch = mine.stop;
  }

  /** Until a manual import of the bound profile saved a key that works for it,
   *  a run could only fail: nothing runs and nothing is reported, not even a
   *  process check. A bare "imported at" time is no evidence of a key. */
  private async importedBefore(): Promise<boolean> {
    const { profileId } = this.settings;
    if (!profileId) return false;
    const [key, state] = await Promise.all([this.deps.keyStatus(), this.deps.state.read()]);
    return key.saved && state.readyProfiles?.includes(profileId) === true;
  }

  /** One run at a time; a run while Chrome lives, or after the key went
   *  missing, is skipped quietly. */
  private attempt(): Promise<void> {
    if (this.current) return this.current;
    const run = (async () => {
      if (!this.settings.enabled) return;
      if (!(await this.importedBefore())) return;
      try {
        if (await this.deps.chromeRunning()) return;
      } catch {
        return;
      }
      if ((await this.deps.state.read()).needsManualImport) return;
      // Read after the checks: the setting may have been turned off, or moved
      // to another profile, while they were awaited.
      const { enabled, profileId } = this.settings;
      if (!enabled) return;
      await this.deps.run(profileId);
    })()
      .catch((error) => this.deps.onError?.(error))
      .finally(() => {
        this.current = null;
        if (this.exitedDuringRun) {
          this.exitedDuringRun = false;
          if (!this.stopped) void this.attempt();
        }
      });
    this.current = run;
    return run;
  }
}
