// Monaco file editor with per-path models, persistent dirty buffers, Ctrl+S,
// and guarded changed-on-disk handling.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { createGitRefreshScheduler } from "./git-refresh-scheduler";
import { monaco, resolveThemeColor } from "./monaco-setup";
import { subscribeProjectFileChanges } from "./project-file-changes";
import { EditorBreadcrumbs } from "./editor-breadcrumbs";
import { useEditorCallHierarchy } from "./editor-call-hierarchy";
import {
  armMonoFontRemeasure,
  colorWithAlpha,
  MIXDOG_EDITOR_SCROLLBAR,
  QUICK_DIFF_COLOR_TOKENS,
} from "./editor-monaco-bootstrap";
import {
  EditorPaneAlerts,
  EditorPaneFileFallback,
  EditorPaneLoadingSurface,
  EditorPaneNoticeSurface,
  EditorPanePreviewSurface,
} from "./editor-pane-surfaces";
import {
  cancelLayoutFrame,
  scheduleLayoutFrame,
} from "./interaction-frame-scheduler";
import {
  nextEditorLayoutDimension,
  type EditorLayoutDimension,
} from "./editor-layout";
// @ts-expect-error The Peek submenu registry is internal and has no declarations.
import { MenuId, MenuRegistry } from "monaco-editor/esm/vs/platform/actions/common/actions.js";
// @ts-expect-error See the menu-registry import above.
import { ContextKeyExpr } from "monaco-editor/esm/vs/platform/contextkey/common/contextkey.js";
import type {
  DesktopEditorSettings,
} from "../shared/contract";
import {
  explicitEditorLanguageIdForPath,
} from "../shared/editor-languages";
import {
  type EditorCodeGraphMode,
} from "./editor-code-graph";
import {
  normalizedFilePath,
} from "./editor-lsp-conversion";
import {
  clearActiveEditorDocument,
  setActiveEditorDocument,
  setActiveEditorPosition,
  type EditorOutlineItem,
} from "./editor-language-store";
import {
  editorAnsiDecorationPlan,
  isAnsiOutputPath,
} from "./editor-ansi";
import { useForegroundMedia } from "./media-lifecycle";
import { DEFAULT_DESKTOP_EDITOR_SETTINGS } from "../shared/editor-settings";
import {
  focusedGraphEditor,
  graphContextsByEditor,
  graphContextsByModel,
  readEditorViewState,
  writeEditorViewState,
  type EditorGraphContext,
} from "./editor-monaco-providers";
import {
  ensureEditorLoad,
  reportEditorLoadStage,
} from "./renderer-load-metrics";
import {
  editorLanguageLabel,
  parseEditorQuickDiffStripes,
  type EditorFileHandle,
} from "./editor-pane-model";
import { useEditorFileSession } from "./use-editor-file-session";
import { useEditorCommandWiring } from "./use-editor-command-wiring";
import { useEditorModelBinding } from "./use-editor-model-binding";
import { useEditorMountSession } from "./use-editor-mount-session";
import { useEditorLspSession } from "./use-editor-lsp-session";
export { parseEditorQuickDiffStripes } from "./editor-pane-model";

