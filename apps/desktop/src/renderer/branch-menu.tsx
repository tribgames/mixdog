// The branch menu shared by the New Task branch chip (a popup) and the
// composer island's branch segment (an island tab): search · branches ·
// "New branch" · "New worktree" · "Clean up", in one theme. Its data, the
// popup's placement, actions and dialogs live here; each host owns only its
// trigger.
import { BrushCleaning, Check, ChevronDown, ChevronRight, FolderGit2, GitBranch, Plus, Search, X } from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type { DesktopBranchMenu } from '../shared/contract';
import { confirmAction } from './app-confirm';
import { t } from './i18n';
import { scrimDismiss } from './scrim-dismiss';
import { BranchRowActions } from './branch-row-actions';
import { useMobileBack } from './mobile-back';
import { MxIcon } from './MxIcon';
import { ProgressSpinner } from './ProgressSpinner';
import { containDialogTab, PaneDialogLayer } from './sidebar-dialog';
import { useSurfaceActive } from './surface-activity';
import { touchPrimaryPointer } from './surface-input-focus';
import { clampOverlayIntoView } from './anchored-panel';
import { acquireTitleBarDim } from './titlebar-dim';
import { useSessionTitle } from './session-glance-store';
import {
  type BranchGroup,
  type BranchRow,
  branchAge,
  branchMatch,
  branchMenuPosition,
  searchedNewBranch,
  invokeWorktree,
  largeRepoPrompt,
  nothingToCleanUp,
  pruneReportText,
  setWorktreeIntent,
  setBranchIntent,
  getBranchIntent,
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

/** The last unfiltered list height per island session (useStableMenuList). */
const lastListHeights = new Map<string, number>();

/** For tests: forgets every cached menu read. */
export function clearBranchMenuCache(): void {
  lastMenuReads.clear();
  lastListHeights.clear();
  menuReadsInFlight.clear();
  menuReadAnsweredAt.clear();
}

export type CarryChoice = 'leave' | 'carry';

/** The transition the user just chose: the "Worktree" item, a branch row
 *  (`name`) or "New branch" (`name`, the created branch). */
export type BranchMenuPending = { kind: 'worktree' | 'branch' | 'create'; name?: string; move: boolean };

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
  // later wins because the default applies once per draft.
  useEffect(() => {
    if (!draft || defaultApplied.has(intentKey)) return;
    defaultApplied.add(intentKey);
    void invokeWorktree<{ newTaskDefault?: string }>('getWorktreeSettings')
      .then((settings) => {
        if (settings?.newTaskDefault === 'worktree') setWorktreeIntent(intentKey, true);
      })
      .catch(() => {
        // Settings are optional chrome: the branch default stays.
      });
  }, [draft, intentKey]);

  // Nothing read or cached for this key yet: the menu is still loading.
  return { menu, recovery, loading: shown === null, notice, setNotice, load };
}

/** Open state and placement of the portal menu: it follows resize and
 *  scroll, and closes on an outside pointer, mobile back, a surface switch
 *  or when the host is disabled. While `modal` (a dialog over the menu) the
 *  dialog owns dismissal. */
export function useBranchMenuOverlay(disabled: boolean, modal: boolean) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties>({});
  const root = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const surfaceActive = useSurfaceActive();
  const visible = open && surfaceActive;

  const place = useCallback(() => {
    if (root.current) setPlacement(branchMenuPosition(root.current));
  }, []);
  const close = useCallback(() => setOpen(false), []);
  useMobileBack(visible && !modal, close);
  useEffect(() => {
    if (!surfaceActive && open) setOpen(false);
  }, [open, surfaceActive]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!visible) return undefined;
    const outside = (event: PointerEvent) => {
      if (modal) return;
      const target = event.target as Node | null;
      if (root.current?.contains(target) || panel.current?.contains(target)) return;
      // The uncommitted-files choice is a modal over the open menu.
      if (
        target instanceof Element &&
        target.closest('.worktree-carry-dialog, .settings-confirm-layer, .dock-scm-context-menu')
      )
        return;
      setOpen(false);
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [modal, place, visible]);

  /** Places the menu at the anchor's current spot (before it opens). */
  const measure = () => (root.current ? branchMenuPosition(root.current) : {});
  /** Opens the menu again at the anchor (a refusal after a dialog that closed it). */
  const reopen = () => {
    setPlacement(measure());
    setOpen(true);
  };
  return {
    open,
    setOpen,
    visible,
    close,
    reopen,
    position: placement,
    setPosition: setPlacement,
    measure,
    root,
    panel,
  };
}

/** The menu's actions: "Worktree", a branch row and "New branch", each one
 *  runtime transition whose failure becomes the menu notice. A session's
 *  "Worktree" creates and enters the worktree now; uncommitted project-folder
 *  files first ask whether they stay or move (`carry`). While `locked` (work
 *  is running) no transition starts. */
