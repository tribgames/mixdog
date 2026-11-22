// The session panel's building block: a category as a sheet of its own in the
// island panels' grammar: a head (name, count, what it holds, chevron), a body
// and a foot of actions. Its head drags the sheet to another place in the panel.
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { DragEvent, KeyboardEvent, ReactNode } from 'react';
import { type DockAction, DockOverflowMenu } from './pane-dock-chrome';
import { t } from './i18n';
import { TidyButton } from './IslandPanelFoot';
import { moveSessionRailCategory, type SessionRailCategory, useSessionRailOrder } from './session-rail-folds';

export type RailTidy = { kind: string; description: string; disabled: boolean; onClick(): void };

/** The category whose head is being dragged; drops are taken from it alone. */
let dragged: SessionRailCategory | null = null;

export function RailSection({
  category,
  title,
  count,
  summary,
  meta,
  open,
  onToggle,
  tidy,
  menu = [],
  top,
  foot,
  scroll = false,
  children,
}: {
  category: SessionRailCategory;
  title: string;
  /** The figure beside the name (how many, how far). */
  count?: ReactNode;
  /** What the category holds, shown at the head's end while it is closed. */
  summary?: ReactNode;
  /** The head's end in both states; replaces the summary. */
  meta?: ReactNode;
  open: boolean;
  onToggle(): void;
  /** The category's Clean up, the foot's last button. */
  tidy?: RailTidy;
  /** The "…" menu; no "…" when it is empty. */
  menu?: readonly DockAction[];
  /** Fixed above the body (a search field). */
  top?: ReactNode;
  /** The foot's own buttons or line, before Clean up. */
  foot?: ReactNode;
  /** The body is a list that scrolls inside the sheet past its height. */
  scroll?: boolean;
  children: ReactNode;
}) {
  const order = useSessionRailOrder();
  const Chevron = open ? ChevronDown : ChevronRight;
  const end = meta ?? (open ? null : summary);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    const shown = [
      ...(event.currentTarget.closest('.session-rail-content')?.querySelectorAll<HTMLElement>('.session-rail-sec') ?? []),
    ]
      .map((node) => node.dataset.category as SessionRailCategory)
      .sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const down = event.key === 'ArrowDown';
    const neighbour = shown[shown.indexOf(category) + (down ? 1 : -1)];
    if (!neighbour) return;
    event.preventDefault();
    moveSessionRailCategory(category, neighbour, down);
  };
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!dragged || dragged === category) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    moveSessionRailCategory(dragged, category, event.clientY > box.top + box.height / 2);
  };
  return (
    <section
      className="session-rail-sec"
      data-category={category}
      data-open={open || undefined}
      aria-label={title}
      style={{ order: order.indexOf(category) }}
      onDragOver={onDragOver}
      onDrop={(event) => {
        if (dragged) event.preventDefault();
      }}
    >
      <div className="session-rail-hd">
        <button
          type="button"
          className="session-rail-tg"
          aria-expanded={open}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          draggable
          onClick={onToggle}
          onKeyDown={onKeyDown}
          onDragStart={(event) => {
            dragged = category;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', title);
            event.currentTarget.closest<HTMLElement>('.session-rail-sec')?.setAttribute('data-dragging', 'true');
          }}
          onDragEnd={(event) => {
            dragged = null;
            event.currentTarget.closest<HTMLElement>('.session-rail-sec')?.removeAttribute('data-dragging');
          }}
        >
          <span className="session-rail-tt">
            {title}
            {count != null && <span className="session-rail-ct">{count}</span>}
          </span>
          <span className="session-rail-sm">{end}</span>
          <Chevron size={12} className="session-rail-cv" aria-hidden="true" />
        </button>
        {open && menu.length > 0 && <DockOverflowMenu items={menu} />}
      </div>
      {open && top}
      {open && (
        <div className="session-rail-bd" data-scroll={scroll || undefined}>
          {children}
        </div>
      )}
      {open && (foot || tidy) && (
        <div className="session-rail-ft">
          {foot}
          {tidy && (
            <span className="session-rail-ft-end">
              <TidyButton
                className="composer-island-button"
                kind={tidy.kind}
                label={t('Clean up')}
                description={tidy.description}
                named
                disabled={tidy.disabled}
                onClick={tidy.onClick}
              />
            </span>
          )}
        </div>
      )}
    </section>
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
