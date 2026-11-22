// The session panel's building blocks: a category with its one head pattern
// (name, chevron, summary while closed, buttons while open) and a list that
// shows its first few rows.
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { type DockAction, DockOverflowMenu } from './pane-dock-chrome';
import { t } from './i18n';
import { TidyButton } from './IslandPanelFoot';
import type { SessionRailCategory } from './session-rail-folds';

export type RailTidy = { kind: string; description: string; disabled: boolean; onClick(): void };

export function RailSection({
  category,
  title,
  summary,
  open,
  onToggle,
  tidy,
  menu = [],
  children,
}: {
  category: SessionRailCategory;
  title: string;
  summary: ReactNode;
  open: boolean;
  onToggle(): void;
  /** The category's Clean up, the same control in every head that has one. */
  tidy?: RailTidy;
  /** The "…" menu; no "…" when it is empty. */
  menu?: readonly DockAction[];
  children: ReactNode;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="session-rail-sec" data-category={category} data-open={open || undefined} aria-label={title}>
      <div className="session-rail-hd">
        <button type="button" className="session-rail-tg" aria-expanded={open} onClick={onToggle}>
          <span className="session-rail-tt">{title}</span>
          <Chevron size={12} className="session-rail-cv" aria-hidden="true" />
          <span className="session-rail-sm" aria-hidden={open || undefined}>
            {summary}
          </span>
        </button>
        {open && tidy && (
          <TidyButton
            className="session-rail-tidy"
            kind={tidy.kind}
            label={t('Clean up')}
            description={tidy.description}
            named
            disabled={tidy.disabled}
            onClick={tidy.onClick}
          />
        )}
        {open && menu.length > 0 && <DockOverflowMenu items={menu} />}
      </div>
      {open && <div className="session-rail-bd">{children}</div>}
    </section>
  );
}

/** The first `budget` rows (in `list`, the rows' container), then "n more" / "Show less". */
export function RailList({
  rows,
  budget,
  list = (shown) => shown,
}: {
  rows: readonly ReactNode[];
  budget: number;
  list?: (shown: readonly ReactNode[]) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  const rest = rows.length - budget;
  return (
    <>
      {list(all ? rows : rows.slice(0, budget))}
      {rest > 0 && (
        <button type="button" className="session-rail-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? t('Show less') : t('Show {{count}} more', { count: rest })}
        </button>
      )}
    </>
  );
}

/** A row that opens a picker: arrow keys open it too, as on the composer's pill. */
export function openOnArrow(event: KeyboardEvent<HTMLElement>, open: boolean, show: () => void): void {
  if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
  event.preventDefault();
  show();
}

/** The "▾" a pressable Info row shows on hover, focus or while its picker is open. */
export function RailPickMark() {
  return <ChevronDown size={12} className="session-rail-pk" aria-hidden="true" />;
}
