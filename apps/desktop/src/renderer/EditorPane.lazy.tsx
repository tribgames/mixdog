// Monaco file editor with per-path models, persistent dirty buffers, Ctrl+S,
// and guarded changed-on-disk handling.
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DownloadSessionContext } from './project-file-download';
import { ErrorNotice } from './ErrorNotice';
import { EditorBreadcrumbs } from './editor-breadcrumbs';
import { useZoomBarVisible } from './zoom-bar-pref';
import type { SideFileChrome } from './side-surface-strip';
import { SideFileStatusRow, sideFileHasFooter } from './side-file-status-row';
import { useMobileRemoteSurface } from './mobile-surface';
import { useEditorCallHierarchy } from './editor-call-hierarchy';
import { armMonoFontRemeasure } from './editor-monaco-bootstrap';
import { EditorPaneDocumentSurface } from './editor-pane-document';
import {
  EditorPaneAlerts,
  EditorPaneReadOnlyNotice,
  EditorPaneFileFallback,
  EditorPaneLoadingSurface,
  EditorPaneNoticeSurface,
  EditorPanePreviewSurface,
} from './editor-pane-surfaces';
import { editorViewKindForPath } from './editor-delimited';
import { EditorPaneTextBody } from './editor-pane-text-body';
import { useEditorPaneLayout } from './editor-pane-session-layout';
import { useEditorPaneStatus } from './editor-pane-session-status';
import { formatEditorDocumentForSave } from './editor-pane-session-format';
import type { DesktopEditorSettings } from '../shared/contract';
import type { EditorCodeGraphMode } from './editor-code-graph';
import { normalizedFilePath } from './editor-lsp-conversion';
import type { EditorOutlineItem } from './editor-language-store';
import { useForegroundMedia } from './media-lifecycle';
import { readEditorViewState, type EditorGraphContext } from './editor-monaco-providers';
import { useEditorActiveDocument } from './use-editor-active-document';
import { useEditorSurfaceLifecycle } from './use-editor-surface-lifecycle';
import { useEditorFooterSlot } from './use-editor-footer-slot';
import { ensureEditorLoad, reportEditorLoadStage } from './renderer-load-metrics';
import type { EditorFileHandle } from './editor-pane-model';
import { useEditorFileSession } from './use-editor-file-session';
import { useEditorAnsiOutput, useEditorQuickDiff } from './use-editor-decorations';
import { useEditorSettings, useLightTheme } from './use-editor-appearance';
import { useEditorSideChrome } from './use-editor-side-chrome';
import { useEditorViewMode } from './use-editor-view-mode';
import { openEditorFileExternally } from './editor-external-file';
import { useEditorCommandWiring } from './use-editor-command-wiring';
import { useEditorModelBinding } from './use-editor-model-binding';
import { useEditorMountSession } from './use-editor-mount-session';
import { useEditorLspSession } from './use-editor-lsp-session';
import { ProjectRecoveryNotice } from './ProjectRecoveryNotice';
import { editorPaneMonacoOptions } from './editor-pane-monaco-options';
import { useEditorRevealRequest } from './use-editor-reveal-request';
import { useEditorDocumentCommands } from './use-editor-document-commands';
import { editorBreadcrumbMenuActions } from './editor-pane-breadcrumb-actions';

