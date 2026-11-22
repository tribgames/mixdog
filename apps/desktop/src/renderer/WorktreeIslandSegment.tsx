import { FileDiff, GitBranch, GitFork, GitMerge, Trash2, TriangleAlert } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { DesktopMergeWorkspaceResult, DesktopSessionWorkspace } from '../shared/contract';
import {
  BranchIslandPanel,
  BranchNameDialog,
  clearBranchMenuCache,
  startNewBranch,
  useBranchMenuActions,
  useBranchMenuData,
  WorktreeCarryDialog,
} from './branch-menu';
import type { ComposerIslandFlash } from './ComposerIsland';
import { IslandSegmentPending, useComposerIslandTab } from './composer-island-state';
import { t } from './i18n';
import { registerIdleReclaim } from './idle-reclaim';
import { useIslandGitStatus } from './IslandGitSegment';
import { useMobileBack } from './mobile-back';
import { ProgressSpinner } from './ProgressSpinner';
import { RendererLruCache } from './renderer-lru-cache';
import { usePaneKey } from './pane-key-context';
import { prefetchSessionChanges } from './session-changes-store';
import { SettingsConfirmDialog } from './settings/capability-controls';
import type { SettingsConfirmation } from './settings/capability-data';
import {
  branchRows,
  invokeWorktree,
  projectFolderBranch,
  worktreeFailure,
  worktreeFailureText,
} from './worktree-branch-model';

/** A git checkout the segment can name. A project-folder workspace may carry
 *  its branch without repoCommonDir; a detached HEAD is told from "not a
 *  repository" by repoCommonDir alone. Outside a repository the workspace
 *  holds no git field at all (only a pending project move, say). */
function showsBranch(workspace: DesktopSessionWorkspace): boolean {
  return Boolean(
    workspace.branch || workspace.repoCommonDir || workspace.worktreeId || workspace.transition?.state === 'recovery'
  );
}

function branchPresentation(workspace: DesktopSessionWorkspace | null) {
  if (!workspace || !showsBranch(workspace)) return null;
  return {
    branch: workspace.branch ?? '',
    cwd: workspace.cwd,
    baseCommit: workspace.baseCommit?.slice(0, 7) ?? '',
    mergeTarget: workspace.mergeTarget ?? '',
    recovery: workspace.transition?.state === 'recovery',
    worktree: Boolean(workspace.worktreeId),
    // A menu action using the fallback must still reject a stale workspace.
    revision: workspace.revision,
  };
}

type BranchPresentation = NonNullable<ReturnType<typeof branchPresentation>>;

/** What a branch tab trigger carries, whichever host draws it. */
export type BranchTriggerProps = {
  ref: RefObject<HTMLButtonElement | null>;
  'aria-haspopup': 'dialog';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  'aria-busy': true | undefined;
  title: string;
  onPointerEnter(): void;
  onFocus(): void;
  onClick(): void;
};

/** Bridge a recent session's remount without holding its workspace DTO. */
const lastShownBranches = new RendererLruCache<string, BranchPresentation>({
  name: 'branch-presentation',
  maxEntries: 64,
  maxChars: 64 * 1024,
  measure: (view, id) =>
    id.length + view.branch.length + view.cwd.length + view.baseCommit.length + view.mergeTarget.length + 32,
});
registerIdleReclaim(() => lastShownBranches.clear());

/** For tests: forgets the branch presentation and menu caches. */
export function clearBranchSegmentCache(): void {
  lastShownBranches.clear();
  clearBranchMenuCache();
}

function branchTooltip({
  moving,
  recovery,
  worktree,
  target,
  detached,
  branch,
}: {
  moving: boolean;
  recovery: boolean;
  worktree: boolean;
  target: string;
  detached: boolean;
  branch: string;
}): string {
  if (moving) return t('Moving to the worktree…');
  if (recovery) return t('Worktree missing');
  if (worktree && target) return `${branch} · ${t('Branched from {{base}}', { base: target })}`;
  if (detached) return `${t('Detached HEAD')} · ${branch}`;
  return branch;
}

function segmentIcon(recovery: boolean, worktree: boolean) {
  if (recovery) return TriangleAlert;
  if (worktree) return GitFork;
  return GitBranch;
}

