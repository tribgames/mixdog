/** Report only real foreground returns. visibilitychange also fires while the
 * page is being hidden, when repainting an Electron guest would be wasted. */
export function watchBrowserForegroundReturns(
  browserWindow: Window,
  browserDocument: Document,
  report: () => void,
): () => void {
  const reportVisibleReturn = () => {
    if (browserDocument.visibilityState === "hidden") return;
    report();
  };
  browserWindow.addEventListener("focus", reportVisibleReturn);
  browserWindow.addEventListener("pageshow", reportVisibleReturn);
  browserDocument.addEventListener("visibilitychange", reportVisibleReturn);
  return () => {
    browserWindow.removeEventListener("focus", reportVisibleReturn);
    browserWindow.removeEventListener("pageshow", reportVisibleReturn);
    browserDocument.removeEventListener("visibilitychange", reportVisibleReturn);
  };
}

/** Repaint after the dock has committed its final size. Electron webviews can
 * retain a blank native layer when invalidated in the same frame as a move
 * from the offscreen parking host; two frames cross the layout/compositor
 * boundary without reloading or replacing the guest. */
export function scheduleBrowserForegroundRepaint(
  browserWindow: Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame">,
  report: () => void,
): () => void {
  let layoutFrame = 0;
  let paintFrame = 0;
  layoutFrame = browserWindow.requestAnimationFrame(() => {
    layoutFrame = 0;
    paintFrame = browserWindow.requestAnimationFrame(() => {
      paintFrame = 0;
      report();
    });
  });
  return () => {
    if (layoutFrame) browserWindow.cancelAnimationFrame(layoutFrame);
    if (paintFrame) browserWindow.cancelAnimationFrame(paintFrame);
  };
}
