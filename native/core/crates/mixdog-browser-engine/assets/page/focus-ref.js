function() {
  const el = this;
  if (!el || !el.isConnected) return { error: 'stale' };
  const editError = (__MIXDOG_EDITABILITY__)(el);
  if (editError) return { error: editError };
  if (!(el.matches?.('input, textarea') || el.isContentEditable)) return { error: 'element is not editable' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  return { sensitive: el.type === 'password' };
}