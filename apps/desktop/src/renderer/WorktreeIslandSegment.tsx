// The composer island's branch segment, first of the pill's git group: shown
// for every session whose workspace is a git checkout. In the project folder
// it names the branch (or the short commit of a detached HEAD); in a managed
// worktree the worktree branch with its prefix and base muted. Pressing it
// expands the island into its branch tab, the same menu as the New Task chip
// (branch-menu) in the island's panel grammar; in a worktree the tab's footer
// holds View changes · Merge into <base> · Remove worktree, whose runs and
// refusals go through the shared confirm popup. While work runs the tab still
// opens, but nothing in it can switch.
import { FileDiff, GitBranch, GitFork, GitMerge, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

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
import { useIslandGitStatus } from './IslandGitSegment';
import { useMobileBack } from './mobile-back';
import { ProgressSpinner } from './ProgressSpinner';
import { SettingsConfirmDialog } from './settings/capability-controls';
import type { SettingsConfirmation } from './settings/capability-data';
import { branchRows, invokeWorktree, worktreeFailure, worktreeFailureText } from './worktree-branch-model';

/** A git checkout the segment can name. A project-folder workspace may carry
 *  its branch without repoCommonDir; a detached HEAD is told from "not a
 *  repository" by repoCommonDir alone. */
function showsBranch(workspace: DesktopSessionWorkspace): boolean {
  return Boolean(
    workspace.branch || workspace.repoCommonDir || workspace.worktreeId || workspace.transition.state === 'recovery'
  );
}

/** The last workspace each session showed a branch for. Module-level, so the
 *  island (remounted per session switch) names the branch on its first paint
 *  instead of leaving the pill without it until the workspace is read again. */
const lastShownWorkspaces = new Map<string, DesktopSessionWorkspace>();

/** For tests: forgets every cached workspace and branch menu. */
export function clearBranchSegmentCache(): void {
  lastShownWorkspaces.clear();
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
function useDetachedCommit(workspace: DesktopSessionWorkspace | null | undefined, detached: boolean): string {
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

export function BranchIslandSegment({
  sessionId,
  workspace: live,
  projectPath = '',
  locked = false,
  onViewChanges,
  onFlash,
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
}) {
  const [dialog, setDialog] = useState<SettingsConfirmation | null>(null);
  const [running, setRunning] = useState(false);
  const [namingBranch, setNamingBranch] = useState(false);
  const [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  // A session that never left its project folder publishes no workspace in
  // its snapshot: its branch menu's workspace stands in, re-read whenever
  // the session's work settles.
  // The island owns the open tab (one at a time).
  const [open, setOpen] = useComposerIslandTab('branch');
  const { menu, loading, notice, setNotice, load } = useBranchMenuData({
    draft: false,
    projectPath,
    sessionId,
    intentKey: sessionId,
    refreshKey: String(locked),
    // The menu is large (a phone pulls it over the relay), so a snapshot that
    // already names the branch reads it only when it is used: on hover or
    // focus of the segment, or when the tab opens, and then it follows the
    // session's work (refreshKey) while the tab stays open. Only a stub
    // snapshot needs it at once, for the workspace the segment is drawn from.
    eager: Boolean(sessionId) && (open || !(live && showsBranch(live))),
  });
  // While a move is pending or refused, the snapshot's workspace and the menu
  // re-read can both be momentarily absent (and so can they right after a
  // session switch): the segment keeps the session's last shown workspace
  // instead of leaving a gap in the pill.
  // A stub snapshot workspace (no branch, repository or worktree) stands aside
  // for the menu's.
  const current = live && showsBranch(live) ? live : (menu?.workspace ?? live ?? null);
  if (sessionId && current && showsBranch(current)) lastShownWorkspaces.set(sessionId, current);
  const workspace = current && showsBranch(current) ? current : (lastShownWorkspaces.get(sessionId) ?? current);
  const recovery = workspace?.transition.state === 'recovery';
  const worktree = Boolean(workspace?.worktreeId);
  const shown = Boolean(sessionId && workspace && showsBranch(workspace));
  const detached = shown && !worktree && !recovery && !workspace?.branch;
  const commit = useDetachedCommit(workspace, detached);
  const panel = useRef<HTMLElement>(null);
  // The checkout's status beside the open tab's chip (the Git segment's own read).
  const gitStatus = useIslandGitStatus(open ? (workspace?.cwd ?? '') : '');
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
  const actions = useBranchMenuActions({
    draft: false,
    intent: Boolean(menu?.pendingWorktree),
    intentKey: sessionId,
    sessionId,
    projectPath,
    menu,
    query,
    locked,
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
  const dialogShown = Boolean(dialog || actions.carry || namingBranch);
  // biome-ignore lint/correctness/useExhaustiveDependencies: open is the trigger; the rest is read at close time
  useEffect(() => {
    if (open) return;
    if (refocus.current && !dialogShown) trigger.current?.focus();
    refocus.current = false;
  }, [open]);

  // Nothing read or cached for the session yet: the segment keeps its room.
  if (!shown || !workspace) return sessionId && loading ? <IslandSegmentPending kind="branch" /> : null;
  const branch = workspace.branch || (worktree ? t('Worktree') : commit || 'HEAD');
  const slash = worktree ? branch.lastIndexOf('/') : -1;
  const target = workspace.mergeTarget || '';

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
  const merge = () =>
    run(t("Couldn't merge"), async () => {
      // Cleanup follows the worktree settings' automatic cleanup.
      const result = await invokeWorktree<DesktopMergeWorkspaceResult>(
        'mergeWorkspace',
        [{ confirmed: true, target, expectedRevision: workspace.revision, cleanup: true }],
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
        ? t('Nothing to merge into {{target}}', { target })
        : t('Merged {{source}} into {{target}}', { source: branch, target });
      if (kept && !result.upToDate) {
        text = t('Merged {{source}} into {{target}}; the worktree was kept', { source: branch, target });
      }
      onFlash?.({ key: `worktree-merge:${result.commit ?? ''}:${workspace.revision}`, text }, sessionId);
    });
  const remove = () =>
    run(t("Couldn't remove the worktree"), async () => {
      await invokeWorktree('removeWorktree', [{ expectedRevision: workspace.revision }], sessionId);
    });

  type WorktreeAction = {
    id: string;
    label: string;
    icon: typeof FileDiff;
    danger?: boolean;
    /** Changes the workspace: unavailable while work runs. */
    switches?: boolean;
    onSelect(): void;
  };
  const items: WorktreeAction[] = [];
  if (worktree || recovery) {
    if (!recovery && onViewChanges) {
      items.push({
        id: 'view-changes',
        label: t('View changes'),
        icon: FileDiff,
        onSelect: () => {
          close();
          onViewChanges();
        },
      });
    }
    if (!recovery && target) {
      items.push({
        id: 'merge',
        label: t('Merge into {{value0}}', { value0: target }),
        icon: GitMerge,
        switches: true,
        onSelect: () => {
          close();
          setDialog({
            title: t('Merge {{source}} into {{target}}?', { source: branch, target }),
            description: t(
              'A merge commit joins the branches. The project folder must be on {{target}} with no uncommitted changes.',
              { target }
            ),
            confirmLabel: t('Merge'),
            // Cleanup follows the worktree settings' automatic cleanup.
            onConfirm: merge,
          });
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
        setDialog({
          title: t('Remove this worktree?'),
          description: t('The session returns to the project folder. Uncommitted or unmerged work blocks the removal.'),
          confirmLabel: t('Remove'),
          danger: true,
          onConfirm: remove,
        });
      },
    });
  }
  const worktreeActions = items.length
    ? items.map(({ id, label, icon: Icon, danger, switches, onSelect }) => {
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
  const modified = gitStatus?.repository ? gitStatus.files.length : 0;
  const ahead = gitStatus?.repository ? gitStatus.ahead : 0;
  const meta = intent
    ? ''
    : [modified > 0 ? t('Modified {{count}}', { count: modified }) : '', ahead > 0 ? `↑${ahead}` : '']
        .filter(Boolean)
        .join(' · ');

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`composer-island-seg composer-island-seg-branch${worktree ? ' composer-island-seg-worktree' : ''}${recovery ? ' composer-island-seg-warning' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-busy={pendingMark || undefined}
        aria-label={moving ? `${branch} — ${tooltip}` : undefined}
        title={tooltip}
        onPointerEnter={() => void load()}
        onFocus={() => {
          if (!open) void load();
        }}
        onClick={toggle}
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
      {open && (menu || loading) && (
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
          pending={actions.pending}
          loading={!menu}
          locked={locked}
          base={base}
          rows={menu ? branchRows(menu, sessionId, query) : []}
          worktreeBound={Boolean(menuWorkspace.worktreeId)}
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
      {dialog && <SettingsConfirmDialog options={dialog} portal onClose={() => setDialog(null)} />}
    </>
  );
}
