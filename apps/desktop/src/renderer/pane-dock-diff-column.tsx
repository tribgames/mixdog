// The diff pair column of the per-pane dock: a resizable column PAIRED to the
// left of the panel view. It only hides on close (see useRetainedDiff).
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';

export function PaneDockDiffColumn({
  showing,
  width,
  resizeProps,
  children,
}: {
  showing: boolean;
  width: number;
  resizeProps: HTMLAttributes<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div
      className="pane-dock-diff-column"
      hidden={!showing}
      inert={showing ? undefined : true}
      style={{ '--pane-dock-diff-width': `${width}px` } as CSSProperties}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a draggable resize handle, not a thematic break; <hr> brings its own border and margins. */}
      <div className="pane-dock-diff-resize" role="separator" aria-orientation="vertical" {...resizeProps} />
      <div className="pane-dock-diff-body">
        <div className="workbench-side-surface-slot" data-surface-active={showing ? 'true' : 'false'}>
          {children}
        </div>
      </div>
    </div>
  );
}
