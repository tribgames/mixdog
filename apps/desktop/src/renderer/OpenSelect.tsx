import React, {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Check, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { createPortal } from 'react-dom';

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
  displayValue?: string;
  onChange?: (value: string) => void;
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
  displayValue,
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
  const listboxId = useId();
  const typeahead = useRef({ value: '', timer: 0 });
  const pendingActive = useRef<number | null>(null);
  const restoreFocusAfterDisabled = useRef(false);
  const enabledIndexes = useMemo(() => options.flatMap((option, index) =>
    option.disabled ? [] : [index]), [options]);
  const selected = options.find((option) => option.value === current);
  const settingsStyle = className.split(/\s+/).includes('settings-select');
  const activeOption = options[active]?.disabled ? undefined : options[active];

  const updatePosition = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const viewport = window.visualViewport;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const sheet = trigger.current?.closest<HTMLElement>('.workspace, .session-sidebar');
    const sheetBounds = sheet?.getBoundingClientRect();
    const bounds = sheetBounds && sheetBounds.width > 0 && sheetBounds.height > 0
      ? sheetBounds
      : {
        left: viewportLeft,
        top: viewportTop,
        right: viewportLeft + viewportWidth,
        bottom: viewportTop + viewportHeight,
      };
    const edge = 8;
    const width = Math.min(
      Math.max(160, Math.min(368, rect.width)),
      Math.max(0, bounds.right - bounds.left - edge * 2),
    );
    const estimatedHeight = Math.min(240, options.length * 30 + 8);
    const spaceBelow = bounds.bottom - rect.bottom - edge;
    const spaceAbove = rect.top - bounds.top - edge;
    const openAbove = spaceBelow < Math.min(160, estimatedHeight) && spaceAbove > spaceBelow;
    const availableHeight = Math.max(0, (openAbove ? spaceAbove : spaceBelow) - 4);
    const viewportMaxHeight = Math.min(240, viewportHeight - edge * 2);
    const maxHeight = Math.min(viewportMaxHeight, availableHeight);
    const idealLeft = settingsStyle ? rect.right - width : rect.left;
    const left = Math.max(
      bounds.left + edge,
      Math.min(bounds.right - width - edge, idealLeft),
    );
    setPosition({
      left,
      width,
      ...(openAbove
        ? {
          bottom: Math.max(edge, viewportHeight - bounds.bottom + (bounds.bottom - rect.top + 4)),
          maxHeight,
          transformOrigin: 'bottom center',
        }
        : { top: Math.min(bounds.bottom - edge, rect.bottom + 4), maxHeight, transformOrigin: 'top center' }),
    });
  }, [options.length, settingsStyle]);

  const select = (next: string) => {
    if (!controlled) setInternalValue(next);
    onChange?.(next);
    setOpen(false);
    queueMicrotask(() => trigger.current?.focus());
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const selectedIndex = options.findIndex((option) => option.value === current && !option.disabled);
    const initialIndex = pendingActive.current ??
      (selectedIndex >= 0 ? selectedIndex : (enabledIndexes[0] ?? 0));
    pendingActive.current = null;
    setActive(initialIndex);
    queueMicrotask(() => {
      const item = menu.current?.querySelector<HTMLElement>('[data-active="true"]');
      item?.focus();
      item?.scrollIntoView?.({ block: 'nearest' });
    });
  }, [current, open, options.length, updatePosition]);

  useEffect(() => {
    if (!open) return;
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
  }, [open, updatePosition]);

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
      const item = menu.current?.querySelectorAll<HTMLElement>('.oc-menu-item')[next];
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
    if (event.key === 'Tab' && open) {
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
        if (!open) {
          pendingActive.current = match;
          setOpen(true);
        }
        setActive(match);
      }
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (!open) {
      setOpen(true);
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

  return <div ref={root} className={`oc-select-root ${className}`.trim()}
    data-trigger-style={settingsStyle ? 'settings' : 'default'}>
    {name && <input type="hidden" name={name} value={current} required={required} />}
    <button ref={trigger} type="button" className="oc-select-trigger" role="combobox"
      aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={listboxId}
      aria-activedescendant={open && activeOption ? `${listboxId}-option-${active}` : undefined}
      disabled={disabled} onClick={() => setOpen((currentOpen) => !currentOpen)} onKeyDown={onKeyDown}>
      <span className="oc-select-value">{displayValue || selected?.label || options[0]?.label || 'Select…'}</span>
      {settingsStyle
        ? <ChevronsUpDown size={14} aria-hidden="true" />
        : <ChevronDown size={16} aria-hidden="true" />}
    </button>
    {open && createPortal(<div ref={menu} id={listboxId} className="oc-menu" role="listbox"
      data-trigger-style={settingsStyle ? 'settings' : 'default'}
      aria-label={ariaLabel} style={position} onKeyDown={onKeyDown}>
      {options.map((option, index) => <button type="button" role="option" className="oc-menu-item"
        id={`${listboxId}-option-${index}`} disabled={option.disabled}
        aria-selected={option.value === current} data-active={index === active} tabIndex={index === active ? 0 : -1}
        key={option.value} onMouseEnter={() => setActive(index)} onClick={() => select(option.value)}>
        <span>{option.label}</span>{option.value === current && <Check size={16} aria-hidden="true" />}
      </button>)}
    </div>, document.body)}
  </div>;
}
