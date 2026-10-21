import { PanelLeft } from 'lucide-react';
import type { DragEvent } from 'react';
import { dataTransferHasLocalFiles } from './file-drag';
import { t } from './i18n';
import type { MediaLane } from './studio-support';

/** Desktop already names this surface in its workspace tab. Phones keep only
 *  the drawer reopen control because their tab strip is hidden. */
export function StudioHeader({ sidebarOpen, onToggleSidebar }: { sidebarOpen: boolean; onToggleSidebar?: () => void }) {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: header is the page banner landmark here; the label names it
    <header className="session-header studio-header" aria-label={t('Studio navigation')}>
      <div className="session-header-content">
        {/* Phone-only sidebar reopen, exactly like the chat header. Desktop
        uses the Activity Rail's Sessions control. */}
        <button
          type="button"
          className="toolbar-sidebar session-header-menu"
          aria-label={t('Toggle session list')}
          aria-expanded={sidebarOpen}
          onClick={onToggleSidebar}
        >
          <PanelLeft className="sidebar-toggle-icon" size={18} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

/** The lane catalogs' Retry control and their warnings, above the composer. */
export function StudioCatalogNotices({
  lanes,
  loading,
  onRetry,
}: {
  lanes: readonly MediaLane[];
  loading: boolean;
  onRetry(): void;
}) {
  return (
    <>
      {lanes.some((entry) => entry.catalogError || entry.catalogWarning) && (
        <button type="button" disabled={loading} onClick={onRetry}>
          {t('Retry')}
        </button>
      )}
      {lanes
        .filter((entry) => entry.catalogWarning)
        .map((entry) => (
          <p className="studio-status" role="status" key={entry.id}>
            {entry.label}: {entry.catalogWarning}
          </p>
        ))}
    </>
  );
}

/** The Studio root as a drop target for local files (references). */
export function studioDropHandlers(
  setDropping: (dropping: boolean) => void,
  addDroppedFiles: (transfer: DataTransfer) => unknown
) {
  return {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasLocalFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropping(true);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasLocalFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      setDropping(true);
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node)) return;
      setDropping(false);
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasLocalFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropping(false);
      void addDroppedFiles(event.dataTransfer);
    },
  };
}
