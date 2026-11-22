import { ChevronDown, GitBranch, GitFork, TriangleAlert } from 'lucide-react';
import {
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useId,
  useRef,
  useState,
} from 'react';

import { BranchMenuLayer, useBranchMenuActions, useBranchMenuData, useBranchMenuOverlay } from './branch-menu';
import { t } from './i18n';
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { ProgressSpinner } from './ProgressSpinner';
import { branchChipState, branchRows, getBranchIntent, useWorktreeIntent } from './worktree-branch-model';

export type BranchChipProps = {
  /** The pane's session; '' for a New Task draft. */
  sessionId: string;
  draftId?: string;
  projectPath: string;
  disabled?: boolean;
  /** Changes whenever the session may have moved (turn start/end): re-reads the menu. */
  refreshKey?: string;
};

export function BranchChip({
  sessionId,
  draftId = '',
  projectPath,
  disabled = false,
  refreshKey = '',
  renderTrigger,
}: BranchChipProps & {
  /** Another host's trigger (the session panel's Branch row): `button`
   *  carries the chip's own wiring; the menu opens from it. */
  renderTrigger?: (
    button: ComponentProps<'button'> & { ref: RefObject<HTMLButtonElement | null> },
    view: { label: string; icon: (className?: string) => ReactNode; toggle: () => void }
  ) => ReactNode;
}) {
  const draft = !sessionId;
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
    menuOpen: open,
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
  const draftBranch = draft ? getBranchIntent(intentKey)?.branch : null;
  const label = recovery ? t('Worktree missing') : draftBranch || state.label;
  const button = {
    ref: trigger,
    'aria-haspopup': 'dialog' as const,
    'aria-expanded': visible,
    'aria-controls': visible ? panelId : undefined,
    'aria-label': t('Branch and worktree'),
    disabled,
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      clickGuard.markPointerActivation();
      toggle();
    },
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (clickGuard.consumePointerClick()) return;
      if (event.detail !== 0) return;
      toggle();
    },
    onPointerCancel: clickGuard.clearPointerActivation,
  };
  const icon = (className?: string) => (
    <ChipIcon recovery={recovery} forked={forked} pending={Boolean(actions.pending)} className={className} />
  );
  return (
    <div
      className={renderTrigger ? 'session-rail-branch' : 'composer-branch-context'}
      ref={(node) => {
        root.current = node;
      }}
      data-state={state.kind}
      data-recovery={recovery || undefined}
    >
      {renderTrigger ? (
        renderTrigger(button, { label, icon, toggle })
      ) : (
        <button
          type="button"
          {...button}
          className="branch-chip-trigger"
          data-tooltip={t('Select branch')}
          data-tooltip-side="top"
        >
          {icon()}
          <span className="branch-chip-label">{label}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      )}
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

function ChipIcon({
  recovery,
  forked,
  pending,
  className,
}: {
  recovery: boolean;
  forked: boolean;
  pending: boolean;
  className?: string;
}) {
  if (pending) return <ProgressSpinner size={14} className={className} aria-hidden="true" />;
  if (recovery) return <TriangleAlert size={14} className={className} aria-hidden="true" />;
  if (forked)
    return <GitFork size={14} className={className ? `${className} branch-chip-fork` : 'branch-chip-fork'} aria-hidden="true" />;
  return <GitBranch size={14} className={className} aria-hidden="true" />;
}