/** The short commit of a detached HEAD: the workspace's own, else git status'. */
function useDetachedCommit(workspace: BranchPresentation | null, detached: boolean): string {
  const [commit, setCommit] = useState('');
  const cwd = workspace?.cwd ?? '';
  const revision = workspace?.revision ?? 0;
  const own = workspace?.baseCommit ?? '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the re-read trigger
  useEffect(() => {
    setCommit('');
    if (!detached || own || !cwd) return undefined;
    let active = true;
    void Promise.resolve(window.mixdogDesktop?.gitStatus?.(cwd, { skipLineStats: true }))
      .then((status) => {
        const match = String(status?.branch ?? '').match(/\(([0-9a-f]{4,})\)/i);
        if (active && match) setCommit(match[1] ?? '');
      })
      .catch(() => {
        // The label falls back to HEAD.
      });
    return () => {
      active = false;
    };
  }, [cwd, detached, own, revision]);
  return (own || commit).slice(0, 7);
}

/** The session's own worktree: merge it into its target or remove it, each
 *  behind its confirmation; a refusal shows as a dialog, a merge as a flash.
 *  The island's branch tab and the session panel both ask through it. */
export function useWorktreeSessionActions({
  sessionId,
  onFlash,
}: {
  sessionId: string;
  onFlash?: (flash: ComposerIslandFlash, sessionId: string) => void;
}) {
  const [dialog, setDialog] = useState<SettingsConfirmation | null>(null);
  const [running, setRunning] = useState(false);
  const failed = (title: string, description: string) => setDialog({ title, description });
  const run = async (title: string, action: () => Promise<void>) => {
    setRunning(true);
    try {
      await action();
    } catch (reason) {
      failed(title, worktreeFailureText(worktreeFailure(reason)));
    } finally {
      setRunning(false);
    }
  };
  const merge = (branch: string, mergeInto: string, revision: number) =>
    run(t("Couldn't merge"), async () => {
      // Cleanup follows the worktree settings' automatic cleanup.
      const result = await invokeWorktree<DesktopMergeWorkspaceResult>(
        'mergeWorkspace',
        [{ confirmed: true, target: mergeInto, expectedRevision: revision, cleanup: true }],
        sessionId
      );
      if (!result.merged) {
        // The preflight found conflicts; nothing changed.
        failed(
          t("Couldn't merge"),
          worktreeFailureText({ code: 'MERGE_CONFLICT', message: '', details: { files: result.conflicts ?? [] } })
        );
        return;
      }
      // A refused cleanup never undoes the merge: it only keeps the worktree.
      const kept = result.cleanup?.removed === false;
      let text = result.upToDate
        ? t('Nothing to merge into {{target}}', { target: mergeInto })
        : t('Merged {{source}} into {{target}}', { source: branch, target: mergeInto });
      if (kept && !result.upToDate) {
        text = t('Merged {{source}} into {{target}}; the worktree was kept', { source: branch, target: mergeInto });
      }
      onFlash?.({ key: `worktree-merge:${result.commit ?? ''}:${revision}`, text }, sessionId);
    });
  const remove = (revision: number) =>
    run(t("Couldn't remove the worktree"), async () => {
      await invokeWorktree('removeWorktree', [{ expectedRevision: revision }], sessionId);
    });
  const askMerge = (branch: string, mergeInto: string, revision: number) =>
    setDialog({
      title: t('Merge {{source}} into {{target}}?', { source: branch, target: mergeInto }),
      description: t(
        'A merge commit joins the branches. The project folder must be on {{target}} with no uncommitted changes.',
        { target: mergeInto }
      ),
      confirmLabel: t('Merge'),
      onConfirm: () => merge(branch, mergeInto, revision),
    });
  const askRemove = (revision: number) =>
    setDialog({
      title: t('Remove this worktree?'),
      description: t('The session returns to the project folder. Uncommitted or unmerged work blocks the removal.'),
      confirmLabel: t('Remove'),
      danger: true,
      onConfirm: () => remove(revision),
    });
  return {
    running,
    dialogShown: Boolean(dialog),
    askMerge,
    askRemove,
    dialog: dialog && <SettingsConfirmDialog options={dialog} portal onClose={() => setDialog(null)} />,
  };
}

