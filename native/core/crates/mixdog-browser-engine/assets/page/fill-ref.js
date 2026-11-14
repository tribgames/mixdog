function(text) {
  const el = this;
  if (!el || !el.isConnected) return { error: 'stale' };
  const editError = (__MIXDOG_EDITABILITY__)(el);
  if (editError) return { error: editError };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : '';
    if (type === 'file') return { error: 'file inputs require upload' };
    const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) return { error: 'input value setter is unavailable' };
    setter.call(el, text);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: type === 'password' ? '' : el.value, sensitive: type === 'password' };
  }
  if (el.isContentEditable) {
    const doc = el.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(el);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { contentEditable: true };
  }
  return { error: 'element is not editable' };
}