export default function EditorPane({
  projectPath,
  relPath,
  accessToken,
  workspaceFile,
  surfaceKey,
  active,
  focused,
  onDirty,
  onSaveHandle,
  reveal,
  codeGraph,
  onOpenAt,
  onOpenFile,
  onNavigationLocation,
  onReady,
  revealed = true,
  onSideChrome,
  onShowProblems,
  onOpenPreviewToSide,
}: {
  /** Main tab: "Open Preview to the Side" opens this file as a dock Preview. */
  onOpenPreviewToSide?(project: string, rel: string, accessToken?: string): void;
  /** Side-dock mode: the status-bar Problems button calls this instead. */
  onShowProblems?(): void;
  /** Side-dock mode: the editor draws no breadcrumb row. The dock's own strip
   *  shows the file and its actions from what is reported here. */
  onSideChrome?(chrome: SideFileChrome | null): void;
  projectPath: string;
  relPath: string;
  accessToken?: string;
  workspaceFile?: string;
  surfaceKey?: string;
  active: boolean;
  focused: boolean;
  onDirty(dirty: boolean): void;
  onSaveHandle?(handle: EditorFileHandle | null, released?: EditorFileHandle): void;
  reveal?: { line: number; column?: number; nonce: number } | null;
  codeGraph?(mode: EditorCodeGraphMode, query: string): Promise<string>;
  onOpenAt?(rel: string, line: number): void;
  onOpenFile?(project: string, rel: string, line?: number, accessToken?: string): void;
  onNavigationLocation?(rel: string, line: number, column: number): void;
  onReady?(): void;
  /** The loading cover has lifted: a hidden editor cannot take focus, so a
   *  first open claims the keyboard only once it is visible. */
  revealed?: boolean;
}) {
  const api = window.mixdogDesktop;
  ensureEditorLoad(projectPath, relPath, accessToken);
  reportEditorLoadStage(projectPath, relPath, accessToken, 'module');
  const abs = `${projectPath.replace(/[\\/]+$/, '')}/${relPath}`;
  const viewStateKey = normalizedFilePath(abs);
  // A preview's zoom is remembered per file and surface (dock vs. tab).
  const zoomKey = `${surfaceKey ?? ''}|${viewStateKey}`;
  const [breadcrumbOutline, setBreadcrumbOutline] = useState<EditorOutlineItem[]>([]);
  // Alt+Z override: the Editor options prop is re-applied on every render
  // (monaco-react updateOptions), so a plain editor.updateOptions toggle
  // would be reverted immediately. null follows the settings value.
  const [wordWrapOverride, setWordWrapOverride] = useState<DesktopEditorSettings['wordWrap'] | null>(null);
  const phoneLayout = useMobileRemoteSurface();
  const downloadSessionId = useContext(DownloadSessionContext);
  const mediaForeground = useForegroundMedia(active);
  // SVG opens as an image, Markdown and CSV/TSV as text; the toggle shows the
  // other view while the hidden editor (and its unsaved edits) stays mounted.
  const viewKind = editorViewKindForPath(relPath);
  const { footerSlot, bindFooterSlot } = useEditorFooterSlot();
  const editorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<import('monaco-editor').editor.ITextModel | null>(null);
  const {
    cursorPosition,
    setCursorPosition,
    setSelectionStatus,
    problemStatus,
    setProblemStatus,
    editorFormat,
    setEditorFormat,
    syncEditorFormat,
    showProblems,
    selectionLabel,
  } = useEditorPaneStatus(editorRef, onShowProblems);
  const { editorLayoutSize, editorLayoutObserver, layoutEditorToHost, scheduleEditorLayout } =
    useEditorPaneLayout(editorRef);
  const activeRef = useRef(active);
  const focusedRef = useRef(focused);
  activeRef.current = active;
  focusedRef.current = focused;
  // Opening or previewing a file on the phone never takes focus: the soft
  // keyboard would cover half of it. A tap into the text does.
  const autoFocus = !phoneLayout;
  const autoFocusRef = useRef(autoFocus);
  autoFocusRef.current = autoFocus;
  const callHierarchyContextKey = useRef<import('monaco-editor').editor.IContextKey<boolean> | null>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const graphContextRef = useRef<EditorGraphContext>({
    projectPath,
    relPath,
    codeGraph,
    onOpenAt,
  });
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onNavigationLocationRef = useRef(onNavigationLocation);
  onNavigationLocationRef.current = onNavigationLocation;
  const notifyReady = useCallback(() => onReadyRef.current?.(), []);
  const editorSettings = useEditorSettings({ api, accessToken, projectPath, relPath, workspaceFile, editorRef });
  const editorSettingsRef = useRef(editorSettings);
  editorSettingsRef.current = editorSettings;
  const lightTheme = useLightTheme();
  const { renderAnsiOutput, scheduleAnsiOutput, releaseAnsiOutput } = useEditorAnsiOutput({
    editorRef,
    relPath,
    lightTheme,
  });
  const syncLspRef = useRef<(kind?: 'change' | 'save') => Promise<boolean>>(async () => false);
  const {
    load,
    preview,
    previewLoaded,
    previewError,
    documentPreview,
    documentError,
    documentOfficeMissing,
    documentPassword,
    unlockDocument,
    cancelDocumentPassword,
    documentPageErrors,
    documentPagesLoading,
    loadDocumentPages,
    error,
    dirty,
    saving,
    reverting,
    diskChanged,
    saveError,
    setSaveError,
    revertError,
    recovery,
    diffTick,
    savedText,
    markDirty,
    reload,
    save,
    saveRef,
    revertFromDisk,
    contentRevision,
    restoreConflictingBackup,
    discardPendingBackup,
    keepEdits,
    onEditorChange,
    completePreview,
    failPreview,
    setRichHeld,
  } = useEditorFileSession({
    editorRef,
    modelRef,
    formatDocument: () => formatEditorDocumentForSave(editorRef, modelRef),
    projectPath,
    relPath,
    accessToken,
    active,
    editorSettings,
    notifyReady,
    onDirty,
    onSaveHandle,
    syncLspRef,
  });
  const { viewMode, richNotice, viewSnapshot, setViewSnapshot, changeViewMode, reportRichUnsupported } =
    useEditorViewMode({
      viewKind,
      modelRef,
      loadedContent: load?.content,
      contentRevision,
      modeKey: viewStateKey,
      markdownDefaultView: editorSettings.markdownDefaultView,
      readOnly: Boolean(load?.readOnly),
    });
  const [tocOpen, setTocOpen] = useState(false);
  const toggleToc = useCallback(() => setTocOpen((open) => !open), []);
  const openPreviewToSide = onOpenPreviewToSide
    ? () => onOpenPreviewToSide(projectPath, relPath, accessToken)
    : undefined;
  const {
    modelUri,
    setModelUri,
    lspReady,
    lspCapabilities,
    lspChangeTimer,
    outlineTimer,
    languageDisposables,
    lspMarkerSignature,
    publishOutline,
    acceptLspState,
    syncLsp,
    requestLsp,
    applyWorkspaceEdit,
    updateOutline,
    disposeLsp,
  } = useEditorLspSession({
    editorRef,
    modelRef,
    graphContextRef,
    callHierarchyContextKey,
    projectPath,
    relPath,
    active,
    codeGraph,
    onOutline: setBreadcrumbOutline,
    onLanguageError: setSaveError,
  });
  syncLspRef.current = syncLsp;
  const { portal: callHierarchyPortal, start: startCallHierarchy } = useEditorCallHierarchy({
    editorRef,
    graphContextRef,
    projectPath,
    accessToken,
    lightTheme,
    requestLsp,
    onOpenAt,
    contextKey: callHierarchyContextKey,
  });
  graphContextRef.current = {
    projectPath,
    relPath,
    api,
    codeGraph,
    onOpenAt,
    requestLsp,
    applyWorkspaceEdit,
    lspCapabilities: lspCapabilities.current ?? undefined,
    onOutline: (rows) => {
      const uri = editorRef.current?.getModel()?.uri.toString();
      if (uri) publishOutline(uri, rows);
    },
    onLanguageError: setSaveError,
    startCallHierarchy: () => {
      void startCallHierarchy();
    },
  };
  useEffect(() => {
    if (mediaForeground) return;
    mediaRef.current?.pause();
  }, [mediaForeground]);
  useEditorActiveDocument({
    editorRef,
    editorLayoutSize,
    layoutEditorToHost,
    onNavigationLocationRef,
    active,
    focused,
    autoFocus,
    revealed,
    loaded: load,
    viewMode,
    modelUri,
    projectPath,
    relPath,
    updateOutline,
  });
  // Quick-diff refresh: file-watch evidence plus a slow safety pass while active.
  const releaseQuickDiff = useEditorQuickDiff({
    api,
    active,
    load,
    projectPath,
    relPath,
    diffTick,
    lightTheme,
    editorRef,
  });
  const revealBreadcrumbSymbol = useEditorRevealRequest({
    editorRef,
    reveal,
    load,
    relPath,
    autoFocusRef,
    onNavigationLocationRef,
  });
  const bindEditorModel = useEditorModelBinding({
    projectPath,
    relPath,
    graphContextRef,
    languageDisposables,
    lspMarkerSignature,
    lspChangeTimer,
    outlineTimer,
    activeRef,
    focusedRef,
    onNavigationLocationRef,
    setModelUri,
    acceptLspState,
    scheduleAnsiOutput,
    syncLsp,
    updateOutline,
    setCursorPosition,
    setSelectionStatus,
    setProblemStatus,
    setEditorFormat,
    syncEditorFormat,
  });
  const wireEditorCommands = useEditorCommandWiring({
    callHierarchyContextKey,
    lspReady,
    lspCapabilities,
    languageDisposables,
    activeRef,
    focusedRef,
    editorSettingsRef,
    saveRef,
    setWordWrapOverride,
    startCallHierarchy,
  });
  const mountEditorSession = useEditorMountSession({
    editorRef,
    editorLayoutObserver,
    editorLayoutSize,
    scheduleEditorLayout,
    armFonts: armMonoFontRemeasure,
    bindModel: bindEditorModel,
    wireCommands: wireEditorCommands,
    activeRef,
    focusedRef,
    autoFocusRef,
    savedText,
    projectPath,
    relPath,
    accessToken,
    viewStateKey,
    readViewState: readEditorViewState,
    markDirty,
    renderAnsiOutput,
    notifyReady,
  });
  const { onMonacoMount, releaseEditorSurface } = useEditorSurfaceLifecycle({
    editorRef,
    modelRef,
    graphContextRef,
    editorLayoutObserver,
    editorLayoutSize,
    viewStateKey,
    mountEditorSession,
    onEditorChange,
    disposeLsp,
    releaseAnsiOutput,
    releaseQuickDiff,
  });
  const { formattingAvailable, formatDocument, gotoLine } = useEditorDocumentCommands({
    editorRef,
    lspCapabilities: lspCapabilities.current,
    languageId: editorFormat.languageId,
  });
  useZoomBarVisible();
  const zoomable = preview?.kind === 'image' || Boolean(documentPreview);
  const fileChrome = useEditorSideChrome({
    zoomable,
    api,
    projectPath,
    relPath,
    accessToken,
    load,
    preview,
    documentPreview,
    viewKind,
    viewMode,
    viewSnapshot,
    changeViewMode,
    tocOpen,
    toggleToc,
    onOpenPreviewToSide: onSideChrome ? undefined : openPreviewToSide,
    dirty,
    saving,
    save,
    problemStatus,
    showProblems,
    selectionLabel,
    cursorPosition,
    languageId: editorFormat.languageId,
    formattingAvailable,
    formatDocument,
    gotoLine,
    onSideChrome,
  });
  const breadcrumbPreview = viewKind === 'svg' ? null : preview;
  const breadcrumbMenuActions = editorBreadcrumbMenuActions({
    formattingAvailable,
    load,
    preview,
    documentPreview,
    zoomable,
    formatDocument,
  });
  const saveFile = () => {
    void save();
  };
  const revertFile = () => {
    void revertFromDisk();
  };
  const openExternally = () => void openEditorFileExternally(projectPath, relPath, accessToken, downloadSessionId);
  const editorBreadcrumbs = onSideChrome ? null : (
    <EditorBreadcrumbs
      projectPath={projectPath}
      relPath={relPath}
      accessToken={accessToken}
      load={load}
      preview={breadcrumbPreview}
      dirty={dirty}
      saving={saving}
      reverting={reverting}
      cursorLine={cursorPosition.line}
      outline={breadcrumbOutline}
      menuActions={breadcrumbMenuActions}
      viewControls={fileChrome}
      onSave={saveFile}
      onRevert={revertFile}
      onOpenAt={onOpenAt}
      onFocusEditor={() => editorRef.current?.focus()}
      onRevealSymbol={revealBreadcrumbSymbol}
    />
  );
  if (error && !load) {
    return (
      <EditorPaneNoticeSurface breadcrumbs={editorBreadcrumbs}>
        <ErrorNotice error={error} onRetry={reload} />
      </EditorPaneNoticeSurface>
    );
  }
  if (!load) {
    return <EditorPaneLoadingSurface breadcrumbs={editorBreadcrumbs} />;
  }
  if (preview && viewKind !== 'svg') {
    return (
      <EditorPanePreviewSurface
        breadcrumbs={editorBreadcrumbs}
        preview={preview}
        relPath={relPath}
        zoomKey={zoomKey}
        loaded={previewLoaded}
        error={previewError}
        mediaForeground={mediaForeground}
        mediaRef={mediaRef}
        onComplete={completePreview}
        onFail={failPreview}
        onOpen={openExternally}
      />
    );
  }
  if (documentPreview) {
    return (
      <EditorPaneDocumentSurface
        key={relPath}
        breadcrumbs={editorBreadcrumbs}
        preview={documentPreview}
        zoomKey={zoomKey}
        error={documentError}
        pageErrors={documentPageErrors}
        loading={documentPagesLoading}
        onRequestPages={loadDocumentPages}
        onFirstPageLoad={completePreview}
      />
    );
  }
  if (load.binary || load.tooLarge) {
    return (
      <EditorPaneFileFallback
        breadcrumbs={editorBreadcrumbs}
        load={load}
        note={documentError}
        officeMissing={documentOfficeMissing}
        password={
          documentPassword
            ? { ...documentPassword, onSubmit: unlockDocument, onCancel: cancelDocumentPassword }
            : undefined
        }
        active={active}
        onRetry={documentError ? reload : undefined}
        onOpen={openExternally}
      />
    );
  }
  const options = editorPaneMonacoOptions(editorSettings, wordWrapOverride, {
    side: Boolean(onSideChrome),
    phone: phoneLayout,
    readOnly: Boolean(load.readOnly),
  });
  // Main tab only: the footer is the last row of the workspace sheet, below the
  // pane's Problems panel (PaneWorkspace's footer slot); without a slot it closes
  // the editor pane itself.
  const mainFooter = !onSideChrome && active && sideFileHasFooter(fileChrome);
  const footer = <SideFileStatusRow chrome={fileChrome} />;
  return (
    <>
      {callHierarchyPortal}
      <div className="editor-pane" ref={bindFooterSlot}>
        {editorBreadcrumbs}
        {load.readOnly && <EditorPaneReadOnlyNotice reason={load.readOnlyReason} />}
        <EditorPaneAlerts
          recovery={recovery}
          diskChanged={diskChanged}
          error={error}
          saveError={saveError}
          revertError={revertError}
          onRestoreBackup={restoreConflictingBackup}
          onDiscardBackup={discardPendingBackup}
          onReload={revertFile}
          onKeepEdits={keepEdits}
          onRetrySave={saveFile}
        />
        {saveError && (
          <ProjectRecoveryNotice
            key={`${projectPath}\0${saveError}`}
            projectPath={projectPath}
            message={saveError}
            onOpenFile={(project, rel) => onOpenFile?.(project, rel)}
          />
        )}
        <EditorPaneTextBody
          load={load}
          preview={preview}
          previewError={previewError}
          viewKind={viewKind}
          viewMode={viewMode}
          richNotice={richNotice}
          tocOpen={tocOpen}
          onViewSource={() => changeViewMode('source')}
          onRichUnsupported={reportRichUnsupported}
          viewSnapshot={viewSnapshot}
          onSnapshotChange={setViewSnapshot}
          projectPath={projectPath}
          relPath={relPath}
          path={abs}
          surfaceKey={surfaceKey ?? abs}
          zoomKey={zoomKey}
          active={active}
          theme={lightTheme ? 'mixdog-light' : 'mixdog-dark'}
          options={options}
          modelRef={modelRef}
          onComplete={completePreview}
          onFail={failPreview}
          onOpenFile={onOpenFile}
          onSave={saveFile}
          onRichHeldChange={setRichHeld}
          onMount={onMonacoMount}
          onRelease={releaseEditorSurface}
        />
        {mainFooter && !footerSlot && footer}
      </div>
      {mainFooter && footerSlot && createPortal(footer, footerSlot)}
    </>
  );
}
