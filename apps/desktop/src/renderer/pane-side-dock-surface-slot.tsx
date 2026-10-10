import type { ReactNode } from 'react';

/** One persistent session surface layer inside the dock body; an inactive
 *  layer stays mounted but inert and hidden from assistive tech. */
export function PaneDockSurfaceSlot({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      className="workbench-side-surface-slot"
      data-surface-active={active ? 'true' : 'false'}
      inert={active ? undefined : true}
      aria-hidden={active ? undefined : true}
    >
      {children}
    </div>
  );
}
