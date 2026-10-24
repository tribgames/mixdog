import { Download, ExternalLink } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { isPhoneSurfaceMarked } from './mobile-surface';
import { ErrorNotice } from './ErrorNotice';
import {
  installOfficeForPreview,
  refreshOfficeAvailability,
  subscribeOfficeInstalled,
  useOfficeInstall,
} from './editor-office-install';
import type { EditorFileLoad } from './editor-file-loader';
import type { EditorRecovery, FilePreview } from './editor-pane-model';
import { ProgressSpinner } from './ProgressSpinner';
import { t } from './i18n';
import { ZoomFrame, ZoomImage, useImageSize } from './ZoomFrame';

/** The host's OS app on the desktop; on a paired device the file downloads
 *  (openEditorFileExternally routes it) under the Download / Share label. */
export function OpenExternallyLabel({ onOpen, disabled }: { onOpen(): void; disabled?: boolean }) {
  const remote = isRemoteHostRenderer();
  const Icon = remote ? Download : ExternalLink;
  return (
    <button type="button" disabled={disabled} onClick={onOpen}>
      <Icon size={14} aria-hidden="true" /> {remote ? t('Download / Share') : t('Open in default app')}
    </button>
  );
}

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

/** The question a password-protected document asks before it previews. The
 *  typed password lives in this field until it is submitted, then leaves with
 *  that one request; nothing else keeps it. */
function DocumentPasswordForm({
  wrong,
  busy,
  onSubmit,
  onCancel,
}: {
  wrong: boolean;
  busy: boolean;
  onSubmit(password: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState('');
  const promptId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // After a wrong password the field takes focus again for the next try.
  useEffect(() => {
    if (wrong && !busy) inputRef.current?.focus();
  }, [wrong, busy]);
  return (
    <form
      className="editor-pane-password"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value || busy) return;
        onSubmit(value);
        setValue('');
      }}
    >
      <p id={promptId} role="status">
        {t('This file is password-protected. Enter its password to preview it.')}
      </p>
      <input
        ref={inputRef}
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-labelledby={promptId}
        aria-invalid={wrong || undefined}
        disabled={busy}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      {wrong && (
        <p className="editor-pane-password-wrong" role="alert">
          {t("That password didn't work.")}
        </p>
      )}
      <div className="editor-pane-notice-actions">
        <button type="submit" className="primary" disabled={busy || !value}>
          {busy && <ProgressSpinner size={14} className="editor-pane-spinner" aria-hidden="true" />} {t('Open')}
        </button>
        <button type="button" onClick={onCancel}>
          {t('Cancel')}
        </button>
      </div>
    </form>
  );
}

export function EditorPaneFileFallback({
  breadcrumbs,
  load,
  note,
  officeMissing,
  password,
  onRetry,
  onOpen,
  active = true,
}: {
  breadcrumbs: ReactNode;
  load: EditorFileLoad;
  /** The pane is the visible tab; activating it re-checks the Office engine. */
  active?: boolean;
  /** Why a viewer that WAS attempted could not show this file — a failed
   *  document conversion. Absent for files that never had one. */
  note?: string;
  /** The conversion failed because neither LibreOffice nor Microsoft Office
   *  was found: the note offers to install LibreOffice. */
  officeMissing?: boolean;
  /** The document is password-protected and a password can open it: the pane
   *  asks for one in place of the note. */
  password?: { wrong: boolean; busy: boolean; onSubmit(password: string): void; onCancel(): void };
  /** Tries the viewer again (a failed conversion may have been transient). */
  onRetry?(): void;
  onOpen(): void;
}) {
  const install = useOfficeInstall();
  // Installing happens on the PC: a paired device or the phone layout only reads.
  const installable = Boolean(officeMissing && !isRemoteHostRenderer() && !isPhoneSurfaceMarked());
  const installing = installable && install.phase === 'installing';
  const failed = installable && install.phase === 'failed';
  const retryRef = useRef(onRetry);
  retryRef.current = onRetry;
  // The install may finish after this pane was left and reopened: whichever
  // pane is open then retries its own preview.
  useEffect(() => (installable ? subscribeOfficeInstalled(() => retryRef.current?.()) : undefined), [installable]);
  // LibreOffice may be installed outside Mixdog while this failed preview stays
  // open: re-read the engine status when the pane is activated or the window
  // regains focus; a newly installed engine fires the retry above.
  useEffect(() => {
    if (!installable || !active) return undefined;
    const refresh = () => refreshOfficeAvailability(window.mixdogDesktop);
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [installable, active]);
  const noteSurface = (() => {
    if (password) return <DocumentPasswordForm {...password} />;
    if (!note) return null;
    if (!installable) return <ErrorNotice error={note} role="status" />;
    if (installing) {
      return (
        <ErrorNotice
          error={note}
          role="status"
          summary={t('Installing LibreOffice… this can take a few minutes.')}
          recovery={t('The install keeps going if you leave this pane.')}
        />
      );
    }
    if (failed) {
      return (
        <ErrorNotice
          error={install.error}
          role="alert"
          className="is-danger"
          summary={t('LibreOffice could not be installed: {{error}}', { error: install.error })}
          recovery={t('Try again from Extensions → Built-in → Office, or download LibreOffice from libreoffice.org.')}
        />
      );
    }
    return (
      <ErrorNotice
        error={note}
        role="status"
        summary={t('Previewing Office files needs LibreOffice or Microsoft Office, and neither was found.')}
        recovery={t('Microsoft Office works too if it is installed.')}
      />
    );
  })();
  return (
    <EditorPaneNoticeSurface breadcrumbs={breadcrumbs}>
      {noteSurface}
      <p>
        {load.binary
          ? t('Binary file — in-app editing is unavailable.')
          : t('File exceeds the 10 MB in-app viewing cap.')}
      </p>
      <div className="editor-pane-notice-actions">
        {installable && (
          <button
            type="button"
            className="primary"
            disabled={installing}
            onClick={() => void installOfficeForPreview(window.mixdogDesktop)}
          >
            {installing ? (
              <ProgressSpinner size={14} className="editor-pane-spinner" aria-hidden="true" />
            ) : (
              <Download size={14} aria-hidden="true" />
            )}{' '}
            {installing ? t('Installing…') : failed ? t('Install again') : t('Install LibreOffice')}
          </button>
        )}
        <OpenExternallyLabel onOpen={onOpen} disabled={installing} />
        {onRetry && !password && (
          <button type="button" disabled={installing} onClick={onRetry}>
            {t('Retry')}
          </button>
        )}
      </div>
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
          action={<OpenExternallyLabel onOpen={onOpen} />}
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

/** A missing reason is the legacy size-cap response, not an encoding failure. */
export function EditorPaneReadOnlyNotice({ reason }: { reason?: 'encoding' }) {
  return (
    <p className="editor-pane-readonly-notice" role="status">
      {reason === 'encoding'
        ? t(
            'Read-only: this file has invalid text encoding. Convert or repair it in an external editor to avoid data loss.'
          )
        : t('Read-only: this file is over 1 MB, so it can be viewed but not edited.')}
    </p>
  );
}
