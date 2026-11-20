import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesktopBranchMenu } from '../shared/contract';
import {
  applyDefaultWorktreeIntent,
  getBranchIntent,
  invokeWorktree,
  worktreeFailure,
  worktreeFailureText,
} from './worktree-branch-model';

const defaultApplied = new Set<string>();

/** A failed eager read retries after this, doubling until it passes the cap. */
const MENU_RETRY_FIRST_MS = 800;
const MENU_RETRY_MAX_MS = 6000;

type MenuRead = { menu: DesktopBranchMenu | null; recovery: boolean };

/** The last menu read per session (or Project, for a draft). Module-level, so
 *  a host that remounts — the island per session switch, the chip per route —
 *  opens with the last known branch, workspace and branch list at once while
 *  the fresh read lands in the background. */
const lastMenuReads = new Map<string, MenuRead>();

const menuReadKey = (draft: boolean, projectPath: string, sessionId: string) =>
  draft ? `project\0${projectPath}` : `session\0${sessionId}`;

/** Reads of one key share a single round trip: the composer's branch chip and
 *  the island's branch segment both read a session's menu as they mount, and
 *  a phone paid the (large) menu twice over the relay. */
const menuReadsInFlight = new Map<string, Promise<DesktopBranchMenu | null>>();
/** When each key's last read was answered: a host that mounts right after
 *  another host's read adopts that answer instead of asking again. */
const menuReadAnsweredAt = new Map<string, number>();
const MENU_MOUNT_REUSE_MS = 2_000;

function sharedMenuRead(key: string, read: () => Promise<DesktopBranchMenu | null>) {
  const running = menuReadsInFlight.get(key);
  if (running) return running;
  const next = read();
  menuReadsInFlight.set(key, next);
  const settle = () => {
    if (menuReadsInFlight.get(key) === next) menuReadsInFlight.delete(key);
  };
  next.then(() => {
    menuReadAnsweredAt.set(key, Date.now());
    settle();
  }, settle);
  return next;
}

/** For tests: forgets every cached menu read. */
export function clearBranchMenuReads(): void {
  lastMenuReads.clear();
  menuReadsInFlight.clear();
  menuReadAnsweredAt.clear();
}

/** The menu's data: the session's branch menu, or a draft's Project menu,
 *  re-read whenever `refreshKey` changes (only while `eager`; a lazy host
 *  calls `load` itself), plus the recovery state of a vanished worktree and
 *  the menu notice. */
export function useBranchMenuData({
  draft,
  projectPath,
  sessionId,
  intentKey,
  refreshKey,
  eager = true,
}: {
  draft: boolean;
  projectPath: string;
  sessionId: string;
  intentKey: string;
  refreshKey: string;
  eager?: boolean;
}) {
  const readKey = menuReadKey(draft, projectPath, sessionId);
  // A read answered for this key since mount (null menu: it failed); until
  // then the cached read of the key, if any, stands in.
  const [answered, setAnswered] = useState<(MenuRead & { key: string }) | null>(null);
  const shown = answered?.key === readKey ? answered : (lastMenuReads.get(readKey) ?? null);
  const selected = draft ? getBranchIntent(intentKey) : undefined;
  const menu = shown?.menu
    ? selected
      ? { ...shown.menu, workspace: { ...shown.menu.workspace, branch: selected.branch } }
      : shown.menu
    : null;
  const recovery = shown?.recovery ?? false;
  const [notice, setNotice] = useState('');
  const loadId = useRef(0);
  const setRead = useCallback(
    (next: DesktopBranchMenu | null, recovering: boolean) => {
      if (next) lastMenuReads.set(readKey, { menu: next, recovery: recovering });
      setAnswered({ key: readKey, menu: next, recovery: recovering });
    },
    [readKey]
  );

  // A draft has no session: the Project's own menu (real occupancy of the
  // project folder) from the runtime, never a client-side guess.
  const projectMenu = useCallback(
    () => invokeWorktree<DesktopBranchMenu>('getProjectBranchMenu', [{ projectPath }]),
    [projectPath]
  );
  /** Resolves false only when the read failed (the caller may retry). */
  const load = useCallback(async (): Promise<boolean> => {
    const id = ++loadId.current;
    try {
      let next: DesktopBranchMenu | null = null;
      if (!draft)
        next = await sharedMenuRead(readKey, () => invokeWorktree<DesktopBranchMenu>('getBranchMenu', [], sessionId));
      else if (projectPath) next = await sharedMenuRead(readKey, projectMenu);
      if (id !== loadId.current) return true;
      setRead(next, next?.workspace.transition.state === 'recovery');
    } catch (reason) {
      if (id !== loadId.current) return true;
      const failure = worktreeFailure(reason);
      // A vanished worktree still offers the project's branches as the way out.
      if (failure.code === 'WORKTREE_MISSING' && projectPath) {
        const next = await projectMenu().catch(() => null);
        // A later load owns the menu, whichever way this fallback ended.
        if (id !== loadId.current) return true;
        setNotice(worktreeFailureText(failure));
        if (!next) {
          // The last good menu stands; the caller retries.
          if (!lastMenuReads.has(readKey)) setRead(null, false);
          return false;
        }
        setRead(next, true);
        return true;
      }
      // The last good read stands; only a key that never had one reports the failure.
      if (!lastMenuReads.has(readKey)) setRead(null, false);
      return false;
    }
    return true;
  }, [draft, projectMenu, projectPath, readKey, sessionId, setRead]);

  // The read follows the key and the refresh trigger, not `load`'s identity:
  // a session's Project path landing with the catalog changes `load` but not
  // what the session's menu read returns.
  const loadRef = useRef(load);
  loadRef.current = load;
  const readFor = useRef('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the deliberate re-read trigger
  useEffect(() => {
    if (!eager) return undefined;
    const mountRead = readFor.current !== readKey;
    readFor.current = readKey;
    // Another host answered this key a moment ago (both mount with the
    // session): its read is already shown from the shared cache.
    const answeredAt = menuReadAnsweredAt.get(readKey);
    if (
      mountRead &&
      lastMenuReads.has(readKey) &&
      answeredAt !== undefined &&
      Date.now() - answeredAt < MENU_MOUNT_REUSE_MS
    )
      return undefined;
    // A failed read (the runtime busy or not yet up) retries with backoff.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async (delay: number) => {
      const ok = await loadRef.current();
      if (ok || cancelled || delay > MENU_RETRY_MAX_MS) return;
      timer = setTimeout(() => void attempt(delay * 2), delay);
    };
    void attempt(MENU_RETRY_FIRST_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [eager, readKey, refreshKey]);
  // A New Task starts in the user's configured default; an explicit choice
  // later wins because the default applies once per draft. It waits for a
  // menu read showing a git repository: no project or a non-git folder has
  // no worktree to default to.
  const repository = Boolean(menu?.workspace.repoCommonDir);
  useEffect(() => {
    if (!draft || !repository || defaultApplied.has(intentKey)) return;
    defaultApplied.add(intentKey);
    void invokeWorktree<{ newTaskDefault?: string }>('getWorktreeSettings')
      .then((settings) => {
        if (settings?.newTaskDefault === 'worktree') applyDefaultWorktreeIntent(intentKey);
      })
      .catch(() => {
        // Settings are optional chrome: the branch default stays.
      });
  }, [draft, intentKey, repository]);

  // Nothing read or cached for this key yet: the menu is still loading.
  return { menu, recovery, loading: shown === null, notice, setNotice, load };
}
