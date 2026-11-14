function() {
  const el = this;
  if (!el || !el.isConnected) return { error: 'stale' };
  if ((el.tagName || '').toLowerCase() !== 'select') return { custom: true };
  const options = Array.from(
    { length: Math.min(el.options.length, 200) },
    (_, index) => el.options[index],
  )
    .map((option) => {
      const label = String(option.label || option.text || option.value || '').trim().slice(0, 200);
      if (!label) return '';
      const group = option.parentElement;
      const disabled = option.disabled || Boolean(group && group.tagName === 'OPTGROUP' && group.disabled);
      const marks = [option.selected && 'selected', disabled && 'disabled'].filter(Boolean);
      return marks.length ? label + ' [' + marks.join(', ') + ']' : label;
    })
    .filter(Boolean);
  return { options, total: el.options.length > 200 ? el.options.length : undefined };
}