export function useBranchMenuActions({
  draft,
  intent,
  intentKey,
  sessionId,
  projectPath,
  menu,
  query,
  locked = false,
  load,
  setNotice,
  close,
  reopen,
  trigger,
}: {
  draft: boolean;
  intent: boolean;
  intentKey: string;
  sessionId: string;
  projectPath: string;
  menu: DesktopBranchMenu | null;
  query: string;
  locked?: boolean;
  load(): Promise<unknown>;
  setNotice(notice: string): void;
  close(): void;
  /** Opens the menu again so a refusal after the uncommitted-files choice
   *  (which closed it) shows as its notice. */
  reopen(): void;
  trigger: RefObject<HTMLElement | null>;
}) {
  const [busy, setBusy] = useState(false);
  // What the user chose, from the click until the new state is read back: the
  // menu marks that row at once (a refusal can take seconds to arrive) and the
  // island segment shows a pending mark. `move` is a worktree move, which
  // runs for seconds (a carry for much longer) before the workspace switches.
  const [pending, setPending] = useState<BranchMenuPending | null>(null);
  const [carry, setCarry] = useState<{
    count: number;
    paths: string[];
    resolve(choice: CarryChoice | null): void;
  } | null>(null);

  /** One transition: asks once more with `confirmLarge` after the user OKs
   *  the large-repository prompt, and with `carryChanges` after the user
   *  picks what happens to uncommitted files; every other failure becomes
   *  the menu notice. */
  const perform = async (
    call: (extra: { confirmLarge?: true; carryChanges?: CarryChoice }) => Promise<unknown>,
    { checkout = false, mark }: { checkout?: boolean; mark: BranchMenuPending }
  ): Promise<boolean> => {
    setBusy(true);
    setPending(mark);
    setNotice('');
    let extra: { confirmLarge?: true; carryChanges?: CarryChoice } = {};
    try {
      for (;;) {
        try {
          await call(extra);
          return true;
        } catch (reason) {
          const failure = worktreeFailure(reason);
          if (failure.code === 'WORKTREE_LARGE_REPO_CONFIRM' && !extra.confirmLarge) {
            if (!(await confirmAction(largeRepoPrompt(failure)))) return false;
            extra = { ...extra, confirmLarge: true };
            continue;
          }
          if (failure.code === 'WORKTREE_DIRTY_CHOICE' && !extra.carryChanges) {
            const paths = Array.isArray(failure.details.paths) ? failure.details.paths.map(String) : [];
            const count = Number(failure.details.count) || paths.length;
            // The choice is a dialog of its own, like the confirm popups: the
            // menu closes first so nothing of it is drawn over the dialog.
            close();
            // Nothing runs while the user decides.
            setPending(null);
            const choice = await new Promise<CarryChoice | null>((resolve) => setCarry({ count, paths, resolve }));
            setCarry(null);
            if (!choice) return false;
            setPending(mark);
            extra = { ...extra, carryChanges: choice };
            continue;
          }
          throw reason;
        }
      }
    } catch (reason) {
      const failure = worktreeFailure(reason);
      setNotice(worktreeFailureText(failure, { checkout, carry: extra.carryChanges === 'carry' }));
      // The uncommitted-files choice closed the menu: bring it back for the notice.
      if (extra.carryChanges) reopen();
      if (failure.code === 'WORKTREE_REVISION_CONFLICT' || failure.code === 'WORKTREE_MISSING') void load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const finish = async (ok: boolean) => {
    if (!ok) return;
    close();
    await load();
    queueMicrotask(() => trigger.current?.focus());
  };
  /** One transition and its read-back: the mark stays until the new state is
   *  read (a move shows as pending until the workspace has switched). */
  const transition = async (...args: Parameters<typeof perform>): Promise<boolean> => {
    try {
      const ok = await perform(...args);
      await finish(ok);
      return ok;
    } finally {
      setPending(null);
    }
  };

  const revision = menu?.workspace.revision;
  const pickWorktree = async () => {
    if (!menu || busy || locked) return;
    if (draft) {
      setWorktreeIntent(intentKey, !intent);
      close();
      return;
    }
    if (menu.workspace.worktreeId) {
      close();
      return;
    }
    await transition(
      (extra) =>
        invokeWorktree('requestWorktree', [{ expectedRevision: revision, provision: true, ...extra }], sessionId),
      { mark: { kind: 'worktree', move: true } }
    );
  };
  // A draft only records intent. Its first send resolves a branch checkout;
  // existing sessions move through the idle-only workspace transition.
  const selectBranch = async (branch: string, create: boolean) => {
    if (draft) {
      setBranchIntent(intentKey, branch, create);
      close();
      queueMicrotask(() => trigger.current?.focus());
      return;
    }
    const createFlag = create ? { create: true } : {};
    const ok = await perform(
      (extra) =>
        invokeWorktree('selectBranch', [{ branch, ...createFlag, expectedRevision: revision, ...extra }], sessionId),
      { checkout: true, mark: { kind: create ? 'create' : 'branch', name: branch, move: false } }
    );
    try {
      await finish(ok);
    } finally {
      setPending(null);
    }
  };
  const pickRow = (row: BranchRow) => {
    if (busy || row.disabled) return;
    if (row.mark === 'current' && !intent) {
      close();
      return;
    }
    if (locked) return;
    void selectBranch(row.name, false);
  };
  const createBranch = () => {
    if (busy || locked) return;
    const name = query.trim();
    if (name) void selectBranch(name, true);
  };

  // Whether "Clean up" has anything to act on (a cheap read, no git checks):
  // unknown (loading, failed) keeps the button usable. Re-read whenever the
  // menu is read again and after a prune.
  const repoCommonDir = menu?.workspace.repoCommonDir;
  const [cleanup, setCleanup] = useState<{ repoCommonDir: string; empty: boolean } | null>(null);
  const cleanupRead = useRef(0);
  const readCleanup = useCallback(async () => {
    const id = ++cleanupRead.current;
    // A new request makes the answer unknown (usable) until it arrives.
    setCleanup(null);
    if (!repoCommonDir) return;
    const empty = await invokeWorktree('previewWorktreeCleanup', [{ repoCommonDir }], sessionId)
      .then(nothingToCleanUp)
      .catch(() => false);
    if (id === cleanupRead.current) setCleanup({ repoCommonDir, empty });
  }, [repoCommonDir, sessionId]);
  // `menu` itself is a fresh object per render for a draft's chosen branch;
  // its occupancy list is the read's own identity.
  const menuRead = menu?.occupancy;
  // biome-ignore lint/correctness/useExhaustiveDependencies: menuRead is the deliberate re-read trigger
  useEffect(() => {
    void readCleanup();
  }, [readCleanup, menuRead]);

  /** "Clean up": the manual prune (clean, merged worktrees no session keeps;
   *  registrations whose folder is gone), its summary as the notice, then a
   *  fresh read. Unmanaged worktrees with work in them are never touched. */
  const prune = async () => {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      setNotice(pruneReportText(await invokeWorktree('pruneWorktrees', [{ repoCommonDir }], sessionId)));
      await Promise.all([load(), readCleanup()]);
    } catch (reason) {
      setNotice(worktreeFailureText(worktreeFailure(reason)));
    } finally {
      setBusy(false);
    }
  };

  return {
    // "Clean up worktrees" wherever the folder is a git repository (worktrees are possible).
    management: {
      projectPath,
      refresh: load,
      ...(repoCommonDir ? { prune, nothingToClean: cleanup?.repoCommonDir === repoCommonDir && cleanup.empty } : {}),
    },
    busy,
    pending,
    pickWorktree,
    pickRow,
    createBranch,
    carry: carry ? { count: carry.count, paths: carry.paths, choose: carry.resolve } : null,
  };
}

/** Electron cannot show window.prompt; keep the original name/confirm/cancel flow in an app dialog. */
export function BranchNameDialog({
  panelId,
  anchor,
  name,
  onName,
  busy,
  notice,
  onCreate,
  onClose,
}: {
  panelId: string;
  anchor: RefObject<HTMLElement | null>;
  name: string;
  onName(name: string): void;
  busy: boolean;
  notice: string;
  onCreate(): void;
  onClose(): void;
}) {
  const titleId = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!busy) input.current?.focus();
  }, [busy]);
  useEffect(() => () => anchor.current?.focus(), [anchor]);
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <PaneDialogLayer anchor={anchor} onClose={close}>
      <section
        id={panelId}
        className="schedules-dialog branch-name-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        style={{ '--mx-editor-width': '420px' } as CSSProperties}
        onKeyDown={containDialogTab}
      >
        <header>
          <h2 id={titleId}>{t('New branch')}</h2>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!busy && name.trim()) onCreate();
          }}
        >
          <label className="schedules-field">
            <span>{t('New branch name')}</span>
            <input
              ref={input}
              type="text"
              required
              value={name}
              disabled={busy}
              onChange={(event) => onName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                event.stopPropagation();
                if (!event.nativeEvent.isComposing) event.currentTarget.form?.requestSubmit();
              }}
            />
          </label>
          {notice && <p role="alert">{notice}</p>}
          <footer>
            <button type="button" className="secondary" disabled={busy} onClick={close}>
              {t('Cancel')}
            </button>
            <button type="submit" disabled={busy || !name.trim()}>
              {t('New branch')}
            </button>
          </footer>
        </form>
      </section>
    </PaneDialogLayer>
  );
}

