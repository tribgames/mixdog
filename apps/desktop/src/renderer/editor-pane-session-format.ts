import type { RefObject } from 'react';
import { monaco } from './monaco-setup';

/** Format-on-save: runs the format action on the mounted editor, or, for a
 *  hidden tab, on a short-lived command surface over its model. */
export async function formatEditorDocumentForSave(
  editorRef: RefObject<import('monaco-editor').editor.IStandaloneCodeEditor | null>,
  modelRef: RefObject<import('monaco-editor').editor.ITextModel | null>
): Promise<void> {
  const mounted = editorRef.current;
  if (mounted) {
    await mounted.getAction('editor.action.formatDocument')?.run();
    return;
  }
  const model = modelRef.current;
  if (!model) return;
  // Saving a hidden tab can still request format-on-save. Its short-lived
  // command surface must not steal the pane's visible editor or its model.
  const temporary = monaco.editor.create(document.createElement('div'), { model });
  try {
    await temporary.getAction('editor.action.formatDocument')?.run();
  } finally {
    temporary.setModel(null);
    temporary.dispose();
  }
}
