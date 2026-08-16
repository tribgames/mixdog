// Monaco file editor with per-path models, persistent dirty buffers, Ctrl+S,
// and guarded changed-on-disk handling.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Editor from "@monaco-editor/react";
import {
  Braces,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  File as FileIcon,
  Folder,
  FolderOpen,
  Save,
  Undo2,
  X,
} from "lucide-react";
import { monaco, resolveThemeColor } from "./monaco-setup";
import { ProgressSpinner } from "./ProgressSpinner";
// Monaco caches glyph metrics at mount. If the mono face lands AFTER a cold
// editor measured against Consolas (boot restore, first open on a cold
// cache), the paint swaps but the layout keeps stale widths — cursor and
// text visibly jump (user: 폰트가 움직이며 크게 튄다). One remeasure when
// the face settles realigns every open editor.
let monoRemeasureArmed = false;
const MIXDOG_EDITOR_SCROLLBAR = {
  arrowSize: 0,
  verticalScrollbarSize: 14,
  horizontalScrollbarSize: 12,
} as const;
const QUICK_DIFF_COLOR_TOKENS = {
  add: ["--mx-editor-diff-add", "#487e02", "#48985d"],
  mod: ["--mx-editor-diff-mod", "#1b81a8", "#2090d3"],
  del: ["--mx-editor-diff-del", "#f14c4c", "#b5200d"],
} as const;
function colorWithAlpha(color: string, alpha: string): string {
  const hex = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(color);
  return hex ? `#${hex[1]}${alpha}` : color;
}
function armMonoFontRemeasure() {
  if (monoRemeasureArmed) return;
  monoRemeasureArmed = true;
  const remeasure = () => {
    try { monaco.editor.remeasureFonts(); } catch { /* cosmetic */ }
  };
  try {
    // One fonts.load() alone raced the @font-face registration: called before
    // the face exists it resolves EMPTY and never fires again, so Monaco kept
    // fallback metrics while painting the arrived webfont — intermittent
    // garbled/overlapping text (user: 간헐적으로 생텍스트처럼 깨진다). Cover
    // every arrival path: explicit load, whole-set readiness, and any late
    // subset/instance load.
    void document.fonts.load('400 13px "JetBrains Mono Variable"')
      .then(remeasure)
      .catch(() => undefined);
    void document.fonts.ready.then(remeasure).catch(() => undefined);
    document.fonts.addEventListener?.("loadingdone", remeasure);
  } catch { /* font readiness stays cosmetic */ }
}
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
  DesktopLspCapabilities,
  DesktopLspRequestMethod,
  DesktopLspServerState,
  DesktopTextFileEncoding,
} from "../shared/contract";
import {
  filePreviewTypeForPath,
} from "../shared/file-preview";
import {
  editorLanguageIdForPath,
  explicitEditorLanguageIdForPath,
} from "../shared/editor-languages";
import {
  parseCodeGraphSymbols,
  type EditorCodeGraphMode,
} from "./editor-code-graph";
import {
  lspCallHierarchyItem,
  lspPosition,
  monacoRange,
  normalizedFilePath,
  recordOf,
  type EditorCallHierarchyItem,
} from "./editor-lsp-conversion";
import {
  clearActiveEditorDocument,
  ensureEditorLanguageStore,
  getEditorLanguageSnapshot,
  setActiveEditorDocument,
  setActiveEditorPosition,
  setEditorOutline,
  setNativeEditorProblems,
  subscribeEditorLanguageStore,
  type EditorOutlineItem,
} from "./editor-language-store";
import {
  editorAnsiDecorationPlan,
  isAnsiOutputPath,
  visibleEditorAnsiText,
} from "./editor-ansi";
import { useForegroundMedia } from "./media-lifecycle";
import {
  normalizeEditorModelText,
  resolveEditorBackup,
  takeEditorFileLoad,
  type EditorFileLoad as FileLoad,
} from "./editor-file-loader";
import { DEFAULT_DESKTOP_EDITOR_SETTINGS } from "../shared/editor-settings";
import {
  applyLspWorkspaceEdit,
  CALL_HIERARCHY_DIRECTION_KEY,
  CALL_HIERARCHY_LAYOUT_KEY,
  codeGraphOutlineItems,
  ensureCallHierarchyMenu,
  ensureGraphProviders,
  FORMAT_DOCUMENT_WITH,
  focusedGraphEditor,
  graphContextsByEditor,
  graphContextsByModel,
  HAS_CALL_HIERARCHY,
  lspCapabilitiesByLanguage,
  lspDocumentSymbols,
  lspReadyLanguages,
  readEditorViewState,
  writeEditorViewState,
  type EditorGraphContext,
} from "./editor-monaco-providers";
import {
  ensureEditorLoad,
  reportEditorLoadStage,
} from "./renderer-load-metrics";
import {
  breadcrumbPickerAnchor,
  editorLanguageLabel,
  parseEditorQuickDiffStripes,
  readCallHierarchyLayout,
  type BreadcrumbFileItem,
  type BreadcrumbPickerAnchor,
  type BreadcrumbPickerState,
  type CallHierarchyLayout,
  type CallHierarchyPreview,
  type EditorFileHandle,
  type EditorRecovery,
  type FilePreview,
} from "./editor-pane-model";
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
  const [load, setLoad] = useState<FileLoad | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [diskChanged, setDiskChanged] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [revertError, setRevertError] = useState("");
  const [recovery, setRecovery] = useState<EditorRecovery | null>(null);
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
  const [breadcrumbPicker, setBreadcrumbPicker] = useState<BreadcrumbPickerState | null>(null);
  const [breadcrumbFocusIndex, setBreadcrumbFocusIndex] = useState(0);
  const [, setLspFeatureRevision] = useState(0);
  const mediaForeground = useForegroundMedia(active);
  const [callHierarchy, setCallHierarchy] = useState<{
    root: EditorCallHierarchyItem | null;
    rows: EditorCallHierarchyItem[];
    stack: EditorCallHierarchyItem[];
    direction: "incoming" | "outgoing";
    selectedIndex: number;
    loading: boolean;
    error: string;
  } | null>(null);
  const callHierarchyRef = useRef(callHierarchy);
  callHierarchyRef.current = callHierarchy;
  const [callHierarchyTarget, setCallHierarchyTarget] = useState<HTMLElement | null>(null);
  const [callHierarchyLayout, setCallHierarchyLayout] = useState<CallHierarchyLayout>(
    readCallHierarchyLayout,
  );
  const [callHierarchyPreview, setCallHierarchyPreview] = useState<CallHierarchyPreview | null>(null);
  const callHierarchyPreviewGeneration = useRef(0);
  const callHierarchyTreeRef = useRef<HTMLDivElement | null>(null);
  const breadcrumbPickerGeneration = useRef(0);
  const breadcrumbPickerRef = useRef<HTMLDivElement | null>(null);
  const breadcrumbButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const breadcrumbPickerRowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Gutter quick-diff stripes against the Git worktree.
  const diffDecorations = useRef<import("monaco-editor").editor.IEditorDecorationsCollection | null>(null);
  const ansiDecorations = useRef<import("monaco-editor").editor.IEditorDecorationsCollection | null>(null);
  const ansiStyleElement = useRef<HTMLStyleElement | null>(null);
  const ansiRenderTimer = useRef<number | null>(null);
  const [diffTick, setDiffTick] = useState(0);
  const editorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  const editorLayoutSize = useRef<EditorLayoutDimension | null>(null);
  const callHierarchyZone = useRef<{
    id: string;
    zone: {
      afterLineNumber: number;
      heightInLines: number;
      domNode: HTMLElement;
      suppressMouseDown: boolean;
    };
  } | null>(null);
  const activeRef = useRef(active);
  const focusedRef = useRef(focused);
  activeRef.current = active;
  focusedRef.current = focused;
  const [modelUri, setModelUri] = useState("");
  const lspReady = useRef(false);
  const lspCapabilities = useRef<DesktopLspCapabilities | null>(null);
  const lspCapabilitiesKey = useRef("");
  const lspLanguageId = useRef("");
  const lspLastVersion = useRef(-1);
  const lspOpenPromise = useRef<Promise<unknown> | null>(null);
  const lspAttached = useRef(false);
  const lspAttachmentEpoch = useRef(0);
  const lspReopenAt = useRef(0);
  const lspChangeTimer = useRef<number | null>(null);
  const outlineTimer = useRef<number | null>(null);
  const languageDisposables = useRef<Array<{ dispose(): void }>>([]);
  const editorLayoutObserver = useRef<ResizeObserver | null>(null);
  const lspMarkerSignature = useRef("");
  const callHierarchyContextKey =
    useRef<import("monaco-editor").editor.IContextKey<boolean> | null>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const graphContextRef = useRef<EditorGraphContext>({
    projectPath,
    relPath,
    codeGraph,
    onOpenAt,
  });
  const savedMtime = useRef(0);
  const savedDiskText = useRef("");
  const savedText = useRef("");
  const loadedRef = useRef(false);
  const savingRef = useRef(false);
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const backupTimer = useRef<number | null>(null);
  const backupQueue = useRef<Promise<void>>(Promise.resolve());
  const skipUnmountBackup = useRef(false);
  const skipNextBackupRestore = useRef(false);
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
  const enqueueBackup = useCallback((operation: () => Promise<unknown>): Promise<void> => {
    const run = backupQueue.current.catch(() => undefined).then(operation).then(() => undefined);
    backupQueue.current = run.catch(() => undefined);
    return run;
  }, []);
  const writeBackupNow = useCallback((content: string): Promise<void> => {
    if (!api?.writeEditorBackup) return Promise.resolve();
    return enqueueBackup(() => api.writeEditorBackup!(
      projectPath,
      relPath,
      content,
      savedDiskText.current,
      accessToken,
    ));
  }, [accessToken, api, enqueueBackup, projectPath, relPath]);
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
  const deleteBackup = useCallback((): Promise<void> => {
    if (backupTimer.current !== null) {
      window.clearTimeout(backupTimer.current);
      backupTimer.current = null;
    }
    if (!api?.deleteEditorBackup) return Promise.resolve();
    return enqueueBackup(() => api.deleteEditorBackup!(
      projectPath,
      relPath,
      accessToken,
    ));
  }, [accessToken, api, enqueueBackup, projectPath, relPath]);
  const scheduleBackup = useCallback((content: string) => {
    if (backupTimer.current !== null) window.clearTimeout(backupTimer.current);
    backupTimer.current = window.setTimeout(() => {
      backupTimer.current = null;
      void writeBackupNow(content).catch(() => undefined);
    }, 500);
  }, [writeBackupNow]);
  // READY is reported by the concrete surfaces below (Monaco onMount after
  // view-state restore, preview load, binary/error fallback) — NOT on first
  // DOM commit: an early ready dropped the pane cover one frame before
  // Monaco's rAF layout, so the fresh editor visibly settled up-right
  // (user: 스크립트 생성될 때 한 프레임 자리잡는 게 보인다). The gate's
  // 900ms cover cap still bounds a slow hydration.
  const removeCallHierarchyZone = useCallback(() => {
    const editor = editorRef.current;
    const current = callHierarchyZone.current;
    callHierarchyZone.current = null;
    if (editor && current) {
      try {
        editor.changeViewZones((accessor) => accessor.removeZone(current.id));
      } catch {
        // A disposed editor already removed all view zones.
      }
    }
    setCallHierarchyTarget(null);
  }, []);
  const closeCallHierarchy = useCallback(() => {
    setCallHierarchy(null);
    setCallHierarchyPreview(null);
    removeCallHierarchyZone();
    editorRef.current?.focus();
  }, [removeCallHierarchyZone]);
  const showCallHierarchyZone = useCallback((position: import("monaco-editor").Position) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    removeCallHierarchyZone();
    const domNode = document.createElement("div");
    domNode.className = "editor-call-hierarchy-zone";
    const visible = editor.getScrolledVisiblePosition(position);
    domNode.style.setProperty("--peek-arrow-left", `${Math.max(12, visible?.left ?? 12)}px`);
    const zone = {
      afterLineNumber: Math.min(model.getLineCount(), Math.max(1, position.lineNumber)),
      heightInLines: callHierarchyLayout.height,
      domNode,
      suppressMouseDown: false,
    };
    let id = "";
    editor.changeViewZones((accessor) => {
      id = accessor.addZone(zone);
    });
    callHierarchyZone.current = { id, zone };
    setCallHierarchyTarget(domNode);
    editor.revealLineInCenter(position.lineNumber);
  }, [callHierarchyLayout.height, removeCallHierarchyZone]);
  useEffect(() => {
    try {
      window.localStorage.setItem(CALL_HIERARCHY_LAYOUT_KEY, JSON.stringify(callHierarchyLayout));
    } catch {
      // Peek layout is a convenience only.
    }
    const editor = editorRef.current;
    const current = callHierarchyZone.current;
    if (!editor || !current) return;
    current.zone.heightInLines = callHierarchyLayout.height;
    editor.changeViewZones((accessor) => accessor.layoutZone(current.id));
  }, [callHierarchyLayout]);
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
    const hierarchyZone = callHierarchyZone.current;
    if (editor && hierarchyZone) {
      try {
        editor.changeViewZones((accessor) => accessor.removeZone(hierarchyZone.id));
      } catch {
        // Editor disposal also removes the zone.
      }
      callHierarchyZone.current = null;
    }
    callHierarchyContextKey.current?.reset();
    callHierarchyContextKey.current = null;
    if (lspChangeTimer.current !== null) window.clearTimeout(lspChangeTimer.current);
    if (outlineTimer.current !== null) window.clearTimeout(outlineTimer.current);
    if (backupTimer.current !== null) window.clearTimeout(backupTimer.current);
    if (ansiRenderTimer.current !== null) window.clearTimeout(ansiRenderTimer.current);
    if (model && !skipUnmountBackup.current && model.getValue() !== savedText.current) {
      void writeBackupNow(model.getValue()).catch(() => undefined);
    }
    for (const disposable of languageDisposables.current.splice(0)) disposable.dispose();
    if (model) {
      clearActiveEditorDocument(model.uri.toString());
      if (lspAttached.current && api?.lspDocument) {
        lspAttached.current = false;
        lspAttachmentEpoch.current += 1;
        const pendingOpen = lspOpenPromise.current;
        lspOpenPromise.current = null;
        lspReady.current = false;
        lspLastVersion.current = -1;
        void Promise.resolve(pendingOpen).catch(() => undefined).then(() =>
          api.lspDocument!({
            kind: "close",
            projectPath,
            relPath,
            languageId: lspLanguageId.current || model.getLanguageId(),
            version: model.getVersionId(),
          })).catch(() => undefined);
      }
    }
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
  }, [api, projectPath, relPath, viewStateKey, writeBackupNow]);
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
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const markDirty = useCallback((next: boolean) => {
    setDirty(next);
    onDirtyRef.current(next);
  }, []);
  const publishOutline = useCallback((
    uri: string,
    rows: EditorOutlineItem[],
  ) => {
    setEditorOutline(uri, rows);
    setBreadcrumbOutline(rows);
  }, []);
  const acceptLspState = useCallback((state: DesktopLspServerState, languageId: string) => {
    lspReady.current = state.available;
    lspCapabilities.current = state.capabilities ?? null;
    callHierarchyContextKey.current?.set(
      Boolean(state.available && state.capabilities?.callHierarchy),
    );
    const key = JSON.stringify(state.capabilities ?? null);
    if (state.available && state.capabilities) {
      lspCapabilitiesByLanguage.set(languageId, state.capabilities);
      lspReadyLanguages.add(languageId);
      ensureGraphProviders(languageId);
    }
    if (key !== lspCapabilitiesKey.current) {
      lspCapabilitiesKey.current = key;
      setLspFeatureRevision((revision) => revision + 1);
    }
  }, []);
  const syncLsp = useCallback(async (kind: "change" | "save" = "change"): Promise<boolean> => {
    const model = editorRef.current?.getModel();
    if (!model || !api?.lspDocument) return false;
    if (lspOpenPromise.current) await lspOpenPromise.current.catch(() => undefined);
    if (!lspReady.current) {
      // A failed attach (server cold-start timeout at boot, idle 'missing'
      // window) must not mute the document forever — typing retried NOTHING
      // and diagnostics never appeared (user: 타이핑해도 반응 없음). Re-open
      // with the current content, throttled, and continue this very sync.
      if (!lspAttached.current || Date.now() < lspReopenAt.current) return false;
      lspReopenAt.current = Date.now() + 5_000;
      const epoch = lspAttachmentEpoch.current;
      const reopening = api.lspDocument({
        kind: "open",
        projectPath,
        relPath,
        languageId: model.getLanguageId(),
        version: model.getVersionId(),
        content: model.getValue(),
      });
      lspOpenPromise.current = reopening;
      try {
        const state = await reopening;
        if (epoch !== lspAttachmentEpoch.current || !lspAttached.current) return false;
        acceptLspState(state, model.getLanguageId());
        if (!state.available) return false;
        lspLastVersion.current = model.getVersionId();
        return true;
      } catch {
        return false;
      }
    }
    const version = model.getVersionId();
    if (kind === "change" && version === lspLastVersion.current) return true;
    const state = await api.lspDocument({
      kind,
      projectPath,
      relPath,
      languageId: model.getLanguageId(),
      version,
      content: model.getValue(),
    });
    acceptLspState(state, model.getLanguageId());
    if (state.available) lspLastVersion.current = version;
    return state.available;
  }, [acceptLspState, api, projectPath, relPath]);
  const requestLsp = useCallback(async (
    method: DesktopLspRequestMethod,
    params: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const model = editorRef.current?.getModel();
    if (!model || !api?.lspRequest || !await syncLsp("change")) return undefined;
    const response = await api.lspRequest({
      projectPath,
      relPath,
      languageId: model.getLanguageId(),
      method,
      params,
    });
    return response.available && response.status !== "error" ? response.result : undefined;
  }, [api, projectPath, relPath, syncLsp]);
  const applyWorkspaceEdit = useCallback(async (
    edit: unknown,
    confirmationLabel?: string,
  ): Promise<boolean> => {
    try {
      setSaveError("");
      return await applyLspWorkspaceEdit(graphContextRef.current, edit, confirmationLabel);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  }, []);
  const updateOutline = useCallback(async (): Promise<void> => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    const raw = await requestLsp("textDocument/documentSymbol");
    const converted = lspDocumentSymbols(model, raw, graphContextRef.current);
    if (converted.outline.length) {
      publishOutline(model.uri.toString(), converted.outline);
      return;
    }
    if (!codeGraph) {
      publishOutline(model.uri.toString(), []);
      return;
    }
    try {
      const rows = parseCodeGraphSymbols(await codeGraph("symbols", relPath));
      publishOutline(
        model.uri.toString(),
        codeGraphOutlineItems(model, graphContextRef.current, rows),
      );
    } catch {
      publishOutline(model.uri.toString(), []);
    }
  }, [codeGraph, projectPath, publishOutline, relPath, requestLsp]);
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model || !api?.lspDocument) return;
    const languageId = model.getLanguageId();
    if (active) {
      if (lspAttached.current) return;
      lspAttached.current = true;
      const epoch = ++lspAttachmentEpoch.current;
      lspLanguageId.current = languageId;
      const opening = api.lspDocument({
        kind: "open",
        projectPath,
        relPath,
        languageId,
        version: model.getVersionId(),
        content: model.getValue(),
      });
      lspOpenPromise.current = opening;
      void opening.then((state) => {
        if (epoch !== lspAttachmentEpoch.current || !lspAttached.current) return;
        acceptLspState(state, languageId);
        if (state.available) lspLastVersion.current = model.getVersionId();
        void updateOutline();
      }).catch(() => {
        if (epoch === lspAttachmentEpoch.current) lspReady.current = false;
      });
      return;
    }
    if (!lspAttached.current) return;
    lspAttached.current = false;
    lspAttachmentEpoch.current += 1;
    const pendingOpen = lspOpenPromise.current;
    lspOpenPromise.current = null;
    lspReady.current = false;
    lspLastVersion.current = -1;
    void Promise.resolve(pendingOpen).catch(() => undefined).then(() =>
      api.lspDocument!({
        kind: "close",
        projectPath,
        relPath,
        languageId: lspLanguageId.current || languageId,
        version: model.getVersionId(),
      })).catch(() => undefined);
  }, [acceptLspState, active, api, modelUri, projectPath, relPath, updateOutline]);
  const loadCallHierarchy = useCallback(async (
    root: EditorCallHierarchyItem,
    direction: "incoming" | "outgoing",
    stack: EditorCallHierarchyItem[],
  ) => {
    setCallHierarchy({
      root,
      rows: [],
      stack,
      direction,
      selectedIndex: 0,
      loading: true,
      error: "",
    });
    try {
      const result = await requestLsp(
        direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls",
        { item: root.raw },
      );
      const rows = (Array.isArray(result) ? result : []).flatMap((value) => {
        const record = recordOf(value);
        const item = lspCallHierarchyItem(
          direction === "incoming" ? record?.from : record?.to,
          graphContextRef.current,
        );
        if (!item) return [];
        const ranges = (Array.isArray(record?.fromRanges) ? record.fromRanges : [])
          .flatMap((rawRange) => {
            const range = monacoRange(rawRange);
            return range ? [range] : [];
          });
        return [{
          ...item,
          previewUri: direction === "incoming" ? item.uri : root.uri,
          previewRanges: ranges.length ? ranges : [item.selectionRange],
        }];
      });
      setCallHierarchy({
        root,
        rows,
        stack,
        direction,
        selectedIndex: 0,
        loading: false,
        error: "",
      });
    } catch (reason) {
      setCallHierarchy({
        root,
        rows: [],
        stack,
        direction,
        selectedIndex: 0,
        loading: false,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }, [requestLsp]);
  const startCallHierarchy = useCallback(async () => {
    const position = editorRef.current?.getPosition();
    if (!position) return;
    setCallHierarchy({
      root: null,
      rows: [],
      stack: [],
      direction: window.localStorage.getItem(CALL_HIERARCHY_DIRECTION_KEY) === "outgoing"
        ? "outgoing"
        : "incoming",
      selectedIndex: 0,
      loading: true,
      error: "",
    });
    showCallHierarchyZone(position);
    try {
      const result = await requestLsp(
        "textDocument/prepareCallHierarchy",
        { position: lspPosition(position) },
      );
      const root = lspCallHierarchyItem(
        Array.isArray(result) ? result[0] : result,
        graphContextRef.current,
      );
      if (!root) throw new Error("No call hierarchy is available at the cursor.");
      const direction = window.localStorage.getItem(CALL_HIERARCHY_DIRECTION_KEY) === "outgoing"
        ? "outgoing"
        : "incoming";
      await loadCallHierarchy(root, direction, []);
    } catch (reason) {
      setCallHierarchy({
        root: null,
        rows: [],
        stack: [],
        direction: "incoming",
        selectedIndex: 0,
        loading: false,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }, [loadCallHierarchy, requestLsp, showCallHierarchyZone]);
  const switchCallHierarchyDirection = useCallback((next?: "incoming" | "outgoing") => {
    const current = callHierarchyRef.current;
    if (!current?.root) return;
    const direction = next ?? (current.direction === "incoming" ? "outgoing" : "incoming");
    try {
      window.localStorage.setItem(CALL_HIERARCHY_DIRECTION_KEY, direction);
    } catch {
      // Direction persistence is best-effort.
    }
    void loadCallHierarchy(current.root, direction, current.stack);
  }, [loadCallHierarchy]);
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
  const openCallItem = useCallback((item: EditorCallHierarchyItem) => {
    try {
      const target = normalizedFilePath(monaco.Uri.parse(item.uri).fsPath);
      const root = normalizedFilePath(projectPath);
      if (target.toLocaleLowerCase() === root.toLocaleLowerCase()
        || !target.toLocaleLowerCase().startsWith(`${root.toLocaleLowerCase()}/`)) return;
      onOpenAt?.(target.slice(root.length + 1), item.line);
    } catch {
      // Stale server locations are ignored.
    }
  }, [onOpenAt, projectPath]);
  const selectedCallHierarchyItem = callHierarchy?.rows[
    Math.max(0, Math.min(callHierarchy.selectedIndex, callHierarchy.rows.length - 1))
  ] ?? null;
  useEffect(() => {
    const item = selectedCallHierarchyItem;
    const generation = ++callHierarchyPreviewGeneration.current;
    if (!item) {
      setCallHierarchyPreview(null);
      return;
    }
    let target: import("monaco-editor").Uri;
    try {
      target = monaco.Uri.parse(item.previewUri);
    } catch {
      setCallHierarchyPreview(null);
      return;
    }
    const normalizedRoot = normalizedFilePath(projectPath);
    const normalizedTarget = normalizedFilePath(target.fsPath);
    const rootComparable = normalizedRoot.toLocaleLowerCase();
    const targetComparable = normalizedTarget.toLocaleLowerCase();
    if (targetComparable === rootComparable
      || !targetComparable.startsWith(`${rootComparable}/`)) {
      setCallHierarchyPreview(null);
      return;
    }
    const previewRelPath = normalizedTarget.slice(normalizedRoot.length + 1);
    const line = item.previewRanges[0]?.startLineNumber ?? item.line;
    const existing = monaco.editor.getModels().find((candidate) =>
      normalizedFilePath(candidate.uri.fsPath).toLocaleLowerCase() === targetComparable);
    if (existing) {
      setCallHierarchyPreview({
        itemKey: item.key,
        relPath: previewRelPath,
        content: existing.getValue(),
        languageId: existing.getLanguageId(),
        line,
        ranges: item.previewRanges,
        loading: false,
        error: "",
      });
      return;
    }
    if (!api?.readProjectFile) {
      setCallHierarchyPreview(null);
      return;
    }
    setCallHierarchyPreview({
      itemKey: item.key,
      relPath: previewRelPath,
      content: "",
      languageId: editorLanguageIdForPath(previewRelPath),
      line,
      ranges: item.previewRanges,
      loading: true,
      error: "",
    });
    void api.readProjectFile(projectPath, previewRelPath, accessToken)
      .then((result) => {
        if (generation !== callHierarchyPreviewGeneration.current) return;
        if (result.binary || result.tooLarge) {
          throw new Error("Preview is unavailable for this file.");
        }
        setCallHierarchyPreview({
          itemKey: item.key,
          relPath: previewRelPath,
          content: result.content,
          languageId: editorLanguageIdForPath(previewRelPath),
          line,
          ranges: item.previewRanges,
          loading: false,
          error: "",
        });
      })
      .catch((reason) => {
        if (generation !== callHierarchyPreviewGeneration.current) return;
        setCallHierarchyPreview({
          itemKey: item.key,
          relPath: previewRelPath,
          content: "",
          languageId: editorLanguageIdForPath(previewRelPath),
          line,
          ranges: [],
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      });
  }, [accessToken, api, projectPath, selectedCallHierarchyItem?.key]);
  useEffect(() => {
    if (!callHierarchy || callHierarchy.loading || callHierarchy.error) return;
    window.requestAnimationFrame(() => callHierarchyTreeRef.current?.focus({ preventScroll: true }));
  }, [callHierarchy?.loading, callHierarchy?.error, callHierarchy?.root?.key]);
  const beginCallHierarchySplitResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const move = (pointer: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      if (!rect.width) return;
      const ratio = (pointer.clientX - rect.left) / rect.width;
      setCallHierarchyLayout((current) => ({
        ...current,
        ratio: Math.max(0.35, Math.min(0.85, ratio)),
      }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }, []);
  const beginCallHierarchyHeightResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = callHierarchyLayout.height;
    const move = (pointer: PointerEvent) => {
      const lineDelta = Math.round((pointer.clientY - startY) / 21);
      setCallHierarchyLayout((current) => ({
        ...current,
        height: Math.max(8, Math.min(40, startHeight + lineDelta)),
      }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }, [callHierarchyLayout.height]);

  const reload = useCallback(() => {
    setError("");
    setSaveError("");
    setRevertError("");
    setPreviewError("");
    setPreviewLoaded(false);
    setPreview(null);
    if (filePreviewTypeForPath(relPath) && api?.previewProjectFile) {
      void api.previewProjectFile(projectPath, relPath, accessToken)
        .then((result) => {
          loadedRef.current = true;
          savedMtime.current = result.mtimeMs;
          savedDiskText.current = "";
          savedText.current = "";
          setPreview(result);
          setLoad({
            content: "",
            mtimeMs: result.mtimeMs,
            binary: true,
            tooLarge: false,
            encoding: "utf8",
          });
          setRecovery(null);
          setDiskChanged(false);
          markDirty(false);
        })
        .catch((reason) => {
          setLoad(null);
          setError(reason instanceof Error ? reason.message : String(reason));
        });
      return;
    }
    const reader = api?.readProjectFile;
    if (!reader) {
      setError("Desktop file access is unavailable.");
      return;
    }
    const shouldRestoreBackup = !skipNextBackupRestore.current;
    skipNextBackupRestore.current = false;
    void takeEditorFileLoad(
      api,
      projectPath,
      relPath,
      accessToken,
      !loadedRef.current,
      shouldRestoreBackup,
    )
      .then(({ file: result, backup }) => {
        const resolution = resolveEditorBackup(
          result.content,
          shouldRestoreBackup ? backup : null,
        );
        const content = resolution.content;
        let nextRecovery: EditorRecovery | null = null;
        if (!result.binary && !result.tooLarge && shouldRestoreBackup) {
          nextRecovery = resolution.recovery;
          if (resolution.discardBackup) {
            void deleteBackup().catch(() => undefined);
          }
        }
        loadedRef.current = true;
        savedMtime.current = result.mtimeMs;
        savedDiskText.current = result.content;
        savedText.current = resolution.savedContent;
        setLoad({ ...result, content });
        setRecovery(nextRecovery);
        setDiskChanged(false);
        const model = editorRef.current?.getModel();
        if (model && model.getValue() !== content) model.setValue(content);
        markDirty(content !== resolution.savedContent);
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        if (loadedRef.current) setDiskChanged(true);
      });
  }, [accessToken, api, deleteBackup, projectPath, relPath, markDirty]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if ((error && !load) || (load && !preview && (load.binary || load.tooLarge))) {
      reportEditorLoadStage(projectPath, relPath, accessToken, "fallback-ready", "", true);
      notifyReady();
    }
  }, [accessToken, error, load, notifyReady, preview, projectPath, relPath]);
  useEffect(() => {
    if (mediaForeground) return;
    mediaRef.current?.pause();
  }, [mediaForeground]);
  const saveNow = useCallback(async (encoding?: DesktopTextFileEncoding): Promise<boolean> => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const writer = api?.writeProjectFile;
    if (!editor || !model || !writer) return false;
    if (!encoding && model.getValue() === savedText.current) return true;
    if (editorSettings.formatOnSave) {
      try {
        await editor.getAction("editor.action.formatDocument")?.run();
      } catch (reason) {
        setSaveError(`Format on save failed: ${reason instanceof Error ? reason.message : String(reason)}`);
        return false;
      }
    }
    const content = model.getValue();
    const expectedContent = savedDiskText.current;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    setRevertError("");
    try {
      const result = await writer(
        projectPath,
        relPath,
        content,
        expectedContent,
        accessToken,
        encoding,
      );
      savedMtime.current = result?.mtimeMs ?? Date.now();
      savedDiskText.current = content;
      savedText.current = content;
      setRecovery(null);
      setDiskChanged(false);
      setError("");
      if (encoding) {
        setLoad((current) => current ? { ...current, encoding } : current);
      }
      const currentContent = editorRef.current?.getModel()?.getValue() ?? content;
      const changedAfterSave = currentContent !== content;
      markDirty(changedAfterSave);
      setDiffTick((tick) => tick + 1);
      if (backupTimer.current !== null) {
        window.clearTimeout(backupTimer.current);
        backupTimer.current = null;
      }
      if (changedAfterSave) await writeBackupNow(currentContent).catch(() => undefined);
      else await deleteBackup().catch(() => undefined);
      void syncLsp("save");
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setSaveError(message);
      if (/changed on disk|ENOENT|no such file|cannot find/i.test(message)) setDiskChanged(true);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [accessToken, api, deleteBackup, editorSettings.formatOnSave, projectPath, relPath,
    markDirty, syncLsp, writeBackupNow]);
  const save = useCallback((encoding?: DesktopTextFileEncoding): Promise<boolean> => {
    const queued = saveQueue.current.catch(() => false).then(() => saveNow(encoding));
    saveQueue.current = queued;
    return queued;
  }, [saveNow]);
  const saveRef = useRef<() => Promise<boolean>>(save);
  saveRef.current = save;
  const discard = useCallback(async (): Promise<void> => {
    skipUnmountBackup.current = true;
    await deleteBackup();
  }, [deleteBackup]);
  const onSaveHandleRef = useRef(onSaveHandle);
  onSaveHandleRef.current = onSaveHandle;
  useEffect(() => {
    const handle: EditorFileHandle = {
      save: () => saveRef.current(),
      discard,
    };
    onSaveHandleRef.current?.(handle);
    return () => onSaveHandleRef.current?.(null);
  }, [discard]);

  // Poll mtime every 2.5 seconds while visible.
  useEffect(() => {
    if (!active || !load || load.binary || load.tooLarge) return undefined;
    const timer = window.setInterval(() => {
      // A live tab drag owns the main thread — skip this tick so a log-file
      // auto-reload can never jank the pointer gesture (titlebar sets the flag).
      if (document.body.dataset.tabDragging) return;
      void api?.statProjectFile?.(projectPath, relPath, accessToken).then((info) => {
        if (!info || info.mtimeMs <= savedMtime.current) return;
        const model = editorRef.current?.getModel();
        const isDirty = model ? model.getValue() !== savedText.current : false;
        if (isDirty) setDiskChanged(true);
        else reload();
      }).catch((reason) => {
        const model = editorRef.current?.getModel();
        if (!model) return;
        setDiskChanged(true);
        setSaveError(reason instanceof Error ? reason.message : "File was deleted or renamed on disk.");
      });
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [accessToken, api, active, load, projectPath, relPath, reload]);
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
  // Quick-diff refresh: on load/save (diffTick) and a slow poll while active.
  useEffect(() => {
    if (!active || !load || load.binary || load.tooLarge || !api?.gitDiff) return undefined;
    let live = true;
    const refresh = () => void api.gitDiff?.(projectPath, relPath, false)
      .then((text) => {
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
      })
      .catch(() => { diffDecorations.current?.clear(); });
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => { live = false; window.clearInterval(timer); };
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
  const revertFromDisk = useCallback(async (): Promise<boolean> => {
    const reader = api?.readProjectFile;
    const model = editorRef.current?.getModel();
    if (!reader || !model || reverting || savingRef.current) return false;
    setReverting(true);
    setRevertError("");
    try {
      const result = await reader(projectPath, relPath, accessToken);
      if (result.binary || result.tooLarge) {
        throw new Error("The disk version can no longer be safely edited as text.");
      }
      const content = normalizeEditorModelText(result.content);
      savedMtime.current = result.mtimeMs;
      savedDiskText.current = result.content;
      savedText.current = content;
      setLoad({ ...result, content });
      setRecovery(null);
      setDiskChanged(false);
      setError("");
      setSaveError("");
      model.setValue(content);
      markDirty(false);
      setDiffTick((tick) => tick + 1);
      await deleteBackup().catch(() => undefined);
      editorRef.current?.focus();
      return true;
    } catch (reason) {
      setRevertError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setReverting(false);
    }
  }, [accessToken, api, deleteBackup, markDirty, projectPath, relPath, reverting]);
  const restoreConflictingBackup = useCallback(() => {
    const model = editorRef.current?.getModel();
    if (!model || !recovery) return;
    model.setValue(recovery.content);
    setRecovery({ ...recovery, restored: true });
    markDirty(true);
    scheduleBackup(recovery.content);
    editorRef.current?.focus();
  }, [markDirty, recovery, scheduleBackup]);
  const discardPendingBackup = useCallback(() => {
    setRecovery(null);
    void deleteBackup().catch(() => undefined);
  }, [deleteBackup]);
  const keepEdits = useCallback(() => {
    const model = editorRef.current?.getModel();
    const reader = api?.readProjectFile;
    if (!model || !reader) return;
    setSaveError("");
    void reader(projectPath, relPath, accessToken)
      .then((result) => {
        if (result.binary || result.tooLarge) {
          throw new Error("The disk version can no longer be safely edited as text.");
        }
        const savedContent = normalizeEditorModelText(result.content);
        const currentContent = model.getValue();
        savedMtime.current = result.mtimeMs;
        savedDiskText.current = result.content;
        savedText.current = savedContent;
        setDiskChanged(false);
        setError("");
        const changed = currentContent !== savedContent;
        markDirty(changed);
        if (changed) void writeBackupNow(currentContent).catch(() => undefined);
        else void deleteBackup().catch(() => undefined);
      })
      .catch((reason) => {
        setDiskChanged(true);
        setSaveError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [accessToken, api, deleteBackup, projectPath, relPath, markDirty, writeBackupNow]);
  const breadcrumbSegments = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  // Render the full symbol container chain, one crumb per nesting level.
  const breadcrumbSymbols = (() => {
    const byLevel = new Map<number, EditorOutlineItem>();
    const containing = breadcrumbOutline
      .filter((item) => item.line <= cursorPosition.line
        && (item.endLine ?? item.line) >= cursorPosition.line)
      .sort((left, right) => left.level - right.level || left.line - right.line);
    for (const item of containing) byLevel.set(item.level, item);
    return [...byLevel.values()];
  })();
  const breadcrumbSymbol = breadcrumbSymbols[breadcrumbSymbols.length - 1];
  const selectionLabel = selectionStatus.selections > 1
    ? `${selectionStatus.selections} selections${selectionStatus.characters
      ? ` (${selectionStatus.characters} characters selected)`
      : ""}`
    : `Ln ${cursorPosition.line}, Col ${cursorPosition.column}${selectionStatus.characters
      ? ` (${selectionStatus.characters} selected)`
      : ""}`;
  const closeBreadcrumbPicker = useCallback((restoreBreadcrumbFocus = false) => {
    const sourceIndex = breadcrumbPicker?.anchor.sourceIndex ?? breadcrumbFocusIndex;
    setBreadcrumbPicker(null);
    if (restoreBreadcrumbFocus) {
      window.requestAnimationFrame(() => breadcrumbButtonRefs.current[sourceIndex]?.focus());
    }
  }, [breadcrumbFocusIndex, breadcrumbPicker?.anchor.sourceIndex]);
  const showBreadcrumbFiles = useCallback((
    anchor: BreadcrumbPickerAnchor,
    directory: string,
    selectedRelPath: string,
  ) => {
    const list = api?.listProjectDir;
    if (!list || accessToken) return;
    const generation = ++breadcrumbPickerGeneration.current;
    setBreadcrumbPicker({
      kind: "files",
      anchor,
      directory,
      selectedRelPath,
      rows: [],
      activeIndex: 0,
      loading: true,
      error: "",
    });
    void list(projectPath, directory)
      .then((entries) => {
        if (generation !== breadcrumbPickerGeneration.current) return;
        const rows = entries.map((entry) => ({
          ...entry,
          relPath: [directory, entry.name].filter(Boolean).join("/"),
        }));
        const selectedIndex = Math.max(0, rows.findIndex((row) =>
          normalizedFilePath(row.relPath).toLocaleLowerCase()
            === normalizedFilePath(selectedRelPath).toLocaleLowerCase()));
        setBreadcrumbPicker((current) => current?.kind === "files"
          ? { ...current, rows, activeIndex: selectedIndex, loading: false, error: "" }
          : current);
      })
      .catch((reason) => {
        if (generation !== breadcrumbPickerGeneration.current) return;
        setBreadcrumbPicker((current) => current?.kind === "files"
          ? {
              ...current,
              rows: [],
              activeIndex: 0,
              loading: false,
              error: reason instanceof Error ? reason.message : String(reason),
            }
          : current);
      });
  }, [accessToken, api, projectPath]);
  const openPathBreadcrumb = useCallback((
    event: React.MouseEvent<HTMLButtonElement>,
    index: number,
  ) => {
    setBreadcrumbFocusIndex(index);
    const anchor = breadcrumbPickerAnchor(event.currentTarget, index);
    const isFile = index === breadcrumbSegments.length - 1;
    const directory = isFile
      ? breadcrumbSegments.slice(0, -1).join("/")
      : breadcrumbSegments.slice(0, index + 1).join("/");
    const selectedRelPath = isFile
      ? breadcrumbSegments.join("/")
      : breadcrumbSegments.slice(0, index + 2).join("/");
    showBreadcrumbFiles(anchor, directory, selectedRelPath);
  }, [breadcrumbSegments, showBreadcrumbFiles]);
  const openSymbolBreadcrumb = useCallback((
    event: React.MouseEvent<HTMLButtonElement>,
    sourceIndex: number,
    selected?: EditorOutlineItem,
  ) => {
    setBreadcrumbFocusIndex(sourceIndex);
    const rows = breadcrumbOutline.slice().sort((left, right) =>
      left.line - right.line || left.level - right.level);
    const activeIndex = Math.max(0, rows.findIndex((row) =>
      row.key === (selected ?? breadcrumbSymbol)?.key));
    setBreadcrumbPicker({
      kind: "symbols",
      anchor: breadcrumbPickerAnchor(event.currentTarget, sourceIndex),
      rows,
      activeIndex,
    });
  }, [breadcrumbOutline, breadcrumbSymbol?.key]);
  const openBreadcrumbFile = useCallback((item: BreadcrumbFileItem) => {
    if (item.dir) {
      const current = breadcrumbPicker;
      if (current?.kind === "files") {
        showBreadcrumbFiles(current.anchor, item.relPath, "");
      }
      return;
    }
    setBreadcrumbPicker(null);
    if (normalizedFilePath(item.relPath).toLocaleLowerCase()
      === normalizedFilePath(relPath).toLocaleLowerCase()) {
      editorRef.current?.focus();
      return;
    }
    onOpenAt?.(item.relPath, 1);
  }, [breadcrumbPicker, onOpenAt, relPath, showBreadcrumbFiles]);
  const revealBreadcrumbSymbol = useCallback((item: EditorOutlineItem) => {
    const editor = editorRef.current;
    if (!editor) return;
    setBreadcrumbPicker(null);
    editor.setPosition({ lineNumber: item.line, column: Math.max(1, item.column) });
    editor.revealLineInCenter(item.line);
    editor.focus();
  }, []);
  const focusBreadcrumbPickerRow = useCallback((index: number) => {
    setBreadcrumbPicker((current) => current
      ? { ...current, activeIndex: index } as BreadcrumbPickerState
      : current);
    window.requestAnimationFrame(() => breadcrumbPickerRowRefs.current[index]?.focus());
  }, []);
  const handleBreadcrumbPickerKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = breadcrumbPicker;
    if (!current) return;
    const count = current.rows.length;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeBreadcrumbPicker(true);
      return;
    }
    if (current.kind === "files" && event.key === "ArrowLeft" && current.directory) {
      event.preventDefault();
      const parent = current.directory.split("/").slice(0, -1).join("/");
      showBreadcrumbFiles(current.anchor, parent, current.directory);
      return;
    }
    if (!count) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp"
      || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? 0
        : event.key === "End" ? count - 1
          : (current.activeIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      focusBreadcrumbPickerRow(next);
      return;
    }
    if (event.key === "Enter" || event.key === " "
      || (event.key === "ArrowRight" && current.kind === "files"
        && current.rows[current.activeIndex]?.dir)) {
      event.preventDefault();
      breadcrumbPickerRowRefs.current[current.activeIndex]?.click();
    }
  }, [breadcrumbPicker, closeBreadcrumbPicker, focusBreadcrumbPickerRow, showBreadcrumbFiles]);
  useEffect(() => {
    if (!breadcrumbPicker || breadcrumbPicker.kind === "files" && breadcrumbPicker.loading) return;
    window.requestAnimationFrame(() =>
      breadcrumbPickerRowRefs.current[breadcrumbPicker.activeIndex]?.focus());
  }, [
    breadcrumbPicker?.kind,
    breadcrumbPicker?.kind === "files" ? breadcrumbPicker.directory : "",
    breadcrumbPicker?.kind === "files" ? breadcrumbPicker.loading : false,
  ]);
  useEffect(() => {
    if (!breadcrumbPicker) return undefined;
    const dismiss = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (breadcrumbPickerRef.current?.contains(target)
        || breadcrumbButtonRefs.current.some((button) => button?.contains(target)))) return;
      setBreadcrumbPicker(null);
    };
    window.addEventListener("pointerdown", dismiss, true);
    return () => window.removeEventListener("pointerdown", dismiss, true);
  }, [Boolean(breadcrumbPicker)]);
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
  const handleBreadcrumbKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    // The path owns roving left/right focus; the trailing file actions are
    // ordinary buttons and must keep their native keyboard behavior.
    if ((event.target as HTMLElement).closest(".editor-breadcrumb-actions")) return;
    const count = breadcrumbSegments.length + breadcrumbSymbols.length;
    if (!count) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setBreadcrumbPicker(null);
      editorRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight"
      && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0
      : event.key === "End" ? count - 1
        : (breadcrumbFocusIndex + (event.key === "ArrowRight" ? 1 : -1) + count) % count;
    setBreadcrumbFocusIndex(next);
    breadcrumbButtonRefs.current[next]?.focus();
  }, [breadcrumbFocusIndex, breadcrumbSegments.length, breadcrumbSymbols.length]);
  const editorBreadcrumbs = <nav className="editor-breadcrumbs" aria-label="Breadcrumbs"
    onKeyDown={handleBreadcrumbKeyDown}>
    <span className="editor-breadcrumb-path">
      {breadcrumbSegments.map((segment, index) =>
        <React.Fragment key={`${index}:${segment}`}>
          {index > 0 && <ChevronRight size={14} aria-hidden="true" />}
          <button ref={(node) => { breadcrumbButtonRefs.current[index] = node; }}
            type="button"
            className={`editor-breadcrumb-item${index === breadcrumbSegments.length - 1
              ? " editor-breadcrumb-current" : ""}`}
            title={breadcrumbSegments.slice(0, index + 1).join("/")}
            aria-haspopup={accessToken ? undefined : "tree"}
            aria-expanded={breadcrumbPicker?.kind === "files"
              && breadcrumbPicker.anchor.sourceIndex === index}
            disabled={Boolean(accessToken)}
            tabIndex={breadcrumbFocusIndex === index ? 0 : -1}
            onFocus={() => setBreadcrumbFocusIndex(index)}
            onClick={(event) => openPathBreadcrumb(event, index)}>
            {index === breadcrumbSegments.length - 1
              ? <FileIcon size={14} aria-hidden="true" />
              : <Folder size={14} aria-hidden="true" />}
            <span>{segment}</span>
          </button>
        </React.Fragment>)}
      {breadcrumbSymbols.map((item, symbolIndex) => {
        const focusIndex = breadcrumbSegments.length + symbolIndex;
        return <React.Fragment key={item.key}>
          <ChevronRight size={14} aria-hidden="true" />
          <button ref={(node) => { breadcrumbButtonRefs.current[focusIndex] = node; }}
            type="button"
            className="editor-breadcrumb-item editor-breadcrumb-symbol"
            title={item.detail || item.name}
            aria-haspopup="tree"
            aria-expanded={breadcrumbPicker?.kind === "symbols"
              && breadcrumbPicker.anchor.sourceIndex === focusIndex}
            tabIndex={breadcrumbFocusIndex === focusIndex ? 0 : -1}
            onFocus={() => setBreadcrumbFocusIndex(focusIndex)}
            onClick={(event) => openSymbolBreadcrumb(event, focusIndex, item)}>
            <Braces size={14} aria-hidden="true" />
            <span>{item.name}</span>
          </button>
        </React.Fragment>;
      })}
    </span>
    {/* File-local actions belong to the file path, not to the pane-wide tab
        strip. Keeping them in this shared row also preserves the controls for
        previews and fallback surfaces that do not mount Monaco. */}
    <span className="editor-breadcrumb-actions">
      {load && !preview && !load.binary && !load.tooLarge
        && <button type="button" disabled={!dirty || saving || reverting} onClick={() => { void save(); }}
          aria-label="Save" data-tooltip="Save (Ctrl+S)">
          <Save size={16} aria-hidden="true" />
        </button>}
      {load && !preview && !load.binary && !load.tooLarge && dirty
        && <button type="button" className="editor-revert-action" disabled={saving || reverting}
          onClick={() => { void revertFromDisk(); }}
          aria-label="Revert" data-tooltip="Revert File">
          <Undo2 size={18} aria-hidden="true" />
        </button>}
      <button type="button" aria-label="Reveal in Explorer" data-tooltip="Reveal in Explorer"
        onClick={() => void api?.revealFile?.(projectPath, relPath, accessToken)}>
        <FolderOpen size={16} aria-hidden="true" />
      </button>
    </span>
  </nav>;
  const breadcrumbPickerPortal = breadcrumbPicker
    ? createPortal(
        <div ref={breadcrumbPickerRef} className="editor-breadcrumb-picker" role="dialog"
          aria-label={breadcrumbPicker.kind === "files" ? "File Breadcrumbs" : "Symbol Breadcrumbs"}
          style={{
            left: breadcrumbPicker.anchor.x,
            top: breadcrumbPicker.anchor.y,
            width: breadcrumbPicker.anchor.width,
            maxHeight: breadcrumbPicker.anchor.maxHeight,
          }}
          onKeyDown={handleBreadcrumbPickerKeyDown}>
          {breadcrumbPicker.kind === "files" && <div className="editor-breadcrumb-picker-header">
            <button type="button" aria-label="Parent Folder"
              disabled={!breadcrumbPicker.directory}
              onClick={() => {
                const parent = breadcrumbPicker.directory.split("/").slice(0, -1).join("/");
                showBreadcrumbFiles(
                  breadcrumbPicker.anchor,
                  parent,
                  breadcrumbPicker.directory,
                );
              }}><ChevronLeft size={14} aria-hidden="true" /></button>
            <span title={breadcrumbPicker.directory || projectPath}>
              {breadcrumbPicker.directory || projectPath}
            </span>
          </div>}
          <div className="editor-breadcrumb-picker-tree" role="tree">
            {breadcrumbPicker.kind === "files" && breadcrumbPicker.loading
              && <p><ProgressSpinner size={14} className="editor-pane-spinner" /> Loading…</p>}
            {breadcrumbPicker.kind === "files" && !breadcrumbPicker.loading
              && breadcrumbPicker.error && <p>{breadcrumbPicker.error}</p>}
            {breadcrumbPicker.kind === "files" && !breadcrumbPicker.loading
              && !breadcrumbPicker.error && !breadcrumbPicker.rows.length
              && <p>No files found.</p>}
            {breadcrumbPicker.kind === "symbols" && !breadcrumbPicker.rows.length
              && <p>No symbols found.</p>}
            {breadcrumbPicker.rows.map((item, index) => {
              const fileItem = breadcrumbPicker.kind === "files"
                ? item as BreadcrumbFileItem
                : null;
              const symbolItem = breadcrumbPicker.kind === "symbols"
                ? item as EditorOutlineItem
                : null;
              const selected = index === breadcrumbPicker.activeIndex;
              return <button key={fileItem?.relPath || symbolItem?.key || index}
                ref={(node) => { breadcrumbPickerRowRefs.current[index] = node; }}
                type="button"
                role="treeitem"
                aria-selected={selected}
                className={selected ? "selected" : ""}
                style={symbolItem ? { paddingLeft: `${8 + symbolItem.level * 14}px` } : undefined}
                onFocus={() => setBreadcrumbPicker((current) => current
                  ? { ...current, activeIndex: index } as BreadcrumbPickerState
                  : current)}
                onMouseEnter={() => setBreadcrumbPicker((current) => current
                  ? { ...current, activeIndex: index } as BreadcrumbPickerState
                  : current)}
                onClick={() => fileItem
                  ? openBreadcrumbFile(fileItem)
                  : symbolItem && revealBreadcrumbSymbol(symbolItem)}>
                {fileItem
                  ? fileItem.dir
                    ? <Folder size={14} aria-hidden="true" />
                    : <FileIcon size={14} aria-hidden="true" />
                  : <Braces size={14} aria-hidden="true" />}
                <span>{fileItem?.name || symbolItem?.name}</span>
                {symbolItem?.detail && <small>{symbolItem.detail}</small>}
              </button>;
            })}
          </div>
        </div>,
        document.body,
      )
    : null;
  const callHierarchyPortal = callHierarchy && callHierarchyTarget
    ? createPortal(
        <section className="editor-call-hierarchy" role="dialog" aria-label="Call Hierarchy"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeCallHierarchy();
              return;
            }
            if (event.shiftKey && event.altKey && event.key.toLocaleLowerCase() === "h") {
              event.preventDefault();
              switchCallHierarchyDirection();
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setCallHierarchy((current) => {
                if (!current?.rows.length) return current;
                const offset = event.key === "ArrowDown" ? 1 : -1;
                return {
                  ...current,
                  selectedIndex: (current.selectedIndex + offset + current.rows.length)
                    % current.rows.length,
                };
              });
              return;
            }
            if (event.key === "ArrowLeft" && callHierarchy.stack.length) {
              event.preventDefault();
              const root = callHierarchy.stack.at(-1);
              if (root) void loadCallHierarchy(
                root,
                callHierarchy.direction,
                callHierarchy.stack.slice(0, -1),
              );
              return;
            }
            if (event.key === "ArrowRight" && selectedCallHierarchyItem) {
              event.preventDefault();
              if (callHierarchy.root) void loadCallHierarchy(
                selectedCallHierarchyItem,
                callHierarchy.direction,
                [...callHierarchy.stack, callHierarchy.root],
              );
              return;
            }
            if (event.key === "Enter" && selectedCallHierarchyItem) {
              event.preventDefault();
              openCallItem(selectedCallHierarchyItem);
              closeCallHierarchy();
            }
          }}>
          <header>
            <div className="editor-call-hierarchy-title">
              <b>{callHierarchy.loading
                ? "Loading…"
                : callHierarchy.direction === "incoming"
                  ? `Callers of '${callHierarchy.root?.name || ""}'`
                  : `Calls from '${callHierarchy.root?.name || ""}'`}</b>
              {callHierarchy.root?.detail && <small>{callHierarchy.root.detail}</small>}
            </div>
            <div className="editor-call-hierarchy-actions">
              <button type="button" disabled={!callHierarchy.stack.length}
                aria-label="Back" data-tooltip="Back"
                onClick={() => {
                  const root = callHierarchy.stack.at(-1);
                  if (root) void loadCallHierarchy(
                    root,
                    callHierarchy.direction,
                    callHierarchy.stack.slice(0, -1),
                  );
                }}>←</button>
              <button type="button"
                aria-label={callHierarchy.direction === "incoming"
                  ? "Show Outgoing Calls"
                  : "Show Incoming Calls"}
                data-tooltip={callHierarchy.direction === "incoming"
                  ? "Show Outgoing Calls (Shift+Alt+H)"
                  : "Show Incoming Calls (Shift+Alt+H)"}
                onClick={() => switchCallHierarchyDirection()}>
                {callHierarchy.direction === "incoming" ? "⇥" : "⇤"}
              </button>
              <button type="button" aria-label="Close" data-tooltip="Close (Escape)"
                onClick={closeCallHierarchy}><X size={14} /></button>
            </div>
          </header>
          <div className="editor-call-hierarchy-results"
            style={{
              gridTemplateColumns: `${callHierarchyLayout.ratio * 100}% 4px minmax(100px, 1fr)`,
            }}>
            <div className="editor-call-hierarchy-preview">
              {callHierarchyPreview?.loading
                ? <p>Loading…</p>
                : callHierarchyPreview?.error
                  ? <p>{callHierarchyPreview.error}</p>
                  : callHierarchyPreview
                    ? <Editor key={callHierarchyPreview.itemKey}
                        defaultValue={callHierarchyPreview.content}
                        defaultLanguage={callHierarchyPreview.languageId}
                        theme={lightTheme ? "mixdog-light" : "mixdog-dark"}
                        options={{
                          readOnly: true,
                          domReadOnly: true,
                          fontSize: 13,
                          lineHeight: 20,
                          fontFamily: '"JetBrains Mono Variable", "Cascadia Code", Consolas, monospace',
                          minimap: { enabled: false },
                          scrollbar: MIXDOG_EDITOR_SCROLLBAR,
                          scrollBeyondLastLine: false,
                          overviewRulerLanes: 2,
                          fixedOverflowWidgets: true,
                          automaticLayout: true,
                          lineNumbersMinChars: 3,
                          folding: false,
                          glyphMargin: false,
                        }}
                        onMount={(peekEditor) => {
                          peekEditor.setPosition({
                            lineNumber: callHierarchyPreview.line,
                            column: callHierarchyPreview.ranges[0]?.startColumn ?? 1,
                          });
                          if (callHierarchyPreview.ranges.length) {
                            peekEditor.revealRangeInCenter(callHierarchyPreview.ranges[0]);
                            peekEditor.createDecorationsCollection(
                              callHierarchyPreview.ranges.map((range) => ({
                                range,
                                options: {
                                  className: "editor-call-hierarchy-match",
                                  overviewRuler: {
                                    color: resolveThemeColor("--mx-focus", "#0078d4"),
                                    position: monaco.editor.OverviewRulerLane.Center,
                                  },
                                },
                              })),
                            );
                          } else {
                            peekEditor.revealLineInCenter(callHierarchyPreview.line);
                          }
                          peekEditor.addCommand(monaco.KeyCode.Escape, closeCallHierarchy);
                          peekEditor.addCommand(
                            monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyH,
                            () => switchCallHierarchyDirection(),
                          );
                          peekEditor.onMouseDown((mouseEvent) => {
                            if (mouseEvent.event.detail !== 2 || !selectedCallHierarchyItem) return;
                            openCallItem(selectedCallHierarchyItem);
                            closeCallHierarchy();
                          });
                        }} />
                    : <p>{callHierarchy.error || (callHierarchy.loading
                      ? "Loading…"
                      : "No results")}</p>}
            </div>
            <div className="editor-call-hierarchy-sash" role="separator"
              aria-orientation="vertical" onPointerDown={beginCallHierarchySplitResize} />
            <div ref={callHierarchyTreeRef} className="editor-call-hierarchy-tree"
              role="tree" aria-label={callHierarchy.direction === "incoming"
                ? "Incoming Calls"
                : "Outgoing Calls"} tabIndex={0}>
              {callHierarchy.loading && <p>Loading…</p>}
              {!callHierarchy.loading && callHierarchy.error && <p>{callHierarchy.error}</p>}
              {!callHierarchy.loading && !callHierarchy.error && !callHierarchy.rows.length
                && <p>{callHierarchy.direction === "incoming"
                  ? `No callers of '${callHierarchy.root?.name || ""}'`
                  : `No calls from '${callHierarchy.root?.name || ""}'`}</p>}
              {callHierarchy.rows.map((item, index) =>
                <div key={item.key} role="treeitem"
                  aria-selected={index === callHierarchy.selectedIndex}
                  className={index === callHierarchy.selectedIndex ? "selected" : ""}>
                  <button type="button" className="editor-call-hierarchy-row"
                    onMouseEnter={() => setCallHierarchy((current) =>
                      current ? { ...current, selectedIndex: index } : current)}
                    onClick={() => setCallHierarchy((current) =>
                      current ? { ...current, selectedIndex: index } : current)}
                    onDoubleClick={() => {
                      openCallItem(item);
                      closeCallHierarchy();
                    }}>
                    <span><b>{item.name}</b>{item.detail && <small>{item.detail}</small>}</span>
                  </button>
                  <button type="button" className="editor-call-hierarchy-expand"
                    aria-label={`Show ${callHierarchy.direction} calls for ${item.name}`}
                    onClick={() => callHierarchy.root && void loadCallHierarchy(
                      item,
                      callHierarchy.direction,
                      [...callHierarchy.stack, callHierarchy.root],
                    )}><ChevronRight size={14} /></button>
                </div>)}
            </div>
          </div>
          <div className="editor-call-hierarchy-height-sash" role="separator"
            aria-orientation="horizontal" onPointerDown={beginCallHierarchyHeightResize} />
        </section>,
        callHierarchyTarget,
      )
    : null;
  if (error && !load) {
    return <>{breadcrumbPickerPortal}<div className="editor-pane">{editorBreadcrumbs}<div className="editor-pane-notice">
      <p>{error}</p>
      <button type="button" onClick={reload}>Retry</button>
    </div></div></>;
  }
  if (!load) {
    return <>{breadcrumbPickerPortal}<div className="editor-pane">{editorBreadcrumbs}<div className="editor-pane-notice">
      <ProgressSpinner size={16} className="editor-pane-spinner" aria-hidden="true" /><p>Loading…</p>
    </div></div></>;
  }
  if (preview) {
    const completePreview = () => {
      setPreviewLoaded(true);
      notifyReady();
    };
    const failPreview = () => {
      setPreviewLoaded(true);
      setPreviewError("This file could not be displayed in the built-in viewer.");
      notifyReady();
    };
    return <>{breadcrumbPickerPortal}<div className="editor-pane">{editorBreadcrumbs}
      <div className={`editor-pane-preview is-${preview.kind}`}
        data-ready={previewLoaded ? "true" : "false"}>
        {!previewLoaded && !previewError && <div className="editor-pane-preview-loading" role="status">
          <ProgressSpinner size={16} className="editor-pane-spinner" aria-hidden="true" />
          <p>Loading preview…</p>
        </div>}
        {preview.kind === "image"
          ? <img src={preview.url} alt={relPath.split("/").at(-1) || relPath}
              onLoad={completePreview} onError={failPreview} />
          : preview.kind === "pdf"
            ? <iframe src={preview.url} title={`${relPath.split("/").at(-1) || relPath} PDF preview`}
              onLoad={completePreview} onError={failPreview} />
            : preview.kind === "audio"
              ? <audio key={mediaForeground ? "foreground" : "suspended"}
                ref={(node) => { mediaRef.current = node; }}
                src={mediaForeground ? preview.url : undefined}
                controls={mediaForeground} preload={mediaForeground ? "metadata" : "none"}
                onLoadedMetadata={completePreview} onError={failPreview} />
              : <video key={mediaForeground ? "foreground" : "suspended"}
                ref={(node) => { mediaRef.current = node; }}
                src={mediaForeground ? preview.url : undefined}
                controls={mediaForeground} preload={mediaForeground ? "metadata" : "none"}
                onLoadedMetadata={completePreview} onError={failPreview} />}
        {previewError && <div className="editor-pane-preview-error" role="alert">
          <p>{previewError}</p>
          <button type="button" onClick={() => void api?.openFilePath?.(projectPath, relPath, accessToken)}>
            <ExternalLink size={14} aria-hidden="true" /> Open in default app</button>
        </div>}
      </div>
    </div></>;
  }
  if (load.binary || load.tooLarge) {
    return <>{breadcrumbPickerPortal}<div className="editor-pane">{editorBreadcrumbs}<div className="editor-pane-notice">
      <p>{load.binary ? "Binary file — in-app editing is unavailable." : "File exceeds the 1 MB in-app editing cap."}</p>
      <button type="button" onClick={() => void api?.openFilePath?.(projectPath, relPath, accessToken)}>
        <ExternalLink size={14} aria-hidden="true" /> Open in default app</button>
    </div></div></>;
  }
  return <>{breadcrumbPickerPortal}{callHierarchyPortal}<div className="editor-pane">
    {editorBreadcrumbs}
    {recovery && <div className="editor-pane-recovery" role="status">
      <span>{recovery.diskChanged && !recovery.restored
        ? "Unsaved backup conflicts with the current disk version."
        : "Unsaved changes were restored from the previous session."}</span>
      {recovery.diskChanged && !recovery.restored
        ? <>
            <button type="button" onClick={restoreConflictingBackup}>Restore Backup</button>
            <button type="button" onClick={discardPendingBackup}>Discard Backup</button>
          </>
        : null}
    </div>}
    {diskChanged && <div className="editor-pane-conflict" role="alert">
      <span>{saveError || error || "File changed on disk."}</span>
      <button type="button" onClick={() => { void revertFromDisk(); }}>Reload</button>
      <button type="button" onClick={keepEdits}>Keep my edits</button>
    </div>}
    {revertError && <div className="editor-pane-conflict" role="alert">
      <span>Revert failed: {revertError}</span>
      <button type="button" onClick={() => { void revertFromDisk(); }}>Retry</button>
    </div>}
    {!diskChanged && saveError && <div className="editor-pane-conflict" role="alert">
      <span>Save failed: {saveError}</span>
      <button type="button" onClick={() => { void save(); }}>Retry</button>
    </div>}
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
        onMount={(editor) => {
          editorRef.current = editor;
          armMonoFontRemeasure();
          const layoutHost = editor.getDomNode()?.parentElement;
          if (layoutHost && typeof ResizeObserver !== "undefined") {
            editorLayoutObserver.current?.disconnect();
            editorLayoutObserver.current = new ResizeObserver(() => {
              scheduleEditorLayout(editor, layoutHost);
            });
            editorLayoutObserver.current.observe(layoutHost);
            editorLayoutSize.current = null;
            scheduleEditorLayout(editor, layoutHost);
          }
          ensureCallHierarchyMenu();
          callHierarchyContextKey.current = editor.createContextKey(
            HAS_CALL_HIERARCHY,
            Boolean(lspReady.current && lspCapabilities.current?.callHierarchy),
          );
          languageDisposables.current.push(editor.onDidFocusEditorText(() => {
            focusedGraphEditor.current = editor;
          }));
          if (activeRef.current && focusedRef.current) focusedGraphEditor.current = editor;
          const model = editor.getModel();
          if (model) {
            // A model reused or created before this pane owned it can carry a
            // stale guessed language (plain white paint); realign with the
            // path-derived language before wiring providers and LSP state.
            const expectedLanguageId = explicitEditorLanguageIdForPath(relPath);
            if (expectedLanguageId && model.getLanguageId() !== expectedLanguageId) {
              monaco.editor.setModelLanguage(model, expectedLanguageId);
            }
            ensureEditorLanguageStore();
            setModelUri(model.uri.toString());
            graphContextsByModel.set(model.uri.toString(), graphContextRef);
            graphContextsByEditor.set(editor, graphContextRef);
            ensureGraphProviders(model.getLanguageId());
            lspLanguageId.current = model.getLanguageId();
            const syncLanguageState = () => {
              const languageSnapshot = getEditorLanguageSnapshot();
              const comparableRelPath = relPath.replace(/\\/g, "/").toLocaleLowerCase();
              const status = languageSnapshot.statuses.find((candidate) =>
                candidate.projectPath === projectPath
                && candidate.languageId === model.getLanguageId()
                && candidate.relPath?.replace(/\\/g, "/").toLocaleLowerCase()
                  === comparableRelPath)
                ?? languageSnapshot.statuses.find((candidate) =>
                  candidate.projectPath === projectPath
                  && candidate.languageId === model.getLanguageId()
                  && !candidate.relPath);
              if (status) acceptLspState(status, model.getLanguageId());
              const problems = languageSnapshot.problems
                .filter((problem) => problem.origin === "lsp"
                  && problem.projectPath.replace(/[\\/]+/g, "/").toLocaleLowerCase()
                    === projectPath.replace(/[\\/]+/g, "/").toLocaleLowerCase()
                  && problem.relPath.replace(/\\/g, "/").toLocaleLowerCase()
                    === relPath.replace(/\\/g, "/").toLocaleLowerCase());
              const signature = JSON.stringify(problems.map((problem) => [
                problem.severity,
                problem.message,
                problem.startLineNumber,
                problem.startColumn,
                problem.endLineNumber,
                problem.endColumn,
              ]));
              if (signature === lspMarkerSignature.current) return;
              lspMarkerSignature.current = signature;
              monaco.editor.setModelMarkers(model, "mixdog-lsp", problems.map((problem) => ({
                severity: problem.severity === 1 ? monaco.MarkerSeverity.Error
                  : problem.severity === 2 ? monaco.MarkerSeverity.Warning
                    : problem.severity === 4 ? monaco.MarkerSeverity.Hint
                      : monaco.MarkerSeverity.Info,
                message: problem.message,
                source: problem.source,
                code: problem.code || undefined,
                startLineNumber: problem.startLineNumber,
                startColumn: problem.startColumn,
                endLineNumber: problem.endLineNumber,
                endColumn: problem.endColumn,
              })));
            };
            const unsubscribeStore = subscribeEditorLanguageStore(syncLanguageState);
            languageDisposables.current.push({ dispose: unsubscribeStore });
            syncLanguageState();
            const publishNative = () => setNativeEditorProblems(
              projectPath,
              relPath,
              model.uri.toString(),
              monaco.editor.getModelMarkers({ resource: model.uri })
                .filter((marker) => marker.owner !== "mixdog-lsp"),
            );
            languageDisposables.current.push(monaco.editor.onDidChangeMarkers((uris) => {
              if (uris.some((uri) => uri.toString() === model.uri.toString())) publishNative();
            }));
            publishNative();
            languageDisposables.current.push(model.onDidChangeContent(() => {
              scheduleAnsiOutput(model);
              if (lspChangeTimer.current !== null) window.clearTimeout(lspChangeTimer.current);
              lspChangeTimer.current = window.setTimeout(() => { void syncLsp("change"); }, 120);
              if (outlineTimer.current !== null) window.clearTimeout(outlineTimer.current);
              outlineTimer.current = window.setTimeout(() => { void updateOutline(); }, 350);
            }));
            languageDisposables.current.push(editor.onDidChangeCursorPosition((event) => {
              setActiveEditorPosition(model.uri.toString(), event.position.lineNumber, event.position.column);
              setCursorPosition({
                line: event.position.lineNumber,
                column: event.position.column,
              });
              if (activeRef.current && focusedRef.current) {
                onNavigationLocationRef.current?.(
                  relPath,
                  event.position.lineNumber,
                  event.position.column,
                );
              }
            }));
            const syncSelection = () => {
              const selections = editor.getSelections() ?? [];
              setSelectionStatus({
                selections: Math.max(1, selections.length),
                characters: selections.reduce(
                  (total, selection) => total + model.getValueLengthInRange(selection),
                  0,
                ),
              });
            };
            languageDisposables.current.push(editor.onDidChangeCursorSelection(syncSelection));
            syncSelection();
            const syncProblems = () => {
              const markers = monaco.editor.getModelMarkers({ resource: model.uri });
              setProblemStatus({
                errors: markers.filter((marker) =>
                  marker.severity === monaco.MarkerSeverity.Error).length,
                warnings: markers.filter((marker) =>
                  marker.severity === monaco.MarkerSeverity.Warning).length,
              });
            };
            languageDisposables.current.push(monaco.editor.onDidChangeMarkers((uris) => {
              if (uris.some((uri) => uri.toString() === model.uri.toString())) syncProblems();
            }));
            syncProblems();
            const position = editor.getPosition();
            if (position) {
              setCursorPosition({ line: position.lineNumber, column: position.column });
            }
            const modelOptions = model.getOptions();
            setEditorFormat({
              tabSize: modelOptions.tabSize,
              insertSpaces: modelOptions.insertSpaces,
              eol: model.getEOL() === "\r\n" ? "CRLF" : "LF",
              languageId: model.getLanguageId(),
            });
            languageDisposables.current.push(model.onDidChangeOptions(syncEditorFormat));
            languageDisposables.current.push(model.onDidChangeLanguage(syncEditorFormat));
            const editorNode = editor.getDomNode();
            const copyRenderedAnsi = (event: ClipboardEvent) => {
              if (!isAnsiOutputPath(relPath) || !event.clipboardData) return;
              const selections = editor.getSelections() ?? [];
              const raw = selections.map((selection) => model.getValueInRange(selection)).join("\n");
              if (!raw.includes("\x1b[")) return;
              event.preventDefault();
              event.clipboardData.setData("text/plain", visibleEditorAnsiText(raw));
            };
            editorNode?.addEventListener("copy", copyRenderedAnsi, true);
            languageDisposables.current.push({
              dispose: () => editorNode?.removeEventListener("copy", copyRenderedAnsi, true),
            });
          }
          const viewState = readEditorViewState(viewStateKey);
          if (viewState) {
            try { editor.restoreViewState(viewState); } catch { /* stale Monaco state starts at the top */ }
          }
          if (active && focused) {
            requestAnimationFrame(() => editor.focus());
          }
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void saveRef.current(); });
          // Alt+Z toggles word wrap; the stable action id lets the command
          // palette resolve it through getAction.
          editor.addAction({
            id: "editor.action.toggleWordWrap",
            label: "View: Toggle Word Wrap",
            keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
            run: () => {
              const wrapped = editor.getOption(monaco.editor.EditorOption.wordWrap) !== "off";
              const configured = editorSettingsRef.current.wordWrap;
              setWordWrapOverride(wrapped ? "off" : configured !== "off" ? configured : "on");
            },
          });
          // Workspace-shortcut parity while Monaco owns the keyboard: tab
          // cycling (Ctrl+PageUp/PageDown / Ctrl+Tab) and immediate mod+W close
          // re-emit the same app-level events the global listener handles.
          const cycle = (offset: number) => window.dispatchEvent(
            new CustomEvent("mixdog:cycle-tab", { detail: offset }));
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.PageDown, () => cycle(1));
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.PageUp, () => cycle(-1));
          // Ctrl+Tab routes to the MRU switcher, not the sequential cycle.
          const switchTab = (offset: number) => window.dispatchEvent(
            new CustomEvent("mixdog:tab-switcher", { detail: offset }));
          editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.Tab, () => switchTab(1));
          editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyMod.Shift | monaco.KeyCode.Tab, () => switchTab(-1));
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () =>
            window.dispatchEvent(new CustomEvent("mixdog:close-active-tab")));
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyQ, () =>
            window.dispatchEvent(new CustomEvent("mixdog:close-active-tab")));
          const onEditorAction = (event: Event) => {
            if (!activeRef.current || !focusedRef.current) return;
            const detail = (event as CustomEvent).detail;
            const action = typeof detail === "string" ? detail : String(detail?.action || "");
            if (typeof detail?.line === "number") {
              editor.setPosition({
                lineNumber: Math.max(1, detail.line),
                column: Math.max(1, Number(detail.column) || 1),
              });
              editor.revealLineInCenter(Math.max(1, detail.line));
            }
            if (action === "callHierarchy") {
              void startCallHierarchy();
              return;
            }
            const actionId = action === "rename" ? "editor.action.rename"
              : action === "quickFix" ? "editor.action.quickFix"
                : action === "refactor" ? "editor.action.refactor"
                  : action === "format" ? "editor.action.formatDocument"
                    : action.startsWith("editor.") ? action : "";
            if (actionId === FORMAT_DOCUMENT_WITH) {
              void editor.getAction("editor.action.formatDocument")?.run();
            } else if (actionId) {
              void editor.getAction(actionId)?.run();
            }
          };
          window.addEventListener("mixdog:editor-action", onEditorAction);
          languageDisposables.current.push({
            dispose: () => window.removeEventListener("mixdog:editor-action", onEditorAction),
          });
          if (model) markDirty(model.getValue() !== savedText.current);
          renderAnsiOutput(model);
          reportEditorLoadStage(projectPath, relPath, accessToken, "ready", "", true);
          notifyReady();
        }}
        onChange={(value) => {
          const content = String(value ?? "");
          const changed = content !== savedText.current;
          skipUnmountBackup.current = false;
          setRevertError("");
          markDirty(changed);
          if (changed) scheduleBackup(content);
          else {
            setRecovery(null);
            void deleteBackup().catch(() => undefined);
          }
        }}
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
