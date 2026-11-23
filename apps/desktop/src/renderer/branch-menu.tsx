import { Check, ChevronDown, ChevronRight, FolderGit2, GitBranch, Plus, Search, X } from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
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
import { IslandPanelFoot, IslandPanelHead, TidyButton } from './IslandPanelFoot';
import { ProgressSpinner } from './ProgressSpinner';
import { containDialogTab, PaneDialogLayer } from './sidebar-dialog';
import { useSurfaceActive } from './surface-activity';
import { touchPrimaryPointer } from './surface-input-focus';
import { clampOverlayIntoView } from './anchored-panel';
import { acquireTitleBarDim } from './titlebar-dim';
import { closeOnUserScroll } from './menu-dismiss';
import { useAnchoredPlacement } from './use-anchored-placement';
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
  sharedCleanupPreview,
  chooseWorktreeIntent,
  setBranchIntent,
  worktreeFailure,
  worktreeFailureText,
} from './worktree-branch-model';
import { clearBranchMenuReads } from './branch-menu-data';
import { emptyStateHost } from './empty-state-host';

export { useBranchMenuData } from './branch-menu-data';

/** The last unfiltered list height per island session (useStableMenuList). */
const lastListHeights = new Map<string, number>();

/** For tests: forgets every cached menu read. */
export function clearBranchMenuCache(): void {
  lastListHeights.clear();
  clearBranchMenuReads();
}

export type CarryChoice = 'leave' | 'carry';

/** The transition the user just chose: the "Worktree" item, a branch row
 *  (`name`) or "New branch" (`name`, the created branch). */
export type BranchMenuPending = { kind: 'worktree' | 'branch' | 'create'; name?: string; move: boolean };

/** A dialog the open menu put over itself (the uncommitted-files choice, a row
 *  action's confirmation, the row menu): a press there is not outside it. */
