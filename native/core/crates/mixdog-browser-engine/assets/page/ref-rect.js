//@@ BROWSER_REF_RECT
async function(target, frames = []) {
  if (!target?.isConnected) return { error: 'stale' };
  const view = target.ownerDocument?.defaultView;
  if (!view) return { error: 'stale' };
  // The same-origin frames the target sits in, outermost first, are brought into view too (a page-side record names them; a ref
  // of the accessibility tree does not, so the chain is read from the target itself).
  if (!frames.length) {
    for (let frameView = view; frameView;) {
      let frame;
      try { frame = frameView.frameElement; } catch { break; }
      if (!frame) break;
      frames.unshift(frame);
      frameView = frame.ownerDocument?.defaultView;
    }
  }
  const style = view.getComputedStyle(target);
  if (style.display === 'none' || style.visibility === 'hidden') return { error: 'not-visible' };
  const rect = await (__MIXDOG_STABLE_RECT__)(target, frames);
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
}
//@@ browserRefRectExpression
(async () => {
    const record = window.__mixdogAgentSnapshot?.refs?.get(__MIXDOG_REF__);
    const element = record?.element || record;
    const frames = Array.isArray(record?.frames) ? record.frames : [];
    return (__MIXDOG_REF_RECT__)(element, frames);
  })()
