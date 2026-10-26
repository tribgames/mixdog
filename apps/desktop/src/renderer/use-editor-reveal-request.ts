import { type RefObject, useCallback, useEffect } from 'react';

import type { EditorOutlineItem } from './editor-language-store';

/** Jumps inside the open document: an incoming reveal request (go to a line
 *  once the file has loaded) and a breadcrumb symbol pick. */
export function useEditorRevealRequest({
  editorRef,
  reveal,
  load,
  relPath,
  autoFocusRef,
  onNavigationLocationRef,
}: {
  editorRef: RefObject<import('monaco-editor').editor.IStandaloneCodeEditor | null>;
  reveal: { line: number; column?: number; nonce: number } | null | undefined;
  load: unknown;
  relPath: string;
  autoFocusRef: RefObject<boolean>;
  onNavigationLocationRef: RefObject<((rel: string, line: number, column: number) => void) | undefined>;
}): (item: EditorOutlineItem) => void {
  // The reveal nonce is a wall-clock stamp, so two jumps raised in the same
  // millisecond carry the same one. The line this body reads therefore keys the
  // jump as well; the nonce still re-runs a repeat jump to the same line.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the jump is keyed on the requested line, column and nonce (pinned by editor-reveal-request.test.mjs) rather than the reveal object, and `load ? 1 : 0` re-runs it once when the file first loads without re-running on every content reload.
  useEffect(() => {
    if (!reveal || !load) return;
    const editor = editorRef.current;
    if (!editor) return;
    const column = reveal.column && reveal.column > 0 ? reveal.column : 1;
    editor.setPosition({ lineNumber: reveal.line, column });
    editor.revealPositionInCenter({ lineNumber: reveal.line, column });
    if (autoFocusRef.current) editor.focus();
    onNavigationLocationRef.current?.(relPath, reveal.line, column);
  }, [reveal?.line, reveal?.column, reveal?.nonce, load ? 1 : 0, relPath]);
  return useCallback(
    (item: EditorOutlineItem) => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.setPosition({ lineNumber: item.line, column: Math.max(1, item.column) });
      editor.revealLineInCenter(item.line);
      editor.focus();
    },
    [editorRef]
  );
}
