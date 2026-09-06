/** Shared preflight for AX and DOM-fallback form actions, run in the element's realm. */
export const BROWSER_EDITABILITY_CHECK = `function(el) {
  if (!el || !el.isConnected) return 'stale';
  if (el.matches?.(':disabled') || el.disabled
    || el.closest?.('[inert],[aria-disabled="true"]')) return 'element is disabled';
  if (el.readOnly || el.getAttribute?.('aria-readonly') === 'true') return 'element is readonly';
  const view = el.ownerDocument.defaultView;
  const style = view.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden'
    || style.visibility === 'collapse') return 'element is hidden';
  return '';
}`;
