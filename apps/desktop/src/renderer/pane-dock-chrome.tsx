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
import { anchoredPanelGeometry, anchoredPanelStyle, paneBounds } from './anchored-panel';
import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { useRowMenuClamp } from './row-menu-geometry';
import { useMobileRemoteSurface } from './mobile-surface';
import { commitImmediateOverlay } from './immediate-overlay';
import { usePhoneDockSwitchActions } from './phone-dock-switch';
import { useWorkspaceCover } from './workspace-cover';
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
  /** Draws attention (`data-attention`): an inline button is styled by the
   *  pane; a ⋯ item marks its glyph and puts a dot on the ⋯ button. */
  attention?: boolean;
  /** A small count over an inline glyph (e.g. findings); a ⋯ item shows it
   *  as its detail and dots the ⋯ button. */
  badge?: number;
  /** Menu only: a `checked` item is a single-choice radio unless this marks
   *  it an independent checkbox. */
  checkbox?: boolean;
  disabled?: boolean;
  /** Menu only: muted text after the label (e.g. problem counts). */
  detail?: string;
  /** Menu only: a hairline above this item starts a new group. */
  separatorBefore?: boolean;
  /** Menu only: a destructive item. */
  danger?: boolean;
  /** Inline only: the button opens this menu (same menu as ⋯) instead of
   *  selecting; `label` names the button and the menu, `attention` tints it
   *  and `detail` is its tooltip. */
  submenu?: readonly DockAction[];
}

/** In-flow dock surfaces (file, diff, Changes) share the dock's expanded
 *  state: the dock provides it and every DockHeaderRow below picks it up, so
 *  each shows the same expand/collapse control. Browser and terminal live in
 *  their own roots and pass their own props instead. */
export const PaneDockExpandContext = createContext<{ expanded: boolean; toggle(): void } | null>(null);

/** Splits header actions: `inline` ones are buttons, everything else is a ⋯
 *  menu item at every width. */
export function splitDockActions(actions: readonly DockAction[]): { inline: DockAction[]; menu: DockAction[] } {
  return { inline: actions.filter((action) => action.inline), menu: actions.filter((action) => !action.inline) };
}

/** Wheel mapping of the pane workspace strip: the vertical wheel drives the
 *  horizontal tab run (WorkspaceTabStrip `onWheel`). */
export function scrollTabListByWheel(
  event: { deltaX: number; deltaY: number },
  list: { scrollBy?: (options: ScrollToOptions) => void } | null
): void {
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (list && delta) list.scrollBy?.({ left: delta, behavior: 'auto' });
}

/** Surfaces live in their own React roots, so the header's X reaches the
 *  owning dock through this window event rather than a context. A session
 *  surface names its session, which picks the dock; otherwise the focused
 *  dock takes it. */
export const PANE_DOCK_CLOSE_EVENT = 'mixdog:pane-dock-close';
export type PaneDockCloseSurface = 'browser' | 'terminal' | 'session-diff' | 'visualize' | 'agent-session';
export function requestPaneDockClose(surface: PaneDockCloseSurface, sessionId?: string): void {
  window.dispatchEvent(new CustomEvent(PANE_DOCK_CLOSE_EVENT, { detail: { surface, sessionId } }));
}

const MENU_ITEM_HEIGHT = 28;
const MENU_ITEM_SEPARATOR = 5;
const MENU_PADDING = 10;

/** Fixed placement of the portalled ⋯ menu: the shared anchored-popup rule
 *  for a trailing trigger (anchored-panel.ts) — below the button, right edges
 *  aligned, 6px off, flipping above only when below cannot hold it and above
 *  is roomier. The menu sizes to its labels; the owner clamps it into the
 *  window once measured. */
export function dockMenuPlacement(
  anchor: { top: number; bottom: number; left: number; right: number },
  viewport: { width: number; height: number },
  items: readonly DockAction[],
  bounds = { left: 0, top: 0, right: viewport.width, bottom: viewport.height, ...viewport }
): CSSProperties {
  const estimated =
    items.length * MENU_ITEM_HEIGHT +
    items.filter((item) => item.separatorBefore).length * MENU_ITEM_SEPARATOR +
    MENU_PADDING;
  // Copied field by field: a DOMRect's edges are prototype getters.
  const { top, bottom, left, right } = anchor;
  const trigger = { top, bottom, left, right, width: right - left, height: bottom - top };
  const geometry = anchoredPanelGeometry({
    trigger,
    bounds,
    preferredWidth: 0,
    naturalHeight: estimated,
    align: 'end',
  });
  const { transformOrigin: _origin, ...style } = anchoredPanelStyle(geometry, trigger);
  // Right-pinned, the menu grows leftward: never past the pane's left inset
  // (useRowMenuClamp lets the CSS min-width yield to this room).
  return { ...style, maxWidth: Math.max(0, geometry.left + geometry.width - bounds.left - 8) };
}

/** False once the menu's owner is detached, `hidden`/`inert`, or inside a
 *  `display: none` / `visibility: hidden` ancestor. */
