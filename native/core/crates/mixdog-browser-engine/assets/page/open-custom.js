function() {
  __MIXDOG_CUSTOM_CONTROL__
  if (!ownList && target.getAttribute('aria-expanded') !== 'true') {
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    target.click();
  }
  return {};
}