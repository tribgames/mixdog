/**
 * Pure URL admission rules: scheme, embedded credentials, agent-input secret
 * tokens (but in a link the runtime read in a mail for the session), cloud
 * metadata endpoints, private networks, and the optional domain
 * allowlist. url-admission wraps these with DNS resolution; navigation and
 * request filtering both call through here.
 */
import { isIP } from 'node:net';

import { getDomain } from 'tldts';

import { FLOW_TTL_MS } from './linked-sign-in';
import { browserUrlContainsSecret, redactBrowserText } from './redaction';

export interface BrowserUrlPolicy {
  allowPrivateNetwork?: boolean;
  allowedDomains?: string[];
}

/** Runtime-set on a navigate, never a tool argument (runtime
 *  browser-bridge/mail-links.mjs): `url` appeared in a mail from `from_domain`
 *  that the runtime read through its mailbox connector for this session at
 *  `read_at` (ms since the epoch). */
export interface BrowserMailLink {
  url: string;
  from_domain: string;
  read_at: number;
}

/** How long after the runtime read the mail its link may still be opened:
 *  the lifetime of a sign-in flow, a 2-step check included. */
export const MAIL_LINK_WINDOW_MS = FLOW_TTL_MS;

/** The registrable domain on the public suffix list, private suffixes
 *  included (`a.github.io` is not `b.github.io`); '' for an IP or a suffix. */
function registrableDomain(hostname: string): string {
  return getDomain(hostname, { allowPrivateDomains: true }) || '';
}

/** Whether agent URL `raw` is exactly the https link `link` names, read within
 *  the window, on the registrable domain of the mail's sender: the one agent
 *  URL that may carry a token. Where the page redirects afterwards is its own. */
export function mailLinkAdmits(raw: string, link: BrowserMailLink | undefined, now = Date.now()): boolean {
  if (!link || typeof link !== 'object' || !/^[\p{L}\p{N}.-]+$/u.test(String(link.from_domain))) return false;
  let parsed: URL;
  let sender: string;
  try {
    parsed = new URL(String(raw).trim());
    if (parsed.href !== new URL(String(link.url)).href) return false;
    sender = new URL(`https://${link.from_domain}/`).hostname;
  } catch {
    return false;
  }
  const age = now - Number(link.read_at);
  if (parsed.protocol !== 'https:' || !(age >= 0 && age <= MAIL_LINK_WINDOW_MS)) return false;
  const site = registrableDomain(parsed.hostname);
  return Boolean(site) && site === registrableDomain(sender);
}

function normalizedHostname(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){0,3}$/.test(host);
}

function parseIpv4(hostname: string): number[] | null {
  const parts = normalizedHostname(hostname).split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return numbers;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = parseIpv4(hostname);
  if (!parts) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function mappedIpv4(hostname: string): string | null {
  const host = normalizedHostname(hostname);
  if (isIP(host) !== 6) return null;
  // URL canonicalization expands dotted IPv4 tails into two hexadecimal words.
  const canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1);
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(canonical);
  if (!match) return null;
  const high = parseInt(match[1], 16);
  const low = parseInt(match[2], 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
}

function isPrivateNetworkAddress(address: string): boolean {
  const host = normalizedHostname(address);
  const mapped = mappedIpv4(host);
  if (mapped) return isPrivateIpv4(mapped);
  if (isIP(host) === 4) return isPrivateIpv4(host);
  if (isIP(host) !== 6) return false;
  return host === '::' || host === '::1' || /^(?:fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host);
}

function isCloudMetadataHost(hostname: string): boolean {
  const host = mappedIpv4(hostname) || normalizedHostname(hostname);
  return (
    host === '169.254.169.254' ||
    host === '169.254.170.2' ||
    host === '100.100.100.200' ||
    host === 'metadata.google.internal' ||
    host === 'metadata.goog' ||
    host === 'fd00:ec2::254'
  );
}

function allowedByDomainPolicy(hostname: string, allowedDomains: string[]): boolean {
  const host = normalizedHostname(hostname);
  return allowedDomains.some((raw) => {
    const domain = normalizedHostname(raw.replace(/^\*\./, ''));
    if (!domain) return false;
    return host === domain || (raw.trim().startsWith('*.') && host.endsWith(`.${domain}`));
  });
}

/** Browser navigation stays on the web. Cloud metadata endpoints are always
 * refused; private networks are refused unless the policy allows them (a local
 * session on the user's own PC). Loopback remains available for local web-app
 * development. */
function normalizeBrowserUrl(raw: string, policy: BrowserUrlPolicy, rejectSecrets: boolean): string {
  const text = String(raw || '').trim();
  if (!text) throw new Error('navigate requires url');
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`invalid url: ${redactBrowserText(text)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`only http(s) navigation is allowed (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs containing embedded credentials are not allowed');
  }
  const host = normalizedHostname(parsed.hostname);
  if (rejectSecrets && !isLoopbackHostname(host) && browserUrlContainsSecret(parsed.href)) {
    throw new Error('navigation URLs may not contain credential-like query values or secret tokens');
  }
  if (isCloudMetadataHost(host)) {
    throw new Error('navigation to cloud metadata endpoints is blocked');
  }
  if (!policy.allowPrivateNetwork && !isLoopbackHostname(host) && isPrivateNetworkAddress(host)) {
    throw new Error(`navigation to private or internal address ${host} is blocked`);
  }
  const allowedDomains = policy.allowedDomains?.map((domain) => domain.trim()).filter(Boolean) || [];
  if (allowedDomains.length && !allowedByDomainPolicy(host, allowedDomains)) {
    throw new Error(`navigation to ${host} is blocked by the Browser Use domain policy`);
  }
  return parsed.href;
}

/** `mailLink` lifts only the secret-token refusal, and only for the exact link
 *  it names (mailLinkAdmits); every other rule still applies. */
export function normalizeAgentUrl(raw: string, policy: BrowserUrlPolicy = {}, mailLink?: BrowserMailLink): string {
  return normalizeBrowserUrl(raw, policy, !mailLinkAdmits(raw, mailLink));
}

/** Page-generated requests may contain OAuth or tracking tokens that are
 * required for the site to work. They retain scheme, credential, domain,
 * metadata, and private-network checks; only agent-input secret rejection is
 * skipped. */
export function normalizePageUrl(raw: string, policy: BrowserUrlPolicy = {}): string {
  return normalizeBrowserUrl(raw, policy, false);
}

export function assertResolvedAddressAllowed(address: string, hostname: string, policy: BrowserUrlPolicy = {}): void {
  if (isCloudMetadataHost(address)) {
    throw new Error(`navigation to ${hostname} resolved to a blocked cloud metadata endpoint`);
  }
  if (policy.allowPrivateNetwork || isLoopbackHostname(hostname)) return;
  if (isPrivateNetworkAddress(address)) {
    throw new Error(`navigation to ${hostname} resolved to blocked private or internal address ${address}`);
  }
}
