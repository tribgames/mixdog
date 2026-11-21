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
