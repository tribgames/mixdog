// The session panel's building block: a category as a section of the panel: a
// head that folds it (the category's name with the fold's chevron beside it,
// then what it holds at the head's end), a body and a foot of actions in the
// island panels' grammar. Its head drags the section to another place in the
// panel.
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type DragEvent, type KeyboardEvent, type ReactNode, useRef } from 'react';
import { t } from './i18n';
import { TidyButton } from './IslandPanelFoot';
import { useScrollProgress } from './scroll-progress';
import {
  moveSessionRailCategory,
  releasePointerFocus,
  type SessionRailCategory,
  sessionRailOrderNow,
  setSessionRailOrder,
} from './session-rail-folds';

export type RailTidy = { kind: string; description: string; disabled: boolean; onClick(): void };
/** The category whose head is being dragged (drops are taken from it alone),
 *  and the arrangement it was picked up from. */
let dragged: { category: SessionRailCategory; from: readonly SessionRailCategory[] } | null = null;

/** A category is being dragged to another place. */
export function sessionRailDragging(): boolean {
  return dragged !== null;
}

export function RailSection({
  category,
  title,
  count,
  summary,
  meta,
  action,
  open,
  onToggle,
  tidy,
  foot,
  scroll = false,
  children,
}: {
  category: SessionRailCategory;
  title: string;
  /** The figure at the head's end (a state mark, then how many or how far). */
  count?: ReactNode;
  /** What the category holds, shown at the head's end while it is closed. */
  summary?: ReactNode;
  /** The head's end in both states; replaces the summary. */
  meta?: ReactNode;
  /** The category's one action, a button at the head's end, folded or open. */
  action?: ReactNode;
  open: boolean;
  onToggle(): void;
  /** The category's Clean up, at the foot's right end as on the island panels. */
  tidy?: RailTidy;
  /** The foot's own buttons or line. */
  foot?: ReactNode;
  /** The body is a list that scrolls inside the section past its height. */
  scroll?: boolean;
  children: ReactNode;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  const end = meta ?? (open ? null : summary);
  // A scrolling list's position, for its edge fades (session-rail.css); the list is drawn anew each time it opens.
  const list = useRef<HTMLDivElement>(null);
  useScrollProgress(list, undefined, open && scroll);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    const head = event.currentTarget;
    const sections = head
      .closest('.session-rail-content')
      ?.querySelectorAll<HTMLElement>('.session-rail-sec:not([data-leaving])');
    const shown = [...(sections ?? [])].map((node) => node.dataset.category as SessionRailCategory);
    const down = event.key === 'ArrowDown';
    const neighbour = shown[shown.indexOf(category) + (down ? 1 : -1)];
    if (!neighbour) return;
    event.preventDefault();
    moveSessionRailCategory(category, neighbour, down);
    // The section moved in the document, which drops focus: the head keeps it.
    requestAnimationFrame(() => head.focus());
  };
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!dragged || dragged.category === category) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    moveSessionRailCategory(dragged.category, category, event.clientY > box.top + box.height / 2);
  };
  return (
    <section
      className="session-rail-sec"
      data-category={category}
      data-open={open || undefined}
      aria-label={title}
      onDragOver={onDragOver}
    >
      <div className="session-rail-hd">
        <button
          type="button"
          className="session-rail-tg"
          aria-expanded={open}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          draggable
          onClick={(event) => {
            onToggle();
            releasePointerFocus(event);
          }}
          onKeyDown={onKeyDown}
          onDragStart={(event) => {
            dragged = { category, from: sessionRailOrderNow() };
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', title);
            // What is carried is the whole section, held where it was pressed.
            const section = event.currentTarget.closest<HTMLElement>('.session-rail-sec');
            if (!section) return;
            const box = section.getBoundingClientRect();
            event.dataTransfer.setDragImage(section, event.clientX - box.left, event.clientY - box.top);
            // After the browser has taken the section's picture: its place in the column dims.
            requestAnimationFrame(() => section.setAttribute('data-dragging', 'true'));
          }}
          onDragEnd={(event) => {
            // Let go outside the panel or cancelled with Escape: the order it was picked up from.
            if (dragged && event.dataTransfer.dropEffect === 'none') setSessionRailOrder(dragged.from);
            dragged = null;
            event.currentTarget.closest<HTMLElement>('.session-rail-sec')?.removeAttribute('data-dragging');
          }}
        >
          <span className="session-rail-tt">{title}</span>
          <Chevron size={12} className="session-rail-cv" aria-hidden="true" />
          <span className="session-rail-sm">{end}</span>
          {count != null && <span className="session-rail-ct">{count}</span>}
        </button>
        {action}
      </div>
      {open && (
        <div ref={scroll ? list : undefined} className="session-rail-bd" data-scroll={scroll || undefined}>
          {children}
        </div>
      )}
      {open && (foot || tidy) && (
        <div className="session-rail-ft">
          {foot}
          {tidy && (
            <TidyButton
              className="composer-island-button session-rail-tidy"
              kind={tidy.kind}
              label={t('Clean up')}
              description={tidy.description}
              disabled={tidy.disabled}
              onClick={tidy.onClick}
            />
          )}
        </div>
      )}
    </section>
  );
}

/** A fold inside a category (a to-do group): its name, the chevron, then how
 *  many it holds, in the order of the category's own head. */
export function RailFold({
  id,
  name,
  count,
  open,
  onToggle,
}: {
  id: string;
  name: ReactNode;
  count?: number;
  open: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      className="session-rail-gh"
      data-fold={id}
      aria-expanded={open}
      onClick={(event) => {
        onToggle();
        releasePointerFocus(event);
      }}
    >
      <span className="session-rail-gn">{name}</span>
      {open ? (
        <ChevronDown size={12} className="session-rail-cv" aria-hidden="true" />
      ) : (
        <ChevronRight size={12} className="session-rail-cv" aria-hidden="true" />
      )}
      {count != null && <span className="session-rail-ct">{count}</span>}
    </button>
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
