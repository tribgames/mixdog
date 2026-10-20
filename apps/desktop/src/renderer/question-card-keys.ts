// The keyboard model the transcript's decision cards share (QuestionCard and
// ApprovalCard): one document-level capture keydown per card, scoped to the
// pane of the last pointer/focus interaction (several panes can each show
// their own pending card), never while typing, an IME commit, a held
// (repeating) key or a modifier chord. In one pane only the newest card owns
// the keys. A card takes focus only when nothing else holds it.

const cards = new Set<HTMLElement>();
let lastPane: Element | null = null;
const paneOf = (node: EventTarget | null): Element | null =>
  node instanceof Element ? node.closest('.pane-leaf') : null;
const rememberPane = (event: Event) => {
  lastPane = paneOf(event.target) ?? lastPane;
};
function ownsKeyboard(card: HTMLElement): boolean {
  // Focus in a dialog or anywhere outside the card's conversation (and outside
  // every pane) belongs to that surface. A single-pane layout has no pane
  // element, so the conversation is the scope there.
  const active = document.activeElement;
  const scope = card.closest('.conversation');
  if (active && active !== document.body && !paneOf(active) && !scope?.contains(active)) return false;
  if (document.querySelector('[aria-modal="true"], dialog[open]')) return false;
  const cardPane = paneOf(card);
  const peers = [...cards].filter((other) => paneOf(other) === cardPane);
  const pane = lastPane ?? paneOf(active);
  if (pane ? pane !== cardPane : peers.length !== cards.size) return false;
  return peers.at(-1) === card;
}

// An IME commit arrives as keyCode 229 even after isComposing has cleared.
export const isImeKey = (event: globalThis.KeyboardEvent): boolean => event.isComposing || event.keyCode === 229;

export const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLElement && target.isContentEditable);

/** Route the card's shortcuts to `onKeyDown` while it owns the keyboard;
 *  returns the cleanup. */
export function bindCardKeys(card: HTMLElement, onKeyDown: (event: globalThis.KeyboardEvent) => void): () => void {
  cards.add(card);
  if (!lastPane) lastPane = paneOf(document.activeElement);
  document.addEventListener('pointerdown', rememberPane, true);
  document.addEventListener('focusin', rememberPane, true);
  const listener = (event: globalThis.KeyboardEvent) => {
    if (isImeKey(event) || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!ownsKeyboard(card)) return;
    onKeyDown(event);
  };
  document.addEventListener('keydown', listener, true);
  return () => {
    cards.delete(card);
    document.removeEventListener('keydown', listener, true);
    if (cards.size === 0) {
      document.removeEventListener('pointerdown', rememberPane, true);
      document.removeEventListener('focusin', rememberPane, true);
      lastPane = null;
    }
  };
}

/** Focus a new card when nothing else holds focus, so its shortcuts work at
 *  once; a user typing in the composer keeps the caret. */
export function focusCardWhenIdle(card: HTMLElement): void {
  const active = document.activeElement;
  if (active && active !== document.body) return;
  card.focus({ preventScroll: true });
  // Long tool output above can leave the new card below the fold.
  card.scrollIntoView({ block: 'nearest' });
}
