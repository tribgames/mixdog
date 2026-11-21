import { useSyncExternalStore } from 'react';
// Modal-dialog plumbing shared by the settings dialog and the onboarding wizard.

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** True while a portaled combobox menu inside `dialog` is open and owns Escape. */
export function portaledMenuOpen(dialog: HTMLElement | null): boolean {
  return Array.from(
    dialog?.querySelectorAll<HTMLElement>('[role="combobox"][aria-expanded="true"][aria-controls]') || []
  ).some((trigger) => {
    const menu = document.getElementById(trigger.getAttribute('aria-controls') || '');
    return menu?.matches('.mx-menu[role="listbox"]');
  });
}

// Markers on body-level nodes: `data-modal-above` (the toast region, the guided tour pointing into a dialog) is never
// made inert; `data-modal-background` (update or connection banner, pairing request) added while a modal is open is
// covered by every open modal and unlocked only when all are closed.
const BACKGROUND_MARK = '[data-modal-background]';
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

/** True while any modal is open. */
export function hasOpenModal(): boolean {
  return openModals.length > 0;
}

/** Calls `listener` whenever a modal opens or closes; returns the unsubscribe. */
export function subscribeModals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React view of hasOpenModal. */
export function useAnyModalOpen(): boolean {
  return useSyncExternalStore(subscribeModals, hasOpenModal, () => false);
}

function coverBackground(node: Node): void {
  if (!(node as Element).matches?.(BACKGROUND_MARK)) return;
  for (const modal of openModals) {
    if (!modal.covered.includes(node as HTMLElement)) modal.covered.push(node as HTMLElement);
  }
  applyModality();
}

function watchBackground(): void {
  if (openModals.length && !observer && typeof window.MutationObserver !== 'undefined') {
    observer = new window.MutationObserver((records) => {
      for (const record of records) for (const node of Array.from(record.addedNodes)) coverBackground(node);
    });
    observer.observe(document.body, { childList: true });
  } else if (!openModals.length && observer) {
    observer.disconnect();
    observer = null;
  }
  for (const listener of listeners) listener();
}

interface OpenModal {
  host: HTMLElement;
  covered: HTMLElement[];
}
const openModals: OpenModal[] = [];
// Only what this owner made inert: an element already inert belongs to someone
// else (a closed surface) and is never written, so nothing stale is restored.
const captured = new Map<HTMLElement, string | null>();

function coveredBy(host: HTMLElement): HTMLElement[] {
  const covered: HTMLElement[] = [];
  for (let node: HTMLElement | null = host; node && node !== document.body; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement?.children ?? [])) {
      if (sibling !== node && !sibling.matches('.mx-toast-region, [data-modal-above]')) {
        covered.push(sibling as HTMLElement);
      }
    }
  }
  return covered;
}

function applyModality(): void {
  const wanted = new Set(openModals[openModals.length - 1]?.covered ?? []);
  for (const [element, ariaHidden] of captured) {
    if (wanted.has(element)) continue;
    element.inert = false;
    if (ariaHidden === null) element.removeAttribute('aria-hidden');
    else element.setAttribute('aria-hidden', ariaHidden);
    captured.delete(element);
  }
  for (const element of wanted) {
    if (!captured.has(element) && !element.inert && element.isConnected) {
      captured.set(element, element.getAttribute('aria-hidden'));
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
  }
}

/** Registers an open modal whose DOM is `host`; returns its (idempotent)
 *  release. */
export function openModal(host: HTMLElement): () => void {
  const modal = { host, covered: coveredBy(host) };
  openModals.push(modal);
  applyModality();
  watchBackground();
  return () => {
    const index = openModals.indexOf(modal);
    if (index < 0) return;
    openModals.splice(index, 1);
    applyModality();
    watchBackground();
  };
}

/** Wraps Tab / Shift+Tab inside `root`; `controls` is its tab order. */
export function trapTab(event: KeyboardEvent, root: HTMLElement, controls: HTMLElement[]): void {
  if (!controls.length) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}
