// Experimental input only. An unavailable verified request preserves rp exactly.
// Ownership and pairing are established by the caller, never inferred here.
export function verifiedContextText({ request, prev, prevRequestVerified } = {}) {
  const current = String(request || '').slice(0, 1500);
  const reply = String(prev || '').slice(-1000);
  const prior = Array.from(String(prevRequestVerified || '')).slice(0, 300).join('');
  return `request: ${current}${prior ? `\nprevious request: ${prior}` : ''}\nprevious reply: ${reply}`;
}
