import { Check, ChevronDown, GitBranch, GitMerge, Plus } from 'lucide-react';
import type { CSSProperties, HTMLAttributes, RefObject } from 'react';
import { createPortal } from 'react-dom';

import { useMobileBack } from './mobile-back';
import { t } from './i18n';

import type { DesktopBranchOccupancy, DesktopGitBranch, DesktopGitStatus } from '../shared/contract';
import { commitImmediateOverlay } from './immediate-overlay';
import { touchPrimaryPointer } from './surface-input-focus';
import { actionTitle, type ScmContextMenuItem } from './ScmContextMenu';
import { operationInProgressReason } from './source-control-actions';

interface BranchCapabilities {
  list: boolean;
  create: boolean;
  checkout: boolean;
  rename: boolean;
  delete: boolean;
  merge: boolean;
}

interface PointerClickGuard {
  markPointerActivation(): void;
  consumePointerClick(): boolean;
  clearPointerActivation(): void;
}

function deleteBlockedReason(branch: DesktopGitBranch): string | undefined {
  if (branch.current) return t('The checked-out branch cannot be deleted');
  if (branch.remote) return t('A remote branch cannot be deleted from here');
  return undefined;
}

export function SourceControlBranchPicker({
  status,
  busy,
  open,
  query,
  loading,
  visibleBranches,
  defaultBranch,
  otherBranches,
  mergeMode,
  occupancy,
  capabilities,
  rootRef,
  triggerRef,
  panelRef,
  panelStyle,
  clickGuard,
  rowContextMenu,
  missingChannel,
  guarded,
  onOpen,
  onClose,
  onQueryChange,
  onCreate,
  onCheckout,
  onRename,
  onDelete,
  onMerge,
  onToggleMergeMode,
  onOpenSession,
}: {
  status: DesktopGitStatus;
  busy: string;
  open: boolean;
  query: string;
  loading: boolean;
  visibleBranches: DesktopGitBranch[];
  defaultBranch: DesktopGitBranch | null | undefined;
  otherBranches: DesktopGitBranch[];
  mergeMode: boolean;
  /** Who holds each local branch outside this folder (worktree sessions). */
  occupancy: ReadonlyMap<string, DesktopBranchOccupancy>;
  capabilities: BranchCapabilities;
  rootRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  panelStyle: CSSProperties;
  clickGuard: PointerClickGuard;
  rowContextMenu(label: string, items: () => ScmContextMenuItem[]): HTMLAttributes<HTMLDivElement>;
  missingChannel(label: string): string;
  guarded(action: () => void): void;
  onOpen(): void;
  onClose(): void;
  onQueryChange(value: string): void;
  onCreate(): void;
  onCheckout(branch: DesktopGitBranch): void;
  onRename(branch: DesktopGitBranch): void;
  onDelete(branch: DesktopGitBranch): void;
  onMerge(branch: DesktopGitBranch): void;
  onToggleMergeMode(): void;
  /** Opens the Mixdog session that holds a branch. */
  onOpenSession?(sessionId: string): void;
}) {
  // ABB: the open branch panel owns hardware back.
  useMobileBack(open, onClose);
  const operationReason = operationInProgressReason(status);
  // A branch another Mixdog session holds is not checked out here: the click
  // goes to that session. An external worktree's branch cannot be checked out.
  const checkoutOrOpen = (branch: DesktopGitBranch) => {
    const held = branch.remote ? undefined : occupancy.get(branch.name);
    if (held?.kind === 'session' && held.sessionId && onOpenSession) {
      onClose();
      onOpenSession(held.sessionId);
      return;
    }
    onCheckout(branch);
  };
  const branchMenuItems = (branch: DesktopGitBranch): ScmContextMenuItem[] => [
    {
      id: 'checkout',
      label: t('Checkout'),
      disabled:
        Boolean(busy) ||
        branch.current ||
        Boolean(status.operation) ||
        !capabilities.checkout ||
        (!branch.remote && occupancy.get(branch.name)?.kind === 'external'),
      title: actionTitle(
        branch.current ? t('This branch is already checked out') : operationReason,
        capabilities.checkout,
        () => missingChannel(t('Checkout'))
      ),
      onSelect: () => guarded(() => checkoutOrOpen(branch)),
    },
    {
      id: 'rename',
      label: t('Rename…'),
      disabled: Boolean(busy) || branch.remote || !capabilities.rename,
      title: actionTitle(
        branch.remote ? t('A remote branch cannot be renamed from here') : undefined,
        capabilities.rename,
        () => missingChannel(t('Renaming a branch'))
      ),
      onSelect: () => guarded(() => onRename(branch)),
    },
    {
      id: 'delete',
      label: t('Delete…'),
      danger: true,
      disabled: Boolean(busy) || branch.remote || branch.current || !capabilities.delete,
      title: actionTitle(deleteBlockedReason(branch), capabilities.delete, () =>
        missingChannel(t('Deleting a branch'))
      ),
      onSelect: () => guarded(() => onDelete(branch)),
    },
    {
      id: 'merge',
      label: t('Merge into {{value0}}', { value0: status.branch }),
      separatorBefore: true,
      disabled:
        Boolean(busy) ||
        branch.current ||
        Boolean(status.operation) ||
        !capabilities.merge ||
        !status.branch ||
        status.detached,
      title: actionTitle(operationReason, capabilities.merge, () => missingChannel(t('Merging a branch'))),
      onSelect: () => guarded(() => onMerge(branch)),
    },
  ];
  return (
    <div className="dock-scm-toolbar-section dock-scm-toolbar-branch" ref={rootRef}>
      <button
        type="button"
        className="dock-scm-branch-button"
        aria-haspopup="dialog"
        ref={triggerRef}
        aria-expanded={open}
        disabled={!capabilities.list}
        title={status.upstreamName || status.branch}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          clickGuard.markPointerActivation();
          commitImmediateOverlay(open ? onClose : onOpen);
        }}
        onClick={(event) => {
          if (clickGuard.consumePointerClick()) return;
          if (event.detail !== 0) return;
          commitImmediateOverlay(open ? onClose : onOpen);
        }}
        onPointerCancel={clickGuard.clearPointerActivation}
      >
        <GitBranch size={14} aria-hidden="true" />
        <span>{status.detached ? 'Detached HEAD' : status.branch || 'No branch'}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            className="dock-scm-branch-picker"
            role="dialog"
            aria-label={t('Git branches')}
            ref={panelRef}
            style={panelStyle}
          >
            <header>
              {/* Touch devices browse the list first; autofocus would raise the
            software keyboard over it. */}
              <input
                type="search"
                value={query}
                // biome-ignore lint/a11y/noAutofocus: the filter box is the point of the opened picker; touch devices are excluded
                autoFocus={!touchPrimaryPointer()}
                aria-label={t('Filter branches')}
                placeholder={t('Filter')}
                onInput={(event) => onQueryChange(event.currentTarget.value)}
              />
              <button
                type="button"
                className="dock-scm-branch-new"
                disabled={Boolean(busy) || !capabilities.create || Boolean(status.operation)}
                title={operationReason || undefined}
                onClick={onCreate}
              >
                <Plus size={12} aria-hidden="true" />
                <span>{t('New branch')}</span>
              </button>
            </header>
            <div className="dock-scm-branch-list">
              {loading && <p>{t('Loading branches…')}</p>}
              {!loading && visibleBranches.length === 0 && <p>{t('No matching branches.')}</p>}
              {(
                [
                  [t('Default branch'), defaultBranch ? [defaultBranch] : []],
                  [t('Other branches'), otherBranches],
                ] as Array<[string, DesktopGitBranch[]]>
              ).map(
                ([label, rows]) =>
                  rows.length > 0 && (
                    <section key={label}>
                      <h3>{label}</h3>
                      {rows.map((branch) => {
                        const held = branch.remote ? undefined : occupancy.get(branch.name);
                        const holder = held?.kind === 'session' && held.sessionId ? held.sessionId : '';
                        const external = held?.kind === 'external';
                        let rowTitle = operationReason || branch.name;
                        if (external) {
                          rowTitle = t('Checked out in an external worktree: {{path}}', { path: held?.path ?? '' });
                        } else if (holder) rowTitle = t('Open the session that uses this branch');
                        return (
                          <div
                            className="dock-scm-branch-row"
                            data-current={branch.current || undefined}
                            data-occupancy={holder ? 'session' : external ? 'external' : undefined}
                            key={`${branch.remote}:${branch.name}`}
                            {...rowContextMenu(t('Actions for branch {{value0}}', { value0: branch.name }), () =>
                              branchMenuItems(branch)
                            )}
                          >
                            <button
                              type="button"
                              className="dock-scm-branch-main"
                              disabled={
                                Boolean(busy) || branch.current || Boolean(status.operation) || (external && !mergeMode)
                              }
                              title={rowTitle}
                              onClick={() => {
                                if (mergeMode) onMerge(branch);
                                else checkoutOrOpen(branch);
                              }}
                            >
                              {branch.current ? (
                                <Check size={14} aria-hidden="true" />
                              ) : (
                                <GitBranch size={14} aria-hidden="true" />
                              )}
                              <span>{branch.name}</span>
                              {holder || external ? (
                                <small className="dock-scm-branch-mark">{holder ? t('In use') : t('External')}</small>
                              ) : (
                                (branch.lastCommitRelative || (!branch.remote && branch.upstream)) && (
                                  <small>{branch.lastCommitRelative || branch.upstream}</small>
                                )
                              )}
                            </button>
                            {!branch.remote && (
                              <>
                                <button
                                  type="button"
                                  className="dock-scm-branch-action"
                                  aria-label={t('Rename branch {{value0}}', { value0: branch.name })}
                                  disabled={Boolean(busy)}
                                  onClick={() => onRename(branch)}
                                >
                                  {t('Rename')}
                                </button>
                                {!branch.current && (
                                  <button
                                    type="button"
                                    className="dock-scm-branch-action danger"
                                    aria-label={t('Delete branch {{value0}}', { value0: branch.name })}
                                    disabled={Boolean(busy)}
                                    onClick={() => onDelete(branch)}
                                  >
                                    {t('Delete')}
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </section>
                  )
              )}
            </div>
            {status.branch && !status.detached && (
              <button
                type="button"
                className="dock-scm-merge-row"
                aria-pressed={mergeMode}
                disabled={Boolean(busy) || !capabilities.merge || Boolean(status.operation)}
                title={operationReason || t('Choose a branch to merge into {{branch}}', { branch: status.branch })}
                onClick={onToggleMergeMode}
              >
                <GitMerge size={14} aria-hidden="true" />
                <span>
                  {t('Choose a branch to merge into')} <strong>{status.branch}</strong>
                </span>
              </button>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
