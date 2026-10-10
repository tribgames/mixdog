import { X } from 'lucide-react';
import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { t } from './i18n';

export const SIDE_FILE_PROBLEMS_MIN_HEIGHT = 96;
export const SIDE_FILE_PROBLEMS_MAX_HEIGHT = 640;
export const SIDE_FILE_PROBLEMS_DEFAULT_HEIGHT = 200;

export function clampSideFileProblemsHeight(height: number): number {
  return Math.min(SIDE_FILE_PROBLEMS_MAX_HEIGHT, Math.max(SIDE_FILE_PROBLEMS_MIN_HEIGHT, Math.round(height)));
}

/** The Problems split under a side-dock file editor: resizable from its top
 *  edge, closable with its own X. Scoped to the file by its host's children. */
export function SideFileProblems({
  height,
  onHeightChange,
  onClose,
  children,
}: {
  height: number;
  onHeightChange(height: number): void;
  onClose(): void;
  children: ReactNode;
}) {
  const drag = useRef<{ y: number; height: number } | null>(null);
  return (
    <section className="pane-side-file-problems" style={{ height }} aria-label={t('Problems')}>
      {/* biome-ignore lint/a11y/useSemanticElements: draggable splitter handle; the tag must stay a div */}
      <div
        className="pane-side-file-problems-resize"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
          if (event.button !== 0) return;
          drag.current = { y: event.clientY, height };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          onHeightChange(clampSideFileProblemsHeight(start.height + (start.y - event.clientY)));
        }}
        onPointerUp={(event) => {
          drag.current = null;
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch {
            /* already released */
          }
        }}
      />
      <header className="pane-side-file-problems-head">
        <span>{t('Problems')}</span>
        <button
          type="button"
          className="browser-pane-nav-button"
          aria-label={t('Close panel')}
          data-tooltip={t('Close panel')}
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="pane-side-file-problems-body">{children}</div>
    </section>
  );
}
