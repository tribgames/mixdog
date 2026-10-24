// The keyboard model the transcript's decision cards share (QuestionCard and
// ApprovalCard): one document-level capture keydown per card, scoped to the
// pane of the last pointer/focus interaction (several panes can each show
// their own pending card), never while typing, an IME commit, a held
// (repeating) key or a modifier chord. In one pane only the newest card owns
// the keys. A card takes focus only when nothing else holds it.

import { modalDialogPresented } from './surface-input-focus';

const cards = new Set<HTMLElement>();
let lastPane: Element | null = null;
const paneOf = (node: EventTarget | null): Element | null =>
  node instanceof Element ? node.closest('.pane-leaf') : null;
// Cards showing their shortcut chips follow who owns the keyboard: they hear
// about every change of the owner (a card bound or gone, the pane last used).
const watchers = new Set<() => void>();
const ownerChanged = () => {
  for (const watcher of [...watchers]) watcher();
};
/** Tell the watching cards that something their keys depend on changed (a
 *  card was decided: the others settle again). */
export const cardKeysChanged = ownerChanged;

// A modal dialog opening or closing takes the keys away or gives them back
// without necessarily moving focus. Two observers (one target takes one set of
// options): mounts and unmounts anywhere under the body (a dialog can sit in a
// nested portal), and the attributes that make a mounted dialog modal or
// parked. Transcript streaming inserts many nodes, so the mount callback only
// does work for a record whose added/removed node is or contains a modal: the
// common record is one `nodeType` / `matches` test per node, and a subtree
// scan runs only for nodes that are not themselves a modal (the first hit ends
// the whole callback).
let modalWatch: MutationObserver[] | null = null;
const MODAL_ATTRIBUTES = ['aria-modal', 'aria-hidden', 'inert', 'open', 'data-surface-active'];
const MODAL_NODE = '[aria-modal], dialog';
const isModalNode = (node: Node): boolean =>
  node.nodeType === 1 &&
  ((node as Element).matches(MODAL_NODE) || (node as Element).querySelector(MODAL_NODE) !== null);
function modalNodesChanged(records: MutationRecord[]) {
  for (const record of records) {
    for (const list of [record.addedNodes, record.removedNodes]) {
      for (const node of list) {
        if (isModalNode(node)) return ownerChanged();
      }
    }
  }
}
const rememberPane = (event: Event) => {
  lastPane = paneOf(event.target) ?? lastPane;
  ownerChanged();
};

/** Call `listener` whenever which card owns the keyboard may have changed;
 *  returns the cleanup. */
export function watchCardKeyOwner(listener: () => void): () => void {
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
  };
}

/** Whether `card` is the one card that answers keys, with focus on `active`. */
export function ownsKeyboard(card: HTMLElement, active: Element | null = document.activeElement): boolean {
  // Focus in a dialog or anywhere outside the card's conversation (and outside
  // every pane) belongs to that surface. A single-pane layout has no pane
  // element, so the conversation is the scope there.
  const scope = card.closest('.conversation') ?? card;
  if (active && active !== document.body && !paneOf(active) && !scope?.contains(active)) return false;
  // A parked surface (settings, the command surface) keeps a static aria-modal
  // while closed; only a presented dialog owns the keyboard.
  if (modalDialogPresented() || document.querySelector('dialog[open]')) return false;
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
    // Shift+Enter / Shift+Esc are not Enter / Esc (a newline, a different chord).
    if (event.shiftKey && (event.key === 'Enter' || event.key === 'Escape')) return;
    if (!ownsKeyboard(card)) return;
    onKeyDown(event);
  };
  document.addEventListener('keydown', listener, true);
  if (!modalWatch) {
    const layers = new window.MutationObserver(modalNodesChanged);
    const attributes = new window.MutationObserver(ownerChanged);
    layers.observe(document.body, { childList: true, subtree: true });
    attributes.observe(document.body, { subtree: true, attributes: true, attributeFilter: MODAL_ATTRIBUTES });
    modalWatch = [layers, attributes];
  }
  ownerChanged();
  return () => {
    cards.delete(card);
    document.removeEventListener('keydown', listener, true);
    ownerChanged();
    if (cards.size === 0) {
      document.removeEventListener('pointerdown', rememberPane, true);
      document.removeEventListener('focusin', rememberPane, true);
      for (const watch of modalWatch ?? []) watch.disconnect();
      modalWatch = null;
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
