// Phone drawer tap feedback. The drawer's open/closed look is driven by React
// state, but a tap commits that state in a transition so the shell's heavy
// render never gates the tap's first frame. The tap therefore stamps its
// intent on <html> first; desktop/07-mobile-chrome.css turns the stamp into
// the sheet's visual state at once, and the shell clears it when the
// committed state has caught up with the latest intent.
const DRAWER_INTENT_ATTRIBUTE = 'data-drawer-intent';

export function paintDrawerIntent(open: boolean): void {
  document.documentElement.setAttribute(DRAWER_INTENT_ATTRIBUTE, open ? 'open' : 'closed');
}

/** The drawer's state as the latest tap left it: the stamp while a commit is
 *  pending, else the committed `openNow`. A rapid second tap toggles from this. */
export function drawerIntentOpen(openNow: boolean): boolean {
  const stamp = document.documentElement.getAttribute(DRAWER_INTENT_ATTRIBUTE);
  return stamp === null ? openNow : stamp === 'open';
}

/** Drops the stamp once `committedOpen` is what the latest tap asked for. A
 *  commit that still shows an older state leaves it in place. */
export function settleDrawerIntent(committedOpen: boolean, intendedOpen: boolean): void {
  if (committedOpen !== intendedOpen) return;
  const root = document.documentElement;
  if (root.hasAttribute(DRAWER_INTENT_ATTRIBUTE)) root.removeAttribute(DRAWER_INTENT_ATTRIBUTE);
}
