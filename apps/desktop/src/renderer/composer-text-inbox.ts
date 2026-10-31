// Text another surface hands to "the composer" (Settings → compose). A window
// event heard by every mounted composer would reach retained sessions kept
// mounted off screen (two drafts), and a guard that skipped off-screen
// composers would drop it when the only conversation is parked behind a file
// tab (none). So the text waits here until exactly one composer takes it: the
// focused pane's shown composer (use-composer-external-draft). Sending also
// asks the pane workspace to bring that conversation to the front, so the user
// sees the text land.

let pending: string[] = [];
const takers = new Set<() => void>();
let presenter: (() => void) | null = null;

/** Hands `text` to the composer the user will see; it waits until one takes it. */
export function sendTextToComposer(text: string): void {
  if (!text) return;
  pending.push(text);
  // Bring the target conversation to the front first; a composer already
  // shown and focused takes the text right away, any other once it is shown.
  presenter?.();
  for (const take of [...takers]) take();
}

/** Every waiting text, removed: the first taker gets it, nobody else. */
export function takeComposerText(): string[] {
  const taken = pending;
  pending = [];
  return taken;
}

/** The eligible composer listens while it is eligible. Returns the cleanup. */
export function subscribeComposerText(take: () => void): () => void {
  takers.add(take);
  return () => {
    takers.delete(take);
  };
}

/** The pane workspace shows the conversation whose composer should take the
 *  text (one owner at a time). Returns the cleanup. */
export function registerComposerPresenter(present: () => void): () => void {
  presenter = present;
  return () => {
    if (presenter === present) presenter = null;
  };
}
