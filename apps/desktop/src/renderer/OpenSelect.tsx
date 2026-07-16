import React, {
  type CSSProperties,
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
  const enabled = useMemo(() => options.filter((option) => !option.disabled), [options]);
  const selected = options.find((option) => option.value === current);
  const settingsStyle = className.split(/\s+/).includes('settings-select');
  const activeOption = enabled[active];

  const updatePosition = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(160, Math.min(368, rect.width));
    const estimatedHeight = Math.min(240, options.length * 30 + 8);
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const openAbove = spaceBelow < Math.min(160, estimatedHeight) && rect.top > spaceBelow;
    setPosition({
      left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.left)),
      width,
      ...(openAbove
        ? { bottom: Math.max(8, window.innerHeight - rect.top + 4), transformOrigin: 'bottom center' }
        : { top: Math.min(window.innerHeight - 8, rect.bottom + 4), transformOrigin: 'top center' }),
    });
  };

  const select = (next: string) => {
    if (!controlled) setInternalValue(next);
    onChange?.(next);
    setOpen(false);
    queueMicrotask(() => trigger.current?.focus());
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const selectedIndex = Math.max(0, enabled.findIndex((option) => option.value === current));
    setActive(selectedIndex);
    queueMicrotask(() => menu.current?.querySelector<HTMLElement>('[data-active="true"]')?.focus());
  }, [current, enabled, open, options.length]);

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
    return () => {
      document.removeEventListener('pointerdown', close, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (!open) {
      setOpen(true);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const option = enabled[active];
      if (option) select(option.value);
      return;
    }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? Math.max(0, enabled.length - 1)
      : event.key === 'ArrowDown' ? Math.min(enabled.length - 1, active + 1) : Math.max(0, active - 1);
    setActive(next);
    queueMicrotask(() => menu.current?.querySelectorAll<HTMLElement>('.oc-menu-item')[next]?.focus());
  };

  return <div ref={root} className={`oc-select-root ${className}`.trim()}
    data-trigger-style={settingsStyle ? 'settings' : 'default'}>
    {name && <input type="hidden" name={name} value={current} required={required} />}
    <button ref={trigger} type="button" className="oc-select-trigger" role="combobox"
      aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={listboxId}
      aria-activedescendant={open && activeOption ? `${listboxId}-${activeOption.value}` : undefined}
      disabled={disabled} onClick={() => setOpen((currentOpen) => !currentOpen)} onKeyDown={onKeyDown}>
      <span className="oc-select-value">{selected?.label || options[0]?.label || 'Select…'}</span>
      {settingsStyle
        ? <ChevronsUpDown size={14} aria-hidden="true" />
        : <ChevronDown size={16} aria-hidden="true" />}
    </button>
    {open && createPortal(<div ref={menu} id={listboxId} className="oc-menu" role="listbox"
      data-trigger-style={settingsStyle ? 'settings' : 'default'}
      aria-label={ariaLabel} style={position} onKeyDown={onKeyDown}>
      {enabled.map((option, index) => <button type="button" role="option" className="oc-menu-item"
        id={`${listboxId}-${option.value}`}
        aria-selected={option.value === current} data-active={index === active} tabIndex={index === active ? 0 : -1}
        key={option.value} onMouseEnter={() => setActive(index)} onClick={() => select(option.value)}>
        <span>{option.label}</span>{option.value === current && <Check size={16} aria-hidden="true" />}
      </button>)}
    </div>, document.body)}
  </div>;
}