export function BranchIslandSegment({
  sessionId,
  workspace: live,
  projectPath = '',
  locked = false,
  onViewChanges,
  onFlash,
  renderTrigger,
}: {
  sessionId: string;
  /** The session's live workspace; no segment outside a git repository. */
  workspace: DesktopSessionWorkspace | null | undefined;
  /** The registered Project (the way out of a vanished worktree). */
  projectPath?: string;
  /** A turn, queued input, agents or shells are running: no switch may start. */
  locked?: boolean;
  /** Opens the session's changes (the files segment's own action). */
  onViewChanges?: () => void;
  /** A short island notice after a merge, for the session that merged (the
   *  segment's session when the merge started, whatever is shown by then). */
  onFlash?: (flash: ComposerIslandFlash, sessionId: string) => void;
  /** Another host's trigger for the same tab (the session panel's Branch
   *  row): `button` carries the segment's own wiring, `meta` the branch's
   *  status; the tab then opens under it. */
  renderTrigger?: (button: BranchTriggerProps, view: { branch: string; meta: string; pending: boolean }) => ReactNode;
}) {
  const { running, dialogShown: confirmShown, askMerge, askRemove, dialog } = useWorktreeSessionActions({
    sessionId,
    onFlash,
  });
  const [namingBranch, setNamingBranch] = useState(false);
  const [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [open, setOpen] = useComposerIslandTab('branch');
  const { menu, loading, notice, setNotice, load } = useBranchMenuData({
    draft: false,
    projectPath,
    sessionId,
    intentKey: sessionId,
    refreshKey: String(locked),
    eager: Boolean(sessionId) && (open || !(live && showsBranch(live))),
  });
  const current = live && showsBranch(live) ? live : (menu?.workspace ?? live ?? null);
  const presentation = useMemo(() => branchPresentation(current), [current]);
  // Bridged per session and project: after a move the old project's branch is gone.
  const shownKey = `${sessionId}\0${projectPath}`;
  const workspace = presentation ?? lastShownBranches.peek(shownKey) ?? null;
  useLayoutEffect(() => {
    if (!sessionId) return;
    if (presentation) lastShownBranches.set(shownKey, presentation);
    else lastShownBranches.get(shownKey);
  }, [sessionId, shownKey, presentation]);
  const recovery = workspace?.recovery ?? false;
  const worktree = workspace?.worktree ?? false;
  const shown = Boolean(sessionId && workspace);
  const detached = shown && !worktree && !recovery && !workspace?.branch;
  const commit = useDetachedCommit(workspace, detached);
  const panel = useRef<HTMLElement>(null);
  // The checkout's status beside the open tab's chip (the Git segment's own read).
  const gitStatus = useIslandGitStatus(open || renderTrigger ? (workspace?.cwd ?? '') : '');
  // Set when a close should hand focus back to the segment; the segment is
  // hidden while its tab is open, so focus moves once the tab has closed.
  const refocus = useRef(false);
  const close = () => {
    refocus.current = true;
    setOpen(false);
    setNamingBranch(false);
  };
  const reopen = () => setOpen(true);
  useMobileBack(open, close);
  // Hosted outside the island, the open tab closes on a press outside it.
  // "Inside" is the tab's React tree, its body-portalled row menus included:
  // they mark the press on its way through React, before it bubbles here.
  const hosted = Boolean(renderTrigger);
  const closeRef = useRef(close);
  closeRef.current = close;
  const insidePresses = useRef(new WeakSet<Event>());
  const markInside = (event: { nativeEvent: Event }) => insidePresses.current.add(event.nativeEvent);
  useEffect(() => {
    if (!open || !hosted) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (insidePresses.current.has(event)) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target && trigger.current?.contains(target)) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, hosted]);
  const actions = useBranchMenuActions({
    draft: false,
    intent: Boolean(menu?.pendingWorktree),
    intentKey: sessionId,
    sessionId,
    projectPath,
    menu,
    query,
    locked,
    menuOpen: open,
    load,
    setNotice,
    close,
    reopen,
    trigger,
  });

  // A chosen switch (or a merge/removal) is under way: the pending mark shows
  // at once; a move into a worktree also says so until the workspace switches.
  const moving = Boolean(actions.pending?.move);
  const pendingMark = Boolean(actions.pending) || running;

  // A segment that leaves (no git checkout any more) takes its open tab with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setOpen is rebuilt each render; shown is the trigger
  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);
  // A closed tab hands focus back to the segment, unless a dialog took it.
  const dialogShown = Boolean(confirmShown || actions.carry || namingBranch);
  // biome-ignore lint/correctness/useExhaustiveDependencies: open is the trigger; the rest is read at close time
  useEffect(() => {
    if (open) return;
    if (refocus.current && !dialogShown) trigger.current?.focus();
    refocus.current = false;
  }, [open]);

  // Opening a tab that offers View changes is the first sign Changes may open.
  const offersChanges = !recovery && Boolean(onViewChanges);
  const paneKey = usePaneKey();
  useEffect(() => {
    if (open && offersChanges) prefetchSessionChanges(sessionId, { paneKey });
  }, [open, offersChanges, sessionId, paneKey]);

  // Nothing read or cached for the session yet: the segment keeps its room.
  if (!shown || !workspace) return sessionId && loading ? <IslandSegmentPending kind="branch" /> : null;
  const branch = workspace.branch || (worktree ? t('Worktree') : commit || 'HEAD');
  const slash = worktree ? branch.lastIndexOf('/') : -1;
  const target = workspace.mergeTarget || '';
  // A worktree with no merge target of its own (an existing branch) merges
  // where every merge goes: the project folder's checked-out branch, sent as
  // the confirmed target so a switch meanwhile refuses.
  const mergeInto = target || projectFolderBranch(menu);

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    refocus.current = false;
    setNamingBranch(false);
    setQuery('');
    setNotice('');
    setOpen(true);
    void load();
  };

  type WorktreeAction = {
    id: string;
    label: string;
    icon: typeof FileDiff;
    danger?: boolean;
    /** Changes the workspace: unavailable while work runs. */
    switches?: boolean;
    /** Pressing or focusing the item signals intent to run it. */
    onIntent?(): void;
    onSelect(): void;
  };
  const items: WorktreeAction[] = [];
  if (worktree || recovery) {
    if (!recovery && onViewChanges) {
      items.push({
        id: 'view-changes',
        label: t('View changes'),
        icon: FileDiff,
        onIntent: () => prefetchSessionChanges(sessionId, { paneKey }),
        onSelect: () => {
          close();
          onViewChanges();
        },
      });
    }
    if (!recovery && mergeInto) {
      items.push({
        id: 'merge',
        label: t('Merge into {{value0}}', { value0: mergeInto }),
        icon: GitMerge,
        switches: true,
        onSelect: () => {
          close();
          askMerge(branch, mergeInto, workspace.revision);
        },
      });
    }
    items.push({
      id: 'remove',
      label: t('Remove worktree'),
      icon: Trash2,
      danger: true,
      switches: true,
      onSelect: () => {
        close();
        askRemove(workspace.revision);
      },
    });
  }
  const worktreeActions = items.length
    ? items.map(({ id, label, icon: Icon, danger, switches, onIntent, onSelect }) => {
        const unavailable = running || (switches && locked);
        return (
          <button
            key={id}
            type="button"
            className="composer-island-button"
            data-kind="action"
            data-action-id={id}
            data-danger={danger || undefined}
            aria-disabled={unavailable || undefined}
            onPointerDown={onIntent}
            onFocus={onIntent}
            onClick={() => {
              if (!unavailable) onSelect();
            }}
          >
            <Icon size={14} aria-hidden="true" />
            <span>{label}</span>
          </button>
        );
      })
    : undefined;

  // The segment never changes width while a move runs: the spinner replaces
  // the icon and the move is named in the tooltip and to assistive tech.
  const tooltip = branchTooltip({ moving, recovery, worktree, target, detached, branch });
  const SegmentIcon = segmentIcon(recovery, worktree);

  const label = recovery ? t('Worktree missing') : branch;
  const menuWorkspace = menu?.workspace ?? workspace;
  const base = menuWorkspace.mergeTarget || menuWorkspace.branch || '';
  const intent = Boolean(menu?.pendingWorktree);
  // Modified files and commits ahead; a zero count is left out, none at all shows nothing.
  const modified = gitStatus?.repository ? gitStatus.files.length + (gitStatus.untrackedOmitted ?? 0) : 0;
  const ahead = gitStatus?.repository ? gitStatus.ahead : 0;
  const metaParts: string[] = [];
  if (!intent && modified > 0) metaParts.push(t('Modified {{count}}', { count: modified }));
  if (!intent && ahead > 0) metaParts.push(`↑${ahead}`);
  const meta = metaParts.join(' · ');

  const triggerProps: BranchTriggerProps = {
    ref: trigger,
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'aria-controls': open ? panelId : undefined,
    'aria-busy': pendingMark || undefined,
    title: tooltip,
    onPointerEnter: () => void load(),
    onFocus: () => {
      if (!open) void load();
    },
    onClick: toggle,
  };
  const segment = renderTrigger ? (
    renderTrigger(triggerProps, { branch: label, meta, pending: pendingMark })
  ) : (
    <button
      {...triggerProps}
      type="button"
      className={`composer-island-seg composer-island-seg-branch${worktree ? ' composer-island-seg-worktree' : ''}${recovery ? ' composer-island-seg-warning' : ''}`}
      aria-label={moving ? `${branch} — ${tooltip}` : undefined}
    >
      {pendingMark ? (
          <ProgressSpinner size={14} aria-hidden="true" />
        ) : (
          <SegmentIcon size={14} className="composer-island-seg-icon" aria-hidden="true" />
        )}
        <span className="composer-island-seg-text">
          <span className="composer-island-seg-label">
            {recovery ? (
              t('Worktree missing')
            ) : (
              <>
                {slash > 0 && <span className="composer-island-seg-prefix">{branch.slice(0, slash + 1)}</span>}
                {branch.slice(slash + 1)}
              </>
            )}
          </span>
        </span>
        {!recovery && worktree && target && <span className="composer-island-seg-sub">{target}</span>}
      </button>
  );

  const tab = open && (menu || loading) && (
        <BranchIslandPanel
          management={actions.management}
          panel={panel}
          panelId={panelId}
          heightKey={sessionId}
          title={
            intent ? (
              <>
                <GitFork size={14} className="composer-island-seg-icon" aria-hidden="true" />
                <span className="composer-island-branch-tab-name">{t('{{base}} → New worktree', { base })}</span>
              </>
            ) : (
              <>
                <SegmentIcon size={14} className="composer-island-seg-icon" aria-hidden="true" />
                <span className="composer-island-branch-tab-name">{label}</span>
              </>
            )
          }
          meta={meta}
          query={query}
          onQuery={setQuery}
          notice={notice}
          intent={intent}
          busy={actions.busy}
          worktreeUnavailable={actions.worktreeUnavailable}
          pending={actions.pending}
          loading={!menu}
          locked={locked}
          base={base}
          rows={menu ? branchRows(menu, sessionId, query) : []}
          worktreeBound={menu ? Boolean(menu.workspace.worktreeId) : worktree}
          worktreeActions={worktreeActions}
          onPickWorktree={() => void actions.pickWorktree()}
          onPickRow={actions.pickRow}
          onCreateBranch={() =>
            startNewBranch({
              actions,
              query,
              locked,
              setNotice,
              // The name dialog takes the tab's place: the island collapses under it.
              setNamingBranch: (naming) => {
                setNamingBranch(naming);
                if (naming) setOpen(false);
              },
            })
          }
          onClose={close}
        />
      );

  return (
    <>
      {segment}
      {hosted && tab ? (
        <div className="branch-tab-host" onPointerDownCapture={markInside}>
          {tab}
        </div>
      ) : (
        tab
      )}
      {namingBranch && (
        <BranchNameDialog
          panelId={panelId}
          anchor={trigger}
          name={query}
          onName={setQuery}
          busy={actions.busy}
          notice={notice}
          onCreate={actions.createBranch}
          onClose={close}
        />
      )}
      {actions.carry && (
        <WorktreeCarryDialog count={actions.carry.count} paths={actions.carry.paths} onChoose={actions.carry.choose} />
      )}
      {dialog}
    </>
  );
}
