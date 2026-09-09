/** Shared by AX and DOM targeting. Instant scrolling plus a layout read
 * replaces pre-measurement paint waits; two samples still fence movement. */
export const BROWSER_STABLE_RECT = `async function(target, frames = []) {
  const view = target.ownerDocument.defaultView;
  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  for (const frame of frames) {
    frame.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }
  const first = target.getBoundingClientRect();
  await new Promise((resolve) => {
    let frame;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      view.clearTimeout(timer);
      view.cancelAnimationFrame(frame);
      resolve();
    };
    const timer = view.setTimeout(finish, 100);
    frame = view.requestAnimationFrame(finish);
  });
  const rect = target.getBoundingClientRect();
  if (Math.abs(first.left - rect.left) > 2 || Math.abs(first.top - rect.top) > 2
    || Math.abs(first.width - rect.width) > 2 || Math.abs(first.height - rect.height) > 2) return null;
  return rect;
}`;
