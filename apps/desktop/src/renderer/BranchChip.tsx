// The composer's branch chip: the THIRD context chip (after project and
// workflow) in a New Task, and the only context chip mid-session. Its menu is
// always the same: search · "Worktree" · branches · "New branch".
import { ChevronDown, GitBranch, GitFork, Plus, TriangleAlert } from 'lucide-react';
import { type CSSProperties, type RefObject, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopBranchMenu } from '../shared/contract';
import { t } from './i18n';
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { useMobileBack } from './mobile-back';
import { containDialogTab, PaneDialogLayer } from './sidebar-dialog';
import { useSurfaceActive } from './surface-activity';
import { touchPrimaryPointer } from './surface-input-focus';
import {
  type BranchRow,
  branchChipState,
  branchMenuPosition,
  branchRows,
  invokeWorktree,
  largeRepoPrompt,
  setWorktreeIntent,
  useWorktreeIntent,
  worktreeFailure,
  worktreeFailureText,
} from './worktree-branch-model';

const defaultApplied = new Set<string>();

export function BranchChip({
  sessionId,
  draftId = '',
  projectPath,
  disabled = false,
  refreshKey = '',
  onOpenSession,
}: {
  /** The pane's session; '' for a New Task draft. */
  sessionId: string;
  draftId?: string;
  projectPath: string;
  disabled?: boolean;
  /** Changes whenever the session may have moved (turn start/end): re-reads the menu. */
  refreshKey?: string;
  /** Navigates to the Mixdog session that holds a branch. */
  onOpenSession(sessionId: string): void;
}) {
  const draft = !sessionId;
  // Only a draft keeps a client-side "Worktree" choice (lazy creation at its
  // first send). A session's state is always its backend menu: a bound
  // worktree, or a pending choice the runtime holds for the next send.
  const intentKey = draftId || 'default';
  const draftIntent = useWorktreeIntent(intentKey);
  const { menu, recovery, notice, setNotice, load } = useBranchMenuData({
    draft,
    projectPath,
    sessionId,
    intentKey,
    refreshKey,
  });
  const intent = draft ? draftIntent : Boolean(menu?.pendingWorktree);
  const [namingBranch, setNamingBranch] = useState(false);
  const { open, setOpen, visible, close, position, setPosition, root, panel } = useBranchMenuOverlay(disabled, namingBranch);
  const [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const clickGuard = useImmediateOverlayClickGuard();
  const panelId = useId();
  const { busy, pickWorktree, pickRow, createBranch } = useBranchChipActions({
    draft,
    intent,
    intentKey,
    sessionId,
    projectPath,
    menu,
    query,
    load,
    setNotice,
    close,
    trigger,
    onOpenSession,
  });

  const toggle = () => {
    if (open) {
      commitImmediateOverlay(close);
      return;
    }
    const next = root.current ? branchMenuPosition(root.current) : {};
    commitImmediateOverlay(() => {
      setPosition(next);
      setNamingBranch(false);
      setQuery('');
      setNotice('');
      setOpen(true);
    });
    void load();
  };

  if (!menu) return null;
  const workspace = menu.workspace;
  const state = branchChipState(workspace, intent);
  const rows = branchRows(menu, sessionId, query);
  const base = workspace.mergeTarget || workspace.branch || '';
  const forked = state.kind !== 'branch';
  const label = recovery ? t('Worktree missing') : state.label;
  return (
    <div className="composer-branch-context" ref={root} data-state={state.kind} data-recovery={recovery || undefined}>
      <button
        type="button"
        ref={trigger}
        className="branch-chip-trigger"
        aria-haspopup="dialog"
        aria-expanded={visible}
        aria-controls={visible ? panelId : undefined}
        aria-label={t('Branch and worktree')}
        data-tooltip={t('Select branch')}
        data-tooltip-side="top"
        disabled={disabled}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          clickGuard.markPointerActivation();
          toggle();
        }}
        onClick={(event) => {
          if (clickGuard.consumePointerClick()) return;
          if (event.detail !== 0) return;
          toggle();
        }}
        onPointerCancel={clickGuard.clearPointerActivation}
      >
        <ChipIcon recovery={recovery} forked={forked} />
        <span className="branch-chip-label">{label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {visible && (namingBranch ? (
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
      ) : createPortal(
          <BranchMenuPanel
            panel={panel}
            panelId={panelId}
            position={position}
            query={query}
            onQuery={setQuery}
            notice={notice}
            intent={intent}
            busy={busy}
            base={base}
            rows={rows}
            worktreeBound={Boolean(workspace.worktreeId)}
            onPickWorktree={() => void pickWorktree()}
            onPickRow={pickRow}
            onCreateBranch={() => {
              if (busy) return;
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
        ))}
    </div>
  );
}

/** The chip's menu data: the session's branch menu, or a draft's Project
 *  menu, re-read whenever `refreshKey` changes, plus the recovery state of a
 *  vanished worktree and the menu notice. */
function useBranchMenuData({
  draft,
  projectPath,
  sessionId,
  intentKey,
  refreshKey,
}: {
  draft: boolean;
  projectPath: string;
  sessionId: string;
  intentKey: string;
  refreshKey: string;
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
    void load();
  }, [load, refreshKey]);
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
 *  or when the chip is disabled. */
function useBranchMenuOverlay(disabled: boolean, namingBranch: boolean) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const surfaceActive = useSurfaceActive();
  const visible = open && surfaceActive;

  const place = useCallback(() => {
    if (root.current) setPosition(branchMenuPosition(root.current));
  }, []);
  const close = useCallback(() => setOpen(false), []);
  useMobileBack(visible && !namingBranch, close);
  useEffect(() => {
    if (!surfaceActive && open) setOpen(false);
  }, [open, surfaceActive]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!visible) return undefined;
    const outside = (event: PointerEvent) => {
      // The modal layer owns dismissal while a name is being entered.
      if (namingBranch) return;
      const target = event.target as Node | null;
      if (root.current?.contains(target) || panel.current?.contains(target)) return;
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
  }, [namingBranch, place, visible]);

  return { open, setOpen, visible, close, position, setPosition, root, panel };
}

