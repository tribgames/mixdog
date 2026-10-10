// Keeps the editor's layout and the language store in step with pane
// visibility: relayout and focus on activation, and publish (or clear) the
// active document while this pane is the focused one.
import { useEffect, useLayoutEffect, type MutableRefObject } from 'react';
import type { editor } from 'monaco-editor';
import type { EditorLayoutDimension } from './editor-layout';
import { clearActiveEditorDocument, setActiveEditorDocument, setActiveEditorPosition } from './editor-language-store';

export function useEditorActiveDocument({
  editorRef,
  editorLayoutSize,
  layoutEditorToHost,
  onNavigationLocationRef,
  active,
  focused,
  revealed,
  loaded,
  viewMode,
  modelUri,
  projectPath,
  relPath,
  updateOutline,
}: {
  editorRef: MutableRefObject<editor.IStandaloneCodeEditor | null>;
  editorLayoutSize: MutableRefObject<EditorLayoutDimension | null>;
  layoutEditorToHost(editor: editor.IStandaloneCodeEditor, layoutHost: HTMLElement): void;
  onNavigationLocationRef: MutableRefObject<((rel: string, line: number, column: number) => void) | undefined>;
  active: boolean;
  focused: boolean;
  revealed: boolean;
  loaded: unknown;
  viewMode: string;
  modelUri: string | null;
  projectPath: string;
  relPath: string;
  updateOutline(): Promise<void>;
}) {
  // Hidden→visible tab switches leave Monaco with a stale layout: the first
  // scrollbar press then only re-measures instead of grabbing the slider.
  // A focused file surface also takes the keyboard explicitly after mount or
  // pane activation, so the first pointer click can immediately type.
  // biome-ignore lint/correctness/useExhaustiveDependencies: editorRef and editorLayoutSize are stable refs owned by the pane; only the listed values re-run the relayout.
  useLayoutEffect(() => {
    if (!active || !loaded) return;
    const editor = editorRef.current;
    const layoutHost = editor?.getDomNode()?.parentElement;
    if (editor && layoutHost) {
      editorLayoutSize.current = null;
      layoutEditorToHost(editor, layoutHost);
    }
    if (focused && revealed && viewMode === 'source') editor?.focus();
  }, [active, focused, layoutEditorToHost, loaded, revealed, viewMode]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: editorRef and onNavigationLocationRef are stable refs owned by the pane; only the listed values re-run the publish.
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
}
