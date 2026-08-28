export const PURCHASE_PERMIT_MS = 30000;

export function isFinalPurchaseTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const label = String(target.label || '').replace(/\s+/g, ' ').trim().slice(0, 500).toLowerCase();
  if (/(add\s+to\s+(cart|bag)|장바구니|카트에\s*담|proceed\s+to\s+checkout|review\s+order|checkout\s*$)/i.test(label)) {
    return false;
  }
  const finalLabel = /(?:place|submit|confirm|complete)\s+(?:your\s+)?(?:order|purchase)|(?:pay|buy|purchase)\s+now|confirm\s+and\s+pay|order\s+with\s+obligation\s+to\s+pay|주문(?:을)?\s*(?:확정|완료|하기)|결제(?:를)?\s*(?:확정|완료|하기)|구매(?:를)?\s*(?:확정|완료|하기)|注文を確定|購入する|支払う|确认订单|提交订单|立即支付|立即购买/i.test(label);
  const paymentBrand = /^(?:apple\s*pay|google\s*pay|shop\s*pay|paypal)$/i.test(label);
  const actionable = /^(?:button|input|a)$/i.test(String(target.tag || ''))
    || String(target.role || '').toLowerCase() === 'button'
    || String(target.type || '').toLowerCase() === 'submit';
  return actionable && (finalLabel || paymentBrand);
}

export function createPurchasePermit(permit, now = Date.now()) {
  const kind = permit.kind === 'pointer' ? 'pointer' : 'keyboard';
  return {
    kind,
    x: Number(permit.x),
    y: Number(permit.y),
    expiresAt: now + PURCHASE_PERMIT_MS,
  };
}

export function consumePurchasePermit(store, tabId, kind, params, now = Date.now()) {
  const permit = store.get(tabId);
  store.delete(tabId);
  if (!permit || permit.expiresAt < now || permit.kind !== kind) return false;
  if (kind === 'pointer') {
    return Math.abs(permit.x - Number(params.x)) <= 3
      && Math.abs(permit.y - Number(params.y)) <= 3;
  }
  return true;
}
