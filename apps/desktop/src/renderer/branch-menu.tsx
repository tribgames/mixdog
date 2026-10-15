// The branch menu shared by the New Task branch chip and the composer
// island's branch segment: search · "Worktree" · branches · "New branch", in
// one theme. Its data, placement, actions and dialogs live here; each host
// owns only its trigger.
import { GitBranch, GitFork, Plus, X } from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type { DesktopBranchMenu } from '../shared/contract';
import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { containDialogTab, PaneDialogLayer } from './sidebar-dialog';
import { useSurfaceActive } from './surface-activity';
import { touchPrimaryPointer } from './surface-input-focus';
import { acquireTitleBarDim } from './titlebar-dim';
import {
  type BranchRow,
  branchMenuPosition,
  invokeWorktree,
  largeRepoPrompt,
  setWorktreeIntent,
  worktreeFailure,
  worktreeFailureText,
} from './worktree-branch-model';

const defaultApplied = new Set<string>();

export type CarryChoice = 'leave' | 'carry';

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
  const [menu, setMenu] = useState<DesktopBranchMenu | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [notice, setNotice] = useState('');
  const loadId = useRef(0);

  // A draft has no session: the Project's own menu (real occupancy of the
  // project folder) from the runtime, never a client-side guess.
  const projectMenu = useCallback(
    () => invokeWorktree<DesktopBranchMenu>('getProjectBranchMenu', [{ projectPath }]),
    [projectPath]
  );
  const load = useCallback(async () => {
    const id = ++loadId.current;
    try {
      let next: DesktopBranchMenu | null = null;
      if (!draft) next = await invokeWorktree<DesktopBranchMenu>('getBranchMenu', [], sessionId);
      else if (projectPath) next = await projectMenu();
      if (id !== loadId.current) return;
      setMenu(next);
      setRecovery(next?.workspace.transition.state === 'recovery');
    } catch (reason) {
      if (id !== loadId.current) return;
      const failure = worktreeFailure(reason);
      // A vanished worktree still offers the project's branches as the way out.
      if (failure.code === 'WORKTREE_MISSING' && projectPath) {
        const next = await projectMenu().catch(() => null);
        // A later load owns the menu, whichever way this fallback ended.
        if (id !== loadId.current) return;
        setMenu(next);
        setRecovery(true);
        setNotice(worktreeFailureText(failure));
        return;
      }
      setMenu(null);
    }
  }, [draft, projectMenu, projectPath, sessionId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the deliberate re-read trigger
  useEffect(() => {
    if (eager) void load();
  }, [eager, load, refreshKey]);
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

  return { menu, recovery, notice, setNotice, load };
}

/** Open state and placement of the portal menu: it follows resize and
 *  scroll, and closes on an outside pointer, mobile back, a surface switch
 *  or when the host is disabled. While `modal` (a dialog over the menu) the
 *  dialog owns dismissal. */
export function useBranchMenuOverlay(
  disabled: boolean,
  modal: boolean,
  position: (anchor: HTMLElement) => CSSProperties = branchMenuPosition
) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties>({});
  const root = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const surfaceActive = useSurfaceActive();
  const visible = open && surfaceActive;
  const positionRef = useRef(position);
  positionRef.current = position;

  const place = useCallback(() => {
    if (root.current) setPlacement(positionRef.current(root.current));
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
      if (target instanceof Element && target.closest('.worktree-carry-dialog, .settings-confirm-layer')) return;
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
  const measure = () => (root.current ? positionRef.current(root.current) : {});
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
  onOpenSession,
}: {
  draft: boolean;
  intent: boolean;
  intentKey: string;
  sessionId: string;
  projectPath: string;
  menu: DesktopBranchMenu | null;
  query: string;
  locked?: boolean;
  load(): Promise<void>;
  setNotice(notice: string): void;
  close(): void;
  /** Opens the menu again so a refusal after the uncommitted-files choice
   *  (which closed it) shows as its notice. */
  reopen(): void;
  trigger: RefObject<HTMLElement | null>;
  onOpenSession(sessionId: string): void;
}) {
  const [busy, setBusy] = useState(false);
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
    { checkout = false }: { checkout?: boolean } = {}
  ): Promise<boolean> => {
    setBusy(true);
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
            if (!window.confirm(largeRepoPrompt(failure))) return false;
            extra = { ...extra, confirmLarge: true };
            continue;
          }
          if (failure.code === 'WORKTREE_DIRTY_CHOICE' && !extra.carryChanges) {
            const paths = Array.isArray(failure.details.paths) ? failure.details.paths.map(String) : [];
            const count = Number(failure.details.count) || paths.length;
            // The choice is a dialog of its own, like the confirm popups: the
            // menu closes first so nothing of it is drawn over the dialog.
            close();
            const choice = await new Promise<CarryChoice | null>((resolve) => setCarry({ count, paths, resolve }));
            setCarry(null);
            if (!choice) return false;
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
    const ok = await perform((extra) =>
      invokeWorktree('requestWorktree', [{ expectedRevision: revision, provision: true, ...extra }], sessionId)
    );
    await finish(ok);
  };
  // A draft switches the project folder through the runtime's guarded path
  // (repository lock, active-session and no-carry checks), like a session does.
  const selectBranch = async (branch: string, create: boolean) => {
    const createFlag = create ? { create: true } : {};
    const ok = await perform(
      (extra) =>
        draft
          ? invokeWorktree('selectProjectBranch', [{ projectPath, branch, ...createFlag }])
          : invokeWorktree(
              'selectBranch',
              [{ branch, ...createFlag, expectedRevision: revision, ...extra }],
              sessionId
            ),
      { checkout: true }
    );
    if (ok && draft) setWorktreeIntent(intentKey, false);
    await finish(ok);
  };
  const pickRow = (row: BranchRow) => {
    if (busy || row.disabled) return;
    if (row.mark === 'inUse' && row.sessionId) {
      close();
      onOpenSession(row.sessionId);
      return;
    }
    if (row.mark === 'current' && !intent) {
      close();
      return;
    }
    if (locked) return;
    if (row.retained) {
      void pickWorktree();
      return;
    }
    void selectBranch(row.name, false);
  };
  const createBranch = () => {
    if (busy || locked) return;
    const name = query.trim();
    if (name) void selectBranch(name, true);
  };

  return {
    busy,
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
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onChoose(null);
      }}
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
          <button ref={leaveRef} type="button" className="primary" data-choice="leave" onClick={() => onChoose('leave')}>
            {t('Leave changes and move')}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}

