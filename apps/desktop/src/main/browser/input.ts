/**
 * The input driver a page is driven through: keyboard, mouse, drag and touch
 * gestures over one CDP send port, each timed as an input operation.
 */
import { type BrowserDragInterceptionDeps, createBrowserDragInterception, createDragInput } from './input-drag';
import { createKeyboardInput } from './input-keyboard';
import { createMouseInput } from './input-mouse';
import type { SendBrowserInput } from './input-primitives';
import { createTouchInput } from './input-touch';
import { timedBrowserOperation } from './timing';

export type { BrowserDragData, BrowserDragInterception } from './input-drag';
export { assertBrowserKeyDoesNotAccessClipboard } from './input-keyboard';
export {
  type BrowserInputOutcome,
  type BrowserKeyModifier,
  type BrowserMouseButton,
  browserImagePointToCss,
  normalizeModifierMask,
  normalizeMouseButton,
} from './input-primitives';

export function createBrowserInputDriver(
  send: SendBrowserInput,
  options: { allowClipboard?: boolean; drags?: BrowserDragInterceptionDeps } = {}
) {
  const keyboard = createKeyboardInput(send, options);
  const mouse = createMouseInput(send);
  const drag = createDragInput(send, {
    drags: options.drags ? createBrowserDragInterception(options.drags) : undefined,
  });
  const touch = createTouchInput(send);
  return {
    pressKey: timedBrowserOperation('input', keyboard.pressKey),
    typeText: timedBrowserOperation('input', keyboard.typeText),
    dropFilesAt: timedBrowserOperation('input', drag.dropFilesAt),
    clickAt: timedBrowserOperation('input', mouse.clickAt),
    hoverAt: timedBrowserOperation('input', mouse.hoverAt),
    dragAt: timedBrowserOperation('input', drag.dragAt),
    tapAt: timedBrowserOperation('input', touch.tapAt),
    swipeAt: timedBrowserOperation('input', touch.swipeAt),
    scrollAt: timedBrowserOperation('input', mouse.scrollAt),
  };
}
