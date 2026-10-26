import type { Editor } from '@tiptap/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { richMarkdownCodecFor } from './rich-markdown-codec';
import { replaceDocument } from './rich-markdown-document';
import { RichMarkdownModelSync } from './rich-markdown-model-sync';

/** The host callbacks the sync reports through, read at call time. */
interface RichMarkdownSyncReports {
  refreshHistory(): void;
  reportUnsupported(reason: string): void;
  reportHeld(isHeld: boolean, heldText?: () => string | null): void;
}

/**
 * Binds the editor to the Monaco model: loads it, follows its changes
 * (including undo and redo), reloads when the `text` prop says the model
 * changed, and ends the undo step on the way out. Owns what the model
 * reports back: the front matter, an unsupported document and a held edit.
 */
export function useRichMarkdownModelSync({
  editor,
  model,
  text,
  syncRef,
  historyRef,
  live,
}: {
  editor: Editor;
  model: MonacoEditor.ITextModel | null;
  text: string;
  syncRef: RefObject<RichMarkdownModelSync | null>;
  historyRef: RefObject<boolean>;
  live: RefObject<RichMarkdownSyncReports>;
}) {
  const loadedRef = useRef(false);
  const [held, setHeld] = useState<string | null>(null);
  const [frontMatter, setFrontMatter] = useState('');
  const [unsupported, setUnsupported] = useState(false);

  useLayoutEffect(() => {
    if (!model) return;
    const sync = new RichMarkdownModelSync(model, richMarkdownCodecFor(editor.schema, editor.markdown!), {
      onDocument(doc, nextFrontMatter) {
        replaceDocument(editor, doc, !loadedRef.current, historyRef.current);
        loadedRef.current = true;
        setFrontMatter(nextFrontMatter);
        setUnsupported(false);
      },
      onFrontMatter: setFrontMatter,
      onUnsupported(reason) {
        setUnsupported(true);
        live.current.reportUnsupported(reason);
      },
      onHeld(reason) {
        setHeld(reason);
        if (reason === null) live.current.reportHeld(false);
        else live.current.reportHeld(true, () => sync.heldMarkdown());
      },
    });
    syncRef.current = sync;
    sync.start();
    const changes = model.onDidChangeContent(() => live.current.refreshHistory());
    live.current.refreshHistory();
    return () => {
      changes.dispose();
      sync.flush();
      sync.dispose();
      if (syncRef.current === sync) syncRef.current = null;
      setHeld(null);
      // A held edit outlives the editor in the host's backup.
      if (sync.heldReason === null) live.current.reportHeld(false);
    };
    // The refs are stable: only the editor or the model re-binds.
  }, [editor, model, historyRef, live, syncRef]);

  // A changed text prop means the model changed; reload if it is not ours.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` is the trigger; the effect must re-run when it changes
  useEffect(() => {
    syncRef.current?.refresh();
  }, [text]);

  return { held, frontMatter, unsupported };
}
