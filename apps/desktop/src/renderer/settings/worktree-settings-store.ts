// Cached worktree settings (global, not per session): loaded with the rest of
// the settings data, so Settings → Work mode renders them in its first frame,
// and revalidated whenever that page opens or a setup-tool change is announced.
import type { DesktopWorktreeSettings } from '../../shared/contract';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { invokeWorktree } from '../worktree-branch-model';

type Patch = Partial<DesktopWorktreeSettings>;

/** The last value the host confirmed. */
let committed: DesktopWorktreeSettings | null = null;
/** Saves the host has not answered yet, oldest first; they show on top of `committed`. */
const unconfirmed: Patch[] = [];
/** What the page shows: `committed` with every unconfirmed save applied. */
let current: DesktopWorktreeSettings | null = null;
let read: Promise<void> | null = null;
let readAgain = false;
/** Counts confirmed saves: a read that began before one is older than it. */
let confirmations = 0;
let writes: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

export const peekWorktreeSettings = (): DesktopWorktreeSettings | null => current;

export function subscribeWorktreeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(): void {
  if (!committed) return;
  const next: DesktopWorktreeSettings = Object.assign({}, committed, ...unconfirmed);
  const before = current;
  // An unchanged value keeps its identity: a revalidation that finds nothing
  // new does not render the page again.
  if (before && (Object.keys(next) as (keyof DesktopWorktreeSettings)[]).every((key) => before[key] === next[key])) {
    return;
  }
  current = next;
  for (const listener of [...listeners]) listener();
}

/** Reads the host's value into the cache. Calls during a read share it and ask
 *  for one more after it, so a change announced mid-read is never missed; a
 *  failed read (a backend without worktree support) leaves the cache as is. */
export function refreshWorktreeSettings(): Promise<void> {
  if (read) {
    readAgain = true;
    return read;
  }
  const seen = confirmations;
  read = invokeWorktree<DesktopWorktreeSettings>('getWorktreeSettings')
    .then((value) => {
      if (seen !== confirmations) return;
      committed = value;
      publish();
    })
    .catch(() => {})
    .finally(() => {
      read = null;
      if (!readAgain) return;
      readAgain = false;
      void refreshWorktreeSettings();
    });
  return read;
}

/** The first read only (a read already under way is shared as is); once
 *  filled, the cache is revalidated by `watchWorktreeSettings`. */
export function loadWorktreeSettings(): Promise<void> {
  if (committed) return Promise.resolve();
  return read ?? refreshWorktreeSettings();
}

/** For a mounted Work mode page: revalidates the cache now (another window or
 *  the setup tool may have changed it since it was filled) and again on every
 *  announced setup change, until the returned stop is called. */
export function watchWorktreeSettings(): () => void {
  void refreshWorktreeSettings();
  return subscribeSetupChanges(() => void refreshWorktreeSettings());
}

async function confirm(save: Patch): Promise<void> {
  try {
    committed = await invokeWorktree<DesktopWorktreeSettings>('setWorktreeSettings', [save]);
    confirmations++;
  } catch {
    // Not saved: the page falls back to the last confirmed value.
  }
  unconfirmed.splice(unconfirmed.indexOf(save), 1);
  publish();
}

/** Saves a patch: the page shows it at once; the host answers saves one at a
 *  time in order, the answer replaces it, and a failure drops only this patch,
 *  leaving the last confirmed value with the still-unconfirmed saves on top. */
export function saveWorktreeSettings(patch: Patch): void {
  if (!committed) return;
  const save = { ...patch };
  unconfirmed.push(save);
  publish();
  writes = writes.then(() => confirm(save));
}
