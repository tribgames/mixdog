// A browser takeover waiting on the user, per page-owning session. The card
// registers while it is pending; the phone's streamed page asks it on a tap
// whether to raise the soft keyboard (the frame is a picture, so the page's
// focused field cannot ask for the keyboard itself).

/** Each hold is its own token: the same approval can be mounted twice (the
 *  conversation and a handoff copy), and one unmounting must not end the other. */
const holds = new Map<string, Set<{ tab: string }>>();

/** Marks a takeover of `sessionId` pending, on page `tab` (`''`: the handoff
 *  named no page); the returned function ends only this hold. */
export function holdBrowserTakeover(sessionId: string, tab: string): () => void {
  const hold = { tab };
  let set = holds.get(sessionId);
  if (!set) {
    set = new Set();
    holds.set(sessionId, set);
  }
  set.add(hold);
  return () => {
    const current = holds.get(sessionId);
    if (!current?.delete(hold)) return;
    if (!current.size) holds.delete(sessionId);
  };
}

/** Whether a takeover waits on the page a frame shows (`documentId` is
 *  `<tab>:<n>`). A hold naming a tab covers only that tab; one naming none
 *  covers the session's page as streamed, whichever tab that is. */
export function browserTakeoverCovers(sessionId: string, documentId: string): boolean {
  const tab = documentId.split(':')[0];
  for (const hold of holds.get(sessionId) ?? []) if (!hold.tab || hold.tab === tab) return true;
  return false;
}
