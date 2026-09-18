/**
 * The domain allowlist filters what the network stack carries, and a peer
 * connection does not go through it: STUN, TURN and the DNS they trigger leave
 * the machine without ever becoming a request the policy can see. When an
 * operator restricts the domains a page may reach, that hole is the difference
 * between a policy and a suggestion, so peer connections are refused in the
 * page itself.
 *
 * Limits worth stating plainly: this replaces page-visible constructors, so it
 * is containment for ordinary page code, not a network boundary. A page that
 * can run `evaluate`-level script in a fresh realm could recover an original
 * constructor. Pair it with host or network egress controls when the boundary
 * has to hold below the browser.
 */
export const BROWSER_WEBRTC_BLOCK_SCRIPT = `(() => {
  if (window.__mixdogWebRtcBlocked) return;
  window.__mixdogWebRtcBlocked = true;
  const refuse = function RTCPeerConnection() {
    throw new Error('WebRTC is blocked by the Browser Use domain policy.');
  };
  refuse.prototype = {};
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
    try {
      Object.defineProperty(window, name, { configurable: true, writable: true, value: refuse });
    } catch {}
  }
})()`;

/** Page guards that depend on policy rather than on the page. An unrestricted
 *  browser keeps every capability a site would normally have. */
export function browserPageGuardScripts(policy: { allowedDomains?: string[] }): string[] {
  return policy.allowedDomains?.length ? [BROWSER_WEBRTC_BLOCK_SCRIPT] : [];
}
