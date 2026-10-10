import { MoreHorizontal } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { ScmContextMenu } from './ScmContextMenu';
import { t } from './i18n';
import { useActivityRailPins } from './use-activity-rail-pins';
import {
  setWorkbenchSideIconDragImage,
  workbenchSideBarDropTarget,
  type WorkbenchSideViewDescriptor,
  type WorkbenchSideViewId,
} from './workbench-side-view-layout';

const PIN_DRAG_MIME = 'application/x-mixdog-activity-rail-pin';

/** Destinations open independently of their pins; new pins append above More. */
export function ActivityRailNavigation({
  entries,
  activeId,
  onSelect,
}: {
  entries: readonly WorkbenchSideViewDescriptor[];
  activeId: WorkbenchSideViewId | null;
  onSelect(id: WorkbenchSideViewId): void;
}) {
  const { pins, savePins } = useActivityRailPins();
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [drop, setDrop] = useState<ReturnType<typeof workbenchSideBarDropTarget>>(null);
  const draggingPin = useRef<WorkbenchSideViewId | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setPoint(null), []);
  const togglePin = (id: WorkbenchSideViewId) => {
    savePins(pins.includes(id) ? pins.filter((pin) => pin !== id) : [...pins, id]);
  };
  const targetAt = (bar: HTMLElement, clientY: number) =>
    workbenchSideBarDropTarget(
      [...bar.querySelectorAll<HTMLButtonElement>(':scope > button[data-side-view]')].map((button) => {
        const bounds = button.getBoundingClientRect();
        return { root: button.dataset.sideView as WorkbenchSideViewId, start: bounds.top, end: bounds.bottom };
      }),
      clientY,
      drop
    );
  const descriptors = new Map(entries.map((entry) => [entry.id, entry]));
  const activeInMenu = activeId !== null && !pins.includes(activeId);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the rail container only receives pin drag-and-drop events
    <div
      className="workbench-side-icon-bar is-vertical activity-rail-navigation"
      onDragOver={(event) => {
        if (!draggingPin.current || !Array.from(event.dataTransfer.types).includes(PIN_DRAG_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDrop(targetAt(event.currentTarget, event.clientY));
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
      }}
      onDrop={(event) => {
        const source = draggingPin.current;
        if (!source || !Array.from(event.dataTransfer.types).includes(PIN_DRAG_MIME)) return;
        event.preventDefault();
        const target = targetAt(event.currentTarget, event.clientY);
        draggingPin.current = null;
        setDrop(null);
        if (!target || source === target.root || !pins.includes(source)) return;
        const next = pins.filter((pin) => pin !== source);
        const index = next.indexOf(target.root) + (target.placement === 'after' ? 1 : 0);
        next.splice(index, 0, source);
        savePins(next);
      }}
    >
      {pins.map((id) => {
        const descriptor = descriptors.get(id as WorkbenchSideViewId);
        if (!descriptor) return null;
        const Icon = descriptor.icon;
        const active = activeId === descriptor.id;
        return (
          <button
            key={id}
            type="button"
            className={active ? 'active selected' : ''}
            data-side-view={id}
            aria-label={descriptor.label}
            aria-current={active ? 'page' : undefined}
            data-tooltip={descriptor.tooltip || descriptor.label}
            data-drop-position={drop?.root === id ? drop.placement : undefined}
            draggable
            onPointerEnter={descriptor.onPrefetch}
            onFocus={descriptor.onPrefetch}
            onPointerDown={(event) => {
              if (event.button === 0) descriptor.onPrefetch?.();
            }}
            onDragStart={(event) => {
              draggingPin.current = descriptor.id;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData(PIN_DRAG_MIME, descriptor.id);
              event.dataTransfer.setData('text/plain', descriptor.id);
              setWorkbenchSideIconDragImage(event);
            }}
            onDragEnd={() => {
              draggingPin.current = null;
              setDrop(null);
            }}
            onClick={() => onSelect(descriptor.id)}
          >
            <Icon size={24} aria-hidden="true" />
          </button>
        );
      })}
      <button
        type="button"
        ref={moreRef}
        className={point || activeInMenu ? 'active selected' : ''}
        data-activity-more
        aria-label={t('More')}
        aria-haspopup="menu"
        aria-expanded={point !== null}
        aria-current={activeInMenu ? 'page' : undefined}
        data-tooltip={t('More')}
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          setPoint((current) => (current ? null : { x: bounds.right + 4, y: bounds.top }));
        }}
      >
        <MoreHorizontal size={24} aria-hidden="true" />
      </button>
      <ScmContextMenu
        anchorRef={moreRef}
        onClose={close}
        state={
          point && {
            ...point,
            label: t('Sidebar'),
            items: entries.map((entry) => {
              const Icon = entry.icon;
              return {
                id: entry.id,
                label: entry.tooltip || entry.label,
                icon: <Icon size={16} aria-hidden="true" />,
                active: entry.id === activeId,
                pinned: pins.includes(entry.id),
                onSelect: () => onSelect(entry.id),
                onTogglePin: () => togglePin(entry.id),
              };
            }),
          }
        }
      />
    </div>
  );
}
