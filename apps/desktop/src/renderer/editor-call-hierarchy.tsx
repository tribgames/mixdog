import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useMobileBack } from './mobile-back';
import { lspCallHierarchyItem, lspPosition, type EditorCallHierarchyItem } from './editor-lsp-conversion';
import {
  callHierarchyCalls,
  callHierarchyPreview,
  callHierarchyPreviewTarget,
  failureText,
  hierarchyFailure,
  hierarchyLoading,
  hierarchyResults,
  projectRelativePath,
  type CallHierarchyDirection,
  type CallHierarchyState,
} from './editor-call-hierarchy-model';
import { CallHierarchyPeek } from './editor-call-hierarchy-view';
import {
  CALL_HIERARCHY_DIRECTION_KEY,
  CALL_HIERARCHY_LAYOUT_KEY,
  type EditorGraphContext,
} from './editor-monaco-providers';
import { readCallHierarchyLayout, type CallHierarchyPreview } from './editor-pane-model';
import { monaco } from './monaco-setup';

type EditorInstance = import('monaco-editor').editor.IStandaloneCodeEditor;
type RequestLsp = (
  method: import('../shared/contract').DesktopLspRequestMethod,
  params?: Record<string, unknown>
) => Promise<unknown>;

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
  contextKey: RefObject<import('monaco-editor').editor.IContextKey<boolean> | null>;
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

  const showZone = useCallback(
    (position: import('monaco-editor').Position) => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!editor || !model) return;
      removeZone();
      const domNode = document.createElement('div');
      domNode.className = 'editor-call-hierarchy-zone';
      const visible = editor.getScrolledVisiblePosition(position);
      domNode.style.setProperty('--peek-arrow-left', `${Math.max(12, visible?.left ?? 12)}px`);
      const zone = {
        afterLineNumber: Math.min(model.getLineCount(), Math.max(1, position.lineNumber)),
        heightInLines: layout.height,
        domNode,
        suppressMouseDown: false,
      };
      let id = '';
      editor.changeViewZones((accessor) => {
        id = accessor.addZone(zone);
      });
      zoneRef.current = { id, zone };
      setTarget(domNode);
      editor.revealLineInCenter(position.lineNumber);
    },
    [editorRef, layout.height, removeZone]
  );

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

  useEffect(
    () => () => {
      removeZone();
      contextKey.current?.reset();
      contextKey.current = null;
    },
    [removeZone]
  );

  const load = useCallback(
    async (root: EditorCallHierarchyItem, direction: CallHierarchyDirection, stack: EditorCallHierarchyItem[]) => {
      setState(hierarchyLoading(root, direction, stack));
      try {
        const result = await requestLsp(
          direction === 'incoming' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls',
          { item: root.raw }
        );
        const rows = callHierarchyCalls(result, direction, root, graphContextRef.current);
        setState(hierarchyResults(root, direction, stack, rows));
      } catch (reason) {
        setState(hierarchyFailure(root, direction, stack, reason));
      }
    },
    [graphContextRef, requestLsp]
  );

  const start = useCallback(async () => {
    const position = editorRef.current?.getPosition();
    if (!position) return;
    const direction =
      window.localStorage.getItem(CALL_HIERARCHY_DIRECTION_KEY) === 'outgoing' ? 'outgoing' : 'incoming';
    setState(hierarchyLoading(null, direction, []));
    showZone(position);
    try {
      const result = await requestLsp('textDocument/prepareCallHierarchy', { position: lspPosition(position) });
      const root = lspCallHierarchyItem(Array.isArray(result) ? result[0] : result, graphContextRef.current);
      if (!root) throw new Error('No call hierarchy is available at the cursor.');
      await load(root, direction, []);
    } catch (reason) {
      setState(hierarchyFailure(null, 'incoming', [], reason));
    }
  }, [editorRef, graphContextRef, load, requestLsp, showZone]);

  const switchDirection = useCallback(
    (next?: CallHierarchyDirection) => {
      const current = stateRef.current;
      if (!current?.root) return;
      const direction = next ?? (current.direction === 'incoming' ? 'outgoing' : 'incoming');
      try {
        window.localStorage.setItem(CALL_HIERARCHY_DIRECTION_KEY, direction);
      } catch {
        // Direction persistence is best-effort.
      }
      void load(current.root, direction, current.stack);
    },
    [load]
  );

  const openItem = useCallback(
    (item: EditorCallHierarchyItem) => {
      try {
        const relPath = projectRelativePath(monaco.Uri.parse(item.uri).fsPath, projectPath);
        if (relPath === null) return;
        onOpenAt?.(relPath, item.line);
      } catch {
        // Ignore stale server locations.
      }
    },
    [onOpenAt, projectPath]
  );

  const selected = state?.rows[Math.max(0, Math.min(state.selectedIndex, state.rows.length - 1))] ?? null;

  useEffect(() => {
    const item = selected;
    const generation = ++previewGeneration.current;
    if (!item) {
      setPreview(null);
      return;
    }
    const target = callHierarchyPreviewTarget(item, projectPath);
    if (!target) {
      setPreview(null);
      return;
    }
    if (target.model) {
      setPreview(
        callHierarchyPreview(item, target, {
          content: target.model.getValue(),
          languageId: target.model.getLanguageId(),
        })
      );
      return;
    }
    if (!api?.readProjectFile) {
      setPreview(null);
      return;
    }
    setPreview(callHierarchyPreview(item, target, { loading: true }));
    void api
      .readProjectFile(projectPath, target.relPath, accessToken)
      .then((result) => {
        if (generation !== previewGeneration.current) return;
        if (result.binary || result.tooLarge) {
          throw new Error('Preview is unavailable for this file.');
        }
        setPreview(callHierarchyPreview(item, target, { content: result.content }));
      })
      .catch((reason) => {
        if (generation !== previewGeneration.current) return;
        setPreview(callHierarchyPreview(item, target, { ranges: [], error: failureText(reason) }));
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
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  }, []);

  const beginHeightResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
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
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop, { once: true });
    },
    [layout.height]
  );

  const portal =
    state &&
    target &&
    createPortal(
      <CallHierarchyPeek
        state={state}
        selected={selected}
        preview={preview}
        layout={layout}
        lightTheme={lightTheme}
        treeRef={treeRef}
        setState={setState}
        close={close}
        switchDirection={switchDirection}
        load={load}
        openItem={openItem}
        beginSplitResize={beginSplitResize}
        beginHeightResize={beginHeightResize}
      />,
      target
    );

  return {
    portal,
    start,
    close,
  };
}
