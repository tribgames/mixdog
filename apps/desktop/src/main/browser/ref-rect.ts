/**
 * The box an observed element occupies, in top-document CSS pixels. A gesture
 * only needs the point it lands on; cropping a screenshot needs the whole
 * rectangle, expressed in the coordinates the captured image is scaled from.
 */
import { BROWSER_STABLE_RECT } from './stable-rect';

/** Runs in the element's own realm: same-process frame ancestors are folded
 *  in here, and a cross-process boundary is added by the caller. */
export const BROWSER_REF_RECT = `async function(target, frames = []) {
  if (!target?.isConnected) return { error: 'stale' };
  const view = target.ownerDocument?.defaultView;
  if (!view) return { error: 'stale' };
  const style = view.getComputedStyle(target);
  if (style.display === 'none' || style.visibility === 'hidden') return { error: 'not-visible' };
  const rect = await (${BROWSER_STABLE_RECT})(target, frames);
  if (!rect) return { error: 'moving' };
  if (rect.width < 1 || rect.height < 1) return { error: 'not-visible' };
  let x = rect.left;
  let y = rect.top;
  let frameView = view;
  for (;;) {
    let frame;
    try { frame = frameView?.frameElement; } catch { break; }
    if (!frame) break;
    const frameRect = frame.getBoundingClientRect();
    x += frameRect.left + frame.clientLeft;
    y += frameRect.top + frame.clientTop;
    frameView = frame.ownerDocument?.defaultView;
  }
  return { x, y, width: rect.width, height: rect.height };
}`;

/** Same measurement for a ref the page-side table still holds. */
export function browserRefRectExpression(ref: string): string {
  return `(async () => {
    const record = window.__mixdogAgentSnapshot?.refs?.get(${JSON.stringify(ref)});
    const element = record?.element || record;
    const frames = Array.isArray(record?.frames) ? record.frames : [];
    return (${BROWSER_REF_RECT})(element, frames);
  })()`;
}