/** The opened menu: search · "Worktree" · branches · "New branch". With
 *  `worktreeActions` (a session in its worktree) those actions lead, then a
 *  rule, the search and the branches. While `locked`, a notice leads and no
 *  switch can start. */
export function BranchMenuPanel({
  panel,
  panelId,
  position,
  query,
  onQuery,
  notice,
  intent,
  busy,
  locked = false,
  base,
  rows,
  worktreeBound,
  worktreeActions,
  onPickWorktree,
  onPickRow,
  onCreateBranch,
  onEscape,
}: {
  panel: RefObject<HTMLDivElement | null>;
  panelId: string;
  position: CSSProperties;
  query: string;
  onQuery(query: string): void;
  notice: string;
  intent: boolean;
  busy: boolean;
  locked?: boolean;
  base: string;
  rows: BranchRow[];
  worktreeBound: boolean;
  worktreeActions?: ReactNode;
  onPickWorktree(): void;
  onPickRow(row: BranchRow): void;
  onCreateBranch(): void;
  onEscape(): void;
}) {
  const switchDisabled = busy || locked;
  return (
    <div
      ref={panel}
      id={panelId}
      className="branch-menu"
      role="dialog"
      aria-label={t('Branch and worktree')}
      data-locked={locked || undefined}
      style={position}
      onKeyDown={(event) => moveMenuFocus(event, panel.current, onEscape)}
    >
      {locked && (
        <p className="branch-menu-notice" data-kind="locked" role="status">
          {t("Branches and worktrees can't be changed while work is running.")}
        </p>
      )}
      {worktreeActions && (
        <>
          <div className="branch-menu-actions">{worktreeActions}</div>
          <hr className="branch-menu-rule" />
        </>
      )}
      <input
        type="search"
        className="branch-menu-search"
        value={query}
        // biome-ignore lint/a11y/noAutofocus: the search field is the point of the opened menu; touch devices are excluded
        autoFocus={!touchPrimaryPointer() && !worktreeActions}
        aria-label={t('Search branches')}
        placeholder={t('Search branches')}
        onChange={(event) => onQuery(event.currentTarget.value)}
      />
      {notice && (
        <p className="branch-menu-notice" role="alert">
          {notice}
        </p>
      )}
      <div className="branch-menu-list">
        {!worktreeActions && (
          <button
            type="button"
            className="branch-menu-item"
            data-kind="worktree"
            data-selected={intent || undefined}
            aria-disabled={switchDisabled || undefined}
            onClick={onPickWorktree}
          >
            <GitFork size={14} className={intent ? 'branch-chip-fork' : undefined} aria-hidden="true" />
            <span>{t('Worktree')}</span>
            <small>{intent && base ? t('New branch from {{base}}', { base }) : t('New branch · separate folder')}</small>
          </button>
        )}
        <h3 className="branch-menu-label">{t('Branch')}</h3>
        {rows.map((row) => (
          <BranchMenuRow
            key={row.name}
            row={row}
            intent={intent}
            busy={busy}
            locked={locked}
            worktreeBound={worktreeBound}
            onPick={onPickRow}
          />
        ))}
        {rows.length === 0 && <p className="branch-menu-empty">{t('No matching branches.')}</p>}
      </div>
      {!worktreeActions && (
        <>
          <hr className="branch-menu-rule" />
          <button
            type="button"
            className="branch-menu-item"
            data-kind="create"
            aria-disabled={switchDisabled || undefined}
            onClick={onCreateBranch}
          >
            <Plus size={14} aria-hidden="true" />
            <span>{t('New branch')}</span>
          </button>
        </>
      )}
    </div>
  );
}

