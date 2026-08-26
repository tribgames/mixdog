import Editor from "@monaco-editor/react";
import { ChevronRight, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { editorLanguageIdForPath } from "../shared/editor-languages";
import { useMobileBack } from "./mobile-back";
import {
  lspCallHierarchyItem,
  lspPosition,
  monacoRange,
  normalizedFilePath,
  recordOf,
  type EditorCallHierarchyItem,
} from "./editor-lsp-conversion";
import { MIXDOG_EDITOR_SCROLLBAR } from "./editor-monaco-bootstrap";
import {
  CALL_HIERARCHY_DIRECTION_KEY,
  CALL_HIERARCHY_LAYOUT_KEY,
  type EditorGraphContext,
} from "./editor-monaco-providers";
import {
  readCallHierarchyLayout,
  type CallHierarchyPreview,
} from "./editor-pane-model";
import { monaco, resolveThemeColor } from "./monaco-setup";

type EditorInstance = import("monaco-editor").editor.IStandaloneCodeEditor;
type RequestLsp = (
  method: import("../shared/contract").DesktopLspRequestMethod,
  params?: Record<string, unknown>,
) => Promise<unknown>;

interface CallHierarchyState {
  root: EditorCallHierarchyItem | null;
  rows: EditorCallHierarchyItem[];
  stack: EditorCallHierarchyItem[];
  direction: "incoming" | "outgoing";
  selectedIndex: number;
  loading: boolean;
  error: string;
}

export function useEditorCallHierarchy({
  editorRef,
  graphContextRef,
  projectPath,
  accessToken,
  lightTheme,
  requestLsp,
  onOpenAt,
  contextKey,
}: {
  editorRef: RefObject<EditorInstance | null>;
  graphContextRef: RefObject<EditorGraphContext>;
  projectPath: string;
  accessToken?: string;
  lightTheme: boolean;
  requestLsp: RequestLsp;
  onOpenAt?(relPath: string, line: number): void;
  contextKey: RefObject<import("monaco-editor").editor.IContextKey<boolean> | null>;
}) {
  const api = window.mixdogDesktop;
  const [state, setState] = useState<CallHierarchyState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [layout, setLayout] = useState(readCallHierarchyLayout);
  const [preview, setPreview] = useState<CallHierarchyPreview | null>(null);
  const previewGeneration = useRef(0);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const zoneRef = useRef<{
    id: string;
    zone: {
      afterLineNumber: number;
      heightInLines: number;
      domNode: HTMLElement;
      suppressMouseDown: boolean;
    };
  } | null>(null);
  const removeZone = useCallback(() => {
    const editor = editorRef.current;
    const current = zoneRef.current;
    zoneRef.current = null;
    if (editor && current) {
      try {
        editor.changeViewZones((accessor) => accessor.removeZone(current.id));
      } catch {
        // Disposing Monaco also removes its view zones.
      }
    }
    setTarget(null);
  }, [editorRef]);

  const close = useCallback(() => {
    setState(null);
    setPreview(null);
    removeZone();
    editorRef.current?.focus();
  }, [editorRef, removeZone]);
  useMobileBack(Boolean(state), close);

  const showZone = useCallback((position: import("monaco-editor").Position) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    removeZone();
    const domNode = document.createElement("div");
    domNode.className = "editor-call-hierarchy-zone";
    const visible = editor.getScrolledVisiblePosition(position);
    domNode.style.setProperty("--peek-arrow-left", `${Math.max(12, visible?.left ?? 12)}px`);
    const zone = {
      afterLineNumber: Math.min(model.getLineCount(), Math.max(1, position.lineNumber)),
      heightInLines: layout.height,
      domNode,
      suppressMouseDown: false,
    };
    let id = "";
    editor.changeViewZones((accessor) => {
      id = accessor.addZone(zone);
    });
    zoneRef.current = { id, zone };
    setTarget(domNode);
    editor.revealLineInCenter(position.lineNumber);
  }, [editorRef, layout.height, removeZone]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CALL_HIERARCHY_LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // Peek layout persistence is best-effort.
    }
    const editor = editorRef.current;
    const current = zoneRef.current;
    if (!editor || !current) return;
    current.zone.heightInLines = layout.height;
    editor.changeViewZones((accessor) => accessor.layoutZone(current.id));
  }, [editorRef, layout]);

  useEffect(() => () => {
    removeZone();
    contextKey.current?.reset();
    contextKey.current = null;
  }, [removeZone]);

  const load = useCallback(async (
    root: EditorCallHierarchyItem,
    direction: "incoming" | "outgoing",
    stack: EditorCallHierarchyItem[],
  ) => {
    setState({
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
      setState({
        root,
        rows,
        stack,
        direction,
        selectedIndex: 0,
        loading: false,
        error: "",
      });
    } catch (reason) {
      setState({
        root,
        rows: [],
        stack,
        direction,
        selectedIndex: 0,
        loading: false,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }, [graphContextRef, requestLsp]);

  const start = useCallback(async () => {
    const position = editorRef.current?.getPosition();
    if (!position) return;
    const direction = window.localStorage.getItem(CALL_HIERARCHY_DIRECTION_KEY) === "outgoing"
      ? "outgoing"
      : "incoming";
    setState({
      root: null,
      rows: [],
      stack: [],
      direction,
      selectedIndex: 0,
      loading: true,
      error: "",
    });
    showZone(position);
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
      await load(root, direction, []);
    } catch (reason) {
      setState({
        root: null,
        rows: [],
        stack: [],
        direction: "incoming",
        selectedIndex: 0,
        loading: false,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }, [editorRef, graphContextRef, load, requestLsp, showZone]);

  const switchDirection = useCallback((next?: "incoming" | "outgoing") => {
    const current = stateRef.current;
    if (!current?.root) return;
    const direction = next ?? (current.direction === "incoming" ? "outgoing" : "incoming");
    try {
      window.localStorage.setItem(CALL_HIERARCHY_DIRECTION_KEY, direction);
    } catch {
      // Direction persistence is best-effort.
    }
    void load(current.root, direction, current.stack);
  }, [load]);

  const openItem = useCallback((item: EditorCallHierarchyItem) => {
    try {
      const path = normalizedFilePath(monaco.Uri.parse(item.uri).fsPath);
      const root = normalizedFilePath(projectPath);
      if (path.toLocaleLowerCase() === root.toLocaleLowerCase()
        || !path.toLocaleLowerCase().startsWith(`${root.toLocaleLowerCase()}/`)) return;
      onOpenAt?.(path.slice(root.length + 1), item.line);
    } catch {
      // Ignore stale server locations.
    }
  }, [onOpenAt, projectPath]);

  const selected = state?.rows[
    Math.max(0, Math.min(state.selectedIndex, state.rows.length - 1))
  ] ?? null;

  useEffect(() => {
    const item = selected;
    const generation = ++previewGeneration.current;
    if (!item) {
      setPreview(null);
      return;
    }
    let uri: import("monaco-editor").Uri;
    try {
      uri = monaco.Uri.parse(item.previewUri);
    } catch {
      setPreview(null);
      return;
    }
    const root = normalizedFilePath(projectPath);
    const path = normalizedFilePath(uri.fsPath);
    const rootComparable = root.toLocaleLowerCase();
    const pathComparable = path.toLocaleLowerCase();
    if (pathComparable === rootComparable
      || !pathComparable.startsWith(`${rootComparable}/`)) {
      setPreview(null);
      return;
    }
    const relPath = path.slice(root.length + 1);
    const line = item.previewRanges[0]?.startLineNumber ?? item.line;
    const existing = monaco.editor.getModels().find((candidate) =>
      normalizedFilePath(candidate.uri.fsPath).toLocaleLowerCase() === pathComparable);
    if (existing) {
      setPreview({
        itemKey: item.key,
        relPath,
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
      setPreview(null);
      return;
    }
    setPreview({
      itemKey: item.key,
      relPath,
      content: "",
      languageId: editorLanguageIdForPath(relPath),
      line,
      ranges: item.previewRanges,
      loading: true,
      error: "",
    });
    void api.readProjectFile(projectPath, relPath, accessToken)
      .then((result) => {
        if (generation !== previewGeneration.current) return;
        if (result.binary || result.tooLarge) {
          throw new Error("Preview is unavailable for this file.");
        }
        setPreview({
          itemKey: item.key,
          relPath,
          content: result.content,
          languageId: editorLanguageIdForPath(relPath),
          line,
          ranges: item.previewRanges,
          loading: false,
          error: "",
        });
      })
      .catch((reason) => {
        if (generation !== previewGeneration.current) return;
        setPreview({
          itemKey: item.key,
          relPath,
          content: "",
          languageId: editorLanguageIdForPath(relPath),
          line,
          ranges: [],
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      });
  }, [accessToken, api, projectPath, selected?.key]);

  useEffect(() => {
    if (!state || state.loading || state.error) return;
    window.requestAnimationFrame(() => treeRef.current?.focus({ preventScroll: true }));
  }, [state?.error, state?.loading, state?.root?.key]);

  const beginSplitResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const move = (pointer: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      if (!rect.width) return;
      const ratio = (pointer.clientX - rect.left) / rect.width;
      setLayout((current) => ({
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

  const beginHeightResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = layout.height;
    const move = (pointer: PointerEvent) => {
      const lineDelta = Math.round((pointer.clientY - startY) / 21);
      setLayout((current) => ({
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
  }, [layout.height]);

  const portal = state && target
    ? createPortal(
        <section className="editor-call-hierarchy" role="dialog" aria-label="Call Hierarchy"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            if (event.shiftKey && event.altKey && event.key.toLocaleLowerCase() === "h") {
              event.preventDefault();
              switchDirection();
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setState((current) => {
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
            if (event.key === "ArrowLeft" && state.stack.length) {
              event.preventDefault();
              const root = state.stack.at(-1);
              if (root) void load(root, state.direction, state.stack.slice(0, -1));
              return;
            }
            if (event.key === "ArrowRight" && selected) {
              event.preventDefault();
              if (state.root) void load(selected, state.direction, [...state.stack, state.root]);
              return;
            }
            if (event.key === "Enter" && selected) {
              event.preventDefault();
              openItem(selected);
              close();
            }
          }}>
          <header>
            <div className="editor-call-hierarchy-title">
              <b>{state.loading
                ? "Loading…"
                : state.direction === "incoming"
                  ? `Callers of '${state.root?.name || ""}'`
                  : `Calls from '${state.root?.name || ""}'`}</b>
              {state.root?.detail && <small>{state.root.detail}</small>}
            </div>
            <div className="editor-call-hierarchy-actions">
              <button type="button" disabled={!state.stack.length}
                aria-label="Back" data-tooltip="Back"
                onClick={() => {
                  const root = state.stack.at(-1);
                  if (root) void load(root, state.direction, state.stack.slice(0, -1));
                }}>←</button>
              <button type="button"
                aria-label={state.direction === "incoming"
                  ? "Show Outgoing Calls"
                  : "Show Incoming Calls"}
                data-tooltip={state.direction === "incoming"
                  ? "Show Outgoing Calls (Shift+Alt+H)"
                  : "Show Incoming Calls (Shift+Alt+H)"}
                onClick={() => switchDirection()}>
                {state.direction === "incoming" ? "⇥" : "⇤"}
              </button>
              <button type="button" aria-label="Close" data-tooltip="Close (Escape)"
                onClick={close}><X size={14} /></button>
            </div>
          </header>
          <div className="editor-call-hierarchy-results"
            style={{
              gridTemplateColumns: `${layout.ratio * 100}% 4px minmax(100px, 1fr)`,
            }}>
            <div className="editor-call-hierarchy-preview">
              {preview?.loading
                ? <p>Loading…</p>
                : preview?.error
                  ? <p>{preview.error}</p>
                  : preview
                    ? <Editor key={preview.itemKey}
                        defaultValue={preview.content}
                        defaultLanguage={preview.languageId}
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
                            lineNumber: preview.line,
                            column: preview.ranges[0]?.startColumn ?? 1,
                          });
                          if (preview.ranges.length) {
                            peekEditor.revealRangeInCenter(preview.ranges[0]);
                            peekEditor.createDecorationsCollection(
                              preview.ranges.map((range) => ({
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
                            peekEditor.revealLineInCenter(preview.line);
                          }
                          peekEditor.addCommand(monaco.KeyCode.Escape, close);
                          peekEditor.addCommand(
                            monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyH,
                            () => switchDirection(),
                          );
                          peekEditor.onMouseDown((event) => {
                            if (event.event.detail !== 2 || !selected) return;
                            openItem(selected);
                            close();
                          });
                        }} />
                    : <p>{state.error || (state.loading ? "Loading…" : "No results")}</p>}
            </div>
            <div className="editor-call-hierarchy-sash" role="separator"
              aria-orientation="vertical" onPointerDown={beginSplitResize} />
            <div ref={treeRef} className="editor-call-hierarchy-tree"
              role="tree" aria-label={state.direction === "incoming"
                ? "Incoming Calls"
                : "Outgoing Calls"} tabIndex={0}>
              {state.loading && <p>Loading…</p>}
              {!state.loading && state.error && <p>{state.error}</p>}
              {!state.loading && !state.error && !state.rows.length
                && <p>{state.direction === "incoming"
                  ? `No callers of '${state.root?.name || ""}'`
                  : `No calls from '${state.root?.name || ""}'`}</p>}
              {state.rows.map((item, index) =>
                <div key={item.key} role="treeitem"
                  aria-selected={index === state.selectedIndex}
                  className={index === state.selectedIndex ? "selected" : ""}>
                  <button type="button" className="editor-call-hierarchy-row"
                    onMouseEnter={() => setState((current) =>
                      current ? { ...current, selectedIndex: index } : current)}
                    onClick={() => setState((current) =>
                      current ? { ...current, selectedIndex: index } : current)}
                    onDoubleClick={() => {
                      openItem(item);
                      close();
                    }}>
                    <span><b>{item.name}</b>{item.detail && <small>{item.detail}</small>}</span>
                  </button>
                  <button type="button" className="editor-call-hierarchy-expand"
                    aria-label={`Show ${state.direction} calls for ${item.name}`}
                    onClick={() => state.root && void load(
                      item,
                      state.direction,
                      [...state.stack, state.root],
                    )}><ChevronRight size={14} /></button>
                </div>)}
            </div>
          </div>
          <div className="editor-call-hierarchy-height-sash" role="separator"
            aria-orientation="horizontal" onPointerDown={beginHeightResize} />
        </section>,
        target,
      )
    : null;

  return {
    portal,
    start,
    close,
  };
}
