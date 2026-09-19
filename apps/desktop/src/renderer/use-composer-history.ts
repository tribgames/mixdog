// Prompt history for the composer: the persisted per-scope list merged with
// the engine-provided history, plus the Up/Down navigation cursor.
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_PERSISTED_PROMPT_HISTORY,
  readPromptHistory,
  writePromptHistory,
  type ComposerAttachment,
  type ComposerHistoryEntry,
} from './composer-support';
import { asRecord } from './text-format';

export function useComposerHistory({
  historyScope,
  promptHistoryList,
}: {
  historyScope: string;
  promptHistoryList?: unknown[];
}) {
  const [persistedHistory, setPersistedHistory] = useState(() => readPromptHistory(historyScope));
  const navigation = useRef({ index: -1, seed: '' });
  const seedAttachments = useRef<ComposerAttachment[]>([]);
  // Prompt history keys on historyScope, which can move WITHOUT the pane
  // identity changing (staging a project on the same draft turns
  // new-task:local into new-task:<path>) — refresh it independently.
  useLayoutEffect(() => {
    setPersistedHistory(readPromptHistory(historyScope));
    navigation.current = { index: -1, seed: '' };
  }, [historyScope]);
  const entries = useMemo<ComposerHistoryEntry[]>(() => {
    const engineHistory: ComposerHistoryEntry[] = (Array.isArray(promptHistoryList) ? promptHistoryList : [])
      .map((entry) =>
        typeof entry === 'string'
          ? { text: entry }
          : { text: String(asRecord(entry)?.text || asRecord(entry)?.displayText || '') }
      )
      .filter((entry) => entry.text.trim());
    const seen = new Set<string>();
    return [...persistedHistory, ...engineHistory]
      .filter((entry) => {
        const key = entry.text.trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_PERSISTED_PROMPT_HISTORY);
  }, [persistedHistory, promptHistoryList]);
  const rememberPrompt = useCallback(
    (value: string, submittedAttachments: ComposerAttachment[] = []) => {
      const prompt = value.trim();
      if (!prompt) return;
      const retained = submittedAttachments
        .filter((attachment) => attachment.kind === 'text' && attachment.token && prompt.includes(attachment.token))
        .map((attachment) => ({ ...attachment }));
      const entry: ComposerHistoryEntry = {
        text: prompt,
        ...(retained.length ? { attachments: retained } : {}),
      };
      setPersistedHistory((current) => {
        const next = [entry, ...current.filter((item) => item.text !== prompt)].slice(0, MAX_PERSISTED_PROMPT_HISTORY);
        try {
          writePromptHistory(historyScope, next);
        } catch {
          // The engine-provided history remains available when browser storage is unavailable.
        }
        return next;
      });
    },
    [historyScope]
  );
  return { entries, navigation, seedAttachments, rememberPrompt };
}
