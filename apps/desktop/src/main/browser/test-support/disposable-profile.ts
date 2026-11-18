import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The folder the runner script owns for this run (and removes itself, whatever becomes of this process). */
export const PROFILE_DIR_ENV = 'MIXDOG_CORE_HARNESS_PROFILE_DIR';

export interface DisposableProfile {
  readonly dir: string;
  /** Removes the profile when this process made it; a runner-owned one is the runner's to remove. Never throws. */
  remove(): Promise<void>;
}

/**
 * The profile of one harness run. A killed or timed-out process cannot clean up after itself, so the runner hands it a folder
 * inside its own temp workspace; run alone, the process makes its own and removes it on success and on failure
 * (Chromium can hold profile files briefly after the host closes: retried, and never allowed to change the verdict).
 */
export function disposableProfile(env: NodeJS.ProcessEnv = process.env): DisposableProfile {
  const owned = env[PROFILE_DIR_ENV];
  const dir = owned || mkdtempSync(join(tmpdir(), 'mixdog-browser-core-profile-'));
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    remove: async () => {
      if (owned) return;
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
    },
  };
}
