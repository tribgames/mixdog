/** A PTY size claim made by the phone and followed by every other view. The
 *  host side lives in main/terminal-manager.ts; this is the renderer half. */

export interface TermSizeOwner {
  cols: number;
  rows: number;
  own: boolean;
}

/** The slice of a terminal view the follow logic touches. */
export interface SizeFollowingView {
  followSize: { cols: number; rows: number } | null;
  term: { resize(cols: number, rows: number): void };
  refit?: (() => void) | null;
}

/** A phone showing a PTY owns its size: every other view follows that grid
 *  instead of re-fitting its own pane (which resized the PTY back and forth
 *  with the phone). `own` is true on the owning client itself, and a zero
 *  grid means nobody owns the size any more. */
export function applySizeOwner(view: SizeFollowingView, owner: TermSizeOwner): void {
  if (owner.own || !(owner.cols > 0 && owner.rows > 0)) {
    if (!view.followSize) return;
    view.followSize = null;
    view.refit?.();
    return;
  }
  view.followSize = { cols: owner.cols, rows: owner.rows };
  try {
    view.term.resize(owner.cols, owner.rows);
  } catch {
    /* disposed mid-event */
  }
}

/** An attach/ensure answer states the PTY's ownership outright: a result
 *  without `sizeOwner` means nobody owns it, so a follower that missed the
 *  release event (a reconnect, a dropped push) stops following and refits. */
export function applyEnsuredSizeOwner(view: SizeFollowingView, sizeOwner: TermSizeOwner | undefined): void {
  applySizeOwner(view, sizeOwner ?? { cols: 0, rows: 0, own: false });
}

/** The size-owner protocol (release, heartbeat) exists only on hosts that
 *  advertise it; an older host would resize the PTY to the 0x0 release or to
 *  the phone's grid on every heartbeat. */
export interface SizeOwnerTransport {
  termResize?(id: string, cols: number, rows: number, phoneOwner?: boolean): void;
  readonly remoteTermSizeOwner?: boolean;
}

/** Renew this phone's claim with its own fitted grid. */
export function sendSizeOwnerHeartbeat(api: SizeOwnerTransport, id: string, cols: number, rows: number): void {
  if (api.remoteTermSizeOwner !== true) return;
  api.termResize?.(id, cols, rows, true);
}

/** Hand the size back to the other views. */
export function sendSizeOwnerRelease(api: SizeOwnerTransport, id: string): void {
  if (api.remoteTermSizeOwner !== true) return;
  api.termResize?.(id, 0, 0, true);
}
