import { anchoredPanelGeometry, anchoredPanelStyle, paneBounds } from './anchored-panel';
import React, { type CSSProperties, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { registerMobileBack } from './mobile-back';
import { MxIcon } from './MxIcon';
import { useSurfaceActive } from './surface-activity';

interface OpenSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  /** A rule above this option, setting it (and those after it) apart. */
  separatorBefore?: boolean;
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
  tooltip?: string;
  leading?: React.ReactNode;
  onChange?: (value: string) => void;
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
  tooltip,
  leading,
  menuMinWidth = 160,
  onChange,
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
  const enabledIndexes = useMemo(() => options.flatMap((option, index) => (option.disabled ? [] : [index])), [options]);
  const selected = options.find((option) => option.value === current);
  const routeStyle = variant === 'route';
  const classNames = className.split(/\s+/);
  const settingsStyle = classNames.includes('settings-select');
  // The composer pills and the route workflow chip read as ONE control each:
  // the menu hangs off the pill, never off the inner button, or two pickers
  // sitting in the same bar line up on different edges (user: 정렬 잘 시켜서).
  const contextPillStyle =
    classNames.includes('context-pill-select') ||
    classNames.includes('project-context-select') ||
    classNames.includes('workflow-context-select');
  const activeOption = options[active]?.disabled ? undefined : options[active];
  const triggerLabel = displayValue || selected?.label || options[0]?.label || t('Select…');

  const readPosition = useCallback((): MenuPosition | null => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return null;
    const contextPillAnchor = contextPillStyle
      ? trigger.current
          ?.closest<HTMLElement>('.composer-project-context, .composer-workflow-context')
          ?.getBoundingClientRect()
      : null;
    const anchorRect = contextPillAnchor || rect;
    // The shared placement (anchored-panel.ts): below, left edges aligned.
    // A settings row's trailing select aligns right edges; the composer
    // context pills sit at the bottom of the screen ON TOP of the input, so
    // they open above (the whole pill is the anchor) and fall below only
    // when above cannot hold the menu.
    const estimatedHeight = Math.min(240, options.length * 30 + 8);
    const geometry = anchoredPanelGeometry({
      trigger: anchorRect,
      bounds: paneBounds(trigger.current),
      preferredWidth: Math.max(menuMinWidth, Math.min(368, anchorRect.width)),
      naturalHeight: estimatedHeight,
      align: settingsStyle ? 'end' : 'start',
      placement: contextPillStyle ? 'above' : 'below',
    });
    const style = anchoredPanelStyle(geometry, anchorRect);
    return { ...style, width: geometry.width, maxHeight: Math.min(240, style.maxHeight) };
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
    const selectedIndex = options.findIndex((option) => option.value === current && !option.disabled);
    const initialIndex = pendingActive.current ?? (selectedIndex >= 0 ? selectedIndex : (enabledIndexes[0] ?? 0));
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
    let next = enabledIndexes[(Math.max(0, currentIndex) + direction + enabledIndexes.length) % enabledIndexes.length];
    if (boundary === 'first') next = enabledIndexes[0];
    else if (boundary === 'last') next = enabledIndexes[enabledIndexes.length - 1];
    setActive(next);
    queueMicrotask(() => {
      const item = menu.current?.querySelectorAll<HTMLElement>('.mx-menu-item')[next];
      item?.focus();
      item?.scrollIntoView?.({ block: 'nearest' });
    });
  };

  const moveFocusAfterTrigger = (backward: boolean) => {
    const focusScope = trigger.current?.closest<HTMLElement>('[role="dialog"][aria-modal="true"]') || document;
    const focusable = Array.from(
      focusScope.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), ' +
          'select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => !menu.current?.contains(element) && element.getClientRects().length > 0);
    const index = focusable.indexOf(trigger.current!);
    const offset = backward ? -1 : 1;
    let origin = backward ? 0 : -1;
    if (index >= 0) origin = index;
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
      typeahead.current.timer = window.setTimeout(() => {
        typeahead.current.value = '';
      }, 500);
      const match = options.findIndex(
        (option) => !option.disabled && option.label.toLocaleLowerCase().startsWith(nextQuery)
      );
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

  let triggerStyle = 'default';
  if (routeStyle) triggerStyle = 'route';
  else if (settingsStyle) triggerStyle = 'settings';
  let chevron = <MxIcon name="chevron-down" size={16} />;
  if (routeStyle) chevron = <MxIcon name="chevron-down" size={14} />;
  // Settings selects share the app's one chevron (polish pass: the up/down
  // grabber read as a native stepper).
  else if (settingsStyle) chevron = <MxIcon name="chevron-down" size={14} />;

  return (
    <div
      ref={root}
      className={`mx-select-root ${routeStyle ? 'route-select' : ''} ${className}`.trim()}
      data-trigger-style={triggerStyle}
    >
      {name && <input type="hidden" name={name} value={current} required={required} />}
      <button
        ref={trigger}
        type="button"
        className="mx-select-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-description={tooltip || undefined}
        data-tooltip={tooltip || undefined}
        data-tooltip-side={contextPillStyle ? 'top' : undefined}
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
        aria-controls={listboxId}
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
        onKeyDown={onKeyDown}
      >
        {leading && <span className="mx-select-leading">{leading}</span>}
        <span className="mx-select-value">{triggerLabel}</span>
        {chevron}
      </button>
      {menuOpen &&
        createPortal(
          <div
            ref={menu}
            id={listboxId}
            className="mx-menu"
            role="listbox"
            data-trigger-style={triggerStyle}
            aria-label={ariaLabel}
            style={position}
            onKeyDown={onKeyDown}
          >
            {options.map((option, index) => (
              <React.Fragment key={option.value}>
                {/* biome-ignore lint/a11y/useSemanticElements: <hr> default border/margin would change the styling. */}
                {option.separatorBefore && <div className="usage-menu-separator" role="separator" />}
                <button
                  type="button"
                  role="option"
                  className="mx-menu-item"
                  id={`${listboxId}-option-${index}`}
                  disabled={option.disabled}
                  aria-selected={option.value === current}
                  aria-description={option.description || undefined}
                  data-tooltip={option.description || undefined}
                  data-tooltip-side={option.description ? 'right' : undefined}
                  data-active={index === active}
                  tabIndex={index === active ? 0 : -1}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => select(option.value)}
                >
                  <span>{option.label}</span>
                  {option.value === current && <MxIcon name="check-small" size={16} />}
                </button>
              </React.Fragment>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}
