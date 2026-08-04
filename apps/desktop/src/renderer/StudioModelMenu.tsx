import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';

export interface StudioModelEntry {
  lane: string;
  laneLabel: string;
  model: string;
  label: string;
}

/**
 * Model chooser for the Studio composer.
 *
 * A dropdown that inherits the trigger width truncated every row, and the
 * shared centered dialog was too heavy for ten entries. This is an anchored
 * popover with its own width and one heading per provider lane.
 */
export function StudioModelMenu({ entries, lane, model, disabled = false, onSelect }: {
  entries: StudioModelEntry[];
  lane: string;
  model: string;
  disabled?: boolean;
  onSelect(entry: StudioModelEntry): void;
}) {
  const [open, setOpen] = useState(false);
  // Portal + fixed position: rendered inside the composer the panel fell
  // behind the dock's own layer (user: "채팅창에 묻혀버려").
  const anchor = useRef<{ left: number; bottom: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const clickGuard = useImmediateOverlayClickGuard();
  const current = entries.find((entry) => entry.lane === lane && entry.model === model);

  const rememberAnchor = (element: HTMLButtonElement) => {
    const rect = element.getBoundingClientRect();
    const width = Math.min(268, Math.max(0, window.innerWidth - 16));
    anchor.current = {
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      bottom: window.innerHeight - rect.top + 6,
    };
  };
  const toggle = (element: HTMLButtonElement) => {
    if (!open && !anchor.current) rememberAnchor(element);
    commitImmediateOverlay(() => setOpen((value) => !value));
  };

  useEffect(() => {
    if (!open) {
      anchor.current = null;
      return undefined;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // The panel lives in a portal, so "outside" must exclude it too.
      if (root.current?.contains(target)) return;
      if ((target as HTMLElement)?.closest?.('.studio-model-panel')) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const close = () => setOpen(false);
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const lanes: Array<{ id: string; label: string; items: StudioModelEntry[] }> = [];
  for (const entry of entries) {
    const bucket = lanes.find((group) => group.id === entry.lane);
    if (bucket) bucket.items.push(entry);
    else lanes.push({ id: entry.lane, label: entry.laneLabel, items: [entry] });
  }

  return <div className="studio-model-menu" ref={root}>
    <button ref={trigger} type="button" className="studio-model-trigger" disabled={disabled}
      aria-haspopup="listbox" aria-expanded={open} aria-label="Generation model"
      onPointerEnter={(event) => rememberAnchor(event.currentTarget)}
      onFocus={(event) => rememberAnchor(event.currentTarget)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        clickGuard.markPointerActivation();
        toggle(event.currentTarget);
      }}
      onClick={(event) => {
        if (clickGuard.consumePointerClick()) return;
        if (event.detail !== 0) return;
        toggle(event.currentTarget);
      }}
      onPointerCancel={clickGuard.clearPointerActivation}>
      <span>{current?.label || model || 'Select model'}</span>
      <ChevronDown size={13} aria-hidden="true" />
    </button>
    {open && anchor.current && createPortal(<div className="studio-model-panel" role="listbox"
      aria-label="Generation model" style={{ left: anchor.current.left, bottom: anchor.current.bottom }}>
      {lanes.map((group) => <section key={group.id}>
        <h4>{group.label}</h4>
        {group.items.map((entry) => {
          const active = entry.lane === lane && entry.model === model;
          return <button type="button" key={`${entry.lane}/${entry.model}`} role="option"
            aria-selected={active} className={active ? 'active' : ''}
            onClick={() => {
              onSelect(entry);
              setOpen(false);
            }}>
            <span>{entry.label}</span>
            {active && <Check size={14} aria-hidden="true" />}
          </button>;
        })}
      </section>)}
    </div>, document.body)}
  </div>;
}
