function(wanted) {
  __MIXDOG_CUSTOM_CONTROL__
  const root = target.getRootNode();
  const lists = ownList ? [target] : [];
  for (const id of ids) {
    const list = root.getElementById?.(id);
    if (list && !lists.includes(list)) lists.push(list);
  }
  if (!lists.length) return { pending: true };
  const compact = value => String(value ?? '').slice(0, 2000).replace(/\s+/g, ' ').trim();
  const visible = element => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let current = element; current; current = current.parentElement || current.getRootNode()?.host) {
      const style = current.ownerDocument.defaultView.getComputedStyle(current);
      if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return false;
    }
    return true;
  };
  const candidates = new Set();
  const roots = [...lists];
  let scanned = 0;
  for (let index = 0; index < roots.length; index++) {
    const walker = el.ownerDocument.createTreeWalker(roots[index], 1);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++scanned > 5000) return { error: 'associated option list is too large; choose an explicit option ref' };
      if (node.shadowRoot) roots.push(node.shadowRoot);
      if (node.matches('[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="treeitem"],[data-value]') && visible(node)) {
        candidates.add(node);
        if (candidates.size > 500) return { error: 'associated option list has too many options; choose an explicit option ref' };
      }
    }
  }
  if (!candidates.size) return { pending: true };
  const label = node => compact(node.getAttribute('aria-label') || node.textContent);
  const matches = [...candidates].filter(node =>
    label(node) === wanted || compact(node.getAttribute('data-value')) === wanted);
  if (matches.length > 1) return { error: 'requested option is ambiguous in the associated list; choose an explicit option ref' };
  if (!matches.length) {
    return { error: 'no open option matched exactly; visible options include: '
      + [...candidates].slice(0, 8).map(node => label(node).slice(0, 40)).join(' | ') };
  }
  const hit = matches[0];
  const hitError = (__MIXDOG_EDITABILITY__)(hit);
  if (hitError) return { error: hitError };
  const value = label(hit) || compact(hit.getAttribute('data-value'));
  hit.scrollIntoView({ block: 'center', behavior: 'instant' });
  hit.click();
  return { values: [value.slice(0, 120)] };
}