/** Deterministic payment evidence of the page a submit or post step acts on.
 *  A step on such a page is a payment: it asks once, every time, and no session
 *  or saved allow, nor "Allow all actions", covers it. Only page structure
 *  counts — never a button's label — and only the top document is read:
 *    - an input or select whose `autocomplete` token is a payment-card one
 *      (cc-number, cc-exp, cc-exp-month, cc-exp-year, cc-csc, cc-name), or whose
 *      name/id plainly denotes a card number, expiry or CVC/CVV;
 *    - an embedded frame hosted by a payment processor: Stripe, Braintree,
 *      Adyen or PayPal hosted fields (the list below, kept small on purpose).
 *  Deleting something permanently is not detected here (the Browser Use
 *  guidance covers it); the page is not read when it cannot be evaluated, and
 *  that counts as evidence (fail closed). */
export const PAYMENT_PROCESSOR_FRAME_HOSTS = [
  'js.stripe.com',
  'checkout.stripe.com',
  'js.braintreegateway.com',
  'assets.braintreegateway.com',
  'checkoutshopper-live.adyen.com',
  'checkoutshopper-test.adyen.com',
  'www.paypal.com',
  'www.sandbox.paypal.com',
] as const;

export const PAYMENT_EVIDENCE_EXPRESSION = `(() => {
  const hosts = ${JSON.stringify(PAYMENT_PROCESSOR_FRAME_HOSTS)};
  const cardToken = /^cc-(number|exp|exp-month|exp-year|csc|name)$/;
  const cardName = /(cardnum|ccnum|cardexp|ccexp|cvc|cvv)/;
  const fields = [...document.querySelectorAll('input, select')].some((el) => {
    const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/);
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
})()`;

/** Whether the guest page shows payment evidence; an unreadable page does. */
export async function pageHasPaymentEvidence(evaluate: (expression: string) => Promise<unknown>): Promise<boolean> {
  try {
    return (await evaluate(PAYMENT_EVIDENCE_EXPRESSION)) !== false;
  } catch {
    return true;
  }
}
