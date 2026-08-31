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
