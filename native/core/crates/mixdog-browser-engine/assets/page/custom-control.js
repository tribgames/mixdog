
  const el = this;
  const error = (__MIXDOG_EDITABILITY__)(el);
  if (error) return { error };
  const target = el.closest('[role="combobox"],[role="listbox"],[role="menu"],[aria-haspopup]') || el;
  const ids = [...new Set(
    [target.getAttribute('aria-controls'), target.getAttribute('aria-owns')]
      .filter(Boolean).join(' ').split(/\s+/).filter(Boolean)
  )];
  const ownList = target.matches('[role="listbox"],[role="menu"],[role="tree"]');
  if (!ids.length && !ownList) {
    return { error: 'control has no associated option list; open it and choose an explicit option ref from a fresh snapshot' };
  }
