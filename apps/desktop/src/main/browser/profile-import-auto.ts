/**
 * Automatic cookie import from Chrome, while Chrome is closed.
 *
 * Chrome holds its Cookies database for as long as any chrome.exe lives, so a
 * run happens only when none does: shortly after the app starts (or the
 * setting is turned on), after Chrome exits, and on an hourly tick. The runs
 * use the saved Chrome key and never raise a UAC prompt; without a usable key
 * they stop and ask for one manual import.
 */
import { readFile, rm } from 'node:fs/promises';
import { writeJsonAtomicAsync } from '../../../../../src/runtime/shared/atomic-file.mjs';
import type { DesktopCookieAutoImportStatus } from '../../shared/contract';

/** How often Chrome's process list is checked, to notice that it exited. */
export const CHROME_POLL_MS = 3 * 60_000;
export const HOURLY_MS = 60 * 60_000;
/** Let the app finish starting before the first run. */
export const START_DELAY_MS = 20_000;

/** What the last runs left behind: no cookie values, no key. */
export interface CookieAutoImportState {
  lastImportAt?: number;
  lastCount?: number;
  lastError?: string;
  /** Set when a run found no usable saved key; cleared by a successful manual import. */
  needsManualImport?: boolean;
}

export type AutoCookieImportOutcome =
  | { state: 'imported'; count: number }
  | { state: 'skipped'; reason: 'chrome-running' | 'busy' }
  | { state: 'needs-manual-import' }
  | { state: 'failed'; error: string };

export interface CookieAutoImportSettings {
  enabled: boolean;
  profileId: string;
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
    };
  }

  /** Merge `patch`; a field set to undefined (or false) is removed. */
  update(patch: { [Key in keyof CookieAutoImportState]: CookieAutoImportState[Key] | undefined }): Promise<void> {
    const next = this.queue.then(async () => {
      const merged: CookieAutoImportState = { ...(await this.read()), ...patch };
      if (!merged.needsManualImport) delete merged.needsManualImport;
      for (const key of Object.keys(merged) as Array<keyof CookieAutoImportState>) {
        if (merged[key] === undefined) delete merged[key];
      }
      await writeJsonAtomicAsync(this.file, merged);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async clear(): Promise<void> {
    await this.queue;
    await rm(this.file, { force: true });
  }
}

export interface CookieAutoImportTimers {
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// Timers never keep the app alive.
const REAL_TIMERS: CookieAutoImportTimers = {
  setInterval: (run, ms) => {
    const handle = setInterval(run, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
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
  chromeRunning(): Promise<boolean>;
  keyStatus(): Promise<{ available: boolean; saved: boolean }>;
  forgetKey(): Promise<void>;
  timers?: CookieAutoImportTimers;
  onError?(error: unknown): void;
}

export class CookieAutoImporter {
  private settings: CookieAutoImportSettings = { enabled: false, profileId: '' };
  private cancels: Array<() => void> = [];
  private chromeWasRunning = false;
  private current: Promise<void> | null = null;
  private readonly timers: CookieAutoImportTimers;

  constructor(private readonly deps: CookieAutoImporterDeps) {
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** App start: read the saved setting; when on, the first run follows shortly. */
  async start(): Promise<void> {
    this.settings = await this.deps.settings.read();
    this.arm(START_DELAY_MS);
  }

  stop(): void {
    this.disarm();
  }

  async status(): Promise<DesktopCookieAutoImportStatus> {
    const [state, key] = await Promise.all([this.deps.state.read(), this.deps.keyStatus()]);
    return {
      enabled: this.settings.enabled,
      profileId: this.settings.profileId,
      keySaved: key.saved,
      keyStorageAvailable: key.available,
      running: this.current !== null,
      ...(state.lastImportAt !== undefined ? { lastImportAt: state.lastImportAt } : {}),
      ...(state.lastCount !== undefined ? { lastCount: state.lastCount } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      needsManualImport: state.needsManualImport === true,
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
    if (hadKey && this.settings.enabled) await this.deps.state.update({ needsManualImport: true });
    return await this.status();
  }

  private disarm(): void {
    for (const cancel of this.cancels) cancel();
    this.cancels = [];
  }

  private arm(firstRunDelayMs: number): void {
    this.disarm();
    if (!this.settings.enabled || !this.settings.profileId) return;
    this.chromeWasRunning = false;
    const first = this.timers.setTimeout(() => void this.attempt(), firstRunDelayMs);
    const poll = this.timers.setInterval(() => void this.pollChrome(), CHROME_POLL_MS);
    const hourly = this.timers.setInterval(() => void this.attempt(), HOURLY_MS);
    this.cancels = [
      () => this.timers.clearTimeout(first),
      () => this.timers.clearInterval(poll),
      () => this.timers.clearInterval(hourly),
    ];
  }

  /** Chrome just exited: its database is free now. */
  private async pollChrome(): Promise<void> {
    const wasRunning = this.chromeWasRunning;
    let running: boolean;
    try {
      running = await this.deps.chromeRunning();
    } catch {
      return;
    }
    this.chromeWasRunning = running;
    if (wasRunning && !running) await this.attempt();
  }

  /** One run at a time; a run while Chrome lives, or after the key went
   *  missing, is skipped quietly. */
  private attempt(): Promise<void> {
    if (this.current) return this.current;
    const run = (async () => {
      const { enabled, profileId } = this.settings;
      if (!enabled || !profileId) return;
      try {
        this.chromeWasRunning = await this.deps.chromeRunning();
      } catch {
        return;
      }
      if (this.chromeWasRunning) return;
      if ((await this.deps.state.read()).needsManualImport) return;
      await this.deps.run(profileId);
    })()
      .catch((error) => this.deps.onError?.(error))
      .finally(() => {
        this.current = null;
      });
    this.current = run;
    return run;
  }
}
