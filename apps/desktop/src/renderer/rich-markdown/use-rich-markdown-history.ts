import type { Editor } from '@tiptap/react';
import { type RefObject, useRef, useState } from 'react';

import type { RichMarkdownModelSync } from './rich-markdown-model-sync';

/** Undo, redo and discarding a held edit, all run on the model's history
 *  (shared with Source mode), plus the toolbar's can-undo/can-redo state. */
export function useRichMarkdownHistory(editor: Editor, syncRef: RefObject<RichMarkdownModelSync | null>) {
  /** Set while an undo or redo reloads the editor from the model. */
  const historyRef = useRef(false);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });

  const refreshHistory = () => {
    const sync = syncRef.current;
    const canUndo = Boolean(sync?.canUndo());
    const canRedo = Boolean(sync?.canRedo());
    setHistory((current) =>
      current.canUndo === canUndo && current.canRedo === canRedo ? current : { canUndo, canRedo }
    );
  };

  /** Undo and redo run on the model's history, shared with Source mode. */
  const runHistory = (direction: 'undo' | 'redo') => {
    const sync = syncRef.current;
    if (!sync || !editor.isEditable) return;
    historyRef.current = true;
    try {
      sync[direction]();
    } finally {
      historyRef.current = false;
    }
    refreshHistory();
  };

  /** Drops the held edit (the user's explicit choice) and shows the file. */
  const discardHeld = () => {
    historyRef.current = true;
    try {
      syncRef.current?.discard();
    } finally {
      historyRef.current = false;
    }
    refreshHistory();
    editor.commands.focus();
  };

  return { historyRef, history, refreshHistory, runHistory, discardHeld };
}
