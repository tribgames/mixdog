/** A person's request to leave a page — close its tab, navigate it, or click
 *  or press a key on it so the page leaves by itself (a link, a form submit)
 *  — that the page vetoed with a leave confirmation (beforeunload). Electron
 *  settles that veto synchronously, so the page stays and the person is asked
 *  instead; choosing to leave repeats the request once with the page's veto
 *  skipped. Agent requests are never recorded: an agent does not discard what
 *  a person left unsaved. */
import type { WebContents } from 'electron';

/** Starts the leave; false — now, or once the returned promise settles, or
 *  when it rejects — when nothing was started (no history left, the page
 *  already gone, input its guard refused). */
type LeaveRun = () => boolean | Promise<boolean>;

/** Undo `entry` in `entries` once `started` reports that nothing started,
 *  unless a newer entry has replaced it by then. */
function unlessStarted<T extends object>(
  entries: WeakMap<WebContents, T>,
  guest: WebContents,
  entry: T,
  started: boolean | Promise<boolean>
): void {
  const undo = () => {
    if (entries.get(guest) === entry) entries.delete(guest);
  };
  if (started instanceof Promise) {
    void started.then((ok) => {
      if (!ok) undo();
    }, undo);
  } else if (!started) undo();
}

/** What a veto answers is decided by events, never by elapsed time. A
 *  person's request stands until a veto claims it, a navigation starts, the
 *  person's next request or an agent's command replaces it, or the page goes
 *  away (the maps hold pages weakly). The card stands until it is answered,
 *  a person's next veto replaces it, or the document is left. */
export function createBrowserLeaveConfirmation() {
  /** The repeat of the person's latest request a veto would answer. */
  const requested = new WeakMap<WebContents, { repeat: LeaveRun }>();
  /** Leaving was chosen: the next veto is that repeat's own, and is skipped. */
  const approved = new WeakMap<WebContents, object>();
  const pending = new WeakMap<WebContents, { id: string; leave: LeaveRun }>();
  let serial = 0;
  return {
    /** Run a person's request that may leave the page's document. Leaving
     *  past the page's veto runs `repeat`: the request again, unless only
     *  part of it was run now (a click's release completes its press). A
     *  card already showing stays: it changes only with a veto or an answer. */
    request(guest: WebContents, run: LeaveRun, repeat: LeaveRun = run): void {
      // The new request replaces an earlier one and its unused approval.
      approved.delete(guest);
      const entry = { repeat };
      requested.set(guest, entry);
      unlessStarted(requested, guest, entry, run());
    },
    /** An agent command now acts on the page: a veto from here on answers
     *  the agent's action, so no person's earlier request may claim it. */
    agentActs(guest: WebContents): void {
      requested.delete(guest);
      approved.delete(guest);
    },
    /** The page's beforeunload asked to stay (Electron's will-prevent-unload). */
    vetoed(guest: WebContents, skipVeto: () => void): void {
      if (approved.delete(guest)) {
        skipVeto();
        return;
      }
      const attempt = requested.get(guest);
      requested.delete(guest);
      if (attempt) pending.set(guest, { id: `leave_${++serial}`, leave: attempt.repeat });
    },
    /** A main-frame navigation started: no veto will answer what was asked
     *  or approved before it. Leaving the document also ends the card; a
     *  same-document move keeps it. */
    settled(guest: WebContents, sameDocument: boolean): void {
      requested.delete(guest);
      approved.delete(guest);
      if (!sameDocument) pending.delete(guest);
    },
    /** The confirmation the person is asked, if any. */
    pending(guest: WebContents): string | null {
      return pending.get(guest)?.id ?? null;
    },
    /** Leave (repeat the request past the veto) or stay; false when the
     *  confirmation asked about is no longer the one waiting. */
    answer(guest: WebContents, id: string, leave: boolean): boolean {
      const waiting = pending.get(guest);
      if (!waiting || waiting.id !== id) return false;
      pending.delete(guest);
      if (leave) {
        // The approval covers only this repeat: the page vetoes it again
        // (consuming the approval), it navigates (settled), it started
        // nothing or failed and the approval goes with it, or a newer
        // request or an agent's command replaces it.
        const approval = {};
        approved.set(guest, approval);
        unlessStarted(approved, guest, approval, waiting.leave());
      }
      return true;
    },
  };
}

export type BrowserLeaveConfirmation = ReturnType<typeof createBrowserLeaveConfirmation>;

/** Close a page as a person closing its tab does: its beforeunload runs first
 *  whichever window presents it, and that window follows the page once it
 *  closes. False when the page is already gone. */
export function closePage(guest: WebContents): boolean {
  if (guest.isDestroyed()) return false;
  guest.close({ waitForBeforeUnload: true });
  return true;
}
