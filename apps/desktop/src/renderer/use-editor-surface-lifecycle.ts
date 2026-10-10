// Monaco surface lifecycle: bind the content listener on mount, persist view
// state and release every per-editor resource on release, and dispose the
// model-bound state when the pane unmounts.
import { useEffect, useRef, type MutableRefObject } from 'react';
import type { IDisposable, editor } from 'monaco-editor';
import {
  focusedGraphEditor,
  graphContextsByEditor,
  graphContextsByModel,
  writeEditorViewState,
  type EditorGraphContext,
} from './editor-monaco-providers';
import { cancelLayoutFrame } from './interaction-frame-scheduler';
import type { EditorLayoutDimension } from './editor-layout';

export function useEditorSurfaceLifecycle({
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
}: {
  editorRef: MutableRefObject<editor.IStandaloneCodeEditor | null>;
  modelRef: MutableRefObject<editor.ITextModel | null>;
  graphContextRef: MutableRefObject<EditorGraphContext>;
  editorLayoutObserver: MutableRefObject<ResizeObserver | null>;
  editorLayoutSize: MutableRefObject<EditorLayoutDimension | null>;
  viewStateKey: string;
  mountEditorSession(editor: editor.IStandaloneCodeEditor): void;
  onEditorChange(text: string): void;
  disposeLsp(model: editor.ITextModel | null): void;
  releaseAnsiOutput(): void;
  releaseQuickDiff(): void;
}) {
  const modelChangeListener = useRef<IDisposable | null>(null);
  const onMonacoMount = (editor: editor.IStandaloneCodeEditor) => {
    modelChangeListener.current?.dispose();
    const model = editor.getModel();
    modelRef.current = model;
    modelChangeListener.current = model?.onDidChangeContent(() => onEditorChange(model.getValue())) ?? null;
    mountEditorSession(editor);
  };
  const releaseEditorSurface = (editor: editor.IStandaloneCodeEditor) => {
    const model = editor.getModel();
    const viewState = editor.saveViewState();
    if (viewState) writeEditorViewState(viewStateKey, viewState);
    graphContextsByEditor.delete(editor);
    if (focusedGraphEditor.current === editor) focusedGraphEditor.current = null;
    disposeLsp(model);
    releaseAnsiOutput();
    releaseQuickDiff();
    editorLayoutObserver.current?.disconnect();
    editorLayoutObserver.current = null;
    editorLayoutSize.current = null;
    cancelLayoutFrame(editor);
    if (editorRef.current === editor) editorRef.current = null;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: modelRef and graphContextRef are stable refs owned by the pane; the cleanup re-runs only when disposeLsp changes.
  useEffect(
    () => () => {
      modelChangeListener.current?.dispose();
      const model = modelRef.current;
      if (model && graphContextsByModel.get(model.uri.toString()) === graphContextRef) {
        graphContextsByModel.delete(model.uri.toString());
      }
      disposeLsp(model);
    },
    [disposeLsp]
  );
  return { onMonacoMount, releaseEditorSurface };
}
