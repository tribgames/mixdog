import { useCallback, type RefObject } from "react";
import type { editor } from "monaco-editor";
import { reportEditorLoadStage } from "./renderer-load-metrics";

type Editor = editor.IStandaloneCodeEditor;
type EditorModel = editor.ITextModel;

export function useEditorMountSession({
  editorRef,
  editorLayoutObserver,
  editorLayoutSize,
  scheduleEditorLayout,
  armFonts,
  bindModel,
  wireCommands,
  activeRef,
  focusedRef,
  savedText,
  projectPath,
  relPath,
  accessToken,
  viewStateKey,
  readViewState,
  markDirty,
  renderAnsiOutput,
  notifyReady,
}: {
  editorRef: RefObject<Editor | null>;
  editorLayoutObserver: RefObject<ResizeObserver | null>;
  editorLayoutSize: RefObject<{ width: number; height: number } | null>;
  scheduleEditorLayout(editor: Editor, host: HTMLElement): void;
  armFonts(): void;
  bindModel(editor: Editor, model: EditorModel): void;
  wireCommands(editor: Editor): void;
  activeRef: RefObject<boolean>;
  focusedRef: RefObject<boolean>;
  savedText: RefObject<string>;
  projectPath: string;
  relPath: string;
  accessToken?: string;
  viewStateKey: string;
  readViewState(key: string): editor.ICodeEditorViewState | null;
  markDirty(dirty: boolean): void;
  renderAnsiOutput(model: EditorModel | null): void;
  notifyReady(): void;
}) {
  return useCallback((editorInstance: Editor) => {
    editorRef.current = editorInstance;
    armFonts();
    const layoutHost = editorInstance.getDomNode()?.parentElement;
    if (layoutHost && typeof ResizeObserver !== "undefined") {
      editorLayoutObserver.current?.disconnect();
      editorLayoutObserver.current = new ResizeObserver(() => {
        scheduleEditorLayout(editorInstance, layoutHost);
      });
      editorLayoutObserver.current.observe(layoutHost);
      editorLayoutSize.current = null;
      scheduleEditorLayout(editorInstance, layoutHost);
    }
    wireCommands(editorInstance);
    const model = editorInstance.getModel();
    if (model) bindModel(editorInstance, model);
    const viewState = readViewState(viewStateKey);
    if (viewState) {
      try {
        editorInstance.restoreViewState(viewState);
      } catch {
        // Stale Monaco state starts at the top.
      }
    }
    if (activeRef.current && focusedRef.current) {
      requestAnimationFrame(() => editorInstance.focus());
    }
    if (model) markDirty(model.getValue() !== savedText.current);
    renderAnsiOutput(model);
    reportEditorLoadStage(projectPath, relPath, accessToken, "interactive", "", true);
    notifyReady();
  }, [
    accessToken,
    activeRef,
    armFonts,
    bindModel,
    editorLayoutObserver,
    editorLayoutSize,
    editorRef,
    focusedRef,
    markDirty,
    notifyReady,
    projectPath,
    readViewState,
    relPath,
    renderAnsiOutput,
    savedText,
    scheduleEditorLayout,
    viewStateKey,
    wireCommands,
  ]);
}
