// The windowed commit list of the dock's History view and its one row
// grammar.
import { ArrowUp } from 'lucide-react';
import type React from 'react';
import type { DesktopGitLogEntry } from '../shared/contract';
import { t } from './i18n';
import { elementMenuPoint, isContextMenuKey, pointerMenuPoint } from './ScmContextMenu';
import { EMPTY_SUMMARY, RowSpacer, UNKNOWN_AUTHOR, type ScmRowWindow } from './source-control-support';

export type MenuPoint = { x: number; y: number };

type HistoryRowProps = {
  entry: DesktopGitLogEntry;
  remoteName: string;
  pushBlocked: boolean;
  pushReason: string;
  onOpen: () => void;
  onOpenMenu: (point: MenuPoint) => void;
  onPush: () => void;
};

// History row without the avatar stack (the dock has no avatar service, and a
// monogram only ate width): a one-line summary, the byline
// (`author • relative age`), then the tag and the unpushed push button as
// compact TRAILING affordances so neither can grow the row. The row hosts its
// own push BUTTON, so it cannot be a <button> itself (nested interactive
// content); it keeps the button role, the single tab stop and Enter/Space
// activation instead.
export function HistoryRow({
  entry,
  remoteName,
  pushBlocked,
  pushReason,
  onOpen,
  onOpenMenu,
  onPush,
}: HistoryRowProps) {
  const refs = entry.refs ?? [];
  const summary = (entry.subject ?? '').trim();
  const author = (entry.author ?? '').trim();
  // The row is the focusable element, so the truncated title, the hidden refs
  // and the unpushed glyph all live in ITS accessible name.
  const rowLabel = [
    summary || EMPTY_SUMMARY,
    `${author || UNKNOWN_AUTHOR}, ${entry.when}`,
    refs.length ? `refs: ${refs.join(', ')}` : '',
    entry.pushed ? '' : 'unpushed',
  ]
    .filter(Boolean)
    .join(' · ');
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isContextMenuKey(event)) {
      event.preventDefault();
      onOpenMenu(elementMenuPoint(event.currentTarget));
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    onOpen();
  };
  return (
    <div
      role="button"
      tabIndex={0}
      className="dock-scm-commit-row"
      title={summary || EMPTY_SUMMARY}
      aria-label={rowLabel}
      onClick={onOpen}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenMenu(pointerMenuPoint(event));
      }}
      onKeyDown={onKeyDown}
    >
      <span className="dock-scm-commit-info">
        <b data-empty={summary ? undefined : true}>{summary || EMPTY_SUMMARY}</b>
        <small>
          {author || UNKNOWN_AUTHOR} · {entry.when}
        </small>
      </span>
      <span className="dock-scm-commit-indicators">
        {/* The FIRST ref only. The rest stay reachable — counted VISIBLY as
            `+N` for pointer and touch, spelled out in the row's accessible
            name for AT, and listed in the tooltip for the mouse. */}
        {refs.length > 0 && (
          <i className="dock-scm-refs" title={refs.join(', ')}>
            <em>{refs[0]}</em>
            {refs.length > 1 && (
              <span className="dock-scm-refs-more" aria-hidden="true">
                +{refs.length - 1}
              </span>
            )}
          </i>
        )}
        {/* The unpushed indicator promoted to an ACTION: a round push button
            that runs the toolbar's push, under the toolbar's own rules. */}
        {!entry.pushed && (
          <button
            type="button"
            className="dock-scm-unpushed"
            aria-label={`Push unpushed commits to ${remoteName}`}
            disabled={pushBlocked}
            title={pushReason || `This commit has not been pushed — push to ${remoteName}`}
            onClick={(event) => {
              event.stopPropagation();
              if (pushBlocked) return;
              onPush();
            }}
          >
            <ArrowUp size={12} aria-hidden="true" />
          </button>
        )}
      </span>
    </div>
  );
}

// Windowed exactly like the changed-file list, and the next page is fetched
// from the scroll position instead of a `Load more` button.
export function HistoryList({
  scrollRef,
  rowWindow,
  entries,
  total,
  loading,
  rowProps,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  rowWindow: ScmRowWindow;
  entries: DesktopGitLogEntry[];
  total: number;
  loading: boolean;
  rowProps: (entry: DesktopGitLogEntry, entryIndex: number) => Omit<HistoryRowProps, 'entry'>;
}) {
  return (
    <div className="dock-scm-history" ref={scrollRef}>
      <RowSpacer edge="leading" height={rowWindow.leading} />
      {entries.map((entry, windowIndex) => (
        <HistoryRow key={entry.hash} entry={entry} {...rowProps(entry, rowWindow.start + windowIndex)} />
      ))}
      <RowSpacer edge="trailing" height={rowWindow.trailing} />
      {loading && <p className="utility-dock-empty">{t('Loading history…')}</p>}
      {!loading && total === 0 && <p className="utility-dock-empty">{t('No commits found.')}</p>}
    </div>
  );
}
