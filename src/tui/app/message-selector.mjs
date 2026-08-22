/**
 * app/message-selector.mjs — jump back to a previous message
 * list, opened by a double Escape from an EMPTY prompt while idle.
 *
 * Selecting a row rewinds the conversation to just before that prompt and
 * drops its text back into the input box for editing: the transcript rows and
 * the model-side history after it are undone, so the resubmit continues from
 * exactly that point (engine side: store.rewindToItem).
 */
import { useCallback, useMemo } from 'react';

export const MAX_SELECTABLE_MESSAGES = 20;

/** Newest-last list of rewindable user prompts, capped for the picker. */
export function selectableUserItems(items, limit = MAX_SELECTABLE_MESSAGES) {
  const source = Array.isArray(items) ? items : [];
  const rows = [];
  for (let index = source.length - 1; index >= 0 && rows.length < limit; index -= 1) {
    const item = source[index];
    if (item?.kind !== 'user') continue;
    if (item?.id == null) continue;
    const text = String(item.text || '').trim();
    if (!text) continue;
    rows.push({ id: String(item.id), text });
  }
  return rows.reverse();
}

export function messageSelectorLabel(text, width = 56) {
  const firstLine = String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
  if (firstLine.length <= width) return firstLine;
  return `${firstLine.slice(0, Math.max(1, width - 1))}…`;
}

export function useMessageSelector({
  store,
  state,
  surface,
  setPromptDraftOverride,
  syncPromptLayoutRows,
  showPromptHint,
  clearPromptHint,
}) {
  // Cheap enough to recompute only when the transcript array identity changes;
  // the prompt asks for this on every Escape, never per keystroke.
  const hasUserMessages = useMemo(
    () => (Array.isArray(state.items) ? state.items : []).some(
      (item) => item?.kind === 'user' && String(item?.text || '').trim(),
    ),
    [state.items],
  );

  const applyRewind = useCallback((restored) => {
    const text = String(restored?.text || '');
    if (!text) {
      showPromptHint('Could not restore that message.', 'error');
      return false;
    }
    clearPromptHint();
    syncPromptLayoutRows(text);
    setPromptDraftOverride({ id: Date.now(), value: text });
    return true;
  }, [clearPromptHint, syncPromptLayoutRows, setPromptDraftOverride, showPromptHint]);

  const openMessageSelector = useCallback(() => {
    const items = store.getState?.().items ?? state.items;
    const rows = selectableUserItems(items);
    if (rows.length === 0) {
      showPromptHint('No message to jump back to.', 'info');
      return false;
    }
    const own = surface.claim();
    own.paint({
      _kind: 'message-selector',
      title: 'Jump back to a message',
      description: 'Rewind the conversation to a previous prompt and edit it.',
      initialIndex: rows.length - 1,
      items: rows.map((row) => ({ value: row.id, label: messageSelectorLabel(row.text) })),
      onSelect: (value) => {
        own.close();
        let restored;
        try {
          restored = store.rewindToItem?.(value);
        } catch (error) {
          showPromptHint(`rewind failed: ${error?.message || error}`, 'error');
          return;
        }
        // Daemon-backed stores answer asynchronously; a local store returns the
        // payload directly. Both land in the same apply path.
        if (restored && typeof restored.then === 'function') {
          void Promise.resolve(restored)
            .then(applyRewind)
            .catch((error) => showPromptHint(`rewind failed: ${error?.message || error}`, 'error'));
          return;
        }
        applyRewind(restored);
      },
      onCancel: () => own.close(),
    });
    return true;
  }, [store, state.items, surface, applyRewind, showPromptHint]);

  return { hasUserMessages, openMessageSelector };
}
