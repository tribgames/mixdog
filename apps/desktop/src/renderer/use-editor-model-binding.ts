import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import * as monaco from "monaco-editor";
import type { DesktopLspServerState } from "../shared/contract";
import { explicitEditorLanguageIdForPath } from "../shared/editor-languages";
import {
  getEditorLanguageSnapshot,
  ensureEditorLanguageStore,
  setActiveEditorPosition,
  setNativeEditorProblems,
  subscribeEditorLanguageStore,
} from "./editor-language-store";
import {
  ensureGraphProviders,
  graphContextsByEditor,
  graphContextsByModel,
  type EditorGraphContextRef,
} from "./editor-monaco-providers";
import { isAnsiOutputPath, visibleEditorAnsiText } from "./editor-ansi";

type Editor = monaco.editor.IStandaloneCodeEditor;
type EditorModel = monaco.editor.ITextModel;
type Disposable = { dispose(): void };

export function useEditorModelBinding({
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
}: {
  projectPath: string;
  relPath: string;
  graphContextRef: EditorGraphContextRef;
  languageDisposables: RefObject<Disposable[]>;
  lspMarkerSignature: RefObject<string>;
  lspChangeTimer: RefObject<number | null>;
  outlineTimer: RefObject<number | null>;
  activeRef: RefObject<boolean>;
  focusedRef: RefObject<boolean>;
  onNavigationLocationRef: RefObject<
    ((rel: string, line: number, column: number) => void) | undefined
  >;
  setModelUri(uri: string): void;
  acceptLspState(state: DesktopLspServerState, languageId: string): void;
  scheduleAnsiOutput(model: EditorModel | null): void;
  syncLsp(kind?: "change" | "save"): Promise<boolean>;
  updateOutline(): Promise<void>;
  setCursorPosition: Dispatch<SetStateAction<{ line: number; column: number }>>;
  setSelectionStatus: Dispatch<SetStateAction<{ selections: number; characters: number }>>;
  setProblemStatus: Dispatch<SetStateAction<{ errors: number; warnings: number }>>;
  setEditorFormat: Dispatch<SetStateAction<{
    tabSize: number;
    insertSpaces: boolean;
    eol: string;
    languageId: string;
  }>>;
  syncEditorFormat(): void;
}) {
  return useCallback((editor: Editor, model: EditorModel) => {
    const expectedLanguageId = explicitEditorLanguageIdForPath(relPath);
    if (expectedLanguageId && model.getLanguageId() !== expectedLanguageId) {
      monaco.editor.setModelLanguage(model, expectedLanguageId);
    }
    ensureEditorLanguageStore();
    setModelUri(model.uri.toString());
    graphContextsByModel.set(model.uri.toString(), graphContextRef);
    graphContextsByEditor.set(editor, graphContextRef);
    ensureGraphProviders(model.getLanguageId());
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
      setActiveEditorPosition(
        model.uri.toString(),
        event.position.lineNumber,
        event.position.column,
      );
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
  }, [
    acceptLspState,
    activeRef,
    focusedRef,
    graphContextRef,
    languageDisposables,
    lspChangeTimer,
    lspMarkerSignature,
    onNavigationLocationRef,
    outlineTimer,
    projectPath,
    relPath,
    scheduleAnsiOutput,
    setCursorPosition,
    setEditorFormat,
    setModelUri,
    setProblemStatus,
    setSelectionStatus,
    syncEditorFormat,
    syncLsp,
    updateOutline,
  ]);
}
