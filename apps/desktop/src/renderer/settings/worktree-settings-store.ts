// Cached worktree settings (global, not per session): loaded with the rest of
// the settings data, so Settings → Worktrees renders them in its first frame,
// and revalidated whenever that page opens or a setup-tool change is announced.
import type { DesktopWorktreeSettings } from '../../shared/contract';
import { windowSectionStore } from '../section-store';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { invokeWorktree } from '../worktree-branch-model';

type Patch = Partial<DesktopWorktreeSettings>;
type Problems = { read: string | null; save: string | null };

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
const readbackListeners = new Set<() => void>();
const problemListeners = new Set<() => void>();
let problems: Problems = { read: null, save: null };
let watchers = 0;
let stopWatching: (() => void) | undefined;

export const peekWorktreeSettings = (): DesktopWorktreeSettings | null => current;
export const peekConfirmedWorktreeSettings = (): DesktopWorktreeSettings | null => committed;
export const peekWorktreeSettingsProblems = (): Problems => problems;

export function subscribeWorktreeSettingsProblems(listener: () => void): () => void {
  problemListeners.add(listener);
  return () => {
    problemListeners.delete(listener);
  };
}

export function subscribeConfirmedWorktreeSettings(listener: () => void): () => void {
  readbackListeners.add(listener);
  return () => {
    readbackListeners.delete(listener);
  };
}

function setProblem(kind: keyof Problems, reason: string | null): void {
  if (problems[kind] === reason) return;
  problems = { ...problems, [kind]: reason };
  for (const listener of [...problemListeners]) listener();
}

function adopt(value: DesktopWorktreeSettings): void {
  const before = committed;
  if (before && (Object.keys(value) as (keyof DesktopWorktreeSettings)[]).every((key) => before[key] === value[key]))
    return;
  committed = value;
  for (const listener of [...readbackListeners]) listener();
}

function problemText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

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
 *  failed read leaves the cache as is and is visible separately. */
export function refreshWorktreeSettings(): Promise<void> {
  if (read) {
    readAgain = true;
    return read;
  }
  const seen = confirmations;
  read = invokeWorktree<DesktopWorktreeSettings>('getWorktreeSettings')
    .then((value) => {
      if (seen !== confirmations) return;
      adopt(value);
      setProblem('read', null);
      publish();
    })
    .catch((reason: unknown) => {
      if (seen === confirmations) setProblem('read', problemText(reason));
    })
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

/** Share one watch across the settings groups. The list follows confirmed values. */
export function watchWorktreeSettings(): () => void {
  if (watchers++ === 0) {
    const refresh = () => void refreshWorktreeSettings();
    const sections = windowSectionStore();
    const storedWorktree = () => {
      const agent = sections?.get('config', 'agent')?.value as { worktree?: unknown } | undefined;
      return JSON.stringify(agent?.worktree);
    };
    let held = storedWorktree();
    const stopConfig = sections?.subscribe('config', () => {
      const next = storedWorktree();
      if (next === held) return;
      held = next;
      refresh();
    });
    const stopSetup = subscribeSetupChanges(refresh);
    window.addEventListener('focus', refresh);
    stopWatching = () => {
      stopConfig?.();
      stopSetup();
      window.removeEventListener('focus', refresh);
    };
    refresh();
  }
  return () => {
    if (--watchers !== 0) return;
    stopWatching?.();
    stopWatching = undefined;
  };
}

async function confirm(save: Patch): Promise<void> {
  try {
    const value = await invokeWorktree<DesktopWorktreeSettings>('setWorktreeSettings', [save]);
    confirmations++;
    adopt(value);
    setProblem('read', null);
  } catch (reason) {
    setProblem('save', problemText(reason));
    // A lost reply can hide an applied write. Never retry the write; read back instead.
    void refreshWorktreeSettings();
  }
  unconfirmed.splice(unconfirmed.indexOf(save), 1);
  publish();
}

/** Saves a patch: the page shows it at once; the host answers saves one at a
 *  time in order, the answer replaces it, and a failure drops only this patch,
 *  leaving the last confirmed value with the still-unconfirmed saves on top. */
export function saveWorktreeSettings(patch: Patch): void {
  if (!committed) return;
  setProblem('save', null);
  const save = { ...patch };
  unconfirmed.push(save);
  publish();
  writes = writes.then(() => confirm(save));
}