/** "Worktree" with uncommitted project-folder files: leave them there (the
 *  default), carry them into the worktree, or cancel. The settings-confirm
 *  skin as a modal over the menu. */
export function WorktreeCarryDialog({
  count,
  paths = [],
  onChoose,
}: {
  count: number;
  /** A capped preview of the uncommitted paths. */
  paths?: string[];
  onChoose(choice: CarryChoice | null): void;
}) {
  const leaveRef = useRef<HTMLButtonElement>(null);
  const chooseRef = useRef(onChoose);
  chooseRef.current = onChoose;
  useEffect(() => {
    leaveRef.current?.focus();
  }, []);
  useEffect(() => acquireTitleBarDim(), []);
  useMobileBack(true, () => chooseRef.current(null));
  const choices: { id: CarryChoice; label: string; description: string }[] = [
    {
      id: 'leave',
      label: t('Leave changes and move'),
      description: t(
        'Changes stay in the project folder, and the worktree starts from the current commit without these edits.'
      ),
    },
    {
      id: 'carry',
      label: t('Bring changes'),
      description: t('Changes move to the worktree and are removed from the project folder.'),
    },
  ];
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: scrim click-to-dismiss; Escape is handled on the layer.
    <div
      className="settings-confirm-layer"
      {...scrimDismiss(() => onChoose(null))}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onChoose(null);
      }}
    >
      <section
        className="settings-confirm-dialog worktree-carry-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="worktree-carry-title"
      >
        <header>
          <h3 id="worktree-carry-title">{t('Uncommitted files in the project folder: {{count}}', { count })}</h3>
          <button type="button" aria-label={t('Close confirmation')} onClick={() => onChoose(null)}>
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        {paths.length > 0 && (
          <ul className="worktree-carry-paths" aria-label={t('Uncommitted files')}>
            {paths.map((path) => (
              <li key={path} title={path}>
                {path}
              </li>
            ))}
            {count > paths.length && <li data-more>…</li>}
          </ul>
        )}
        <ul className="worktree-carry-choices">
          {choices.map((choice) => (
            <li key={choice.id} data-choice={choice.id}>
              <b>{choice.label}</b>
              <span>{choice.description}</span>
            </li>
          ))}
        </ul>
        <footer>
          <button type="button" data-choice="cancel" onClick={() => onChoose(null)}>
            {t('Cancel')}
          </button>
          <button type="button" data-choice="carry" onClick={() => onChoose('carry')}>
            {t('Bring changes')}
          </button>
          <button
            ref={leaveRef}
            type="button"
            className="primary"
            data-choice="leave"
            onClick={() => onChoose('leave')}
          >
            {t('Leave changes and move')}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}