function dockMenuOwnerActive(owner: Element): boolean {
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

function menuNavigationTarget(key: string, enabled: HTMLButtonElement[], index: number): HTMLButtonElement | undefined {
  if (key === 'ArrowDown') return enabled[(index + 1) % enabled.length];
  if (key === 'ArrowUp') return enabled[(index <= 0 ? enabled.length : index) - 1];
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled[enabled.length - 1];
  return undefined;
}

function DockMenuItemButton({ item, onPick }: { item: DockAction; onPick(): void }) {
  const Glyph = item.icon;
  let glyph: ReactNode = null;
  if (item.checked) glyph = <Check size={14} aria-hidden={true} />;
  else if (Glyph) glyph = <Glyph size={15} aria-hidden={true} />;
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is menuitemcheckbox/menuitemradio whenever `checked` is set.
    <button
      type="button"
      role={dockMenuItemRole(item)}
      aria-checked={item.checked}
      className={
        [item.separatorBefore ? 'has-separator' : '', item.danger ? 'danger' : ''].filter(Boolean).join(' ') ||
        undefined
      }
      data-attention={item.attention || item.badge ? 'true' : undefined}
      disabled={item.disabled}
      onClick={() => {
        onPick();
        item.onSelect();
      }}
    >
      <span className="dock-header-menu-glyph">{glyph}</span>
      <span>{item.label}</span>
      {(item.detail || item.badge) && (
        <small className="dock-header-menu-detail">{item.detail || String(item.badge)}</small>
      )}
    </button>
  );
}

function DockInlineAction({ action }: { action: DockAction }) {
  if (action.submenu) {
    return (
      <DockOverflowMenu
        items={action.submenu}
        opener={{
          icon: action.icon,
          label: action.label,
          attention: action.attention,
          tooltip: action.detail,
        }}
      />
    );
  }
  const Glyph = action.icon;
  const badgeText = action.badge && action.badge > 99 ? '99+' : action.badge;
  return (
    <button
      type="button"
      className="browser-pane-nav-button"
      aria-label={action.label}
      aria-pressed={action.checked}
      data-attention={action.attention ? 'true' : undefined}
      data-tooltip={action.label}
      disabled={action.disabled}
      onClick={action.onSelect}
    >
      {Glyph ? <Glyph size={15} aria-hidden={true} /> : <span>{action.label}</span>}
      {action.badge ? <span className="dock-action-badge">{badgeText}</span> : null}
    </button>
  );
}

export function DockOverflowMenu({
  items,
  opener,
}: {
  items: readonly DockAction[];
  /** A dedicated header button (icon, name, tooltip) instead of ⋯. */
  opener?: Pick<DockAction, 'icon' | 'label' | 'attention'> & { tooltip?: string };
}) {
  const TriggerGlyph = opener?.icon ?? MoreHorizontal;
  const triggerLabel = opener?.label ?? t('More actions');
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  useRowMenuClamp(open, menu);
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
        items,
        paneBounds(button)
      )
    );
  }, [items]);
  const enabledItems = () =>
    Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)') ?? []);
  const close = () => {
    commitImmediateOverlay(() => setOpen(false));
    trigger.current?.focus();
  };
  useMobileBack(open, close);
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
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        enabled[index]?.click();
        return;
      }
      const next = menuNavigationTarget(event.key, enabled, index);
      if (!next) return;
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
        aria-label={triggerLabel}
        data-attention={opener?.attention ? 'true' : undefined}
        data-tooltip={opener?.tooltip ?? triggerLabel}
        onClick={() =>
          commitImmediateOverlay(() => {
            if (!open) place();
            setOpen(!open);
          })
        }
      >
        <TriggerGlyph size={15} aria-hidden={true} />
        {!opener && items.some((item) => item.attention || item.badge) ? (
          <span className="dock-header-more-dot" aria-hidden="true" />
        ) : null}
      </button>
      {open &&
        createPortal(
          <div ref={menu} className="dock-header-menu" role="menu" aria-label={triggerLabel} style={placement}>
            {items.map((item) => (
              <DockMenuItemButton key={item.id} item={item} onPick={close} />
            ))}
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
  controlsLead,
}: {
  /** Accessible name for the row when it carries no visible title. */
  ariaLabel?: string;
  /** A control group drawn before the action buttons (the file view switch). */
  controlsLead?: ReactNode;
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
  // The phone sheet is already full-screen: expanding would only lift the
  // header out of the sheet (fixed, over the transformed frame) and leave the
  // body behind it.
  const phone = useMobileRemoteSurface();
  const toggleExpanded = phone ? undefined : (onToggleExpanded ?? dockExpand?.toggle);
  const isExpanded = onToggleExpanded ? expanded : (dockExpand?.expanded ?? expanded);
  // An expanded dock, browser or terminal fills the main panel over the chat.
  useWorkspaceCover(isExpanded);
  const phoneSwitch = usePhoneDockSwitchActions(phone);
  const split = splitDockActions(actions);
  const inline = split.inline;
  const menu = [...split.menu, ...phoneSwitch];
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
        {controlsLead}
        {inline.map((action) => (
          <DockInlineAction key={action.id} action={action} />
        ))}
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
