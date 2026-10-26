import { type RefObject, useCallback } from 'react';

import type { DesktopLspCapabilities } from '../shared/contract';
import { showDesktopToast } from './desktop-toasts';
import { documentFormatterAvailable, runFormatDocument } from './editor-format-document';
import { hasLspProviderFeature } from './editor-lsp-providers';
import { t } from './i18n';

/** The document commands the pane's chrome offers: Format Document (gated on
 *  a formatter claim for the language, toasting a no-op or a missing
 *  formatter) and Go to Line. */
export function useEditorDocumentCommands({
  editorRef,
  lspCapabilities,
  languageId,
}: {
  editorRef: RefObject<import('monaco-editor').editor.IStandaloneCodeEditor | null>;
  lspCapabilities: DesktopLspCapabilities | null;
  languageId: string;
}) {
  const formattingAvailable = documentFormatterAvailable(
    lspCapabilities,
    hasLspProviderFeature(languageId, 'formatting')
  );
  const formatDocument = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    void runFormatDocument(editor).then((outcome) => {
      if (outcome === 'unchanged')
        showDesktopToast(t('Document is already formatted.'), 'info', { scope: 'editor-format' });
      else if (outcome === 'unavailable') {
        showDesktopToast(t('No formatter is available for this file.'), 'warn', { scope: 'editor-format' });
      }
    });
  }, [editorRef]);
  const gotoLine = useCallback(() => {
    void editorRef.current?.getAction('editor.action.gotoLine')?.run();
  }, [editorRef]);
  return { formattingAvailable, formatDocument, gotoLine };
}
