import { ExternalLink } from "lucide-react";
import { type ReactNode, type RefObject } from "react";
import { type EditorFileLoad } from "./editor-file-loader";
import { type EditorRecovery, type FilePreview } from "./editor-pane-model";
import { ProgressSpinner } from "./ProgressSpinner";

export function EditorPaneNoticeSurface({
  breadcrumbs,
  children,
}: {
  breadcrumbs: ReactNode;
  children: ReactNode;
}) {
  return <div className="editor-pane">{breadcrumbs}<div className="editor-pane-notice">
    {children}
  </div></div>;
}

export function EditorPaneLoadingSurface({ breadcrumbs }: { breadcrumbs: ReactNode }) {
  return <EditorPaneNoticeSurface breadcrumbs={breadcrumbs}>
    <ProgressSpinner size={16} className="editor-pane-spinner" aria-hidden="true" />
    <p>Loading…</p>
  </EditorPaneNoticeSurface>;
}

export function EditorPaneFileFallback({
  breadcrumbs,
  load,
  note,
  onOpen,
}: {
  breadcrumbs: ReactNode;
  load: EditorFileLoad;
  /** Why a viewer that WAS attempted could not show this file — a failed
   *  document conversion. Absent for files that never had one. */
  note?: string;
  onOpen(): void;
}) {
  return <EditorPaneNoticeSurface breadcrumbs={breadcrumbs}>
    {note && <p>{note}</p>}
    <p>{load.binary
      ? "Binary file — in-app editing is unavailable."
      : "File exceeds the 1 MB in-app editing cap."}</p>
    <button type="button" onClick={onOpen}>
      <ExternalLink size={14} aria-hidden="true" /> Open in default app
    </button>
  </EditorPaneNoticeSurface>;
}

export function EditorPanePreviewSurface({
  breadcrumbs,
  preview,
  relPath,
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
  loaded: boolean;
  error: string;
  mediaForeground: boolean;
  mediaRef: RefObject<HTMLMediaElement | null>;
  onComplete(): void;
  onFail(): void;
  onOpen(): void;
}) {
  const name = relPath.split("/").at(-1) || relPath;
  return <div className="editor-pane">{breadcrumbs}
    <div className={`editor-pane-preview is-${preview.kind}`}
      data-ready={loaded ? "true" : "false"}>
      {!loaded && !error && <div className="editor-pane-preview-loading" role="status">
        <ProgressSpinner size={16} className="editor-pane-spinner" aria-hidden="true" />
        <p>Loading preview…</p>
      </div>}
      {preview.kind === "image"
        ? <img src={preview.url} alt={name} onLoad={onComplete} onError={onFail} />
        : preview.kind === "pdf"
          ? <iframe src={preview.url} title={`${name} PDF preview`}
            onLoad={onComplete} onError={onFail} />
          : preview.kind === "audio"
            ? <audio key={mediaForeground ? "foreground" : "suspended"}
              ref={(node) => { mediaRef.current = node; }}
              src={mediaForeground ? preview.url : undefined}
              controls={mediaForeground} preload={mediaForeground ? "metadata" : "none"}
              onLoadedMetadata={onComplete} onError={onFail} />
            : <video key={mediaForeground ? "foreground" : "suspended"}
              ref={(node) => { mediaRef.current = node; }}
              src={mediaForeground ? preview.url : undefined}
              controls={mediaForeground} preload={mediaForeground ? "metadata" : "none"}
              onLoadedMetadata={onComplete} onError={onFail} />}
      {error && <div className="editor-pane-preview-error" role="alert">
        <p>{error}</p>
        <button type="button" onClick={onOpen}>
          <ExternalLink size={14} aria-hidden="true" /> Open in default app
        </button>
      </div>}
    </div>
  </div>;
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
  return <>
    {recovery && <div className="editor-pane-recovery" role="status">
      <span>{recovery.diskChanged && !recovery.restored
        ? "Unsaved backup conflicts with the current disk version."
        : "Unsaved changes were restored from the previous session."}</span>
      {recovery.diskChanged && !recovery.restored
        ? <>
            <button type="button" onClick={onRestoreBackup}>Restore Backup</button>
            <button type="button" onClick={onDiscardBackup}>Discard Backup</button>
          </>
        : null}
    </div>}
    {diskChanged && <div className="editor-pane-conflict" role="alert">
      <span>{saveError || error || "File changed on disk."}</span>
      <button type="button" onClick={onReload}>Reload</button>
      <button type="button" onClick={onKeepEdits}>Keep my edits</button>
    </div>}
    {revertError && <div className="editor-pane-conflict" role="alert">
      <span>Revert failed: {revertError}</span>
      <button type="button" onClick={onReload}>Retry</button>
    </div>}
    {!diskChanged && saveError && <div className="editor-pane-conflict" role="alert">
      <span>Save failed: {saveError}</span>
      <button type="button" onClick={onRetrySave}>Retry</button>
    </div>}
  </>;
}
