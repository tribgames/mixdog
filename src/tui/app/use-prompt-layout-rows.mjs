// Prompt / text-entry layout rows: keeps the row count of the editable prompt
// (soft-wrapped at the content width) and of multiline core-memory text-entry
// panels in sync with the reserved layout height.
import { useCallback, useEffect } from 'react';
import stringWidth from 'string-width';
import { promptContentRows, textEntryReservedRows } from './text-layout.mjs';
import { CORE_MULTILINE_TEXT_ENTRY_KINDS } from './panel-signature.mjs';

export function usePromptLayoutRows({
  frameColumns,
  promptContentColumns,
  promptLayoutValueRef,
  setPromptLayoutRows,
  settingsPrompt,
  setTextEntryLayoutRows,
}) {
  const syncPromptLayoutRows = useCallback(
    (value) => {
      const text = String(value ?? '');
      promptLayoutValueRef.current = text;
      const nextRows = promptContentRows(text, promptContentColumns);
      setPromptLayoutRows((prev) => (prev === nextRows ? prev : nextRows));
    },
    [promptContentColumns, promptLayoutValueRef, setPromptLayoutRows]
  );
  useEffect(() => {
    syncPromptLayoutRows(promptLayoutValueRef.current);
  }, [syncPromptLayoutRows, promptLayoutValueRef]);
  useEffect(() => {
    const kind = String(settingsPrompt?.kind || '');
    if (!CORE_MULTILINE_TEXT_ENTRY_KINDS.has(kind)) {
      setTextEntryLayoutRows(1);
      return;
    }
    const cols = Math.max(1, frameColumns - 4 - stringWidth('Sentence > '));
    setTextEntryLayoutRows(textEntryReservedRows(settingsPrompt?.initialValue, cols, 8));
  }, [settingsPrompt?.kind, settingsPrompt?.initialValue, frameColumns, setTextEntryLayoutRows]);
  return syncPromptLayoutRows;
}
