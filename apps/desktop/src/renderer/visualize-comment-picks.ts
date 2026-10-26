// The page's answer to the Comment layer's own pick request: it opens a new
// comment, reopens the pin it names, or retargets the open draft.
import { type Dispatch, type RefObject, type SetStateAction, useEffect } from 'react';

import {
  rectFromFractions,
  rectOfBox,
  rectToFractions,
  visualizeFeedbackPageMessage,
} from '../shared/visualize-feedback';
import { type CommentDraft, fullNotice } from './visualize-comment-draft';
import { paneFrame } from './visualize-comment-pane';
import type { createVisualizePickGate } from './visualize-feedback-gate';
import {
  takeVisualizePinOpen,
  type VisualizeFeedback,
  type VisualizePin,
  visualizePinsFull,
} from './visualize-feedback-store';

/** Why the open pick request was made: a retarget keeps the draft's note,
 *  an open answers a pin card's request. */
export type VisualizePickReason = 'click' | 'retarget' | 'open';

/** Listens for the answer to this layer's pick request, and nothing else
 *  (a `ready` page is asked again for a pending pin card request). */
export function useVisualizePickAnswers({
  picks,
  pickGate,
  pickReason,
  sessionId,
  tabId,
  index,
  layer,
  live,
  keys,
  setDraft,
  setNote,
  setNotice,
}: {
  picks: boolean;
  pickGate: ReturnType<typeof createVisualizePickGate>;
  pickReason: RefObject<VisualizePickReason>;
  sessionId: string;
  tabId: string;
  index: number;
  layer: RefObject<HTMLDivElement | null>;
  live: RefObject<{ value: VisualizeFeedback; draft: CommentDraft | null; comment: boolean }>;
  keys: RefObject<{ describePinOpen(): void }>;
  setDraft: Dispatch<SetStateAction<CommentDraft | null>>;
  setNote(note: string): void;
  setNotice(notice: string): void;
}): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs and state setters passed in are stable; the keys are those the layer had
  useEffect(() => {
    if (!picks) return;
    const onMessage = (event: MessageEvent) => {
      const target = paneFrame(layer.current);
      if (!target?.contentWindow || event.source !== target.contentWindow) return;
      const message = visualizeFeedbackPageMessage(event.data);
      if (message?.type === 'ready') {
        if (live.current.comment) keys.current.describePinOpen();
        return;
      }
      if (message?.type !== 'picked' || !pickGate.accept(message.id, performance.now())) return;
      const box = layer.current?.getBoundingClientRect();
      if (!box?.width || !box.height) return;
      const origin = target.getBoundingClientRect();
      const { view } = message.pick;
      const shown = { ...view, x: origin.left + view.x, y: origin.top + view.y };
      const rect = rectToFractions(shown, rectOfBox(box));
      /** Where a pin is now: an anchored region inside its element's live box. */
      const pinRect = (pin: VisualizePin) =>
        pin.target.type === 'region' && pin.target.anchor
          ? rectToFractions(rectFromFractions(pin.target.anchor.rect, shown), rectOfBox(box))
          : rect;
      const { value: current, draft: open } = live.current;
      if (pickReason.current === 'open') {
        pickReason.current = 'click';
        const requested = takeVisualizePinOpen(sessionId, tabId, index);
        if (requested) {
          setDraft({ mode: 'edit', pinId: requested.id, rect: pinRect(requested) });
          setNote(requested.note);
        }
        return;
      }
      if (pickReason.current === 'retarget' && open?.mode === 'new') {
        setDraft({ mode: 'new', rect, pick: message.pick });
        return;
      }
      // An anchored region's number (the page draws it) reopens that pin.
      const region = message.pin
        ? current.pins.find(
            (pin) =>
              pin.id === message.pin &&
              pin.tabId === tabId &&
              pin.pane === index &&
              pin.target.type === 'region' &&
              pin.target.anchor?.selector === message.pick.selector
          )
        : undefined;
      if (region) {
        setDraft({ mode: 'edit', pinId: region.id, rect: pinRect(region) });
        setNote(region.note);
        return;
      }
      // A pinned element (or its number) reopens that pin.
      const pinned = current.pins.find(
        (pin) =>
          pin.tabId === tabId &&
          pin.pane === index &&
          pin.target.type === 'element' &&
          pin.target.selector === message.pick.selector
      );
      if (pinned) {
        setDraft({ mode: 'edit', pinId: pinned.id, rect });
        setNote(pinned.note);
        return;
      }
      if (visualizePinsFull(sessionId)) {
        setNotice(fullNotice());
        return;
      }
      setDraft({ mode: 'new', rect, pick: message.pick });
      setNote('');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [picks, pickGate, sessionId, tabId, index]);
}
