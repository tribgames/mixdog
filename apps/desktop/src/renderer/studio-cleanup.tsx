import { CalendarClock, ImageOff, ListChecks, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { t } from './i18n';
import { useMobileBack } from './mobile-back';

/** A bulk-delete request; the Studio adds the current kind. */
interface StudioCleanupFilter {
  ids?: string[];
  before?: number;
  missing?: boolean;
  all?: boolean;
}

export type StudioCleanupRequest = (filter: StudioCleanupFilter, confirmText: (total: number) => string) => void;

const DAY_MS = 24 * 60 * 60 * 1_000;
const AGE_PRESETS = [7, 30, 90] as const;

/** Gallery top-left: the cleanup menu, or the selection bar while selecting. */
export function StudioCleanupBar({
  selecting,
  selectedCount,
  visibleCount,
  onSelectMode,
  onSelectAll,
  onDeleteSelected,
  onExitSelection,
  onCleanUp,
}: {
  selecting: boolean;
  selectedCount: number;
  visibleCount: number;
  onSelectMode: () => void;
  onSelectAll: () => void;
  onDeleteSelected: () => void;
  onExitSelection: () => void;
  onCleanUp: StudioCleanupRequest;
}) {
  const [open, setOpen] = useState(false);
  const menuNode = useRef<HTMLDivElement>(null);
  useMobileBack(open, () => setOpen(false));
  useMobileBack(selecting, onExitSelection);

  useEffect(() => {
    if (!open && !selecting) return undefined;
    const dismiss = (event: PointerEvent) => {
      if (open && !menuNode.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (open) setOpen(false);
      else onExitSelection();
    };
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', onEscape, true);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', onEscape, true);
    };
  }, [open, selecting, onExitSelection]);

  if (selecting) {
    return (
      <div className="studio-cleanup" role="toolbar" aria-label={t('Clean up')}>
        <span className="studio-cleanup-count">{t('{{total}} selected', { total: selectedCount })}</span>
        <button type="button" disabled={!visibleCount} onClick={onSelectAll}>
          {t('Select all')}
        </button>
        <button type="button" className="studio-cleanup-danger" disabled={!selectedCount} onClick={onDeleteSelected}>
          <Trash2 size={13} aria-hidden="true" />
          {t('Delete selected')}
        </button>
        <button type="button" aria-label={t('Cancel')} title={t('Cancel')} onClick={onExitSelection}>
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    );
  }

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };
  return (
    <div className="studio-cleanup" ref={menuNode}>
      {/* Icon-only trash trigger (user: 클린업 말고 휴지통 아이콘); the
            name rides the tooltip and the accessible label. */}
      <button
        type="button"
        className="studio-cleanup-trigger"
        aria-label={t('Clean up')}
        data-tooltip={t('Clean up')}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!visibleCount}
        onClick={() => setOpen((current) => !current)}
      >
        <Trash2 size={15} aria-hidden="true" />
      </button>
      {open ? (
        <div className="studio-cleanup-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => run(onSelectMode)}>
            <ListChecks size={14} aria-hidden="true" />
            {t('Select items')}
          </button>
          {AGE_PRESETS.map((days) => (
            <button
              key={days}
              type="button"
              role="menuitem"
              className="studio-cleanup-danger"
              onClick={() =>
                run(() =>
                  onCleanUp({ before: Date.now() - days * DAY_MS }, (total) =>
                    t('Delete {{total}} items older than {{days}} days permanently? This cannot be undone.', {
                      total,
                      days,
                    })
                  )
                )
              }
            >
              <CalendarClock size={14} aria-hidden="true" />
              {t('Delete items older than {{days}} days', { days })}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="studio-cleanup-danger"
            onClick={() =>
              run(() =>
                onCleanUp({ missing: true }, (total) => t('Remove {{total}} items whose files are missing?', { total }))
              )
            }
          >
            <ImageOff size={14} aria-hidden="true" />
            {t('Remove missing items')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="studio-cleanup-danger"
            onClick={() =>
              run(() =>
                onCleanUp({ all: true }, (total) =>
                  t('Delete all {{total}} items in this tab permanently? This cannot be undone.', { total })
                )
              )
            }
          >
            <Trash2 size={14} aria-hidden="true" />
            {t('Delete all in this tab')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