/** Menu keyboard: Escape closes, the arrow keys cycle through the search
 *  field and the enabled items. */
function moveMenuFocus(event: React.KeyboardEvent, panel: HTMLDivElement | null, onEscape: () => void) {
  if (event.key === 'Escape') {
    event.preventDefault();
    onEscape();
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const stops = Array.from(
    panel?.querySelectorAll<HTMLElement>('input, .branch-menu-item:not([aria-disabled="true"])') ?? []
  );
  const index = stops.indexOf(document.activeElement as HTMLElement);
  const next = stops[(index + (event.key === 'ArrowDown' ? 1 : -1) + stops.length) % stops.length];
  event.preventDefault();
  next?.focus();
}

function rowTooltip(row: BranchRow): string | undefined {
  if (row.mark === 'inUse') return t('Open the session that uses this branch');
  if (row.mark === 'external') return t('Checked out in an external worktree: {{path}}', { path: row.path ?? '' });
  return undefined;
}

function markLabel(mark: BranchRow['mark']): string {
  if (mark === 'current') return t('Current');
  if (mark === 'inUse') return t('In use');
  if (mark === 'project') return t('Project folder');
  return t('External');
}

function BranchMenuRow({
  row,
  intent,
  busy,
  locked,
  worktreeBound,
  onPick,
}: {
  row: BranchRow;
  intent: boolean;
  busy: boolean;
  locked: boolean;
  worktreeBound: boolean;
  onPick(row: BranchRow): void;
}) {
  const tooltip = rowTooltip(row);
  const bound = row.mark === 'current' && worktreeBound;
  // Opening the session that holds a branch, or the current row, switches nothing.
  const switches = row.mark !== 'inUse' && !(row.mark === 'current' && !intent);
  return (
    <button
      type="button"
      className="branch-menu-item"
      data-kind="branch"
      data-mark={row.mark || undefined}
      data-selected={(row.mark === 'current' && !intent) || undefined}
      aria-disabled={row.disabled || busy || (locked && switches) || undefined}
      aria-description={tooltip}
      data-tooltip={tooltip}
      data-tooltip-side={tooltip ? 'right' : undefined}
      onClick={() => onPick(row)}
    >
      {bound ? (
        <GitFork size={14} className="branch-chip-fork" aria-hidden="true" />
      ) : (
        <GitBranch size={14} aria-hidden="true" />
      )}
      <span>{row.name}</span>
      {row.mark && <small>{markLabel(row.mark)}</small>}
    </button>
  );
}

/** One host's whole menu: the panel (or the New branch name dialog in its
 *  place) and the uncommitted-files choice. */
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
  locked,
  base,
  rows,
  worktreeBound,
  worktreeActions,
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
  locked?: boolean;
  base: string;
  rows: BranchRow[];
  worktreeBound: boolean;
  worktreeActions?: ReactNode;
  actions: ReturnType<typeof useBranchMenuActions>;
  close(): void;
}) {
  const { busy, pickWorktree, pickRow, createBranch, carry } = actions;
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
              panel={panel}
              panelId={panelId}
              position={position}
              query={query}
              onQuery={setQuery}
              notice={notice}
              intent={intent}
              busy={busy}
              locked={locked}
              base={base}
              rows={rows}
              worktreeBound={worktreeBound}
              worktreeActions={worktreeActions}
              onPickWorktree={() => void pickWorktree()}
              onPickRow={pickRow}
              onCreateBranch={() => {
                if (busy || locked) return;
                if (query.trim()) createBranch();
                else {
                  setNotice('');
                  setNamingBranch(true);
                }
              }}
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