type BranchMenuContentsProps = {
  management?: {
    projectPath: string;
    refresh(): Promise<unknown>;
    prune?(): Promise<void>;
    /** "Clean up" has nothing it could act on (disabled). */
    nothingToClean?: boolean;
  };
  query: string;
  onQuery(query: string): void;
  notice: string;
  intent: boolean;
  busy: boolean;
  /** The chosen transition, marked with a spinner until its result arrives. */
  pending?: BranchMenuPending | null;
  /** No branch list has been read yet (none cached): a subtle loading line. */
  loading?: boolean;
  locked?: boolean;
  base: string;
  rows: BranchRow[];
  worktreeBound: boolean;
  /** Remembers the unfiltered list's height under this key, so a reopened
   *  list starts at it instead of growing as rows arrive. */
  heightKey?: string;
  autoFocusSearch: boolean;
  onPickWorktree(): void;
  onPickRow(row: BranchRow): void;
  /** Offered as the list's last row when the search names no branch exactly. */
  onCreateFromSearch?(): void;
};

/** The menu body both hosts share: the search, an error notice, then the
 *  grouped branches. While `locked` no switch can start. */
function BranchMenuContents({
  management,
  query,
  onQuery,
  notice,
  intent,
  busy,
  pending = null,
  loading = false,
  locked = false,
  rows,
  worktreeBound,
  heightKey = '',
  autoFocusSearch,
  onPickRow,
  onCreateFromSearch,
}: BranchMenuContentsProps) {
  const switchDisabled = busy || locked;
  const list = useRef<HTMLDivElement>(null);
  const [otherExpanded, setOtherExpanded] = useState(false);
  // The rest of the branches fold away once recent ones can be told apart
  // (the menu carries commit times); a search always lists every hit.
  const collapsible = !query.trim() && rows.some((row) => row.committedAt !== undefined);
  const otherCollapsed = collapsible && !otherExpanded;
  const otherCount = rows.filter((row) => row.group === 'other').length;
  const toggleOther = () => setOtherExpanded((expanded) => !expanded);
  const track = useStableMenuList(list, rows, query, heightKey, otherExpanded);
  const newName = onCreateFromSearch ? searchedNewBranch(rows, query) : '';
  return (
    <>
      <div className="schedules-search branch-menu-search-frame">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          className="branch-menu-search"
          value={query}
          // biome-ignore lint/a11y/noAutofocus: the search field is the point of the opened menu; touch devices are excluded
          autoFocus={autoFocusSearch}
          aria-label={t('Search branches')}
          placeholder={t('Search branches')}
          onChange={(event) => onQuery(event.currentTarget.value)}
        />
      </div>
      {notice && (
        <p className="branch-menu-notice" role="alert">
          {notice}
        </p>
      )}
      <div className="branch-menu-list" ref={list} onScroll={track} onPointerOver={track} onFocusCapture={track}>
        {/* One flat keyed list: a row keeps its element when the group it starts changes. */}
        {rows.flatMap((row, index) => {
          if (row.group === 'other' && otherCollapsed) {
            if (rows[index - 1]?.group === 'other') return [];
            return [
              <OtherBranchesToggle key="group:other" count={otherCount} expanded={false} onToggle={toggleOther} />,
            ];
          }
          const group =
            row.group !== rows[index - 1]?.group &&
            (row.group === 'other' && collapsible ? (
              <OtherBranchesToggle key="group:other" count={otherCount} expanded onToggle={toggleOther} />
            ) : (
              <h3 className="branch-menu-label" data-group={row.group} key={`group:${row.group}`}>
                {GROUP_LABELS[row.group]()}
              </h3>
            ));
          const item = (
            <BranchMenuRow
              key={row.name}
              row={row}
              query={query}
              intent={intent}
              busy={busy}
              pending={pending?.kind === 'branch' && pending.name === row.name}
              locked={locked}
              worktreeBound={worktreeBound}
              onPick={onPickRow}
            />
          );
          const shell = management ? (
            <BranchRowActions
              key={row.name}
              projectPath={management.projectPath}
              branch={row.name}
              locked={locked || busy}
              onChanged={management.refresh}
            >
              {item}
            </BranchRowActions>
          ) : (
            <div className="branch-row-shell" key={row.name}>
              {item}
            </div>
          );
          return group ? [group, shell] : [shell];
        })}
        {newName && (
          <button
            type="button"
            className="branch-menu-item"
            data-kind="create-from-search"
            data-pending={pending?.kind === 'create' || undefined}
            aria-disabled={switchDisabled || undefined}
            onClick={() => {
              if (!switchDisabled) onCreateFromSearch?.();
            }}
          >
            {pending?.kind === 'create' ? (
              <ProgressSpinner size={14} aria-hidden="true" />
            ) : (
              <Plus size={14} aria-hidden="true" />
            )}
            <span>{t('Create branch "{{name}}"', { name: newName })}</span>
          </button>
        )}
        {rows.length === 0 &&
          !newName &&
          (loading ? (
            <p className="branch-menu-empty" data-loading role="status">
              {t('Loading branches…')}
            </p>
          ) : (
            <p className="branch-menu-empty">{t('No matching branches.')}</p>
          ))}
      </div>
    </>
  );
}

