import { useMemo } from 'react';
import type { TranscriptItem } from './desktop-types';

/** Esc-Esc message selector source: the most recent rewindable user prompts,
 *  oldest → newest (TUI parity, capped like the terminal picker). */
export function useComposerUserMessages(settledItems: readonly TranscriptItem[]) {
  return useMemo(() => {
    const rows: Array<{ id: string; text: string }> = [];
    for (let index = settledItems.length - 1; index >= 0 && rows.length < 20; index -= 1) {
      const item = settledItems[index];
      if (item?.kind !== 'user' || item.id == null) continue;
      const text = String(item.text || '').trim();
      if (!text) continue;
      rows.push({ id: String(item.id), text });
    }
    return rows.reverse();
  }, [settledItems]);
}
