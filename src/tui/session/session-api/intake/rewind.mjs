// Message selector ("jump back to a previous message"): rewind the
// conversation to just before a user prompt and hand its text back for
// editing. Idle-only — a live turn must be interrupted first.
import { restorableAttachmentsFromPrompt } from '../../../../runtime/attachments/prompt-restore.mjs';
import { promptHistoryWithout } from '../../prompt-history.mjs';
import { hydrateTolerantly } from './abort.mjs';

export function createRewindAction(bag) {
  const { runtime, getState, set, flushEmitImmediate, replaceItems, syncContextStats } = bag;

  return {
    // `restoreFiles: false` is a composer that cannot hold PDF/Office file
    // parts (the terminal one): a prompt carrying any is refused untouched.
    rewindToItem: async (itemId, { restoreFiles = true } = {}) => {
      const target = String(itemId ?? '').trim();
      if (!target) return null;
      if (getState().busy || getState().commandBusy) return null;
      const items = getState().items || [];
      const index = items.findIndex((item) => item?.kind === 'user' && String(item?.id) === target);
      // An archived prompt left the model context: there is nothing to rewind.
      if (index < 0 || items[index]?.archived === true) return null;
      const text = String(items[index]?.text || '').trim();
      if (!text) return null;
      set({ commandBusy: true });
      try {
        // Matched by the row's stable message id (the stored prompt is the
        // expanded text); rows without one fall back to the text.
        const messageId = String(items[index]?.messageId || '');
        const rewindOptions = { text, ...(messageId ? { messageId } : {}) };
        // Resolve the prompt and build the whole restore payload BEFORE any
        // history changes: a refusal or an attachment read error then leaves the
        // model history and the transcript both untouched.
        const preview = await runtime.rewindMessages?.({ ...rewindOptions, dryRun: true });
        if (!preview) return null;
        // The stored prompt's attachment references become the restore payload
        // the abort/queue restores use (pastedTexts / pastedImages / file parts).
        const content = preview.message?.content;
        if (!restoreFiles && Array.isArray(content) && content.some((part) => part?.type === 'file')) {
          throw new Error(
            'this message has PDF/Office attachments the terminal composer cannot restore; edit it in the desktop app'
          );
        }
        const refs = restorableAttachmentsFromPrompt(content, text);
        const attachments = hydrateTolerantly(refs.pastedImages, refs.pastedTexts, content);
        // Refused when the history changed since the preview.
        const rewound = await runtime.rewindMessages?.({
          ...rewindOptions,
          ...(preview.historyMarker ? { expectedHistoryMarker: preview.historyMarker } : {}),
        });
        if (!rewound) throw new Error('the conversation changed; select the message again');
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
        return {
          text,
          removed: items.length - index,
          messages: rewound.removed,
          ...(attachments.pastedImages ? { pastedImages: attachments.pastedImages } : {}),
          ...(attachments.pastedTexts ? { pastedTexts: attachments.pastedTexts } : {}),
          ...(attachments.content ? { content: attachments.content } : {}),
          ...(attachments.notice ? { notice: attachments.notice } : {}),
        };
      } finally {
        set({ commandBusy: false });
      }
    },
  };
}
