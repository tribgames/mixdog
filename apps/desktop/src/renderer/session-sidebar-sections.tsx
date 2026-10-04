import { ChevronDown, ChevronRight, type FolderPlus } from 'lucide-react';
import React, { useContext } from 'react';
import { createPortal } from 'react-dom';
import { InitialSurface } from './InitialSurface';
import type { DesktopSessionSummary } from '../shared/contract';
import {
  clampDesktopPanelWidth,
  DESKTOP_SIDEBAR_DEFAULT_WIDTH,
  DESKTOP_SIDEBAR_MIN_WIDTH,
} from '../shared/window-layout';
import { ProgressSpinner } from './ProgressSpinner';
import { t, uiFormatLocale } from './i18n';
import { RowOverflowMenu } from './RowOverflowMenu';
import { sessionLabel } from './session-sidebar-rows';

export function projectIdentity(path: string | null | undefined) {
  return String(path || '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLocaleLowerCase();
}

const DEFAULT_SIDEBAR_WIDTH = DESKTOP_SIDEBAR_DEFAULT_WIDTH;
export const MIN_SIDEBAR_WIDTH = DESKTOP_SIDEBAR_MIN_WIDTH;
export const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_KEY = 'mixdog:session-sidebar-width';

export function clampSidebarWidth(value: number) {
  return clampDesktopPanelWidth(value, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
}

export function storedSidebarWidth() {
  try {
    const value = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));

    return Number.isFinite(value) && value > 0 ? clampSidebarWidth(value) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

/** Width persistence for the next window. Both the settled resize and the
 *  pagehide flush write through here: a storage failure only costs the next
 *  window its restored width, the live resize is already applied. */
export function persistSidebarWidth(width: number) {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // The current window can still resize when persistent storage is unavailable.
  }
}

export type SidebarResizeStart = {
  clientX: number;
  width: number;
  pendingWidth: number;
};

/** Automation runner sessions (schedule/webhook fires) live in their own
 *  Automations section and are excluded from Recent (user decision: fires
 *  must not flood the list). */
export function isAutomationRow(session: DesktopSessionSummary) {
  return session.sourceType === 'schedule' || session.sourceType === 'webhook';
}

type AutomationGroup = { key: string; name: string; runs: DesktopSessionSummary[] };

/** One GROUP per automation name: the newest session is the visible row and
 *  older fires stay reachable behind a per-group "Past runs" toggle (user
 *  decision — fires are full sessions now, so history must not vanish).
 *  Expects activity-desc rows, which is the order the runs keep. */
export function groupAutomationSessions(activityOrderedRows: DesktopSessionSummary[]): AutomationGroup[] {
  const groups = new Map<string, { name: string; runs: DesktopSessionSummary[] }>();
  for (const session of activityOrderedRows) {
    if (session.archived === true || !isAutomationRow(session)) continue;
    const key = `${session.sourceType}:${
      String(session.sourceName || '')
        .trim()
        .toLowerCase() || session.id
    }`;
    let entry = groups.get(key);
    if (!entry) {
      entry = { name: String(session.sourceName || sessionLabel(session)), runs: [] };
      groups.set(key, entry);
    }
    // Runs keep activity order and show their fire time as the row label —
    // every run reads the same name.
    entry.runs.push({
      ...session,
      title: new Date(Number(session.activityAt) || session.updatedAt).toLocaleString(uiFormatLocale(), {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    });
  }
  return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
}

/** Panel-header action slot. Rail destinations (Projects/Workflows/Schedules/
 *  Webhooks) hand their primary action to the panel title row instead of
 *  printing a second page header inside the list (user: 타이틀이 2번). */
export const SidebarPanelHeaderSlot = React.createContext<HTMLElement | null>(null);

export function SidebarPanelAction({
  active = true,
  label,
  icon: Icon,
  className = '',
  disabled,
  onClick,
}: {
  /** Only the VISIBLE panel may own the shared header slot: every rail panel
   *  stays mounted behind [hidden] so its list keeps its scroll and data. */
  active?: boolean;
  label: string;
  icon: typeof FolderPlus;
  className?: string;
  disabled?: boolean;
  onClick(): void;
}) {
  const slot = useContext(SidebarPanelHeaderSlot);
  const button = (
    <button
      type="button"
      className={`session-panel-action ${className}`.trim()}
      aria-label={label}
      data-tooltip={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
  // No slot means the pane renders outside the sidebar (standalone hosts and
  // unit tests): keep the action inline so the surface stays complete.
  if (!slot) return button;
  return active ? createPortal(button, slot) : null;
}

/** Automations section: one disclosure per automation name over its runs.
 *  Separate from Recent because a group header is a PURE disclosure (user
 *  decision) — it never renames and never opens a session itself. */
export function automationsSection({
  groups,
  open,
  onToggleOpen,
  hasHeadingDot,
  archiveAllDisabled,
  onArchiveAll,
  collapsedGroups,
  onToggleGroup,
  workingSessionIds,
  unreadSessionIds,
  renderSessionRow,
}: {
  groups: AutomationGroup[];
  open: boolean;
  onToggleOpen(): void;
  hasHeadingDot: boolean;
  archiveAllDisabled: boolean;
  onArchiveAll(): void;
  collapsedGroups: ReadonlySet<string>;
  onToggleGroup(key: string): void;
  workingSessionIds?: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  renderSessionRow(session: DesktopSessionSummary): React.ReactNode;
}) {
  return (
    <section className="sidebar-recent sidebar-automations" aria-label={t('Automations')}>
      <div className="sidebar-category-header">
        <button
          type="button"
          className="sidebar-recent-heading sidebar-heading-toggle"
          aria-expanded={open}
          onClick={onToggleOpen}
        >
          <span>{t('Automations')}</span>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {/* Collapsed sections still have to announce new activity. */}
          {hasHeadingDot && (
            <span className="sidebar-heading-dot" role="status" aria-label={t('Automations have new activity')} />
          )}
        </button>
        {!hasHeadingDot && (
          <RowOverflowMenu
            label="Actions"
            items={[
              {
                id: 'archive-all',
                label: 'Archive all',
                disabled: archiveAllDisabled,
                onSelect: onArchiveAll,
              },
            ]}
          />
        )}
      </div>
      {open && (
        <nav className="session-list automation-session-list" aria-label={t('Automations')}>
          {groups.map(({ key, name, runs }) => {
            const expanded = !collapsedGroups.has(key);
            const working = runs.some((run) => workingSessionIds?.has(run.id) === true);
            const unread = runs.some((run) => unreadSessionIds?.has(run.id) === true);
            const ExpandGlyph = expanded ? ChevronDown : ChevronRight;
            return (
              <div className="automation-group" key={key}>
                {/* The chevron LEADS in the fixed status cell (one aligned
                    column); the working spinner takes that cell over while a
                    run is live. */}
                <button
                  type="button"
                  className="session-row automation-group-header"
                  aria-expanded={expanded}
                  onClick={() => onToggleGroup(key)}
                >
                  <span className="session-row-status" data-working={working || undefined}>
                    {working ? (
                      <ProgressSpinner
                        size={12}
                        className="session-row-spinner"
                        role="status"
                        aria-label={t('{{name}} is working', { name })}
                      />
                    ) : (
                      <ExpandGlyph size={14} aria-hidden="true" />
                    )}
                  </span>
                  <span className="session-row-copy">
                    <b>{name}</b>
                  </span>
                  {unread && !working && (
                    <span
                      className="session-row-unread-dot"
                      role="status"
                      aria-label={t('{{name}} has new activity', { name })}
                    />
                  )}
                </button>
                {expanded && <div className="automation-group-past">{runs.map(renderSessionRow)}</div>}
              </div>
            );
          })}
        </nav>
      )}
    </section>
  );
}

/** Recent section: the primary session catalog. Owns the invisible end
 *  sentinel that reveals the next page — pagination has NO control of its own
 *  (user decision: no "Show more"). */
export function recentSection({
  sessionsReady,
  rowCount,
  visibleRows,
  hasMoreRows,
  sentinelRef,
  open,
  onToggleOpen,
  hasHeadingDot,
  archiveAllDisabled,
  onArchiveAll,
  renderSessionRow,
}: {
  sessionsReady: boolean;
  rowCount: number;
  visibleRows: DesktopSessionSummary[];
  hasMoreRows: boolean;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  onToggleOpen(): void;
  hasHeadingDot: boolean;
  archiveAllDisabled: boolean;
  onArchiveAll(): void;
  renderSessionRow(session: DesktopSessionSummary): React.ReactNode;
}) {
  return (
    <section className="sidebar-recent" aria-label={t('Recent sessions')}>
      <div className="sidebar-category-header">
        <button
          type="button"
          className="sidebar-recent-heading sidebar-heading-toggle"
          aria-expanded={open}
          onClick={onToggleOpen}
        >
          <span>{t('Recent')}</span>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {hasHeadingDot && (
            <span className="sidebar-heading-dot" role="status" aria-label={t('Recent has new activity')} />
          )}
        </button>
        {!hasHeadingDot && (
          <RowOverflowMenu
            label="Actions"
            items={[
              {
                id: 'archive-all',
                label: 'Archive all',
                disabled: archiveAllDisabled,
                onSelect: onArchiveAll,
              },
            ]}
          />
        )}
      </div>
      {open && (
        <nav id="recent-session-list" className="session-list recent-session-list" aria-label={t('Recent sessions')}>
          {!sessionsReady && rowCount === 0 ? (
            <InitialSurface />
          ) : (
            sessionsReady && rowCount === 0 && <p className="sidebar-section-empty">{t('No sessions')}</p>
          )}
          {visibleRows.map(renderSessionRow)}
          {hasMoreRows && (
            <div
              ref={sentinelRef}
              className="session-list-sentinel"
              aria-hidden="true"
              style={{ height: 1, pointerEvents: 'none' }}
            />
          )}
        </nav>
      )}
    </section>
  );
}

/** Archived section: restore and permanent-delete of parked sessions, kept
 *  apart from Recent because those are the only bulk actions that leave or
 *  destroy the catalog. */
export function archivedSection({
  visibleRows,
  hasMoreRows,
  sentinelRef,
  open,
  onToggleOpen,
  actionsDisabled,
  onRestoreAll,
  onDeleteAll,
  renderSessionRow,
}: {
  visibleRows: DesktopSessionSummary[];
  hasMoreRows: boolean;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  onToggleOpen(): void;
  actionsDisabled: boolean;
  onRestoreAll(): void;
  onDeleteAll(): void;
  renderSessionRow(session: DesktopSessionSummary): React.ReactNode;
}) {
  return (
    <section className="sidebar-recent sidebar-archived" aria-label={t('Archived sessions')}>
      <div className="sidebar-category-header">
        <button
          type="button"
          className="sidebar-recent-heading sidebar-heading-toggle sidebar-archived-toggle"
          aria-expanded={open}
          onClick={onToggleOpen}
        >
          <span>{t('Archived')}</span>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <RowOverflowMenu
          label="Actions"
          items={[
            {
              id: 'restore-all',
              label: 'Restore all',
              disabled: actionsDisabled,
              onSelect: onRestoreAll,
            },
            {
              id: 'delete-all-archived',
              label: 'Delete all archived sessions',
              danger: true,
              separatorBefore: true,
              disabled: actionsDisabled,
              children: [
                {
                  id: 'confirm-delete-all-archived',
                  label: 'Confirm delete',
                  danger: true,
                  onSelect: onDeleteAll,
                },
              ],
            },
          ]}
        />
      </div>
      {open && (
        <nav className="session-list archived-session-list" aria-label={t('Archived sessions')}>
          {visibleRows.map(renderSessionRow)}
          {hasMoreRows && (
            <div
              ref={sentinelRef}
              className="session-list-sentinel"
              aria-hidden="true"
              style={{ height: 1, pointerEvents: 'none' }}
            />
          )}
        </nav>
      )}
    </section>
  );
}

/** Drag separator for the sidebar width. The live pointer width is written
 *  straight to the element and the ref so a drag never re-renders the session
 *  lists; only the settled width reaches state and storage. */
export function sidebarResizeHandle({
  width,
  sidebarWidth,
  resizeStart,
  updateSidebarWidth,
  onFinishResize,
}: {
  width: number;
  sidebarWidth: number;
  resizeStart: { current: SidebarResizeStart | null };
  updateSidebarWidth(value: number): void;
  onFinishResize(): void;
}) {
  return (
    <div
      className="session-sidebar-resize"
      role="separator"
      tabIndex={0}
      aria-label={t('Resize session sidebar')}
      aria-orientation="vertical"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      onDoubleClick={() => updateSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') updateSidebarWidth(sidebarWidth - 16);
        else if (event.key === 'ArrowRight') updateSidebarWidth(sidebarWidth + 16);
        else if (event.key === 'Home') updateSidebarWidth(MIN_SIDEBAR_WIDTH);
        else if (event.key === 'End') updateSidebarWidth(MAX_SIDEBAR_WIDTH);
        else return;
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        resizeStart.current = {
          clientX: event.clientX,
          width: sidebarWidth,
          pendingWidth: sidebarWidth,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        document.body.classList.add('session-sidebar-resizing');
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        const start = resizeStart.current;
        if (!start) return;
        const next = clampSidebarWidth(start.width + event.clientX - start.clientX);
        start.pendingWidth = next;
        const sidebar = event.currentTarget.closest<HTMLElement>('.session-sidebar');
        sidebar?.style.setProperty('--session-sidebar-width', `${next}px`);
        event.currentTarget.setAttribute('aria-valuenow', String(next));
        event.currentTarget.setAttribute('aria-valuetext', `${next} pixels`);
      }}
      onPointerUp={onFinishResize}
      onPointerCancel={onFinishResize}
    />
  );
}
