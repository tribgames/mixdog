import { ExternalLink } from 'lucide-react';
import { ErrorNotice } from './ErrorNotice';
import type { ReactNode, RefObject } from 'react';
import type { EditorFileLoad } from './editor-file-loader';
import type { EditorRecovery, FilePreview } from './editor-pane-model';
import { ProgressSpinner } from './ProgressSpinner';
import { t } from './i18n';
import { ZoomFrame, ZoomImage, useImageSize } from './ZoomFrame';

export function EditorPaneNoticeSurface({ breadcrumbs, children }: { breadcrumbs: ReactNode; children: ReactNode }) {
  return (
    <div className="editor-pane">
      {breadcrumbs}
      <div className="editor-pane-notice">{children}</div>
    </div>
  );
}

export function EditorPaneLoadingSurface({ breadcrumbs }: { breadcrumbs: ReactNode }) {
  return (
    <EditorPaneNoticeSurface breadcrumbs={breadcrumbs}>
      <ProgressSpinner size={16} className="editor-pane-spinner" aria-hidden="true" />
      <p>{t('Loading…')}</p>
    </EditorPaneNoticeSurface>
  );
}

export function EditorPaneFileFallback({
  breadcrumbs,
  load,
  note,
  onRetry,
  onOpen,
}: {
  breadcrumbs: ReactNode;
  load: EditorFileLoad;
  /** Why a viewer that WAS attempted could not show this file — a failed
   *  document conversion. Absent for files that never had one. */
  note?: string;
  /** Tries the viewer again (a failed conversion may have been transient). */
  onRetry?(): void;
  onOpen(): void;
}) {
  return (
    <EditorPaneNoticeSurface breadcrumbs={breadcrumbs}>
      {note && <ErrorNotice error={note} role="status" />}
      <p>
        {load.binary
          ? t('Binary file — in-app editing is unavailable.')
          : t('File exceeds the 10 MB in-app viewing cap.')}
      </p>
      <button type="button" onClick={onOpen}>
        <ExternalLink size={14} aria-hidden="true" /> {t('Open in default app')}
      </button>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          {t('Retry')}
        </button>
      )}
    </EditorPaneNoticeSurface>
  );
}

export function EditorPanePreviewSurface({
  breadcrumbs,
  preview,
  relPath,
  zoomKey,
  loaded,
  error,
  mediaForeground,
  mediaRef,
  onComplete,
  onFail,
  onOpen,
}: {
  breadcrumbs: ReactNode;
  preview: FilePreview;
  relPath: string;
  /** Remembers the zoom while this file stays open in its surface. */
  zoomKey?: string;
  loaded: boolean;
  error: string;
  mediaForeground: boolean;
  mediaRef: RefObject<HTMLMediaElement | null>;
  onComplete(): void;
  onFail(): void;
  onOpen(): void;
}) {
  const name = relPath.split('/').at(-1) || relPath;
  // PDFs never reach this surface: they use the page viewer (no iframe).
  const zoomable = preview.kind === 'image';
  const { natural, onNatural } = useImageSize(preview.url);
  const body = (zoom: { scale: number } | null) => (
    <>
      {!loaded && !error && (
        <div className="editor-pane-preview-loading" role="status">
          <ProgressSpinner size={16} className="editor-pane-spinner" aria-hidden="true" />
          <p>{t('Loading preview…')}</p>
        </div>
      )}
      {preview.kind === 'image' && zoom && (
        <ZoomImage
          src={preview.url}
          alt={name}
          natural={natural}
          scale={zoom.scale}
          onNatural={onNatural}
          onLoad={onComplete}
          onError={onFail}
        />
      )}
      {preview.kind === 'audio' && (
        // biome-ignore lint/a11y/useMediaCaption: this plays the user's own file, which carries no caption track to offer.
        <audio
          key={mediaForeground ? 'foreground' : 'suspended'}
          ref={(node) => {
            mediaRef.current = node;
          }}
          src={mediaForeground ? preview.url : undefined}
          controls={mediaForeground}
          preload={mediaForeground ? 'metadata' : 'none'}
          onLoadedMetadata={onComplete}
          onError={onFail}
        />
      )}
      {preview.kind === 'video' && (
        // biome-ignore lint/a11y/useMediaCaption: this plays the user's own file, which carries no caption track to offer.
        <video
          key={mediaForeground ? 'foreground' : 'suspended'}
          ref={(node) => {
            mediaRef.current = node;
          }}
          src={mediaForeground ? preview.url : undefined}
          controls={mediaForeground}
          preload={mediaForeground ? 'metadata' : 'none'}
          onLoadedMetadata={onComplete}
          onError={onFail}
        />
      )}
      {error && (
        <ErrorNotice
          error={error}
          className="editor-pane-preview-error"
          action={
            <button type="button" onClick={onOpen}>
              <ExternalLink size={14} aria-hidden="true" /> {t('Open in default app')}
            </button>
          }
        />
      )}
    </>
  );
  const readyAttr = loaded ? 'true' : 'false';
  return (
    <div className="editor-pane">
      {breadcrumbs}
      {zoomable ? (
        // Keyed by source: another file starts again at fit.
        <ZoomFrame
          key={preview.url}
          ready={loaded && !error}
          intrinsicWidth={natural?.width}
          intrinsicHeight={natural?.height}
          memoryKey={zoomKey}
          clickToggle
          scrollerClassName={`editor-pane-preview is-${preview.kind}`}
          dataReady={loaded}
        >
          {body}
        </ZoomFrame>
      ) : (
        <div className={`editor-pane-preview is-${preview.kind}`} data-ready={readyAttr}>
          {body(null)}
        </div>
      )}
    </div>
  );
}

export function EditorPaneAlerts({
  recovery,
  diskChanged,
  error,
  saveError,
  revertError,
  onRestoreBackup,
  onDiscardBackup,
  onReload,
  onKeepEdits,
  onRetrySave,
}: {
  recovery: EditorRecovery | null;
  diskChanged: boolean;
  error: string;
  saveError: string;
  revertError: string;
  onRestoreBackup(): void;
  onDiscardBackup(): void;
  onReload(): void;
  onKeepEdits(): void;
  onRetrySave(): void;
}) {
  let onRetry: (() => void) | undefined;
  if (saveError && !diskChanged) onRetry = onRetrySave;
  else if (revertError) onRetry = onReload;
  return (
    <>
      {recovery && (
        <div className="editor-pane-recovery" role="status">
          <span>
            {recovery.diskChanged && !recovery.restored
              ? t('Unsaved backup conflicts with the current disk version.')
              : t('Unsaved changes were restored from the previous session.')}
          </span>
          {recovery.diskChanged && !recovery.restored ? (
            <>
              <button type="button" onClick={onRestoreBackup}>
                {t('Restore Backup')}
              </button>
              <button type="button" onClick={onDiscardBackup}>
                {t('Discard Backup')}
              </button>
            </>
          ) : null}
        </div>
      )}
      {diskChanged && (
        <ErrorNotice
          error={saveError || error || t('File changed on disk.')}
          action={
            <>
              <button type="button" onClick={onReload}>
                {t('Reload')}
              </button>
              <button type="button" onClick={onKeepEdits}>
                {t('Keep my edits')}
              </button>
            </>
          }
        />
      )}
      <ErrorNotice errors={[revertError, !diskChanged ? saveError : '']} onRetry={onRetry} />
    </>
  );
}