function menuDialog(target: Node | null): boolean {
  return (
    (target as Element | null)?.closest?.('.worktree-carry-dialog, .settings-confirm-layer, .dock-scm-context-menu') !=
    null
  );
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
      if (root.current?.contains(target) || panel.current?.contains(target) || menuDialog(target)) return;
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

function useWorktreeCleanupPreview(menu: DesktopBranchMenu | null, menuOpen: boolean, sessionId: string) {
  // Whether "Clean up" has anything to act on (a cheap read, no git checks):
  // unknown (loading, failed) keeps the button usable. Read when the menu
  // opens, again when a menu read changes what it depends on, and after a prune.
  const repoCommonDir = menu?.workspace.repoCommonDir;
  const [cleanup, setCleanup] = useState<{ repoCommonDir: string; empty: boolean } | null>(null);
  const cleanupRead = useRef(0);
  const readCleanup = useCallback(async () => {
    const id = ++cleanupRead.current;
    // A new request makes the answer unknown (usable) until it arrives.
    setCleanup(null);
    if (!repoCommonDir) return;
    const empty = await sharedCleanupPreview(repoCommonDir, () =>
      invokeWorktree('previewWorktreeCleanup', [{ repoCommonDir }], sessionId)
    )
      .then(nothingToCleanUp)
      .catch(() => false);
    if (id === cleanupRead.current) setCleanup({ repoCommonDir, empty });
  }, [repoCommonDir, sessionId]);
  // What the preview depends on: the repository's branches and who holds them.
  // Each menu read (one per turn start and end while the menu is open) is a
  // fresh object, so the preview follows its content, not its identity.
  const branches = menu?.branches;
  const occupancy = menu?.occupancy;
  const retained = menu?.retainedWorktree;
  const menuRead = useMemo(
    () => JSON.stringify([branches ?? null, occupancy ?? null, retained ?? null]),
    [branches, occupancy, retained]
  );
  // Only an open menu shows the button the answer decides: a closed one (a composer per running session, each re-reading
  // its menu on every turn) asked the runtime for a repository scan it never displayed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: menuRead is the deliberate re-read trigger
  useEffect(() => {
    if (menuOpen) void readCleanup();
  }, [readCleanup, menuRead, menuOpen]);
  return {
    repoCommonDir,
    nothingToClean: cleanup?.repoCommonDir === repoCommonDir && cleanup?.empty === true,
    readCleanup,
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
  menuOpen,
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
  /** The menu is shown: the "Clean up" button's preview is read only then. */
  menuOpen: boolean;
  load(): Promise<unknown>;
  setNotice(notice: string): void;
  close(): void;
  /** Opens the menu again so a refusal after the uncommitted-files choice
   *  (which closed it) shows as its notice. */
  reopen(): void;
  trigger: RefObject<HTMLElement | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<BranchMenuPending | null>(null);
  const [carry, setCarry] = useState<{
    count: number;
    paths: string[];
    resolve(choice: CarryChoice | null): void;
  } | null>(null);

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
  // A folder that is not a git repository has no worktree to offer.
  const worktreeUnavailable = Boolean(menu) && !menu?.workspace.repoCommonDir;
  const pickWorktree = async () => {
    if (!menu || worktreeUnavailable || busy || locked) return;
    if (draft) {
      chooseWorktreeIntent(intentKey, !intent);
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
    if (locked) {
      setNotice(t("Can't switch while work is running"));
      return;
    }
    void selectBranch(row.name, false);
  };
  const createBranch = () => {
    if (busy || locked) return;
    const name = query.trim();
    if (name) void selectBranch(name, true);
  };

  const { repoCommonDir, nothingToClean, readCleanup } = useWorktreeCleanupPreview(menu, menuOpen, sessionId);

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
      ...(repoCommonDir ? { prune, nothingToClean } : {}),
    },
    busy,
    pending,
    worktreeUnavailable,
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
  /** The folder is not a git repository: "New worktree" is shown disabled. */
  worktreeUnavailable?: boolean;
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
  const track = useStableMenuList(list, rows, query, heightKey, otherExpanded, loading);
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
        {/* One flat keyed list: a row keeps its element when the group it starts changes. The current branch
            (and the project folder's) leads without a label. */}
        {rows.flatMap((row, index) => {
          if (row.group === 'other' && otherCollapsed) {
            if (rows[index - 1]?.group === 'other') return [];
            return [
              <OtherBranchesToggle key="group:other" count={otherCount} expanded={false} onToggle={toggleOther} />,
            ];
          }
          const group =
            row.group !== rows[index - 1]?.group &&
            row.group !== 'current' &&
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
              <ProgressSpinner size={16} aria-hidden="true" />
            ) : (
              <Plus size={16} aria-hidden="true" />
            )}
            <span>{t('Create branch "{{name}}"', { name: newName })}</span>
          </button>
        )}
        {rows.length === 0 &&
          !newName &&
          (loading ? (
            <p className="branch-menu-empty mx-empty-state" ref={emptyStateHost} data-loading role="status">
              {t('Loading branches…')}
            </p>
          ) : (
            <p className="branch-menu-empty mx-empty-state" ref={emptyStateHost}>
              {t('No matching branches.')}
            </p>
          ))}
      </div>
    </>
  );
}

const GROUP_LABELS: Record<Exclude<BranchGroup, 'current'>, () => string> = {
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
  busy,
  empty,
  onPrune,
}: {
  busy: boolean;
  /** Nothing to clean: not clickable, the tooltip says so. */
  empty: boolean;
  onPrune(): Promise<void>;
}) {
  return (
    <TidyButton
      className="composer-island-button"
      kind="prune"
      label={t('Clean up')}
      description={
        empty
          ? t('Nothing to clean up.')
          : t('Remove clean, merged worktrees no session keeps, and forget deleted worktree folders')
      }
      disabled={busy || empty}
      onClick={() => void onPrune()}
    />
  );
}

/** "New worktree": the next turn starts on a new branch in its own folder.
 *  Pressed while chosen; not offered to a session already in its worktree;
 *  disabled with the reason as its tooltip outside a git repository. */
