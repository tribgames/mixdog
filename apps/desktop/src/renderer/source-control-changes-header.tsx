// Toolbar and header pieces of the dock's Changes view: the Push/Fetch
// buttons with their ahead/behind badges, the in-progress operation banner,
// and the select-all row that is also the list's action header.
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ArrowUpDown, Check, Minus, Undo2 } from 'lucide-react';
import type React from 'react';
import { useRef } from 'react';
import type { DesktopGitFile } from '../shared/contract';
import { t } from './i18n';
import { useImmediateOverlayClickGuard } from './immediate-overlay';
import { ProgressSpinner } from './ProgressSpinner';
import { elementMenuPoint, type ScmContextMenuItem } from './ScmContextMenu';
import type { sourceControlRemoteActions } from './source-control-remote-actions';
import type { MenuPoint } from './source-control-history-list';

type RemoteEntry = ReturnType<typeof sourceControlRemoteActions>['pushEntry'];

// Each count rides the action that CLEARS it: ahead on Push (user: 푸쉬
// 우상단에 태그), behind on Fetch. Split that way every corner carries ONE
// count, so a diverged branch (↑11 ↓32) never has to fit a pair into a
// section that is a THIRD of a 252px/300px dock.
export function RemoteActionButtons({
  entries,
  aheadCount,
  behindCount,
  hasUpstream,
  busy,
  operation,
}: {
  entries: RemoteEntry[];
  aheadCount: number;
  behindCount: number;
  hasUpstream: boolean;
  busy: string;
  operation: string | undefined;
}) {
  return (
    <>
      {entries.map((entry) => {
        const count = entry.key === 'push' ? aheadCount : behindCount;
        const direction = entry.key === 'push' ? 'ahead' : 'behind';
        const badged = hasUpstream && count > 0;
        return (
          <div key={entry.key} className={`dock-scm-toolbar-section dock-scm-toolbar-${entry.key}`}>
            <button
              type="button"
              className="dock-scm-remote-button"
              data-remote-action={entry.key}
              title={badged ? `${entry.reason || entry.label} (${count} ${direction})` : entry.reason || entry.label}
              aria-label={entry.label}
              disabled={Boolean(busy) || Boolean(operation) || entry.blocked}
              onClick={entry.perform}
            >
              {busy === entry.runKey ? <ProgressSpinner size={14} aria-hidden="true" /> : entry.icon}
              <span className="dock-scm-remote-label">
                <span className="dock-scm-remote-verb">{entry.verb}</span>
                {entry.target ? <span className="dock-scm-remote-target">{` ${entry.target}`}</span> : null}
              </span>
            </button>
            {/* The button clips its own content, so the badge is the SECTION's
                child and overlaps the corner from OUTSIDE that clip. It keeps
                its direction arrow even though it sits on the matching button:
                a bare number on a hovered button would read as part of it. A
                three-digit count would stretch the badge across its own
                button's label, so it caps instead. */}
            {badged && (
              <span className="dock-scm-ahead-behind" data-i18n-skip data-direction={direction} aria-hidden="true">
                {entry.key === 'push' ? (
                  <ArrowUp size={8} aria-hidden="true" />
                ) : (
                  <ArrowDown size={8} aria-hidden="true" />
                )}
                {count > 99 ? '99+' : count}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

export function OperationBanner({
  operation,
  conflictCount,
  busy,
  onContinue,
  onAbort,
}: {
  operation: string;
  conflictCount: number;
  busy: string;
  onContinue: () => void;
  onAbort: () => void;
}) {
  const label = operation.replace('-', ' ');
  return (
    <div className="dock-scm-operation" role="status">
      <div>
        <b>{t('{{operation}} in progress', { operation: label })}</b>
        <small>
          {conflictCount ? t('{{count}} unresolved conflicts', { count: conflictCount }) : t('All conflicts resolved')}
        </small>
      </div>
      <button type="button" disabled={Boolean(busy) || conflictCount > 0} onClick={onContinue}>
        {t('Continue')}
      </button>
      <button
        type="button"
        disabled={Boolean(busy)}
        onClick={() => {
          if (!window.confirm(t('Abort the {{operation}} operation?', { operation: label }))) return;
          onAbort();
        }}
      >
        {t('Abort')}
      </button>
    </div>
  );
}

export type SortKey = 'path' | 'name' | 'status';

// ONE flat changed-files list leaves ordering as the only view choice (the
// deleted menu's View & Sort group).
export function viewSortMenuItems(sortKey: string, chooseSortKey: (key: SortKey) => void): ScmContextMenuItem[] {
  return [
    { id: 'sort-path', label: 'Sort by Path', checked: sortKey === 'path', onSelect: () => chooseSortKey('path') },
    { id: 'sort-name', label: 'Sort by Name', checked: sortKey === 'name', onSelect: () => chooseSortKey('name') },
    {
      id: 'sort-status',
      label: 'Sort by Status',
      checked: sortKey === 'status',
      onSelect: () => chooseSortKey('status'),
    },
  ];
}

function IconAction({
  label,
  title = label,
  className,
  disabled,
  onClick,
  children,
}: {
  label: string;
  title?: string;
  className?: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={title}
      data-tooltip={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// Tri-state select-all row; the shared filter box lives in the view controls
// above Changes | History. The row is also the list's ACTION header: Stage
// Stage All, Unstage All and Discard All sit here with Stash / Pop Stash and
// View & Sort beside them. It is a plain row (not a
// <label>) so those buttons cannot toggle the checkbox by label activation;
// the checkbox keeps the same accessible name it always had. No visible count
// line: the Changes tab above already carries the counter.
export function ChangedFilesHeader({
  files,
  busy,
  includedVisible,
  includableVisible,
  checkAllLabel,
  stashReason,
  popStashReason,
  viewSortOpen,
  onSetAllIncluded,
  onDiscardAll,
  onStash,
  onPopStash,
  onToggleViewSort,
}: {
  files: DesktopGitFile[];
  busy: string;
  includedVisible: number;
  includableVisible: number;
  checkAllLabel: string;
  stashReason: string;
  popStashReason: string;
  viewSortOpen: boolean;
  onSetAllIncluded: (included: boolean, files?: DesktopGitFile[]) => void;
  onDiscardAll: () => void;
  onStash: () => void;
  onPopStash: () => void;
  onToggleViewSort: (point: MenuPoint) => void;
}) {
  const viewSortMenuPoint = useRef<MenuPoint | null>(null);
  const viewSortClickGuard = useImmediateOverlayClickGuard();
  const rememberPoint = (event: React.SyntheticEvent<HTMLButtonElement>) => {
    viewSortMenuPoint.current = elementMenuPoint(event.currentTarget);
  };
  const disabled = Boolean(busy) || files.length === 0;
  return (
    <div className="dock-scm-list-header">
      <div className="dock-scm-check-all">
        <input
          type="checkbox"
          checked={includableVisible > 0 && includedVisible === includableVisible}
          disabled={files.length === 0 || Boolean(busy)}
          // Tri-state: partially included lists render mixed, exactly like
          // the reference's CheckboxValue.Mixed.
          ref={(node) => {
            if (node) node.indeterminate = includedVisible > 0 && includedVisible < includableVisible;
          }}
          aria-label={checkAllLabel}
          title={checkAllLabel}
          onChange={(event) => onSetAllIncluded(event.currentTarget.checked)}
        />
        <span className="dock-scm-list-actions">
          <IconAction label={t('Stage All')} disabled={disabled} onClick={() => onSetAllIncluded(true, files)}>
            <Check size={14} aria-hidden="true" />
          </IconAction>
          <IconAction label={t('Unstage All')} disabled={disabled} onClick={() => onSetAllIncluded(false, files)}>
            <Minus size={14} aria-hidden="true" />
          </IconAction>
          <IconAction label={t('Discard All')} className="danger" disabled={disabled} onClick={onDiscardAll}>
            <Undo2 size={14} aria-hidden="true" />
          </IconAction>
          <IconAction
            label={t('Stash Changes')}
            title={stashReason ? t(stashReason) : t('Stash Changes')}
            disabled={Boolean(stashReason)}
            onClick={onStash}
          >
            <Archive size={14} aria-hidden="true" />
          </IconAction>
          <IconAction
            label={t('Pop Stash')}
            title={popStashReason ? t(popStashReason) : t('Pop Stash')}
            disabled={Boolean(popStashReason)}
            onClick={onPopStash}
          >
            <ArchiveRestore size={14} aria-hidden="true" />
          </IconAction>
          <button
            type="button"
            className="dock-scm-sort"
            aria-label={t('View & Sort')}
            title={t('View & Sort')}
            data-tooltip={t('View & Sort')}
            aria-haspopup="menu"
            aria-expanded={viewSortOpen}
            onPointerEnter={rememberPoint}
            onFocus={rememberPoint}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              viewSortClickGuard.markPointerActivation();
              onToggleViewSort(viewSortMenuPoint.current ?? elementMenuPoint(event.currentTarget));
            }}
            onClick={(event) => {
              if (viewSortClickGuard.consumePointerClick()) return;
              if (event.detail !== 0) return;
              onToggleViewSort(viewSortMenuPoint.current ?? elementMenuPoint(event.currentTarget));
            }}
            onPointerCancel={viewSortClickGuard.clearPointerActivation}
          >
            <ArrowUpDown size={14} aria-hidden="true" />
          </button>
        </span>
      </div>
    </div>
  );
}