export default function EditorPane({ projectPath, relPath, accessToken, workspaceFile, active, focused, onDirty, onSaveHandle, reveal, codeGraph, onOpenAt, onNavigationLocation, onReady }: {
  projectPath: string;
  relPath: string;
  accessToken?: string;
  workspaceFile?: string;
  active: boolean;
  focused: boolean;
  onDirty(dirty: boolean): void;
  onSaveHandle?(handle: EditorFileHandle | null): void;
  reveal?: { line: number; nonce: number } | null;
  codeGraph?(mode: EditorCodeGraphMode, query: string): Promise<string>;
  onOpenAt?(rel: string, line: number): void;
  onNavigationLocation?(rel: string, line: number, column: number): void;
  onReady?(): void;
}) {
  const api = window.mixdogDesktop;
  ensureEditorLoad(projectPath, relPath, accessToken);
  reportEditorLoadStage(projectPath, relPath, accessToken, "module");
  const abs = `${projectPath.replace(/[\\/]+$/, "")}/${relPath}`;
  const viewStateKey = normalizedFilePath(abs);
  const [breadcrumbOutline, setBreadcrumbOutline] = useState<EditorOutlineItem[]>([]);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [selectionStatus, setSelectionStatus] = useState({ selections: 1, characters: 0 });
  const [problemStatus, setProblemStatus] = useState({ errors: 0, warnings: 0 });
  const [editorFormat, setEditorFormat] = useState({
    tabSize: 4,
    insertSpaces: true,
    eol: "LF",
    languageId: "",
  });
  const [editorSettings, setEditorSettings] = useState<DesktopEditorSettings>(
    DEFAULT_DESKTOP_EDITOR_SETTINGS,
  );
  // Alt+Z override: the Editor options prop is re-applied on every render
  // (monaco-react updateOptions), so a plain editor.updateOptions toggle
  // would be reverted immediately. null follows the settings value.
  const [wordWrapOverride, setWordWrapOverride] =
    useState<DesktopEditorSettings["wordWrap"] | null>(null);
  const editorSettingsRef = useRef(editorSettings);
  editorSettingsRef.current = editorSettings;
  const mediaForeground = useForegroundMedia(active);
  // Gutter quick-diff stripes against the Git worktree.
  const diffDecorations = useRef<import("monaco-editor").editor.IEditorDecorationsCollection | null>(null);
  const ansiDecorations = useRef<import("monaco-editor").editor.IEditorDecorationsCollection | null>(null);
  const ansiStyleElement = useRef<HTMLStyleElement | null>(null);
  const ansiRenderTimer = useRef<number | null>(null);
  const editorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  const editorLayoutSize = useRef<EditorLayoutDimension | null>(null);
  const activeRef = useRef(active);
  const focusedRef = useRef(focused);
  activeRef.current = active;
  focusedRef.current = focused;
  const editorLayoutObserver = useRef<ResizeObserver | null>(null);
  const callHierarchyContextKey =
    useRef<import("monaco-editor").editor.IContextKey<boolean> | null>(null);
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
  const layoutEditorToHost = useCallback((
    editor: import("monaco-editor").editor.IStandaloneCodeEditor,
    layoutHost: HTMLElement,
  ) => {
    if (editorRef.current !== editor) return;
    const dimension = nextEditorLayoutDimension(editorLayoutSize.current, layoutHost);
    if (!dimension) return;
    editorLayoutSize.current = dimension;
    editor.layout(dimension);
  }, []);
  const scheduleEditorLayout = useCallback((
    editor: import("monaco-editor").editor.IStandaloneCodeEditor,
    layoutHost: HTMLElement,
  ) => {
    scheduleLayoutFrame(editor, () => layoutEditorToHost(editor, layoutHost));
  }, [layoutEditorToHost]);
  const notifyReady = useCallback(() => onReadyRef.current?.(), []);
  useEffect(() => {
    let live = true;
    const reader = api?.readEditorSettings;
    if (!reader || accessToken) {
      setEditorSettings(DEFAULT_DESKTOP_EDITOR_SETTINGS);
      return () => { live = false; };
    }
    void reader(projectPath, relPath, workspaceFile)
      .then((settings) => {
        if (live && settings) setEditorSettings(settings);
      })
      .catch(() => {
        if (live) setEditorSettings(DEFAULT_DESKTOP_EDITOR_SETTINGS);
      });
    return () => { live = false; };
  }, [accessToken, api, projectPath, relPath, workspaceFile]);
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    if (editorSettings.detectIndentation) {
      model.detectIndentation(editorSettings.insertSpaces, editorSettings.tabSize);
    } else {
      model.updateOptions({
        tabSize: editorSettings.tabSize,
        insertSpaces: editorSettings.insertSpaces,
      });
    }
  }, [editorSettings.detectIndentation, editorSettings.insertSpaces, editorSettings.tabSize]);
  // Ready belongs to the concrete surface, after Monaco layout or preview load.
  useEffect(() => () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const viewState = editor?.saveViewState();
    if (viewState) writeEditorViewState(viewStateKey, viewState);
    if (model && graphContextsByModel.get(model.uri.toString()) === graphContextRef) {
      graphContextsByModel.delete(model.uri.toString());
    }
    if (editor) graphContextsByEditor.delete(editor);
    if (focusedGraphEditor.current === editor) focusedGraphEditor.current = null;
    if (ansiRenderTimer.current !== null) window.clearTimeout(ansiRenderTimer.current);
    disposeLsp(model);
    diffDecorations.current?.clear();
    diffDecorations.current = null;
    ansiDecorations.current?.clear();
    ansiDecorations.current = null;
    ansiStyleElement.current?.remove();
    ansiStyleElement.current = null;
    editorLayoutObserver.current?.disconnect();
    editorLayoutObserver.current = null;
    editorLayoutSize.current = null;
    if (editor) cancelLayoutFrame(editor);
    editorRef.current = null;
    model?.dispose();
  }, [api, projectPath, relPath, viewStateKey]);
  // Follow the app theme (default dark; :root[data-mixdog-theme="light"]).
  const [lightTheme, setLightTheme] = useState(() => document.documentElement.dataset.mixdogTheme === "light");
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setLightTheme(document.documentElement.dataset.mixdogTheme === "light"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mixdog-theme"] });
    return () => observer.disconnect();
  }, []);
  const renderAnsiOutput = useCallback((
    model: import("monaco-editor").editor.ITextModel | null | undefined,
  ) => {
    const editor = editorRef.current;
    if (!editor || !model || !isAnsiOutputPath(relPath) || !model.getValue().includes("\x1b[")) {
      ansiDecorations.current?.clear();
      if (ansiStyleElement.current) ansiStyleElement.current.textContent = "";
      return;
    }
    const plan = editorAnsiDecorationPlan(model.getValue(), lightTheme);
    const next = plan.decorations.map((decoration) => ({
      range: new monaco.Range(
        model.getPositionAt(decoration.start).lineNumber,
        model.getPositionAt(decoration.start).column,
        model.getPositionAt(decoration.end).lineNumber,
        model.getPositionAt(decoration.end).column,
      ),
      options: {
        inlineClassName: decoration.className,
        inlineClassNameAffectsLetterSpacing: decoration.className === "editor-ansi-control",
      },
    }));
    if (ansiDecorations.current) ansiDecorations.current.set(next);
    else ansiDecorations.current = editor.createDecorationsCollection(next);
    if (!ansiStyleElement.current) {
      const style = document.createElement("style");
      style.dataset.mixdogEditorAnsi = "true";
      document.head.appendChild(style);
      ansiStyleElement.current = style;
    }
    ansiStyleElement.current.textContent = plan.cssText;
  }, [lightTheme, relPath]);
  const scheduleAnsiOutput = useCallback((
    model: import("monaco-editor").editor.ITextModel | null | undefined,
  ) => {
    if (ansiRenderTimer.current !== null) window.clearTimeout(ansiRenderTimer.current);
    ansiRenderTimer.current = window.setTimeout(() => {
      ansiRenderTimer.current = null;
      renderAnsiOutput(model);
    }, 80);
  }, [renderAnsiOutput]);
  useEffect(() => {
    renderAnsiOutput(editorRef.current?.getModel());
  }, [renderAnsiOutput]);
  const syncLspRef =
    useRef<(kind?: "change" | "save") => Promise<boolean>>(async () => false);
  const {
    load,
    preview,
    previewLoaded,
    previewError,
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
    restoreConflictingBackup,
    discardPendingBackup,
    keepEdits,
    onEditorChange,
    completePreview,
    failPreview,
  } = useEditorFileSession({
    editorRef,
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
  const {
    portal: callHierarchyPortal,
    start: startCallHierarchy,
  } = useEditorCallHierarchy({
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
    startCallHierarchy: () => { void startCallHierarchy(); },
  };
  useEffect(() => {
    if (mediaForeground) return;
    mediaRef.current?.pause();
  }, [mediaForeground]);
  // Unified-diff → gutter stripe ranges against the CURRENT file lines:
  // '+' runs paired with '-' in the same group read as modified, bare '+'
  // as added; a pure deletion marks the line the removal collapsed onto.
  // Reveal requests from cross-file jumps land after the tab activates.
  // Hidden→visible tab switches leave Monaco with a stale layout: the first
  // scrollbar press then only re-measures instead of grabbing the slider.
  // A focused file surface also takes the keyboard explicitly after mount or
  // pane activation, so the first pointer click can immediately type.
  useLayoutEffect(() => {
    if (!active || !load) return;
    const editor = editorRef.current;
    const layoutHost = editor?.getDomNode()?.parentElement;
    if (editor && layoutHost) {
      editorLayoutSize.current = null;
      layoutEditorToHost(editor, layoutHost);
    }
    if (focused) editor?.focus();
  }, [active, focused, layoutEditorToHost, load]);
  useEffect(() => {
    if (!modelUri) return;
    const model = editorRef.current?.getModel();
    if (active && focused && model) {
      setActiveEditorDocument({
        projectPath,
        relPath,
        uri: modelUri,
        languageId: model.getLanguageId(),
      });
      const position = editorRef.current?.getPosition();
      setActiveEditorPosition(modelUri, position?.lineNumber ?? 1, position?.column ?? 1);
      if (position) {
        onNavigationLocationRef.current?.(relPath, position.lineNumber, position.column);
      }
      void updateOutline();
    } else {
      clearActiveEditorDocument(modelUri);
    }
  }, [active, focused, modelUri, projectPath, relPath, updateOutline]);
  // Quick-diff refresh: file-watch evidence plus a slow safety pass while active.
  useEffect(() => {
    const gitDiff = api?.gitDiff;
    if (!active || !load || load.binary || load.tooLarge || !gitDiff) return undefined;
    let live = true;
    const refresh = async () => {
      try {
        const text = await gitDiff(projectPath, relPath, false);
        if (!live) return;
        const editor = editorRef.current;
        if (!editor) return;
        const stripes = parseEditorQuickDiffStripes(text);
        const decos = stripes.map((stripe) => {
          const [token, darkFallback, lightFallback] = QUICK_DIFF_COLOR_TOKENS[stripe.kind];
          const color = resolveThemeColor(token, lightTheme ? lightFallback : darkFallback);
          return {
            range: new monaco.Range(stripe.line, 1, stripe.line, 1),
            options: {
              isWholeLine: stripe.kind !== "del",
              linesDecorationsClassName: `editor-dirty-diff editor-dirty-diff-${stripe.kind}`,
              linesDecorationsTooltip: stripe.kind === "add" ? "Added line"
                : stripe.kind === "mod" ? "Changed line" : "Removed line",
              overviewRuler: {
                color: colorWithAlpha(color, "99"),
                position: monaco.editor.OverviewRulerLane.Left,
              },
              minimap: {
                color,
                position: monaco.editor.MinimapPosition.Gutter,
              },
            },
          };
        });
        diffDecorations.current?.clear();
        diffDecorations.current = editor.createDecorationsCollection(decos);
      } catch {
        diffDecorations.current?.clear();
      }
    };
    const scheduler = createGitRefreshScheduler(refresh, {
      safetyIntervalMs: 30_000,
      activityDebounceMs: 125,
      activityMinGapMs: 1_000,
    });
    const signal = () => scheduler.signal();
    const refreshNow = () => scheduler.refreshNow();
    const visibilityChanged = () => {
      if (document.visibilityState === "hidden") scheduler.pause();
      else scheduler.resume();
    };
    const unsubscribeProject = subscribeProjectFileChanges(projectPath, signal);
    window.addEventListener("focus", refreshNow);
    window.addEventListener("mixdog:git-changed", signal);
    document.addEventListener("visibilitychange", visibilityChanged);
    if (document.visibilityState !== "hidden") scheduler.resume();
    return () => {
      live = false;
      scheduler.dispose();
      unsubscribeProject();
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("mixdog:git-changed", signal);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [api, active, load, projectPath, relPath, diffTick, lightTheme]);
  useEffect(() => {
    if (!reveal || !load) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.setPosition({ lineNumber: reveal.line, column: 1 });
    editor.revealLineInCenter(reveal.line);
    editor.focus();
    onNavigationLocationRef.current?.(relPath, reveal.line, 1);
  }, [reveal?.nonce, load ? 1 : 0, relPath]);
  const selectionLabel = selectionStatus.selections > 1
    ? `${selectionStatus.selections} selections${selectionStatus.characters
      ? ` (${selectionStatus.characters} characters selected)`
      : ""}`
    : `Ln ${cursorPosition.line}, Col ${cursorPosition.column}${selectionStatus.characters
      ? ` (${selectionStatus.characters} selected)`
      : ""}`;
  const revealBreadcrumbSymbol = useCallback((item: EditorOutlineItem) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setPosition({ lineNumber: item.line, column: Math.max(1, item.column) });
    editor.revealLineInCenter(item.line);
    editor.focus();
  }, []);
  const syncEditorFormat = useCallback(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    const options = model.getOptions();
    setEditorFormat({
      tabSize: options.tabSize,
      insertSpaces: options.insertSpaces,
      eol: model.getEOL() === "\r\n" ? "CRLF" : "LF",
      languageId: model.getLanguageId(),
    });
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
  const onMonacoMount = useEditorMountSession({
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
  const editorBreadcrumbs = <EditorBreadcrumbs
    projectPath={projectPath}
    relPath={relPath}
    accessToken={accessToken}
    load={load}
    preview={preview}
    dirty={dirty}
    saving={saving}
    reverting={reverting}
    cursorLine={cursorPosition.line}
    outline={breadcrumbOutline}
    onSave={() => { void save(); }}
    onRevert={() => { void revertFromDisk(); }}
    onOpenAt={onOpenAt}
    onFocusEditor={() => editorRef.current?.focus()}
    onRevealSymbol={revealBreadcrumbSymbol}
  />;
  if (error && !load) {
    return <EditorPaneNoticeSurface breadcrumbs={editorBreadcrumbs}>
      <p>{error}</p>
      <button type="button" onClick={reload}>Retry</button>
    </EditorPaneNoticeSurface>;
  }
  if (!load) {
    return <EditorPaneLoadingSurface breadcrumbs={editorBreadcrumbs} />;
  }
  if (preview) {
    return <EditorPanePreviewSurface
      breadcrumbs={editorBreadcrumbs}
      preview={preview}
      relPath={relPath}
      loaded={previewLoaded}
      error={previewError}
      mediaForeground={mediaForeground}
      mediaRef={mediaRef}
      onComplete={completePreview}
      onFail={failPreview}
      onOpen={() => void api?.openFilePath?.(projectPath, relPath, accessToken)}
    />;
  }
  if (load.binary || load.tooLarge) {
    return <EditorPaneFileFallback
      breadcrumbs={editorBreadcrumbs}
      load={load}
      onOpen={() => void api?.openFilePath?.(projectPath, relPath, accessToken)}
    />;
  }
  return <>{callHierarchyPortal}<div className="editor-pane">
    {editorBreadcrumbs}
    <EditorPaneAlerts
      recovery={recovery}
      diskChanged={diskChanged}
      error={error}
      saveError={saveError}
      revertError={revertError}
      onRestoreBackup={restoreConflictingBackup}
      onDiscardBackup={discardPendingBackup}
      onReload={() => { void revertFromDisk(); }}
      onKeepEdits={keepEdits}
      onRetrySave={() => { void save(); }}
    />
    <div className="editor-pane-body stable-surface-preserved stable-editor-surface">
      <Editor
        path={abs}
        defaultLanguage={explicitEditorLanguageIdForPath(relPath)}
        defaultValue={load.content}
        keepCurrentModel
        theme={lightTheme ? "mixdog-light" : "mixdog-dark"}
        options={{
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
            size: "proportional",
            showSlider: "mouseover",
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
            bracketPairsHorizontal: "active",
            highlightActiveBracketPair: true,
            indentation: true,
          },
          inlayHints: { enabled: editorSettings.inlayHintsEnabled },
          formatOnPaste: editorSettings.formatOnPaste,
          formatOnType: editorSettings.formatOnType,
          glyphMargin: true,
          folding: true,
          showFoldingControls: "mouseover",
          lineNumbersMinChars: 5,
          overviewRulerLanes: 3,
          renderLineHighlight: "line",
          padding: { top: 4, bottom: 4 },
          fixedOverflowWidgets: true,
          /* Hide the lightbulb on empty lines. */
          lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.OnCode },
        }}
        onMount={onMonacoMount}
        onChange={onEditorChange}
      />
    </div>
    {/* ALWAYS mounted: gating on `focused` resized the editor body by 22px on
        every focus change — a visible jump right after a pane appears (user:
        자리를 못 잡고 튄다). Unfocused panes keep the reserved row, hidden. */}
    <footer className={`editor-statusbar${focused ? "" : " editor-statusbar-idle"}`}
      aria-label="Editor status" aria-hidden={focused ? undefined : true}>
      <div className="editor-statusbar-left">
        <button type="button" aria-label="Show Problems"
          data-tooltip={`${problemStatus.errors} Errors, ${problemStatus.warnings} Warnings`}
          onClick={() => window.dispatchEvent(new CustomEvent("mixdog:show-problems"))}>
          <span aria-hidden="true">×</span> {problemStatus.errors}
          <span aria-hidden="true">△</span> {problemStatus.warnings}
        </button>
      </div>
      <div className="editor-statusbar-right">
        {lspCapabilities.current?.formatting && <button type="button"
          aria-label="Format Document" data-tooltip="Format Document"
          onClick={() => { void editorRef.current?.getAction("editor.action.formatDocument")?.run(); }}>
          Formatter
        </button>}
        <button type="button" aria-label="Go to Line/Column" data-tooltip={selectionLabel}
          onClick={() => { void editorRef.current?.getAction("editor.action.gotoLine")?.run(); }}>
          {selectionLabel}
        </button>
        {/* Language stays a quiet read-only indicator until the other format
            controls have an in-app need. */}
        <span className="editor-statusbar-language">
          {editorLanguageLabel(editorFormat.languageId)}
        </span>
      </div>
    </footer>
  </div></>;
}