function NewWorktreeButton({
  intent,
  pending,
  disabled,
  unavailable = false,
  onPick,
}: {
  intent: boolean;
  pending: boolean;
  disabled: boolean;
  unavailable?: boolean;
  onPick(): void;
}) {
  return (
    <button
      type="button"
      className="composer-island-button"
      data-kind="worktree"
      data-selected={intent || undefined}
      data-pending={pending || undefined}
      aria-pressed={intent}
      aria-disabled={disabled || unavailable || undefined}
      aria-label={t('New worktree')}
      title={unavailable ? t('This folder does not support worktrees.') : t('New branch · separate folder')}
      onClick={onPick}
    >
      {pending ? <ProgressSpinner size={14} aria-hidden="true" /> : <FolderGit2 size={14} aria-hidden="true" />}
      <span>{t('New worktree')}</span>
    </button>
  );
}

/** "New branch": the first footer button in both hosts. */
function CreateBranchButton({
  pending,
  disabled,
  onCreate,
}: {
  pending: boolean;
  disabled: boolean;
  onCreate(): void;
}) {
  return (
    <button
      type="button"
      className="composer-island-button"
      data-kind="create"
      data-pending={pending || undefined}
      aria-disabled={disabled || undefined}
      title={t('New branch')}
      onClick={onCreate}
    >
      {pending ? <ProgressSpinner size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
      <span>{t('New branch')}</span>
    </button>
  );
}

/** The foot under the list, the same in every host: New branch · New worktree
 *  (or a worktree session's `actions`), then Clean up at the end. */
function BranchMenuFoot({
  contents,
  actions,
  onCreate,
}: {
  contents: Pick<
    BranchMenuContentsProps,
    'busy' | 'locked' | 'intent' | 'pending' | 'worktreeUnavailable' | 'onPickWorktree' | 'management'
  >;
  actions?: ReactNode;
  onCreate(): void;
}) {
  const disabled = contents.busy || Boolean(contents.locked);
  const prune = contents.management?.prune;
  return (
    <IslandPanelFoot
      className="branch-menu-foot"
      end={
        prune && (
          <PruneWorktreesButton
            busy={contents.busy}
            empty={contents.management?.nothingToClean === true}
            onPrune={prune}
          />
        )
      }
    >
      {actions ?? (
        <>
          <CreateBranchButton pending={contents.pending?.kind === 'create'} disabled={disabled} onCreate={onCreate} />
          <NewWorktreeButton
            intent={contents.intent}
            pending={contents.pending?.kind === 'worktree'}
            disabled={disabled}
            unavailable={contents.worktreeUnavailable}
            onPick={contents.onPickWorktree}
          />
        </>
      )}
    </IslandPanelFoot>
  );
}

/** Keeps the foot on one line at any width: a label the line cannot hold
 *  gives way to its icon (the button's tooltip and name keep the words),
 *  Clean up's first, then the widest. */
function useOneLineFoot(panel: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const foot = panel.current?.querySelector<HTMLElement>('.branch-menu-foot');
    if (!foot) return undefined;
    const fit = () => {
      const buttons = Array.from(foot.querySelectorAll<HTMLElement>('button'));
      for (const button of buttons) delete button.dataset.iconOnly;
      if (foot.scrollWidth <= foot.clientWidth) return;
      const widths = new Map(buttons.map((button) => [button, button.offsetWidth]));
      const order = buttons.sort(
        (a, b) =>
          Number(b.dataset.kind === 'prune') - Number(a.dataset.kind === 'prune') ||
          (widths.get(b) ?? 0) - (widths.get(a) ?? 0)
      );
      for (const button of order) {
        if (foot.scrollWidth <= foot.clientWidth) break;
        button.dataset.iconOnly = '';
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(foot);
    return () => observer.disconnect();
  });
}

/** The New Task chip's popup: search · branches, then "New branch" ·
 *  "New worktree" · "Clean up". */
function BranchMenuPanel({
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
  // The menu is sized by its rows (up to 420px), wider than the 280px the
  // placement assumed: pull it back inside the visible viewport once measured.
  // biome-ignore lint/correctness/useExhaustiveDependencies: position is the trigger; the effect reads the DOM it produced
  useLayoutEffect(() => {
    clampOverlayIntoView(panel.current);
  }, [position, panel]);
  useOneLineFoot(panel);
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
      <BranchMenuFoot contents={contents} onCreate={onCreateBranch} />
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
  /** The header chip: the branch glyph and name. No header without it (a
   *  popup under a row that names the branch). */
  title?: ReactNode;
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
  useOneLineFoot(panel);
  return (
    <section
      ref={panel}
      id={panelId}
      className="composer-island-panel composer-island-branch-panel"
      aria-label={t('Branch and worktree')}
      data-locked={contents.locked || undefined}
      onKeyDown={(event) => moveMenuFocus(event, panel.current, onClose)}
    >
      {title && <IslandPanelHead chip={title} meta={meta} onClose={onClose} />}
      <div className="composer-island-pbody branch-menu-body">
        <BranchMenuContents
          {...contents}
          autoFocusSearch={!touchPrimaryPointer() && !worktreeActions}
          onCreateFromSearch={worktreeActions ? undefined : onCreateBranch}
        />
      </div>
      <BranchMenuFoot contents={contents} actions={worktreeActions} onCreate={onCreateBranch} />
    </section>
  );
}

/** The list is as tall as its rows. Before its rows are read it holds the
 *  height they had the last time it was open under `heightKey` (with none
 *  remembered, the stylesheet's loading height), so the rows land in the
 *  room they will take. While a search narrows it it keeps the height it had
 *  when the search began, so the panel (which grows up from the composer)
 *  never moves the search field under the caret. A row the pointer or focus
 *  is on stays put when rows arrive above it. */
function useStableMenuList(
  list: RefObject<HTMLDivElement | null>,
  rows: BranchRow[],
  query: string,
  heightKey: string,
  expanded: boolean,
  loading: boolean
) {
  // Searching or folding is the user's own change: it drops the row anchor.
  const shape = `${expanded ? '+' : '-'}${query}`;
  const seenShape = useRef(shape);
  const unfiltered = useRef(0);
  const held = useRef(0);
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
    if (seenShape.current !== shape) {
      seenShape.current = shape;
      anchor.current = null;
    } else if (anchor.current) {
      const { name, top } = anchor.current;
      const node = rowNodes().find((row) => row.dataset.branch === name);
      const shift = node ? node.getBoundingClientRect().top - top : 0;
      if (shift) element.scrollTop += shift;
    }
    if (query.trim()) {
      // Measured in the render before the first keystroke filtered the rows.
      held.current ||= unfiltered.current;
      element.style.height = held.current ? `${held.current}px` : '';
    } else {
      held.current = 0;
      element.style.height = '';
      const waiting = loading && rows.length === 0;
      const remembered = heightKey ? lastListHeights.get(heightKey) : undefined;
      element.style.minHeight = waiting && remembered ? `${remembered}px` : '';
      unfiltered.current = element.offsetHeight;
      if (heightKey && !waiting && !expanded) lastListHeights.set(heightKey, unfiltered.current);
    }
    track();
  }, [rows, shape, loading]);
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

/** What closes a row besides the current branch's check (`tag`: a plain
 *  branch's age, nothing else; the group label says a row is a worktree), and
 *  what is left to the tooltip and description (`detail`: the holding
 *  session's title, an unmanaged worktree's path, the project folder's). */
function rowEnd(row: BranchRow, hasWorktree: boolean, owner: string): { tag: string; detail: string } {
  if (row.mark === 'external') {
    return { tag: '', detail: row.path ? t('Checked out in an unmanaged worktree: {{path}}', { path: row.path }) : '' };
  }
  if (row.mark === 'project') return { tag: '', detail: t('Project folder') };
  if (hasWorktree) return { tag: '', detail: row.mark === 'current' ? '' : owner };
  if (row.mark !== '' || row.committedAt === undefined) return { tag: '', detail: '' };
  return { tag: branchAge(row.committedAt), detail: '' };
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
  // A holder whose title is not loaded is still named: another session, or this one's retained worktree.
  const owner = useSessionTitle(
    row.sessionId ?? '',
    row.mark === 'inUse' ? t('Another session') : t('Current session')
  );
  const { tag, detail } = rowEnd(row, hasWorktree, owner);
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
      // Held only by running work: the row stays readable and says why when pressed.
      data-locked={(locked && switches && !row.disabled && !busy) || undefined}
      aria-disabled={row.disabled || busy || (locked && switches) || undefined}
      title={detail || undefined}
      onClick={() => onPick(row)}
    >
      {pending && <ProgressSpinner size={16} aria-hidden="true" />}
      {!pending && hasWorktree && <FolderGit2 size={16} aria-hidden="true" />}
      {!pending && !hasWorktree && <GitBranch size={16} aria-hidden="true" />}
      <BranchName name={row.name} query={query} />
      {tag && <small>{tag}</small>}
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

/** The session panel's Branch popup: a body portal under its row and as wide
 *  as it, placed again as the window or the row changes. A press or a user
 *  scroll outside it (its row aside) closes it. "Inside" is its React tree,
 *  body-portalled row menus included (they mark the press on its way through
 *  React), and the dialogs it opens over itself. */
export function BranchTabHost({
  anchor,
  onClose,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const insidePresses = useRef(new WeakSet<Event>());
  const { style } = useAnchoredPlacement({
    anchor,
    panel: host,
    width: 'anchor',
    side: 'below',
    align: 'start',
  });
  useEffect(() => {
    const inside = (target: Node | null) =>
      Boolean(target && (host.current?.contains(target) || anchor.current?.contains(target))) || menuDialog(target);
    const onPointerDown = (event: PointerEvent) => {
      if (insidePresses.current.has(event)) return;
      if (inside(event.target instanceof Node ? event.target : null)) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown);
    const stopScroll = closeOnUserScroll(() => closeRef.current(), inside);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      stopScroll();
    };
  }, [anchor]);
  return createPortal(
    <div
      ref={host}
      className="branch-tab-host"
      style={style}
      onPointerDownCapture={(event) => insidePresses.current.add(event.nativeEvent)}
    >
      {children}
    </div>,
    document.body
  );
}

/** The New Task chip's whole menu: the panel (or the New branch name dialog
 *  in its place) and the uncommitted-files choice. Under the session panel's
 *  Branch row (`hosted`) the panel is that row's popup, as a session's is. */
export function BranchMenuLayer({
  visible,
  hosted = false,
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
  hosted?: boolean;
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
  const closeToTrigger = () => {
    close();
    trigger.current?.focus();
  };
  const contents = {
    management: actions.management,
    panelId,
    query,
    onQuery: setQuery,
    notice,
    intent,
    busy,
    worktreeUnavailable: actions.worktreeUnavailable,
    pending,
    base,
    rows,
    worktreeBound,
    onPickWorktree: () => void pickWorktree(),
    onPickRow: pickRow,
    onCreateBranch: () => startNewBranch({ actions, query, setNotice, setNamingBranch }),
  };
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
        ) : hosted ? (
          <BranchTabHost anchor={trigger} onClose={close}>
            <BranchIslandPanel {...contents} panel={panel} onClose={closeToTrigger} />
          </BranchTabHost>
        ) : (
          createPortal(
            <BranchMenuPanel {...contents} panel={panel} position={position} onEscape={closeToTrigger} />,
            document.body
          )
        ))}
      {carry && <WorktreeCarryDialog count={carry.count} paths={carry.paths} onChoose={carry.choose} />}
    </>
  );
}
