(() => {
  const hosts = __MIXDOG_HOSTS__;
  const cardToken = /^cc-(number|exp|exp-month|exp-year|csc|name)$/;
  const cardName = /(cardnum|ccnum|cardexp|ccexp|cvc|cvv)/;
  const fields = [...document.querySelectorAll('input, select')].some((el) => {
    const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    if (tokens.some((token) => cardToken.test(token))) return true;
    return cardName.test(((el.name || '') + (el.id || '')).toLowerCase().replace(/[^a-z0-9]/g, ''));
  });
  if (fields) return true;
  return [...document.querySelectorAll('iframe[src]')].some((frame) => {
    try {
      return hosts.includes(new URL(frame.src, document.baseURI).hostname.toLowerCase());
    } catch {
      return false;
    }
  });
})()