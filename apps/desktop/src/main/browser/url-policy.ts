/**
 * URL admission rules: scheme, embedded credentials, agent-input secret
 * tokens (but in a link the runtime read in a mail for the session), cloud
 * metadata endpoints, private networks, and the optional domain allowlist.
 * The rules are Rust (native/core/crates/mixdog-browser-policy), served
 * synchronously through mixdog_window.node (redaction.ts loads it); this file
 * holds the types and the exports, no rule. url-admission wraps these with
 * DNS resolution; navigation and request filtering both call through here.
 */
import { type BrowserMailLink, type BrowserUrlPolicy, browserPolicy } from './redaction';

export type { BrowserMailLink, BrowserUrlPolicy };

/** How long after the runtime read the mail its link may still be opened:
 *  the lifetime of a sign-in flow, a 2-step check included. */
export const MAIL_LINK_WINDOW_MS: number = browserPolicy.mailLinkWindowMs();

export function isLoopbackHostname(hostname: string): boolean {
  return browserPolicy.isLoopbackHostname(String(hostname));
}

/** `mailLink` lifts only the secret-token refusal, and only for the exact link
 *  it names; every other rule still applies. Throws the refusal's reason. */
export function normalizeAgentUrl(raw: string, policy: BrowserUrlPolicy = {}, mailLink?: BrowserMailLink): string {
  return browserPolicy.normalizeAgentUrl(String(raw || ''), policy, mailLink ?? undefined);
}

/** Page-generated requests may contain OAuth or tracking tokens that are
 * required for the site to work: only the agent-input secret rejection is
 * skipped. */
export function normalizePageUrl(raw: string, policy: BrowserUrlPolicy = {}): string {
  return browserPolicy.normalizePageUrl(String(raw || ''), policy);
}

export function assertResolvedAddressAllowed(address: string, hostname: string, policy: BrowserUrlPolicy = {}): void {
  browserPolicy.assertResolvedAddressAllowed(String(address), String(hostname), policy);
}
