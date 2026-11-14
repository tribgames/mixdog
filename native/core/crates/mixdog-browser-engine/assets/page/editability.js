function(el) {
  if (!el || !el.isConnected) return 'stale';
  if (el.matches?.(':disabled') || el.disabled
    || el.closest?.('[inert],[aria-disabled="true"]')) return 'element is disabled';
  if (el.readOnly || el.getAttribute?.('aria-readonly') === 'true') return 'element is readonly';
  const view = el.ownerDocument.defaultView;
  const style = view.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden'
    || style.visibility === 'collapse') return 'element is hidden';
  // display is not inherited: a text input still reports inline-block when
  // an ancestor (including a shadow host) removes it from layout.
  for (let parent = el.parentElement || el.getRootNode?.().host; parent;
    parent = parent.parentElement || parent.getRootNode?.().host) {
    if (view.getComputedStyle(parent).display === 'none') return 'element is hidden';
  }
  return '';
}