function() {
  const el = this;
  if (!el || !el.isConnected) return { error: 'stale' };
  const tag = (el.tagName || '').toLowerCase();
  const type = String(el.type || '').toLowerCase();
  if (tag !== 'input' || !['checkbox', 'radio'].includes(type)) {
    return { error: 'element is not a checkbox or radio button' };
  }
  return { checked: Boolean(el.checked), radio: type === 'radio' };
}