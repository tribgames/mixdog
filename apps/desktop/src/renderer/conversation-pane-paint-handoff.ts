import { useEffect, useRef } from 'react';

/** A first submit already replaced the blank watermark with its optimistic
 *  user row. Re-applying the watermark during draft -> session promotion
 *  flashes one full-pane frame; ordinary New task -> warm session navigation
 *  still uses the compositor handoff. */
export function useConversationPaintHandoff(draftMode: boolean, warmPaintHandoff: boolean) {
  const suppressDraftSubmitPaintHandoff = useRef(false);
  const visibleWarmPaintHandoff = warmPaintHandoff && !suppressDraftSubmitPaintHandoff.current;
  useEffect(() => {
    if (!draftMode && !warmPaintHandoff) {
      suppressDraftSubmitPaintHandoff.current = false;
    }
  }, [draftMode, warmPaintHandoff]);
  return { suppressDraftSubmitPaintHandoff, visibleWarmPaintHandoff };
}