/** The menu's actions: "Worktree", a branch row and "New branch", each one
 *  runtime transition whose failure becomes the menu notice. */
function useBranchChipActions({
  draft,
  intent,
  intentKey,
  sessionId,
  projectPath,
  menu,
  query,
  load,
  setNotice,
  close,
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
  load(): Promise<void>;
  setNotice(notice: string): void;
  close(): void;
  trigger: RefObject<HTMLButtonElement | null>;
  onOpenSession(sessionId: string): void;
}) {
  const [busy, setBusy] = useState(false);

  /** One transition: asks once more with `confirmLarge` after the user OKs
   *  the large-repository prompt; every other failure becomes the menu notice. */
  const perform = async (
    call: (extra: { confirmLarge?: true }) => Promise<unknown>,
    { checkout = false }: { checkout?: boolean } = {}
  ): Promise<boolean> => {
    setBusy(true);
    setNotice('');
    try {
      try {
        await call({});
      } catch (reason) {
        const failure = worktreeFailure(reason);
        if (failure.code !== 'WORKTREE_LARGE_REPO_CONFIRM') throw reason;
        if (!window.confirm(largeRepoPrompt(failure))) return false;
        await call({ confirmLarge: true });
      }
      return true;
    } catch (reason) {
      const failure = worktreeFailure(reason);
      setNotice(worktreeFailureText(failure, { checkout }));
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
    if (!menu || busy) return;
    if (draft) {
      setWorktreeIntent(intentKey, !intent);
      close();
      return;
    }
    if (menu.workspace.worktreeId || intent) {
      close();
      return;
    }
    const ok = await perform((extra) =>
      invokeWorktree('requestWorktree', [{ expectedRevision: revision, ...extra }], sessionId)
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
    if (row.retained) {
      void pickWorktree();
      return;
    }
    void selectBranch(row.name, false);
  };
  const createBranch = () => {
    if (busy) return;
    const name = query.trim();
    if (name) void selectBranch(name, true);
  };

  return { busy, pickWorktree, pickRow, createBranch };
}

function ChipIcon({ recovery, forked }: { recovery: boolean; forked: boolean }) {
  if (recovery) return <TriangleAlert size={14} aria-hidden="true" />;
  if (forked) return <GitFork size={14} className="branch-chip-fork" aria-hidden="true" />;
  return <GitBranch size={14} aria-hidden="true" />;
}

/** Electron cannot show window.prompt; keep the original name/confirm/cancel flow in an app dialog. */
function BranchNameDialog({
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
  anchor: RefObject<HTMLButtonElement | null>;
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

/** The opened menu: search · "Worktree" · branches · "New branch". */
function BranchMenuPanel({
  panel,
  panelId,
  position,
  query,
  onQuery,
  notice,
  intent,
  busy,
  base,
  rows,
  worktreeBound,
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
  base: string;
  rows: BranchRow[];
  worktreeBound: boolean;
  onPickWorktree(): void;
  onPickRow(row: BranchRow): void;
  onCreateBranch(): void;
  onEscape(): void;
}) {
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
      <input
        type="search"
        className="branch-menu-search"
        value={query}
        // biome-ignore lint/a11y/noAutofocus: the search field is the point of the opened menu; touch devices are excluded
        autoFocus={!touchPrimaryPointer()}
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
        <button
          type="button"
          className="branch-menu-item"
          data-kind="worktree"
          data-selected={intent || undefined}
          aria-disabled={busy || undefined}
          onClick={onPickWorktree}
        >
          <GitFork size={14} className={intent ? 'branch-chip-fork' : undefined} aria-hidden="true" />
          <span>{t('Worktree')}</span>
          <small>{intent && base ? t('New branch from {{base}}', { base }) : t('New branch · separate folder')}</small>
        </button>
        <h3 className="branch-menu-label">{t('Branch')}</h3>
        {rows.map((row) => (
          <BranchMenuRow
            key={row.name}
            row={row}
            intent={intent}
            busy={busy}
            worktreeBound={worktreeBound}
            onPick={onPickRow}
          />
        ))}
        {rows.length === 0 && <p className="branch-menu-empty">{t('No matching branches.')}</p>}
      </div>
      <hr className="branch-menu-rule" />
      <button
        type="button"
        className="branch-menu-item"
        data-kind="create"
        aria-disabled={busy || undefined}
        onClick={onCreateBranch}
      >
        <Plus size={14} aria-hidden="true" />
        <span>{t('New branch')}</span>
      </button>
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
  return t('External');
}

function BranchMenuRow({
  row,
  intent,
  busy,
  worktreeBound,
  onPick,
}: {
  row: BranchRow;
  intent: boolean;
  busy: boolean;
  worktreeBound: boolean;
  onPick(row: BranchRow): void;
}) {
  const tooltip = rowTooltip(row);
  const bound = row.mark === 'current' && worktreeBound;
  return (
    <button
      type="button"
      className="branch-menu-item"
      data-kind="branch"
      data-mark={row.mark || undefined}
      data-selected={(row.mark === 'current' && !intent) || undefined}
      aria-disabled={row.disabled || busy || undefined}
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
