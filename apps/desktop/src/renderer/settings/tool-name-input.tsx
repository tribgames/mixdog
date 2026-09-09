import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

/** Editable tool names with a viewport-bounded suggestion list. Unknown
 * names remain valid input; the catalog is assistance, not validation. */
export function ToolNameInput({ value, options, disabled, ariaLabel, placeholder, onChange }: {
  value: string;
  options: ReadonlyArray<{ value: string; description?: string }>;
  disabled?: boolean;
  ariaLabel: string;
  placeholder?: string;
  onChange(value: string): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const matches = options.filter(option =>
    `${option.value} ${option.description || ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selectedIndex = Math.min(active, matches.length - 1);
  const visible = open && !disabled && matches.length > 0 && position !== null;

  useLayoutEffect(() => {
    if (!open || disabled) return;
    const place = () => {
      const rect = input.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
      const topEdge = (viewport?.offsetTop ?? 0) + 8;
      const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 16;
      const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 16;
      if (rect.bottom < topEdge || rect.top > bottomEdge || rect.right < leftEdge || rect.left > rightEdge) {
        setPosition(null);
        return;
      }
      const width = Math.max(0, Math.min(Math.max(160, rect.width), 368, rightEdge - leftEdge));
      const below = Math.max(0, bottomEdge - rect.bottom - 4);
      const above = Math.max(0, rect.top - topEdge - 4);
      const upward = below < Math.min(240, matches.length * 32 + 8) && above > below;
      const height = Math.min(240, upward ? above : below);
      if (height < 24 || width < 24) { setPosition(null); return; }
      setPosition({
        position: 'fixed', boxSizing: 'border-box', minWidth: 0, width, maxWidth: width,
        maxHeight: height, overflowY: 'auto', overscrollBehavior: 'contain',
        left: Math.max(leftEdge, Math.min(rect.left, rightEdge - width)),
        ...(upward
          ? { bottom: window.innerHeight - rect.top + 4, transformOrigin: 'bottom center' }
          : { top: rect.bottom + 4, transformOrigin: 'top center' }),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (input.current) observer?.observe(input.current);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      observer?.disconnect();
    };
  }, [open, disabled, matches.length]);

  useEffect(() => {
    if (!visible) return;
    menu.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [visible, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (input.current?.contains(target) || menu.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [open]);

  const show = () => {
    setQuery('');
    setActive(Math.max(0, options.findIndex(option => option.value === value)));
    setOpen(true);
  };
  const select = (next: string) => { onChange(next); setOpen(false); };

  return <>
    <input ref={input} role="combobox" aria-label={ariaLabel} aria-autocomplete="list"
      aria-expanded={visible} aria-controls={visible ? id : undefined}
      aria-activedescendant={visible && selectedIndex >= 0 ? `${id}-${selectedIndex}` : undefined}
      value={value} disabled={disabled} placeholder={placeholder} spellCheck={false} autoComplete="off"
      onFocus={show} onClick={() => { if (!open) show(); }} onBlur={() => setOpen(false)}
      onChange={event => {
        onChange(event.target.value);
        setQuery(event.target.value);
        setActive(0);
        setOpen(true);
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          event.stopPropagation();
          if (!open) show();
          else setActive(index => Math.max(0, Math.min(matches.length - 1,
            index + (event.key === 'ArrowDown' ? 1 : -1))));
        } else if (event.key === 'Enter' && visible && matches[selectedIndex]) {
          event.preventDefault();
          event.stopPropagation();
          select(matches[selectedIndex].value);
        } else if (event.key === 'Tab') setOpen(false);
      }} />
    {visible && createPortal(<div ref={menu} id={id} role="listbox" aria-label={ariaLabel}
      className="mx-menu" data-i18n-skip="" style={position!}>
      {matches.map((option, index) => <button key={option.value} type="button" role="option"
        id={`${id}-${index}`} className="mx-menu-item" title={option.description}
        tabIndex={-1} aria-selected={option.value === value} data-active={index === selectedIndex}
        onMouseDown={event => event.preventDefault()}
        onMouseEnter={() => setActive(index)} onClick={() => select(option.value)}>
        <span>{option.value}</span>
      </button>)}
    </div>, document.body)}
  </>;
}
