import {
  Check,
  ChevronDown,
  GitBranch,
  GitMerge,
  Plus,
} from "lucide-react";
import type {
  CSSProperties,
  HTMLAttributes,
  RefObject,
} from "react";
import { createPortal } from "react-dom";

import type { DesktopGitBranch, DesktopGitStatus } from "../shared/contract";
import { commitImmediateOverlay } from "./immediate-overlay";
import { touchPrimaryPointer } from "./surface-input-focus";
import type { ScmContextMenuItem } from "./ScmContextMenu";

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
  capabilities: BranchCapabilities;
  rootRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  panelStyle: CSSProperties;
  clickGuard: PointerClickGuard;
  rowContextMenu(
    label: string,
    items: () => ScmContextMenuItem[],
  ): HTMLAttributes<HTMLDivElement>;
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
}) {
  const operationReason = status.operation
    ? `Finish the in-progress ${status.operation.replace("-", " ")} first`
    : "";
  return <div className="dock-scm-toolbar-section dock-scm-toolbar-branch" ref={rootRef}>
    <button type="button" className="dock-scm-branch-button" aria-haspopup="dialog"
      ref={triggerRef}
      aria-expanded={open} disabled={!capabilities.list}
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
      onPointerCancel={clickGuard.clearPointerActivation}>
      <GitBranch size={14} aria-hidden="true" />
      <span>{status.detached ? "Detached HEAD" : status.branch || "No branch"}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && createPortal(<div className="dock-scm-branch-picker" role="dialog"
      aria-label="Git branches" ref={panelRef} style={panelStyle}>
      <header>
        {/* Touch devices browse the list first; autofocus would raise the
            software keyboard over it. */}
        <input type="search" value={query} autoFocus={!touchPrimaryPointer()}
          aria-label="Filter branches"
          placeholder="Filter"
          onInput={(event) => onQueryChange(event.currentTarget.value)} />
        <button type="button" className="dock-scm-branch-new"
          disabled={Boolean(busy) || !capabilities.create || Boolean(status.operation)}
          title={operationReason || undefined}
          onClick={onCreate}>
          <Plus size={12} aria-hidden="true" />
          <span>New branch</span>
        </button>
      </header>
      <div className="dock-scm-branch-list">
        {loading && <p>Loading branches…</p>}
        {!loading && visibleBranches.length === 0 && <p>No matching branches.</p>}
        {([
          ["Default branch", defaultBranch ? [defaultBranch] : []],
          ["Other branches", otherBranches],
        ] as Array<[string, DesktopGitBranch[]]>)
          .map(([label, rows]) => rows.length > 0 && <section key={label}>
          <h3>{label}</h3>
          {rows.map((branch) => <div className="dock-scm-branch-row"
            data-current={branch.current || undefined} key={`${branch.remote}:${branch.name}`}
            {...rowContextMenu(`Actions for branch ${branch.name}`, () => [
              {
                id: "checkout",
                label: "Checkout",
                disabled: Boolean(busy) || branch.current || Boolean(status.operation)
                  || !capabilities.checkout,
                title: branch.current
                  ? "This branch is already checked out"
                  : operationReason
                    || (capabilities.checkout ? undefined : missingChannel("Checkout")),
                onSelect: () => guarded(() => onCheckout(branch)),
              },
              {
                id: "rename",
                label: "Rename…",
                disabled: Boolean(busy) || branch.remote || !capabilities.rename,
                title: branch.remote
                  ? "A remote branch cannot be renamed from here"
                  : capabilities.rename ? undefined : missingChannel("Renaming a branch"),
                onSelect: () => guarded(() => onRename(branch)),
              },
              {
                id: "delete",
                label: "Delete…",
                danger: true,
                disabled: Boolean(busy) || branch.remote || branch.current
                  || !capabilities.delete,
                title: branch.current
                  ? "The checked-out branch cannot be deleted"
                  : branch.remote
                    ? "A remote branch cannot be deleted from here"
                    : capabilities.delete ? undefined : missingChannel("Deleting a branch"),
                onSelect: () => guarded(() => onDelete(branch)),
              },
              {
                id: "merge",
                label: `Merge into ${status.branch}`,
                separatorBefore: true,
                disabled: Boolean(busy) || branch.current || Boolean(status.operation)
                  || !capabilities.merge || !status.branch || status.detached,
                title: operationReason
                  || (capabilities.merge ? undefined : missingChannel("Merging a branch")),
                onSelect: () => guarded(() => onMerge(branch)),
              },
            ])}>
            <button type="button" className="dock-scm-branch-main"
              disabled={Boolean(busy) || branch.current || Boolean(status.operation)}
              title={operationReason || branch.name}
              onClick={() => mergeMode ? onMerge(branch) : onCheckout(branch)}>
              {branch.current
                ? <Check size={14} aria-hidden="true" />
                : <GitBranch size={14} aria-hidden="true" />}
              <span>{branch.name}</span>
              {(branch.lastCommitRelative || (!branch.remote && branch.upstream)) &&
                <small>{branch.lastCommitRelative || branch.upstream}</small>}
            </button>
            {!branch.remote && <>
              <button type="button" className="dock-scm-branch-action"
                aria-label={`Rename branch ${branch.name}`} disabled={Boolean(busy)}
                onClick={() => onRename(branch)}>Rename</button>
              {!branch.current && <button type="button" className="dock-scm-branch-action danger"
                aria-label={`Delete branch ${branch.name}`} disabled={Boolean(busy)}
                onClick={() => onDelete(branch)}>Delete</button>}
            </>}
          </div>)}
        </section>)}
      </div>
      {status.branch && !status.detached && <button type="button" className="dock-scm-merge-row"
        aria-pressed={mergeMode}
        disabled={Boolean(busy) || !capabilities.merge || Boolean(status.operation)}
        title={operationReason || `Choose a branch to merge into ${status.branch}`}
        onClick={onToggleMergeMode}>
        <GitMerge size={14} aria-hidden="true" />
        <span>Choose a branch to merge into <strong>{status.branch}</strong></span>
      </button>}
    </div>, document.body)}
  </div>;
}
