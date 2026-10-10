// Monaco file editor with per-path models, persistent dirty buffers, Ctrl+S,
// and guarded changed-on-disk handling.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { showDesktopToast } from './desktop-toasts';
import { hasLspProviderFeature } from './editor-lsp-providers';
import { documentFormatterAvailable, runFormatDocument } from './editor-format-document';
import { monaco } from './monaco-setup';
import { EditorBreadcrumbs } from './editor-breadcrumbs';
import type { SideFileChrome } from './side-surface-strip';
import { SideFileStatusRow, sideFileHasFooter } from './side-file-status-row';
import { sideEditorOptions } from './editor-side-options';
import { useEditorCallHierarchy } from './editor-call-hierarchy';
import { armMonoFontRemeasure, MIXDOG_EDITOR_SCROLLBAR } from './editor-monaco-bootstrap';
import { EditorPaneDocumentSurface } from './editor-pane-document';
import {
  EditorPaneAlerts,
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

/** The user's editor settings expressed as Monaco construction options; every
 *  value the settings do not own is a deliberate default. */
function monacoEditorOptions(
  editorSettings: DesktopEditorSettings,
  wordWrapOverride: DesktopEditorSettings['wordWrap'] | null
): import('monaco-editor').editor.IStandaloneEditorConstructionOptions {
  return {
    fontSize: editorSettings.fontSize,
    lineHeight: editorSettings.lineHeight,
    fontFamily: editorSettings.fontFamily,
    readOnly: false,
    domReadOnly: false,
    wordWrap: wordWrapOverride ?? editorSettings.wordWrap,
    wordWrapColumn: editorSettings.wordWrapColumn,
    minimap: {
      enabled: editorSettings.minimapEnabled,
      /* Default editor behavior. */
      size: 'proportional',
      showSlider: 'mouseover',
    },
    stickyScroll: { enabled: editorSettings.stickyScrollEnabled },
    scrollbar: MIXDOG_EDITOR_SCROLLBAR,
    automaticLayout: false,
    scrollBeyondLastLine: true,
    renderWhitespace: editorSettings.renderWhitespace,
    bracketPairColorization: {
      enabled: editorSettings.bracketPairColorization,
      /* Default text-model behavior. */
      independentColorPoolPerBracketType: false,
    },
    guides: {
      bracketPairs: editorSettings.bracketPairGuides,
      bracketPairsHorizontal: 'active',
      highlightActiveBracketPair: true,
      indentation: true,
    },
    inlayHints: { enabled: editorSettings.inlayHintsEnabled },
    formatOnPaste: editorSettings.formatOnPaste,
    formatOnType: editorSettings.formatOnType,
    glyphMargin: true,
    folding: true,
    showFoldingControls: 'mouseover',
    lineNumbersMinChars: 5,
    overviewRulerLanes: 3,
    renderLineHighlight: 'line',
    padding: { top: 4, bottom: 4 },
    fixedOverflowWidgets: true,
    /* Hide the lightbulb on empty lines. */
    lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.OnCode },
  };
}

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
}: {
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
  const { viewMode, viewSnapshot, setViewSnapshot, changeViewMode } = useEditorViewMode({
    viewKind,
    modelRef,
    loadedContent: load?.content,
    contentRevision,
  });
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
  // The reveal nonce is a wall-clock stamp, so two jumps raised in the same
  // millisecond carry the same one. The line this body reads therefore keys the
  // jump as well; the nonce still re-runs a repeat jump to the same line.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the jump is keyed on the requested line, column and nonce (pinned by editor-reveal-request.test.mjs) rather than the reveal object, and `load ? 1 : 0` re-runs it once when the file first loads without re-running on every content reload.
  useEffect(() => {
    if (!reveal || !load) return;
    const editor = editorRef.current;
    if (!editor) return;
    const column = reveal.column && reveal.column > 0 ? reveal.column : 1;
    editor.setPosition({ lineNumber: reveal.line, column });
    editor.revealPositionInCenter({ lineNumber: reveal.line, column });
    editor.focus();
    onNavigationLocationRef.current?.(relPath, reveal.line, column);
  }, [reveal?.line, reveal?.column, reveal?.nonce, load ? 1 : 0, relPath]);
  const revealBreadcrumbSymbol = useCallback((item: EditorOutlineItem) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setPosition({ lineNumber: item.line, column: Math.max(1, item.column) });
    editor.revealLineInCenter(item.line);
    editor.focus();
  }, []);
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
  const formattingAvailable = documentFormatterAvailable(
    lspCapabilities.current,
    hasLspProviderFeature(editorFormat.languageId, 'formatting')
  );
  const formatDocument = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    void runFormatDocument(editor).then((outcome) => {
      if (outcome === 'unchanged')
        showDesktopToast(t('Document is already formatted.'), 'info', { scope: 'editor-format' });
      else if (outcome === 'unavailable') {
        showDesktopToast(t('No formatter is available for this file.'), 'warn', { scope: 'editor-format' });
      }
    });
  }, []);
  const gotoLine = useCallback(() => {
    void editorRef.current?.getAction('editor.action.gotoLine')?.run();
  }, []);
  const fileChrome = useEditorSideChrome({
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
  const breadcrumbMenuActions =
    formattingAvailable && load && !load.binary && !load.tooLarge && !preview && !documentPreview && !load.readOnly
      ? [{ id: 'format', label: t('Format Document'), onSelect: formatDocument }]
      : [];
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
      onSave={() => {
        void save();
      }}
      onRevert={() => {
        void revertFromDisk();
      }}
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
        onOpen={() => void openEditorFileExternally(projectPath, relPath, accessToken)}
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
        onRetry={documentError ? reload : undefined}
        onOpen={() => void openEditorFileExternally(projectPath, relPath, accessToken)}
      />
    );
  }
  const baseOptions = monacoEditorOptions(editorSettings, wordWrapOverride);
  const options = {
    ...(onSideChrome ? sideEditorOptions(baseOptions, wordWrapOverride) : baseOptions),
    readOnly: Boolean(load.readOnly),
  };
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
        {load.readOnly && (
          <p className="editor-pane-readonly-notice" role="status">
            {t('Read-only: this file is over 1 MB, so it can be viewed but not edited.')}
          </p>
        )}
        <EditorPaneAlerts
          recovery={recovery}
          diskChanged={diskChanged}
          error={error}
          saveError={saveError}
          revertError={revertError}
          onRestoreBackup={restoreConflictingBackup}
          onDiscardBackup={discardPendingBackup}
          onReload={() => {
            void revertFromDisk();
          }}
          onKeepEdits={keepEdits}
          onRetrySave={() => {
            void save();
          }}
        />
        <EditorPaneTextBody
          load={load}
          preview={preview}
          previewError={previewError}
          viewKind={viewKind}
          viewMode={viewMode}
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
          onSave={() => {
            void save();
          }}
          onMount={onMonacoMount}
          onRelease={releaseEditorSurface}
        />
        {mainFooter && !footerSlot && footer}
      </div>
      {mainFooter && footerSlot && createPortal(footer, footerSlot)}
    </>
  );
}
