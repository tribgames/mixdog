/** A person acted on a page from outside the pane's own display client (a
 *  paired client, or native input on a presented page): it is kept like any
 *  page they touched, and no longer a stand-in the host may tidy away. */
import type { WebContents } from 'electron';

export function createUserTakesPage(host: {
  sessionIdForGuest(guest: WebContents): string | undefined;
  claimPage(sessionId: string, guest: WebContents): void;
  retain(guest: WebContents): void;
}): (guest: WebContents) => void {
  return (guest) => {
    host.retain(guest);
    const sessionId = host.sessionIdForGuest(guest);
    if (sessionId) host.claimPage(sessionId, guest);
  };
}

/** The page a takeover hands to the user, fixed as the takeover starts: the
 *  tab its request names (list_tabs p1, v1 or a page name), else the page the
 *  agent last drove; the tab the panel happens to have selected only when
 *  there is neither. Later tab moves never retarget it, and once that page is
 *  gone there is no handed-over page (nothing stands in for it). */
export function createHandedOverPage(host: {
  /** The session's page `tab` names; may throw when none does. */
  resolveTab(sessionId: string, tab: string): WebContents | null;
  agentPage(sessionId: string): { guest: WebContents; turn: number } | null;
  liveGuest(sessionId: string): WebContents | null;
  /** Whether `guest` is still one of the session's pages. */
  owns(sessionId: string, guest: WebContents): boolean;
  selectGuest(sessionId: string, guest: WebContents): void;
  setAgentPage(sessionId: string, guest: WebContents, turn: number): void;
  resumeAgentFollow(sessionId: string): void;
}) {
  /** sessionId → its pending takeover and the page it handed over; kept only
   *  until the takeover ends, the page closes or the session is released. */
  const handed = new Map<string, { id: string; guest: WebContents | null; unwatch: () => void }>();
  /** Drops the session's entry (only takeover `id`'s, when given). */
  const forget = (sessionId: string, id?: string): void => {
    const entry = handed.get(sessionId);
    if (!entry || (id !== undefined && entry.id !== id)) return;
    entry.unwatch();
    handed.delete(sessionId);
  };
  const page = (sessionId: string, id: string): WebContents | null => {
    const entry = handed.get(sessionId);
    const guest = entry?.id === id ? entry.guest : null;
    return guest && !guest.isDestroyed() && host.owns(sessionId, guest) ? guest : null;
  };
  return {
    /** Records the page takeover `id` hands over, as it starts. */
    capture(sessionId: string, id: string, tab = ''): WebContents | null {
      forget(sessionId);
      let named: WebContents | null = null;
      try {
        named = tab ? host.resolveTab(sessionId, tab) : null;
      } catch {
        // A tab the request names but the session no longer has: the agent's page.
      }
      const guest = named ?? host.agentPage(sessionId)?.guest ?? host.liveGuest(sessionId);
      let unwatch = () => {};
      if (guest) {
        const closed = () => forget(sessionId, id);
        guest.once('destroyed', closed);
        unwatch = () => guest.removeListener('destroyed', closed);
      }
      handed.set(sessionId, { id, guest, unwatch });
      return guest;
    },
    /** The session's takeover is now `current` ('' for none): an entry for
     *  any other takeover (settled, expired, replaced) is dropped. */
    end(sessionId: string, current = ''): void {
      if (handed.get(sessionId)?.id !== current) forget(sessionId);
    },
    /** The session was released: its entry goes. */
    forget: (sessionId: string) => forget(sessionId),
    /** Sessions still holding a handed-over page. */
    tracked: (): number => handed.size,
    dispose(): void {
      for (const sessionId of [...handed.keys()]) forget(sessionId);
    },
    /** The page takeover `id` handed over while it still exists, else null. */
    page,
    /** Selects the handed-over page and makes it the page every pane that
     *  follows the session shows; returns it (null: none, or it is gone). */
    show(sessionId: string, id: string): WebContents | null {
      const guest = page(sessionId, id);
      if (!guest) return null;
      host.selectGuest(sessionId, guest);
      host.setAgentPage(sessionId, guest, host.agentPage(sessionId)?.turn ?? 0);
      host.resumeAgentFollow(sessionId);
      return guest;
    },
  };
}
