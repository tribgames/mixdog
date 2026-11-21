import { ChevronDown } from 'lucide-react';
import type React from 'react';
import { t } from './i18n';
import { explorerGitClass, type ExplorerRow } from './explorer-tree-model';
import { scheduleEditorPanePrefetch } from './lazy-widgets';
import { SetiFileIcon } from './SetiFileIcon';

export type ExplorerRowHandlers = Pick<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onDragStart' | 'onDragOver' | 'onDrop' | 'onDragEnd' | 'onClick' | 'onDoubleClick' | 'onContextMenu'
>;

/** One tree row: the markup and state classes. Interaction is wired by the pane. */
export function ExplorerRowButton({
  row,
  badge,
  gitDirChanged,
  changed,
  selected,
  focused,
  cut,
  dropTarget,
  tabbable,
  registerEl,
  handlers,
}: {
  row: ExplorerRow;
  badge: string | undefined;
  gitDirChanged: boolean;
  changed: boolean;
  selected: boolean;
  focused: boolean;
  cut: boolean;
  dropTarget: boolean;
  tabbable: boolean;
  registerEl(rel: string, element: HTMLButtonElement | null): void;
  handlers: ExplorerRowHandlers;
}) {
  let className = 'dock-file-row';
  if (!row.dir) className += ` is-file${explorerGitClass(badge)}`;
  if (row.dir && gitDirChanged) className += ' git-dir-changed';
  if (selected) className += ' explorer-selected';
  if (focused) className += ' explorer-focused';
  if (cut) className += ' explorer-cut';
  if (dropTarget) className += ' explorer-drop-target';
  // Indent guides: the CSS rule paints one hairline per ancestor level and
  // only needs the covered width (guides render on hover).
  const guides = row.level > 0 ? ({ '--guide-size': `${row.level * 8}px 100%` } as React.CSSProperties) : undefined;
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={row.level + 1}
      aria-expanded={row.dir ? row.expanded : undefined}
      aria-selected={selected}
      title={row.dir ? undefined : row.rel}
      tabIndex={tabbable ? 0 : -1}
      data-guides={row.level > 0 ? 'true' : undefined}
      ref={(element) => registerEl(row.rel, element)}
      className={className}
      style={{ paddingLeft: `calc(var(--mx-explorer-inset, 12px) + ${row.level * 8}px)`, ...guides }}
      draggable
      onPointerEnter={row.dir ? undefined : scheduleEditorPanePrefetch}
      onFocus={row.dir ? undefined : scheduleEditorPanePrefetch}
      {...handlers}
    >
      {/* 16px twistie column on EVERY row (monaco-tl-twistie): files reserve
          the space too, so labels align per depth; the chevron rotates. */}
      <span className={`explorer-twistie${row.dir && !row.expanded ? ' collapsed' : ''}`} aria-hidden="true">
        {row.dir && <ChevronDown size={14} />}
      </span>
      {/* Seti grammar: folders carry only the twistie, files a themed glyph. */}
      {!row.dir && <SetiFileIcon name={row.name} className="dock-file-icon" />}
      <span>{row.name}</span>
      {row.dir && gitDirChanged && <i className="dock-file-changed" aria-hidden="true" />}
      {!row.dir && badge && (
        <em className="dock-file-badge" role="img" aria-label={t('Git status {{badge}}', { badge })}>
          {badge}
        </em>
      )}
      {!row.dir && !badge && changed && <i className="dock-file-changed" aria-hidden="true" />}
    </button>
  );
}
