import { useCallback, useRef, useState, type RefObject } from 'react';
import { selectionStatusLabel } from './use-editor-side-chrome';

type EditorInstance = import('monaco-editor').editor.IStandaloneCodeEditor;

/** What the editor reports about itself for the status footer: cursor,
 *  selection, problem counts and the model's indentation/EOL/language. */
export function useEditorPaneStatus(
  editorRef: RefObject<EditorInstance | null>,
  onShowProblems: (() => void) | undefined
) {
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [selectionStatus, setSelectionStatus] = useState({ selections: 1, characters: 0 });
  const [problemStatus, setProblemStatus] = useState({ errors: 0, warnings: 0 });
  const onShowProblemsRef = useRef(onShowProblems);
  onShowProblemsRef.current = onShowProblems;
  const showProblems = useCallback(() => {
    // Side dock: the host opens Problems in its own split under this editor
    // instead of toggling the main pane's bottom panel.
    if (onShowProblemsRef.current) onShowProblemsRef.current();
    else window.dispatchEvent(new CustomEvent('mixdog:show-problems'));
  }, []);
  const [editorFormat, setEditorFormat] = useState({
    tabSize: 4,
    insertSpaces: true,
    eol: 'LF',
    languageId: '',
  });
  const syncEditorFormat = useCallback(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    const options = model.getOptions();
    setEditorFormat({
      tabSize: options.tabSize,
      insertSpaces: options.insertSpaces,
      eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
      languageId: model.getLanguageId(),
    });
  }, [editorRef]);
  const selectionLabel = selectionStatusLabel(selectionStatus, cursorPosition);
  return {
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
  };
}
