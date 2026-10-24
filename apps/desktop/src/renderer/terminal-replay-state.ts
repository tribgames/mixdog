/** Whether a terminal view's screen is complete: an attached PTY's scrollback
 *  replay is written into xterm asynchronously, and until that write settles
 *  the screen holds only part of it. */
export type ReplayTrackedView = {
  /** The attached PTY, set when the attach answers (before its replay is written). */
  id: string | null;
  /** The replay write still in flight (trackReplay). */
  replayPending: Promise<void> | null;
  writer: { writeReplay(replay: string): Promise<void> };
};

/** Writes a scrollback replay into the view, marking it incomplete
 *  (`replayPending`) until the write settles. */
export function trackReplay(view: ReplayTrackedView, replay: string): Promise<void> {
  const write = view.writer.writeReplay(replay).finally(() => {
    if (view.replayPending === write) view.replayPending = null;
  });
  view.replayPending = write;
  return write;
}

/** The view paints complete in its mount frame: it holds an attached PTY whose
 *  replay is fully written, or the tab never ran (`hasSavedView` false: no
 *  scrollback to replay). A replay still being written is never complete. */
export function viewPaintsAtOnce(view: ReplayTrackedView | undefined, hasSavedView: boolean): boolean {
  if (view?.replayPending) return false;
  return Boolean(view?.id) || !hasSavedView;
}
