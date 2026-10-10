import { useCallback, useRef, type RefObject } from 'react';
import { scheduleLayoutFrame } from './interaction-frame-scheduler';
import { nextEditorLayoutDimension, type EditorLayoutDimension } from './editor-layout';

type EditorInstance = import('monaco-editor').editor.IStandaloneCodeEditor;

/** The last applied layout size, the resize observer slot and the frame-
 *  scheduled layout of the mounted editor into its host element. */
export function useEditorPaneLayout(editorRef: RefObject<EditorInstance | null>) {
  const editorLayoutSize = useRef<EditorLayoutDimension | null>(null);
  const editorLayoutObserver = useRef<ResizeObserver | null>(null);
  const layoutEditorToHost = useCallback(
    (editor: EditorInstance, layoutHost: HTMLElement) => {
      if (editorRef.current !== editor) return;
      const dimension = nextEditorLayoutDimension(editorLayoutSize.current, layoutHost);
      if (!dimension) return;
      editorLayoutSize.current = dimension;
      editor.layout(dimension);
    },
    [editorRef]
  );
  const scheduleEditorLayout = useCallback(
    (editor: EditorInstance, layoutHost: HTMLElement) => {
      scheduleLayoutFrame(editor, () => layoutEditorToHost(editor, layoutHost));
    },
    [layoutEditorToHost]
  );
  return { editorLayoutSize, editorLayoutObserver, layoutEditorToHost, scheduleEditorLayout };
}
