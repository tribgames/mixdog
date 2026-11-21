import { useEffect, useRef } from 'react';

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
