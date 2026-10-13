import { MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { DockAction } from './pane-dock-chrome';

import { type DiffStyle, readDiffStyle, writeDiffStyle } from './desktop-types';
import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { useMobileRemoteSurface } from './mobile-surface';

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
  /** False on the phone layout: a phone-wide column always reads unified, so
   *  the Unified/Split choice is not offered (the stored choice is kept). */
  splitAvailable?: boolean;
};

export function useDiffViewState(styleKey: string): DiffViewState {
  const phone = useMobileRemoteSurface();
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
  return phone
    ? { viewMode: 'unified', onViewModeChange, splitAvailable: false }
    : { viewMode, onViewModeChange, splitAvailable: true };
}

/** Unified/Split as a ⋯ menu radio pair (checked = the current mode); none
 *  where split is unavailable. */
export function diffModeActions(
  viewMode: DiffStyle,
  onViewModeChange: (mode: DiffStyle) => void,
  splitAvailable = true
): DockAction[] {
  if (!splitAvailable) return [];
  return (['unified', 'split'] as const).map((mode) => ({
    id: `diff-mode-${mode}`,
    label: mode === 'unified' ? t('Unified') : t('Split'),
    menuOnly: true,
    checked: viewMode === mode,
    onSelect: () => onViewModeChange(mode),
  }));
}

export type DiffHeaderControlsProps = Pick<DiffViewState, 'viewMode' | 'onViewModeChange' | 'splitAvailable'>;

/** The single-file diff header's only control: a ⋯ menu with the Unified/Split
 *  radio pair. The scope shows in the file chip's tooltip, not here. Nothing
 *  where split is unavailable (the phone layout). */
export function DiffHeaderControls({ viewMode, onViewModeChange, splitAvailable = true }: DiffHeaderControlsProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  useMobileBack(moreOpen, () => setMoreOpen(false));
  if (!splitAvailable) return null;
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
