// The composer's branch chip: the THIRD context chip (after project and
// workflow) in a New Task, and the only context chip mid-session. Its menu is
// always the same: search · "Worktree" · branches · "New branch" (the shared
// branch-menu, also opened by the composer island's branch segment).
import { ChevronDown, GitBranch, GitFork, TriangleAlert } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import { BranchMenuLayer, useBranchMenuActions, useBranchMenuData, useBranchMenuOverlay } from './branch-menu';
import { t } from './i18n';
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { ProgressSpinner } from './ProgressSpinner';
import { branchChipState, branchRows, getBranchIntent, useWorktreeIntent } from './worktree-branch-model';

export function BranchChip({
  sessionId,
  draftId = '',
  projectPath,
  disabled = false,
  refreshKey = '',
}: {
  /** The pane's session; '' for a New Task draft. */
  sessionId: string;
  draftId?: string;
  projectPath: string;
  disabled?: boolean;
  /** Changes whenever the session may have moved (turn start/end): re-reads the menu. */
  refreshKey?: string;
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
  const { open, setOpen, visible, close, reopen, position, setPosition, measure, root, panel } = useBranchMenuOverlay(
    disabled,
    namingBranch
  );
  const [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const clickGuard = useImmediateOverlayClickGuard();
  const panelId = useId();
  const actions = useBranchMenuActions({
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
    reopen,
    trigger,
  });

  const toggle = () => {
    if (open) {
      commitImmediateOverlay(close);
      return;
    }
    const next = measure();
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
  const label = recovery ? t('Worktree missing') : (draft ? getBranchIntent(intentKey)?.branch : null) || state.label;
  return (
    <div
      className="composer-branch-context"
      ref={(node) => {
        root.current = node;
      }}
      data-state={state.kind}
      data-recovery={recovery || undefined}
    >
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
        <ChipIcon recovery={recovery} forked={forked} pending={Boolean(actions.pending)} />
        <span className="branch-chip-label">{label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      <BranchMenuLayer
        visible={visible}
        namingBranch={namingBranch}
        setNamingBranch={setNamingBranch}
        panelId={panelId}
        trigger={trigger}
        panel={panel}
        position={position}
        query={query}
        setQuery={setQuery}
        notice={notice}
        setNotice={setNotice}
        intent={intent}
        base={base}
        rows={rows}
        worktreeBound={Boolean(workspace.worktreeId)}
        actions={actions}
        close={close}
      />
    </div>
  );
}

function ChipIcon({ recovery, forked, pending }: { recovery: boolean; forked: boolean; pending: boolean }) {
  if (pending) return <ProgressSpinner size={14} aria-hidden="true" />;
  if (recovery) return <TriangleAlert size={14} aria-hidden="true" />;
  if (forked) return <GitFork size={14} className="branch-chip-fork" aria-hidden="true" />;
  return <GitBranch size={14} aria-hidden="true" />;
}
