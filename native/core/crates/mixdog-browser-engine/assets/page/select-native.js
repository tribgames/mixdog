function(values) {
  const el = this;
  const error = (__MIXDOG_EDITABILITY__)(el);
  if (error) return { error };
  if ((el.tagName || '').toLowerCase() !== 'select') return { custom: true };
  if (el.options.length > 5000) return { error: 'select has too many options; narrow the control before selecting' };
  const options = Array.from(el.options);
  const selected = new Set();
  for (const value of values) {
    const matches = options.filter(option =>
      String(option.value) === value || String(option.label || option.text) === value);
    if (!matches.length) {
      // A caller that cannot see the control needs its options in the error,
      // or the only recovery left is another snapshot of the same select.
      const listed = options.filter(option => !option.disabled)
        .slice(0, 8).map(option => String(option.label || option.text || option.value).slice(0, 40)).join(' | ');
      return { error: 'no option matched the requested value: ' + value
        + (listed ? '; options include: ' + listed : '') };
    }
    if (matches.length !== 1) return { error: 'requested option is ambiguous: ' + value };
    const option = matches[0];
    if (option.disabled || option.parentElement?.disabled) {
      return { error: 'requested option is disabled: ' + value };
    }
    selected.add(option);
  }
  if (!el.multiple && selected.size !== 1) {
    return { error: 'this select accepts exactly one option' };
  }
  if (el.multiple) {
    for (const option of options) option.selected = selected.has(option);
  } else {
    el.selectedIndex = options.indexOf([...selected][0]);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const actual = Array.from(el.selectedOptions);
  if (actual.length !== selected.size || actual.some(option => !selected.has(option))) {
    return { error: 'select input was dispatched once but the selection changed; observe before continuing' };
  }
  return { values: actual.map(option => String(option.value)) };
}