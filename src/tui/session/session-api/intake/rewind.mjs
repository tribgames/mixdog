// Message selector ("jump back to a previous message"): rewind the
// conversation to just before a user prompt and hand its text back for
// editing. Idle-only — a live turn must be interrupted first.
import { promptHistoryWithout } from '../../prompt-history.mjs';

export function createRewindAction(bag) {
  const { runtime, getState, set, flushEmitImmediate, replaceItems, syncContextStats } = bag;

  return {
    rewindToItem: async (itemId) => {
      const target = String(itemId ?? '').trim();
      if (!target) return null;
      if (getState().busy || getState().commandBusy) return null;
      const items = getState().items || [];
      const index = items.findIndex((item) => item?.kind === 'user' && String(item?.id) === target);
      if (index < 0) return null;
      const text = String(items[index]?.text || '').trim();
      if (!text) return null;
      set({ commandBusy: true });
      try {
        const rewound = await runtime.rewindMessages?.({ text });
        if (!rewound) return null;
        set({
          items: replaceItems(items.slice(0, index), {
            preserveSpill: true,
            preserveTranscriptView: true,
          }),
          spinner: null,
          thinking: null,
          lastTurn: null,
          // The prompt returns to the draft, so it must not ALSO sit in the
          // Up-arrow history — otherwise it shows up twice.
          promptHistoryList: promptHistoryWithout(getState().promptHistoryList, text),
        });
        syncContextStats({ allowEstimated: true });
        set({ stats: { ...getState().stats } });
        flushEmitImmediate?.();
        return { text, removed: items.length - index, messages: rewound.removed };
      } finally {
        set({ commandBusy: false });
      }
    },
  };
}
