/**
 * The feedback half of the desktop host: the Comment-pin / `data-choice` page
 * script, the real-gesture tokens behind picks, and pin crops of the window.
 */
import type { BrowserWindow } from 'electron';

import { type VisualizeFeedbackRect, visualizeFeedbackScript } from '../../shared/visualize-feedback';
import { createVisualizeGestureTokens, type VisualizeGestureTarget } from './gestures';
import { capturedPng, captureWindowRect, paneFrames } from './host-frames';
import { createGestureWatcher } from './host-gesture-watch';
import type { VisualizeService } from './service';

export function createFeedbackHost(
  service: Pick<VisualizeService, 'snapshot' | 'tabView'>,
  window: { live(): BrowserWindow | null; require(): BrowserWindow }
) {
  let cropping = false;
  const gestures = createVisualizeGestureTokens();
  const watchGestures = createGestureWatcher(gestures, {
    window: window.live,
    snapshot: () => service.snapshot(),
  });
  return {
    /** Runs the feedback page script (Comment pins, `data-choice` picks) in
     *  the tab's HTML panes: the panel's own frames only, not frames nested
     *  inside a page. Idempotent per page load. */
    async attachFeedback(sessionId: string, tabId: string): Promise<void> {
      const live = window.live();
      const tab = service.tabView(sessionId, tabId);
      if (!live || !tab) return;
      watchGestures(live);
      const script = visualizeFeedbackScript();
      await Promise.all(
        paneFrames(live, tab).map(({ frame }) =>
          // A page that is navigating away cannot take the script: nothing to attach.
          frame.executeJavaScript(script).catch(() => false)
        )
      );
    },
    /** Spend one real gesture made in this pane on a `data-choice` pick;
     *  false when the user made none there in the last second. */
    consumeChoiceGesture(target: VisualizeGestureTarget): Promise<boolean> {
      return gestures.consume(target);
    },
    /** Base64 PNG of an area of the main window given in CSS px (a pin's
     *  crop); the renderer paints secret fields over it. */
    async captureRect(rect: VisualizeFeedbackRect): Promise<string> {
      // One crop at a time, whatever the renderer asks.
      if (cropping) throw new Error('a visualize crop is already being captured');
      const target = window.require();
      cropping = true;
      try {
        return capturedPng(await captureWindowRect(target, rect)).toString('base64');
      } finally {
        cropping = false;
      }
    },
  };
}