const GROUP_LABELS: Record<BranchGroup, () => string> = {
  current: () => t('Current branch'),
  worktree: () => t('Worktrees'),
  recent: () => t('Recent'),
  other: () => t('Other branches'),
  external: () => t('Other worktrees'),
};

/** The "other branches" header: collapses and expands the group. */
function OtherBranchesToggle({ count, expanded, onToggle }: { count: number; expanded: boolean; onToggle(): void }) {
  return (
    <h3 className="branch-menu-label" data-group="other">
      <button type="button" className="branch-menu-group-toggle" aria-expanded={expanded} onClick={onToggle}>
        {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
        <span>{t('Other branches: {{count}}', { count })}</span>
      </button>
    </h3>
  );
}

/** "Clean up" (worktrees): the footer's quiet last button wherever the
 *  folder is a git repository; its summary becomes the menu notice. */
function PruneWorktreesButton({
  className,
  busy,
  empty,
  onPrune,
}: {
  className: string;
  busy: boolean;
  /** Nothing to clean: not clickable, the tooltip says so. */
  empty: boolean;
  onPrune(): Promise<void>;
}) {
  const disabled = busy || empty;
  return (
    <button
      type="button"
      className={className}
      data-kind="prune"
      aria-disabled={disabled || undefined}
      title={
        empty
          ? t('Nothing to clean up.')
          : t('Remove clean, merged worktrees no session keeps, and forget deleted worktree folders')
      }
      onClick={() => {
        if (!disabled) void onPrune();
      }}
    >
      <BrushCleaning size={14} aria-hidden="true" />
      <span>{t('Clean up')}</span>
    </button>
  );
}

/** "New worktree": the next turn starts on a new branch in its own folder.
 *  Pressed while chosen; not offered to a session already in its worktree. */
function NewWorktreeButton({
  className,
  intent,
  pending,
  disabled,
  onPick,
}: {
  className: string;
  intent: boolean;
  pending: boolean;
  disabled: boolean;
  onPick(): void;
}) {
  return (
    <button
      type="button"
      className={className}
      data-kind="worktree"
      data-selected={intent || undefined}
      data-pending={pending || undefined}
      aria-pressed={intent}
      aria-disabled={disabled || undefined}
      title={t('New branch · separate folder')}
      onClick={onPick}
    >
      {pending ? <ProgressSpinner size={14} aria-hidden="true" /> : <FolderGit2 size={14} aria-hidden="true" />}
      <span>{t('New worktree')}</span>
    </button>
  );
}

/** "New branch": the first footer button in both hosts. */
function CreateBranchButton({
  className,
  pending,
  disabled,
  onCreate,
}: {
  className: string;
  pending: boolean;
  disabled: boolean;
  onCreate(): void;
}) {
  return (
    <button
      type="button"
      className={className}
      data-kind="create"
      data-pending={pending || undefined}
      aria-disabled={disabled || undefined}
      onClick={onCreate}
    >
      {pending ? <ProgressSpinner size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
      <span>{t('New branch')}</span>
    </button>
  );
}

/** The New Task chip's popup: search · branches, then "New branch" ·
 *  "New worktree" · "Clean up". */
export function BranchMenuPanel({
  panel,
  panelId,
  position,
  onCreateBranch,
  onEscape,
  ...contents
}: Omit<BranchMenuContentsProps, 'autoFocusSearch' | 'onCreateFromSearch'> & {
  panel: RefObject<HTMLDivElement | null>;
  panelId: string;
  position: CSSProperties;
  onCreateBranch(): void;
  onEscape(): void;
}) {
  // The menu is sized by its labels (up to 420px), wider than the 280px the
  // placement assumed: pull it back inside the visible viewport once measured.
  // biome-ignore lint/correctness/useExhaustiveDependencies: position is the trigger; the effect reads the DOM it produced
  useLayoutEffect(() => {
    clampOverlayIntoView(panel.current);
  }, [position, panel]);
  return (
    <div
      ref={panel}
      id={panelId}
      className="branch-menu"
      role="dialog"
      aria-label={t('Branch and worktree')}
      style={position}
      onKeyDown={(event) => moveMenuFocus(event, panel.current, onEscape)}
    >
      <BranchMenuContents {...contents} autoFocusSearch={!touchPrimaryPointer()} onCreateFromSearch={onCreateBranch} />
      <hr className="branch-menu-rule" />
      <div className="branch-menu-actions">
        <CreateBranchButton
          className="branch-menu-item"
          pending={contents.pending?.kind === 'create'}
          disabled={contents.busy || Boolean(contents.locked)}
          onCreate={onCreateBranch}
        />
        <NewWorktreeButton
          className="branch-menu-item"
          intent={contents.intent}
          pending={contents.pending?.kind === 'worktree'}
          disabled={contents.busy || Boolean(contents.locked)}
          onPick={contents.onPickWorktree}
        />
        {contents.management?.prune && (
          <PruneWorktreesButton
            className="branch-menu-item"
            busy={contents.busy}
            empty={contents.management.nothingToClean === true}
            onPrune={contents.management.prune}
          />
        )}
      </div>
    </div>
  );
}

/** The composer island's branch tab: the same menu in the island's panel
 *  grammar — a header with the branch chip and close, then the search ·
 *  branches, and a footer with "New branch" · "New worktree" · "Clean up".
 *  A session in its worktree has `worktreeActions` (View changes · Merge ·
 *  Remove) in place of the first two, the first of which takes focus. */
export function BranchIslandPanel({
  panel,
  panelId,
  title,
  meta = '',
  worktreeActions,
  onCreateBranch,
  onClose,
  ...contents
}: Omit<BranchMenuContentsProps, 'autoFocusSearch' | 'onCreateFromSearch'> & {
  panel: RefObject<HTMLElement | null>;
  panelId: string;
  /** The header chip: the branch glyph and name. */
  title: ReactNode;
  /** The branch's status beside the chip, muted ("Modified 3 · ↑2"). */
  meta?: string;
  worktreeActions?: ReactNode;
  onCreateBranch(): void;
  /** Collapses the tab (✕, Escape) and hands focus back to the segment. */
  onClose(): void;
}) {
  // Once, when the tab opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only focus
  useEffect(() => {
    if (!worktreeActions || touchPrimaryPointer()) return;
    panel.current?.querySelector<HTMLElement>('[data-action-id]:not([aria-disabled="true"])')?.focus();
  }, []);
  return (
    <section
      ref={panel}
      id={panelId}
      className="composer-island-panel composer-island-branch-panel"
      aria-label={t('Branch and worktree')}
      data-locked={contents.locked || undefined}
      onKeyDown={(event) => moveMenuFocus(event, panel.current, onClose)}
    >
      <div className="composer-island-phead">
        <span className="composer-island-tab" data-active="true">
          {title}
        </span>
        {meta && <span className="composer-island-phead-meta">{meta}</span>}
        <button
          type="button"
          className="composer-island-close"
          aria-label={t('Close')}
          title={t('Close')}
          onClick={onClose}
        >
          <MxIcon name="close-small" size={16} />
        </button>
      </div>
      <div className="composer-island-pbody branch-menu-body">
        <BranchMenuContents
          {...contents}
          autoFocusSearch={!touchPrimaryPointer() && !worktreeActions}
          onCreateFromSearch={worktreeActions ? undefined : onCreateBranch}
        />
        <div className="composer-island-pfoot branch-menu-foot">
          {worktreeActions ?? (
            <>
              <CreateBranchButton
                className="composer-island-button"
                pending={contents.pending?.kind === 'create'}
                disabled={contents.busy || Boolean(contents.locked)}
                onCreate={onCreateBranch}
              />
              <NewWorktreeButton
                className="composer-island-button"
                intent={contents.intent}
                pending={contents.pending?.kind === 'worktree'}
                disabled={contents.busy || Boolean(contents.locked)}
                onPick={contents.onPickWorktree}
              />
            </>
          )}
          {contents.management?.prune && (
            <PruneWorktreesButton
              className="composer-island-button"
              busy={contents.busy}
              empty={contents.management.nothingToClean === true}
              onPrune={contents.management.prune}
            />
          )}
        </div>
      </div>
    </section>
  );
}

/** Keeps the branch list steady while a fresh read replaces the cached one:
 *  its height never shrinks while the query is unchanged, and the row under
 *  the pointer or focus (rows are keyed by branch name, so it is the same
 *  element) stays where it was by correcting the list's scroll. Returns the
 *  tracker the list calls when focus, pointer or scroll moves the anchor. */
function useStableMenuList(
  list: RefObject<HTMLDivElement | null>,
  rows: BranchRow[],
  query: string,
  heightKey = '',
  expanded = false
) {
  // Folding a group is the user's own change, like a search: it keys the floor too.
  const shape = `${expanded ? '+' : '-'}${query}`;
  const floor = useRef((heightKey && !query && !expanded && lastListHeights.get(heightKey)) || 0);
  const seenQuery = useRef(shape);
  const anchor = useRef<{ name: string; top: number } | null>(null);
  const rowNodes = () => Array.from(list.current?.querySelectorAll<HTMLElement>('[data-branch]') ?? []);
  const track = () => {
    const active = document.activeElement;
    const node = rowNodes().find((row) => row === active || row.matches(':hover'));
    anchor.current = node?.dataset.branch ? { name: node.dataset.branch, top: node.getBoundingClientRect().top } : null;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows is the trigger; the effect reads the DOM it produced
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    if (seenQuery.current !== shape) {
      // Filtering or folding is the user's own change: no floor, no anchor.
      seenQuery.current = shape;
      floor.current = 0;
      anchor.current = null;
      element.style.minHeight = '';
    } else if (anchor.current) {
      const { name, top } = anchor.current;
      const node = rowNodes().find((row) => row.dataset.branch === name);
      const shift = node ? node.getBoundingClientRect().top - top : 0;
      if (shift) element.scrollTop += shift;
    }
    floor.current = Math.max(floor.current, element.offsetHeight);
    element.style.minHeight = floor.current ? `${floor.current}px` : '';
    if (heightKey && !query && !expanded && floor.current) lastListHeights.set(heightKey, floor.current);
    track();
  }, [rows, shape]);
  return track;
}

/** Menu keyboard: Escape closes, the arrow keys cycle through the search
 *  field and the enabled items. */
function moveMenuFocus(event: React.KeyboardEvent, panel: HTMLElement | null, onEscape: () => void) {
  if (event.key === 'Escape') {
    event.preventDefault();
    onEscape();
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const stops = Array.from(
    panel?.querySelectorAll<HTMLElement>(
      ':is(input, .branch-menu-item, .branch-menu-group-toggle, .branch-menu-foot button):not([aria-disabled="true"])'
    ) ?? []
  );
  const index = stops.indexOf(document.activeElement as HTMLElement);
  const next = stops[(index + (event.key === 'ArrowDown' ? 1 : -1) + stops.length) % stops.length];
  event.preventDefault();
  next?.focus();
}

/** The muted label closing a row: "Current", the owning session's name for a
 *  branch in a managed worktree (`owner`), an unmanaged worktree's path,
 *  "Project folder" for the project's branch. */
function rowLabel(row: BranchRow, hasWorktree: boolean, owner: string): string {
  if (row.mark === 'current') return t('Current');
  if (row.mark === 'external' && row.path) return row.path;
  if (hasWorktree) return owner;
  return row.mark === 'project' ? t('Project folder') : '';
}

/** The branch name with the searched text in the accent color. */
function BranchName({ name, query }: { name: string; query: string }) {
  const match = branchMatch(name, query);
  if (!match) return <span>{name}</span>;
  const [start, end] = match;
  return (
    <span>
      {name.slice(0, start)}
      <mark className="branch-menu-match">{name.slice(start, end)}</mark>
      {name.slice(end)}
    </span>
  );
}

function BranchMenuRow({
  row,
  query,
  intent,
  busy,
  pending,
  locked,
  worktreeBound,
  onPick,
}: {
  row: BranchRow;
  query: string;
  intent: boolean;
  busy: boolean;
  /** This row was chosen and its result has not arrived. */
  pending: boolean;
  locked: boolean;
  worktreeBound: boolean;
  onPick(row: BranchRow): void;
}) {
  const hasWorktree =
    (row.mark === 'current' && worktreeBound) || row.mark === 'inUse' || row.mark === 'external' || row.retained;
  // The check marks the selection: the current branch, until the worktree is chosen.
  const selected = row.mark === 'current' && !intent;
  const owner = useSessionTitle(row.sessionId ?? '', t('Worktree'));
  // A row with nothing else to say shows how long ago its tip was committed.
  const label = rowLabel(row, hasWorktree, owner) || (row.committedAt !== undefined ? branchAge(row.committedAt) : '');
  // Shared and external rows move this session too; only the current row is a no-op.
  const switches = !(row.mark === 'current' && !intent);
  return (
    <button
      type="button"
      className="branch-menu-item"
      data-kind="branch"
      data-branch={row.name}
      data-mark={row.mark || undefined}
      data-pending={pending || undefined}
      aria-disabled={row.disabled || busy || (locked && switches) || undefined}
      title={
        row.mark === 'external' && row.path
          ? t('Checked out in a worktree Mixdog does not manage: {{path}}', { path: row.path })
          : undefined
      }
      onClick={() => onPick(row)}
    >
      {pending ? (
        <ProgressSpinner size={14} aria-hidden="true" />
      ) : hasWorktree ? (
        <FolderGit2 size={14} aria-hidden="true" />
      ) : (
        <GitBranch size={14} aria-hidden="true" />
      )}
      <BranchName name={row.name} query={query} />
      {label && <small>{label}</small>}
      {selected && <Check size={14} className="branch-menu-check" role="img" aria-label={t('Current')} />}
    </button>
  );
}

/** "New branch": creates the searched name at once, else asks for a name.
 *  Nothing starts while a transition runs or work is running. */
export function startNewBranch({
  actions,
  query,
  locked = false,
  setNotice,
  setNamingBranch,
}: {
  actions: ReturnType<typeof useBranchMenuActions>;
  query: string;
  locked?: boolean;
  setNotice(notice: string): void;
  setNamingBranch(naming: boolean): void;
}): void {
  if (actions.busy || locked) return;
  if (query.trim()) actions.createBranch();
  else {
    setNotice('');
    setNamingBranch(true);
  }
}

/** The New Task chip's whole menu: the panel (or the New branch name dialog
 *  in its place) and the uncommitted-files choice. */
export function BranchMenuLayer({
  visible,
  namingBranch,
  setNamingBranch,
  panelId,
  trigger,
  panel,
  position,
  query,
  setQuery,
  notice,
  setNotice,
  intent,
  base,
  rows,
  worktreeBound,
  actions,
  close,
}: {
  visible: boolean;
  namingBranch: boolean;
  setNamingBranch(naming: boolean): void;
  panelId: string;
  trigger: RefObject<HTMLElement | null>;
  panel: RefObject<HTMLDivElement | null>;
  position: CSSProperties;
  query: string;
  setQuery(query: string): void;
  notice: string;
  setNotice(notice: string): void;
  intent: boolean;
  base: string;
  rows: BranchRow[];
  worktreeBound: boolean;
  actions: ReturnType<typeof useBranchMenuActions>;
  close(): void;
}) {
  const { busy, pending, pickWorktree, pickRow, createBranch, carry } = actions;
  return (
    <>
      {visible &&
        (namingBranch ? (
          <BranchNameDialog
            panelId={panelId}
            anchor={trigger}
            name={query}
            onName={setQuery}
            busy={busy}
            notice={notice}
            onCreate={createBranch}
            onClose={close}
          />
        ) : (
          createPortal(
            <BranchMenuPanel
              management={actions.management}
              panel={panel}
              panelId={panelId}
              position={position}
              query={query}
              onQuery={setQuery}
              notice={notice}
              intent={intent}
              busy={busy}
              pending={pending}
              base={base}
              rows={rows}
              worktreeBound={worktreeBound}
              onPickWorktree={() => void pickWorktree()}
              onPickRow={pickRow}
              onCreateBranch={() => startNewBranch({ actions, query, setNotice, setNamingBranch })}
              onEscape={() => {
                close();
                trigger.current?.focus();
              }}
            />,
            document.body
          )
        ))}
      {carry && <WorktreeCarryDialog count={carry.count} paths={carry.paths} onChoose={carry.choose} />}
    </>
  );
}
