import { type BrowserMailLink, type BrowserUrlPolicy, browserPolicy } from './redaction';

export type { BrowserMailLink, BrowserUrlPolicy };

/** How long after the runtime read the mail its link may still be opened:
 *  the lifetime of a sign-in flow, a 2-step check included. */
export function mailLinkWindowMs(): number {
  return browserPolicy().mailLinkWindowMs();
}

export function isLoopbackHostname(hostname: string): boolean {
  return browserPolicy().isLoopbackHostname(String(hostname));
}

/** `mailLink` lifts only the secret-token refusal, and only for the exact link
 *  it names; every other rule still applies. Throws the refusal's reason. */
export function normalizeAgentUrl(raw: string, policy: BrowserUrlPolicy = {}, mailLink?: BrowserMailLink): string {
  // The link arrives from the runtime as JSON: a malformed one only fails to admit (as before), it does not fail the
  // Node-API argument conversion and so refuse every URL.
  const link =
    mailLink && typeof mailLink === 'object'
      ? { url: String(mailLink.url), from_domain: String(mailLink.from_domain), read_at: Number(mailLink.read_at) }
      : undefined;
  return browserPolicy().normalizeAgentUrl(String(raw || ''), policy, link);
}

/** Page-generated requests may contain OAuth or tracking tokens that are
 * required for the site to work: only the agent-input secret rejection is
 * skipped. */
export function normalizePageUrl(raw: string, policy: BrowserUrlPolicy = {}): string {
  return browserPolicy().normalizePageUrl(String(raw || ''), policy);
}

export function assertResolvedAddressAllowed(address: string, hostname: string, policy: BrowserUrlPolicy = {}): void {
  browserPolicy().assertResolvedAddressAllowed(String(address), String(hostname), policy);
}
