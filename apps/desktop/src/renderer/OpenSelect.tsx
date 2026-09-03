import React, {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { registerMobileBack } from './mobile-back';
import { MxIcon } from './MxIcon';
import { useSurfaceActive } from './surface-activity';

export interface OpenSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface OpenSelectProps {
  options: ReadonlyArray<OpenSelectOption>;
  value?: string;
  defaultValue?: string;
  name?: string;
  ariaLabel: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  variant?: 'default' | 'route';
  displayValue?: string;
  leading?: React.ReactNode;
  onChange?: (value: string) => void;
  /** Catalog labels (effort levels) stay in English; generic keys like Medium collide. */
  localizeLabels?: boolean;
  /** Menu floor in px for icon-only triggers whose options are wider than
   *  the trigger (the browser viewport picker: a 44px button listing
   *  "iPhone 14 Pro Max · 430×932"). Default follows the trigger width. */
  menuMinWidth?: number;
}

type MenuPosition = CSSProperties & { transformOrigin?: string };

export function OpenSelect({
  options,
  value,
  defaultValue = '',
  name,
  ariaLabel,
  disabled = false,
  required = false,
  className = '',
  variant = 'default',
  displayValue,
  leading,
  menuMinWidth = 160,
  onChange,
  localizeLabels = true,
}: OpenSelectProps) {
  const controlled = value !== undefined;
  const [internalValue, setInternalValue] = useState(defaultValue);
  const current = controlled ? String(value) : internalValue;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<MenuPosition>({});
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const preparedPosition = useRef<MenuPosition | null>(null);
  const clickGuard = useImmediateOverlayClickGuard();
  const listboxId = useId();
  // Retained (inert) Dock tabs keep their pickers mounted; the listbox is a
  // body portal, so it closes with the owning surface instead of surviving as
  // an interactive orphan over another pane.
  const surfaceActive = useSurfaceActive();
  const menuOpen = open && surfaceActive;
  useEffect(() => {
    if (!surfaceActive && open) setOpen(false);
  }, [open, surfaceActive]);
  const typeahead = useRef({ value: '', timer: 0 });
  const pendingActive = useRef<number | null>(null);
  const restoreFocusAfterDisabled = useRef(false);
  const enabledIndexes = useMemo(() => options.flatMap((option, index) =>
    option.disabled ? [] : [index]), [options]);
  const selected = options.find((option) => option.value === current);
  const routeStyle = variant === 'route';
  const settingsStyle = className.split(/\s+/).includes('settings-select');
  // The composer pills and the route workflow chip read as ONE control each:
  // the menu hangs off the pill, never off the inner button, or two pickers
  // sitting in the same bar line up on different edges (user: 정렬 잘 시켜서).
  const contextPillStyle = className.split(/\s+/).includes('context-pill-select')
    || className.split(/\s+/).includes('project-context-select')
    || className.split(/\s+/).includes('workflow-context-select');
  const activeOption = options[active]?.disabled ? undefined : options[active];
  const triggerLabel = displayValue || selected?.label || options[0]?.label || 'Select…';
  const shownLabel = (label: string) => localizeLabels ? t(label) : label;
  const skipI18n = localizeLabels ? undefined : '';

  const readPosition = useCallback((): MenuPosition | null => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return null;
    const contextPillAnchor = contextPillStyle
      ? trigger.current?.closest<HTMLElement>(
        '.composer-project-context, .composer-workflow-context',
      )?.getBoundingClientRect()
      : null;
    const anchorRect = contextPillAnchor || rect;
    const menuGap = contextPillStyle ? 2 : 4;
    const viewport = window.visualViewport;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const visible = {
      left: viewportLeft,
      top: viewportTop,
      right: viewportLeft + viewportWidth,
      bottom: viewportTop + viewportHeight,
    };
    // A split workspace makes the PANE the real box: measuring against the
    // whole workspace flips the menu against room that belongs to a different
    // pane, and lets it paint across the divider.
    const sheet = trigger.current?.closest<HTMLElement>(
      '.pane-leaf, .workspace, .session-sidebar',
    );
    const sheetBounds = sheet?.getBoundingClientRect();
    // A phone keeps the workspace box at full height while the keyboard and
    // the browser chrome cover its bottom, so the sheet alone reports room
    // that does not exist. Clipping it to what is actually visible is what
    // makes the flip decision below honest (user: 버튼 아래 떠서 불편).
    const bounds = sheetBounds && sheetBounds.width > 0 && sheetBounds.height > 0
      ? {
        left: Math.max(sheetBounds.left, visible.left),
        top: Math.max(sheetBounds.top, visible.top),
        right: Math.min(sheetBounds.right, visible.right),
        bottom: Math.min(sheetBounds.bottom, visible.bottom),
      }
      : visible;
    const edge = 8;
    const width = Math.min(
      Math.max(menuMinWidth, Math.min(368, anchorRect.width)),
      Math.max(0, bounds.right - bounds.left - edge * 2),
    );
    const estimatedHeight = Math.min(240, options.length * 30 + 8);
    const spaceBelow = bounds.bottom - anchorRect.bottom - edge;
    const spaceAbove = anchorRect.top - bounds.top - edge;
    // Flip as soon as the WHOLE menu misses below and above is roomier, rather
    // than waiting for the old 160px floor: a composer control sits at the
    // bottom of the screen, where "some space below" is still a cramped strip.
    // Composer context pills sit directly ON TOP of the input card, so the
    // room below them is the textarea, never free space — they open upward
    // and only fall back down when the menu cannot fit above at all
    // (user: 아래로 열리잖아).
    const openAbove = contextPillStyle
      ? spaceAbove >= estimatedHeight || spaceAbove > spaceBelow
      : spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
    const availableHeight = Math.max(0, (openAbove ? spaceAbove : spaceBelow) - menuGap);
    const viewportMaxHeight = Math.min(240, viewportHeight - edge * 2);
    const maxHeight = Math.min(viewportMaxHeight, availableHeight);
    const idealLeft = settingsStyle ? rect.right - width : anchorRect.left;
    const left = Math.max(
      bounds.left + edge,
      Math.min(bounds.right - width - edge, idealLeft),
    );
    return {
      left,
      width,
      ...(openAbove
        ? {
          // `bottom` on a fixed element resolves against the LAYOUT viewport,
          // so an upward menu must measure from that height. The visual height
          // shrinks with the keyboard and dropped the menu onto its trigger.
          bottom: Math.max(
            edge,
            (document.documentElement.clientHeight || window.innerHeight)
              - anchorRect.top + menuGap,
          ),
          maxHeight,
          transformOrigin: 'bottom center',
        }
        : { top: Math.min(bounds.bottom - edge, anchorRect.bottom + menuGap), maxHeight, transformOrigin: 'top center' }),
    };
  }, [contextPillStyle, menuMinWidth, options.length, settingsStyle]);
  const rememberPosition = useCallback(() => {
    const next = readPosition();
    if (next) preparedPosition.current = next;
    return next;
  }, [readPosition]);
  const updatePosition = useCallback(() => {
    const next = rememberPosition();
    if (next) setPosition(next);
  }, [rememberPosition]);
  const commitMenuOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      commitImmediateOverlay(() => setOpen(false));
      return;
    }
    const nextPosition = preparedPosition.current ?? rememberPosition();
    const selectedIndex = options.findIndex((option) =>
      option.value === current && !option.disabled);
    const initialIndex = pendingActive.current ??
      (selectedIndex >= 0 ? selectedIndex : (enabledIndexes[0] ?? 0));
    pendingActive.current = null;
    commitImmediateOverlay(() => {
      if (nextPosition) setPosition(nextPosition);
      setActive(initialIndex);
      setOpen(true);
    });
  };
  const toggleMenu = () => commitMenuOpen(!open);

  const select = (next: string) => {
    if (!controlled) setInternalValue(next);
    onChange?.(next);
    setOpen(false);
    queueMicrotask(() => trigger.current?.focus());
  };

  useEffect(() => {
    if (!menuOpen) return;
    queueMicrotask(() => {
      const item = menu.current?.querySelector<HTMLElement>('[data-active="true"]');
      item?.focus();
      item?.scrollIntoView?.({ block: 'nearest' });
    });
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) preparedPosition.current = null;
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return undefined;
    return registerMobileBack(() => {
      setOpen(false);
      queueMicrotask(() => trigger.current?.focus());
    });
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (root.current?.contains(target) || menu.current?.contains(target)) return;
      setOpen(false);
    };
    const reposition = () => updatePosition();
    document.addEventListener('pointerdown', close, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    window.visualViewport?.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('scroll', reposition);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      window.visualViewport?.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('scroll', reposition);
    };
  }, [menuOpen, updatePosition]);

  useEffect(() => {
    if (disabled) {
      if (open) {
        restoreFocusAfterDisabled.current = true;
        setOpen(false);
      }
      return;
    }
    if (restoreFocusAfterDisabled.current) {
      restoreFocusAfterDisabled.current = false;
      queueMicrotask(() => {
        const active = document.activeElement;
        if (!active || active === document.body || active === document.documentElement) {
          trigger.current?.focus();
        }
      });
    }
  }, [disabled, open]);

  useEffect(() => () => window.clearTimeout(typeahead.current.timer), []);

  const moveActive = (direction: 1 | -1, boundary?: 'first' | 'last') => {
    if (!enabledIndexes.length) return;
    const currentIndex = enabledIndexes.indexOf(active);
    const next = boundary === 'first' ? enabledIndexes[0]
      : boundary === 'last' ? enabledIndexes.at(-1)!
        : enabledIndexes[(Math.max(0, currentIndex) + direction + enabledIndexes.length) % enabledIndexes.length];
    setActive(next);
    queueMicrotask(() => {
      const item = menu.current?.querySelectorAll<HTMLElement>('.mx-menu-item')[next];
      item?.focus();
      item?.scrollIntoView?.({ block: 'nearest' });
    });
  };

  const moveFocusAfterTrigger = (backward: boolean) => {
    const focusScope = trigger.current?.closest<HTMLElement>('[role="dialog"][aria-modal="true"]') || document;
    const focusable = Array.from(focusScope.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), ' +
      'select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !menu.current?.contains(element) && element.getClientRects().length > 0);
    const index = focusable.indexOf(trigger.current!);
    const offset = backward ? -1 : 1;
    const origin = index >= 0 ? index : (backward ? 0 : -1);
    const next = focusable.length
      ? focusable[(origin + offset + focusable.length) % focusable.length]
      : trigger.current;
    setOpen(false);
    window.setTimeout(() => next?.focus(), 0);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (event.key === 'Tab' && menuOpen) {
      event.preventDefault();
      moveFocusAfterTrigger(event.shiftKey);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
      const nextQuery = `${typeahead.current.value}${event.key}`.toLocaleLowerCase();
      typeahead.current.value = nextQuery;
      window.clearTimeout(typeahead.current.timer);
      typeahead.current.timer = window.setTimeout(() => { typeahead.current.value = ''; }, 500);
      const match = options.findIndex((option) =>
        !option.disabled && option.label.toLocaleLowerCase().startsWith(nextQuery));
      if (match >= 0) {
        event.preventDefault();
        if (!menuOpen) {
          pendingActive.current = match;
          commitMenuOpen(true);
          return;
        }
        setActive(match);
      }
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (!menuOpen) {
      commitMenuOpen(true);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const option = options[active];
      if (option) select(option.value);
      return;
    }
    if (event.key === 'Home' || event.key === 'PageUp') moveActive(1, 'first');
    else if (event.key === 'End' || event.key === 'PageDown') moveActive(-1, 'last');
    else moveActive(event.key === 'ArrowDown' ? 1 : -1);
  };

  return <div ref={root} className={`mx-select-root ${routeStyle ? 'route-select' : ''} ${className}`.trim()}
    data-trigger-style={routeStyle ? 'route' : settingsStyle ? 'settings' : 'default'}>
    {name && <input type="hidden" name={name} value={current} required={required} />}
    <button ref={trigger} type="button" className="mx-select-trigger" role="combobox"
      aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={menuOpen} aria-controls={listboxId}
      aria-activedescendant={menuOpen && activeOption ? `${listboxId}-option-${active}` : undefined}
      disabled={disabled}
      onPointerEnter={rememberPosition}
      onFocus={rememberPosition}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        clickGuard.markPointerActivation();
        toggleMenu();
      }}
      onClick={(event) => {
        if (clickGuard.consumePointerClick()) return;
        if (event.detail !== 0) return;
        toggleMenu();
      }}
      onPointerCancel={clickGuard.clearPointerActivation}
      onKeyDown={onKeyDown}>
      {leading && <span className="mx-select-leading">{leading}</span>}
      <span className="mx-select-value" data-i18n-skip={skipI18n}>{shownLabel(triggerLabel)}</span>
      {routeStyle
        ? <MxIcon name="chevron-down" size={14} />
        : settingsStyle
        ? <MxIcon name="chevron-grabber-vertical" size={14} />
        : <MxIcon name="chevron-down" size={16} />}
    </button>
    {menuOpen && createPortal(<div ref={menu} id={listboxId} className="mx-menu" role="listbox"
      data-trigger-style={routeStyle ? 'route' : settingsStyle ? 'settings' : 'default'}
      data-i18n-skip={skipI18n} aria-label={ariaLabel} style={position} onKeyDown={onKeyDown}>
      {options.map((option, index) => <button type="button" role="option" className="mx-menu-item"
        id={`${listboxId}-option-${index}`} disabled={option.disabled}
        aria-selected={option.value === current} data-active={index === active} tabIndex={index === active ? 0 : -1}
        key={option.value} onMouseEnter={() => setActive(index)} onClick={() => select(option.value)}>
        <span>{shownLabel(option.label)}</span>{option.value === current && <MxIcon name="check-small" size={16} />}
      </button>)}
    </div>, document.body)}
  </div>;
}
