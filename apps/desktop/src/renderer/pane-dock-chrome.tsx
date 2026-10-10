// The ONE header row every side surface shares (file, terminal, browser,
// diff): the surface identity on the left, pane controls at the right end —
// a ⋯ menu, expand where supported, and close. These right-end controls are
// fixed — they never fold or clip. Every other action lives in ⋯ regardless of
// width (the one exception is an `inline` action such as Save while dirty).
// The left identity takes the remaining width and ellipsizes.
import { Check, Maximize2, MoreHorizontal, Minimize2, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';
import { commitImmediateOverlay } from './immediate-overlay';
import './tab-strip.css';

export interface DockAction {
  id: string;
  label: string;
  icon?: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  onSelect(): void;
  /** A visible header button instead of a ⋯ item (Save while the file is dirty). */
  inline?: boolean;
  /** Legacy no-op: every non-`inline` action is already a ⋯ item. */
  menuOnly?: boolean;
  /** A menu check mark (selected option) / a pressed button. */
  checked?: boolean;
  /** Menu only: a `checked` item is a single-choice radio unless this marks
   *  it an independent checkbox. */
  checkbox?: boolean;
  disabled?: boolean;
  /** Menu only: muted text after the label (e.g. problem counts). */
  detail?: string;
  /** Menu only: a hairline above this item starts a new group. */
  separatorBefore?: boolean;
}

/** In-flow dock surfaces (file, diff, Changes) share the dock's expanded
 *  state: the dock provides it and every DockHeaderRow below picks it up, so
 *  each shows the same expand/collapse control. Browser and terminal live in
 *  their own roots and pass their own props instead. */
export const PaneDockExpandContext = createContext<{ expanded: boolean; toggle(): void } | null>(null);

/** The right-end controls are fixed: ⋯, Expand, Close (+ an inline Save). */
export const DOCK_HEADER_BUTTON_WIDTH = 28;

/** Splits header actions: `inline` ones are buttons, everything else is a ⋯
 *  menu item at every width. */
export function splitDockActions(actions: readonly DockAction[]): { inline: DockAction[]; menu: DockAction[] } {
  return { inline: actions.filter((action) => action.inline), menu: actions.filter((action) => !action.inline) };
}

/** Surfaces live in their own React roots, so the header's X reaches the
 *  owning dock through this window event rather than a context. */
/** Wheel mapping of the pane workspace strip: the vertical wheel drives the
 *  horizontal tab run (WorkspaceTabStrip `onWheel`). */
export function scrollTabListByWheel(
  event: { deltaX: number; deltaY: number },
  list: { scrollBy?: (options: ScrollToOptions) => void } | null
): void {
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (list && delta) list.scrollBy?.({ left: delta, behavior: 'auto' });
}

export const PANE_DOCK_CLOSE_EVENT = 'mixdog:pane-dock-close';
export type PaneDockCloseSurface = 'browser' | 'terminal' | 'session-diff';
export function requestPaneDockClose(surface: PaneDockCloseSurface): void {
  window.dispatchEvent(new CustomEvent(PANE_DOCK_CLOSE_EVENT, { detail: { surface } }));
}

const MENU_EDGE = 8;
const MENU_GAP = 4;
const MENU_ITEM_HEIGHT = 28;
const MENU_ITEM_SEPARATOR = 5;
const MENU_PADDING = 10;

/** Fixed placement of the portalled ⋯ menu: right-aligned under the button,
 *  flipped above when it does not fit below and above is roomier, capped to
 *  the room on the chosen side. */
export function dockMenuPlacement(
  anchor: { top: number; bottom: number; right: number },
  viewport: { width: number; height: number },
  items: readonly DockAction[]
): CSSProperties {
  const estimated =
    items.length * MENU_ITEM_HEIGHT +
    items.filter((item) => item.separatorBefore).length * MENU_ITEM_SEPARATOR +
    MENU_PADDING;
  const below = Math.max(0, viewport.height - anchor.bottom - MENU_GAP - MENU_EDGE);
  const above = Math.max(0, anchor.top - MENU_GAP - MENU_EDGE);
  const flip = below < estimated && above > below;
  const right = Math.max(MENU_EDGE, viewport.width - anchor.right);
  return flip
    ? { right, bottom: viewport.height - anchor.top + MENU_GAP, maxHeight: above }
    : { right, top: anchor.bottom + MENU_GAP, maxHeight: below };
}

/** False once the menu's owner is detached, `hidden`/`inert`, or inside a
 *  `display: none` / `visibility: hidden` ancestor. */
export function dockMenuOwnerActive(owner: Element): boolean {
  if (!owner.isConnected || owner.closest('[hidden], [inert]')) return false;
  const view = owner.ownerDocument.defaultView;
  for (let node: Element | null = owner; node; node = node.parentElement) {
    const style = view?.getComputedStyle(node);
    if (style?.display === 'none' || (node === owner && style?.visibility === 'hidden')) return false;
  }
  return true;
}

function dockMenuItemRole(item: DockAction): 'menuitem' | 'menuitemradio' | 'menuitemcheckbox' {
  if (item.checked === undefined) return 'menuitem';
  return item.checkbox ? 'menuitemcheckbox' : 'menuitemradio';
}

export function DockOverflowMenu({ items }: { items: readonly DockAction[] }) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const place = useCallback(() => {
    const button = trigger.current;
    if (!button) return;
    setPlacement(
      dockMenuPlacement(
        button.getBoundingClientRect(),
        {
          width: document.documentElement.clientWidth || window.innerWidth,
          height: document.documentElement.clientHeight || window.innerHeight,
        },
        items
      )
    );
  }, [items]);
  const enabledItems = () =>
    Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)') ?? []);
  const close = () => {
    commitImmediateOverlay(() => setOpen(false));
    trigger.current?.focus();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: enabledItems only reads refs; focus moves once per open
  useEffect(() => {
    if (open) enabledItems()[0]?.focus();
  }, [open]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: close/enabledItems only touch refs and the stable setOpen; listeners attach per open
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        (root.current?.contains(event.target) || menu.current?.contains(event.target))
      )
        return;
      setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.isComposing) return;
        event.preventDefault();
        close();
        return;
      }
      if (event.key === 'Tab') {
        close();
        return;
      }
      if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) return;
      const enabled = enabledItems();
      if (!enabled.length) return;
      const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
      let next: HTMLButtonElement | undefined;
      if (event.key === 'ArrowDown') next = enabled[(index + 1) % enabled.length];
      else if (event.key === 'ArrowUp') next = enabled[(index <= 0 ? enabled.length : index) - 1];
      else if (event.key === 'Home') next = enabled[0];
      else if (event.key === 'End') next = enabled[enabled.length - 1];
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        enabled[index]?.click();
        return;
      } else return;
      event.preventDefault();
      next.focus();
    };
    // The menu is portalled to body, so hiding its owner (tab switch, dock
    // close, navigation) does not hide it: close when the owner deactivates.
    const watchOwner = () => {
      if (root.current && !dockMenuOwnerActive(root.current)) setOpen(false);
    };
    const ownerView = (root.current?.ownerDocument ?? document).defaultView;
    const observer = new (ownerView?.MutationObserver ?? MutationObserver)(watchOwner);
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['hidden', 'inert', 'style', 'class'],
    });
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);
  return (
    <div ref={root} className="dock-header-menu-host">
      <button
        ref={trigger}
        type="button"
        className="browser-pane-nav-button dock-header-more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('More actions')}
        data-tooltip={t('More actions')}
        onClick={() =>
          commitImmediateOverlay(() => {
            if (!open) place();
            setOpen(!open);
          })
        }
      >
        <MoreHorizontal size={15} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className="dock-header-menu"
            role="menu"
            aria-label={t('More actions')}
            data-dock-menu-owner=""
            style={placement}
          >
            {items.map((item) => {
              const Glyph = item.icon;
              let glyph: ReactNode = null;
              if (item.checked) glyph = <Check size={14} aria-hidden={true} />;
              else if (Glyph) glyph = <Glyph size={15} aria-hidden={true} />;
              return (
                // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is menuitemcheckbox/menuitemradio whenever `checked` is set.
                <button
                  key={item.id}
                  type="button"
                  role={dockMenuItemRole(item)}
                  aria-checked={item.checked === undefined ? undefined : item.checked}
                  className={item.separatorBefore ? 'has-separator' : undefined}
                  disabled={item.disabled}
                  onClick={() => {
                    close();
                    item.onSelect();
                  }}
                >
                  <span className="dock-header-menu-glyph">{glyph}</span>
                  <span>{item.label}</span>
                  {item.detail && <small className="dock-header-menu-detail">{item.detail}</small>}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}

export function DockHeaderRow({
  left,
  actions = [],
  onClose,
  closeLabel,
  expanded = false,
  onToggleExpanded,
  expandLabel,
  restoreLabel,
  className,
  ariaLabel,
}: {
  /** Accessible name for the row when it carries no visible title. */
  ariaLabel?: string;
  /** The surface identity: file chip, tab strip, or title text. */
  left: ReactNode;
  actions?: readonly DockAction[];
  onClose?(): void;
  closeLabel?: string;
  expanded?: boolean;
  /** Present only where the surface can expand. */
  onToggleExpanded?(): void;
  expandLabel?: string;
  restoreLabel?: string;
  className?: string;
}) {
  const dockExpand = useContext(PaneDockExpandContext);
  const toggleExpanded = onToggleExpanded ?? dockExpand?.toggle;
  const isExpanded = onToggleExpanded ? expanded : (dockExpand?.expanded ?? expanded);
  const { inline, menu } = splitDockActions(actions);
  const closeText = closeLabel ?? t('Close panel');
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the row takes the group role whenever it carries a name.
    <div
      className={`dock-header-row${className ? ` ${className}` : ''}`}
      data-dock-header=""
      role={ariaLabel ? 'group' : undefined}
      aria-label={ariaLabel}
    >
      <div className="dock-header-left">{left}</div>
      <div className="dock-header-controls">
        {inline.map((action) => {
          const Glyph = action.icon;
          return (
            <button
              key={action.id}
              type="button"
              className="browser-pane-nav-button"
              aria-label={action.label}
              aria-pressed={action.checked === undefined ? undefined : action.checked}
              data-tooltip={action.label}
              disabled={action.disabled}
              onClick={action.onSelect}
            >
              {Glyph ? <Glyph size={15} aria-hidden={true} /> : <span>{action.label}</span>}
            </button>
          );
        })}
        {menu.length > 0 && <DockOverflowMenu items={menu} />}
        {toggleExpanded && (
          <button
            type="button"
            className="browser-pane-nav-button"
            aria-label={isExpanded ? (restoreLabel ?? t('Restore')) : (expandLabel ?? t('Expand'))}
            data-tooltip={isExpanded ? (restoreLabel ?? t('Restore')) : (expandLabel ?? t('Expand'))}
            onClick={toggleExpanded}
          >
            {isExpanded ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}
          </button>
        )}
        {onClose && (
          <button
            type="button"
            className="browser-pane-nav-button dock-header-close"
            aria-label={closeText}
            data-tooltip={closeText}
            onClick={onClose}
          >
            <X size={15} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
