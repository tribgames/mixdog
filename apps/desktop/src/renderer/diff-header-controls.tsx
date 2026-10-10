import { MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { DockAction } from './pane-dock-chrome';

import { type DiffStyle, readDiffStyle, writeDiffStyle } from './desktop-types';
import { t } from './i18n';

export type DiffScope = 'unstaged' | 'staged' | 'commit' | 'session';

export function diffScopeLabel(scope: DiffScope): string {
  if (scope === 'staged') return t('Staged');
  if (scope === 'commit') return t('Commit');
  if (scope === 'session') return t('Session');
  return t('Working tree');
}

/** Unified/Split (persisted per surface). A pane owns
 *  one of these unless the host passes its own via `viewState`, so the header
 *  controls mounted outside the pane drive the same state. */
export type DiffViewState = {
  viewMode: DiffStyle;
  onViewModeChange(mode: DiffStyle): void;
};

export function useDiffViewState(styleKey: string): DiffViewState {
  const [viewMode, setViewMode] = useState<DiffStyle>(() => readDiffStyle(styleKey));
  useEffect(() => {
    setViewMode(readDiffStyle(styleKey));
  }, [styleKey]);
  const onViewModeChange = useCallback(
    (next: DiffStyle) => {
      setViewMode(next);
      writeDiffStyle(styleKey, next);
    },
    [styleKey]
  );
  return { viewMode, onViewModeChange };
}

/** Unified/Split as a ⋯ menu radio pair (checked = the current mode). */
export function diffModeActions(viewMode: DiffStyle, onViewModeChange: (mode: DiffStyle) => void): DockAction[] {
  return (['unified', 'split'] as const).map((mode) => ({
    id: `diff-mode-${mode}`,
    label: mode === 'unified' ? t('Unified') : t('Split'),
    menuOnly: true,
    checked: viewMode === mode,
    onSelect: () => onViewModeChange(mode),
  }));
}

export type DiffHeaderControlsProps = Pick<DiffViewState, 'viewMode' | 'onViewModeChange'>;

/** The single-file diff header's only control: a ⋯ menu with the Unified/Split
 *  radio pair. The scope shows in the file chip's tooltip, not here. */
export function DiffHeaderControls({ viewMode, onViewModeChange }: DiffHeaderControlsProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  return (
    <div className="diff-header-controls">
      <span className="diff-header-spacer" />
      <span className="diff-scope">
        <button
          type="button"
          className="diff-icon-button diff-more-button"
          aria-label={t('More actions')}
          data-tooltip={t('More actions')}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
        {moreOpen && (
          <div className="diff-scope-menu diff-more-menu" role="menu">
            {diffModeActions(viewMode, onViewModeChange).map((action) => (
              <button
                key={action.id}
                type="button"
                role="menuitemradio"
                aria-checked={action.checked}
                onClick={() => {
                  setMoreOpen(false);
                  action.onSelect();
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </span>
    </div>
  );
}
