// Agent `visualize` tabs: the panel state, tab commands, pane text, panel
// size and the feedback, capture and gesture hand-offs.
import { DESKTOP_IPC } from '../shared/contract';
import type { IpcHandle } from './ipc';
import {
  requiredVisualizeCaptureRect,
  requiredVisualizeGestureTarget,
  requiredVisualizePanelSize,
  requiredVisualizeTabCommand,
} from './ipc-validation';
import type { DesktopVisualize } from './visualize/host';
import type { VisualizeService } from './visualize/service';

export type VisualizeIpcHost = Pick<VisualizeService, 'snapshot' | 'command' | 'paneText' | 'setPanelSize'> &
  Partial<Pick<VisualizeService, 'hydrateShown'>> &
  Partial<Pick<DesktopVisualize, 'attachFeedback' | 'captureRect' | 'consumeChoiceGesture'>>;

export function registerVisualizeIpc({ handle, visualize }: { handle: IpcHandle; visualize?: VisualizeIpcHost }): void {
  handle(DESKTOP_IPC.visualizeState, async () => {
    if (!visualize) return [];
    await visualize.hydrateShown?.();
    return visualize.snapshot();
  });
  handle(DESKTOP_IPC.visualizeCommand, async (_event, command) =>
    visualize?.command(requiredVisualizeTabCommand(command))
  );
  handle(DESKTOP_IPC.visualizePaneText, async (_event, sessionId, tabId, index) => {
    if (!visualize) throw new Error('Visualize is unavailable.');
    const target = requiredVisualizeGestureTarget({ sessionId, tabId, pane: index });
    return visualize.paneText(target.sessionId, target.tabId, target.pane);
  });
  handle(DESKTOP_IPC.visualizePanelSize, (_event, size) => {
    visualize?.setPanelSize(requiredVisualizePanelSize(size));
  });
  handle(DESKTOP_IPC.visualizeFeedbackAttach, async (_event, sessionId, tabId) => {
    const target = requiredVisualizeTabCommand({ sessionId, tabId, action: 'activate' });
    await visualize?.attachFeedback?.(target.sessionId, target.tabId);
  });
  handle(DESKTOP_IPC.visualizeCaptureRect, async (_event, rect) => {
    if (!visualize?.captureRect) throw new Error('Visualize capture is unavailable.');
    return visualize.captureRect(requiredVisualizeCaptureRect(rect));
  });
  handle(
    DESKTOP_IPC.visualizeConsumeGesture,
    async (_event, target) => (await visualize?.consumeChoiceGesture?.(requiredVisualizeGestureTarget(target))) === true
  );
}
