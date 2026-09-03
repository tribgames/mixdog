/**
 * Pure URL admission rules: scheme, embedded credentials, agent-input secret
 * tokens, cloud metadata endpoints, private networks, and the optional domain
 * allowlist. url-admission wraps these with DNS resolution; navigation and
 * request filtering both call through here.
 */
import { isIP } from 'node:net';

import { browserUrlContainsSecret, redactBrowserText } from './redaction';

export interface BrowserUrlPolicy {
  allowPrivateNetwork?: boolean;
  allowedDomains?: string[];
}

function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isLoopbackHostname(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === '::1'
    || /^127(?:\.\d{1,3}){0,3}$/.test(host);
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
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function mappedIpv4(hostname: string): string | null {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(normalizedHostname(hostname));
  return match?.[1] || null;
}

export function isPrivateNetworkAddress(address: string): boolean {
  const host = normalizedHostname(address);
  const mapped = mappedIpv4(host);
  if (mapped) return isPrivateIpv4(mapped);
  if (isIP(host) === 4) return isPrivateIpv4(host);
  if (isIP(host) !== 6) return false;
  return host === '::'
    || host === '::1'
    || /^(?:fc|fd)[0-9a-f]{2}:/i.test(host)
    || /^fe[89ab][0-9a-f]:/i.test(host);
}

function isCloudMetadataHost(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  return host === '169.254.169.254'
    || host === '169.254.170.2'
    || host === '100.100.100.200'
    || host === 'metadata.google.internal'
    || host === 'metadata.goog'
    || host === 'fd00:ec2::254';
}

function allowedByDomainPolicy(hostname: string, allowedDomains: string[]): boolean {
  const host = normalizedHostname(hostname);
  return allowedDomains.some((raw) => {
    const domain = normalizedHostname(raw.replace(/^\*\./, ''));
    if (!domain) return false;
    return host === domain || (raw.trim().startsWith('*.') && host.endsWith(`.${domain}`));
  });
}

/** Browser navigation stays on the web and cannot silently cross into a
 * private network. Loopback remains available for local web-app development. */
function normalizeBrowserUrl(
  raw: string,
  policy: BrowserUrlPolicy,
  rejectSecrets: boolean,
): string {
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
  if (!policy.allowPrivateNetwork
    && !isLoopbackHostname(host)
    && isPrivateNetworkAddress(host)) {
    throw new Error(`navigation to private or internal address ${host} is blocked`);
  }
  const allowedDomains = policy.allowedDomains?.map((domain) => domain.trim()).filter(Boolean) || [];
  if (allowedDomains.length && !allowedByDomainPolicy(host, allowedDomains)) {
    throw new Error(`navigation to ${host} is blocked by the Browser Use domain policy`);
  }
  return parsed.href;
}

export function normalizeAgentUrl(raw: string, policy: BrowserUrlPolicy = {}): string {
  return normalizeBrowserUrl(raw, policy, true);
}

/** Page-generated requests may contain OAuth or tracking tokens that are
 * required for the site to work. They retain scheme, credential, domain,
 * metadata, and private-network checks; only agent-input secret rejection is
 * skipped. */
export function normalizePageUrl(raw: string, policy: BrowserUrlPolicy = {}): string {
  return normalizeBrowserUrl(raw, policy, false);
}

export function assertResolvedAddressAllowed(
  address: string,
  hostname: string,
  policy: BrowserUrlPolicy = {},
): void {
  if (policy.allowPrivateNetwork || isLoopbackHostname(hostname)) return;
  if (isCloudMetadataHost(address) || isPrivateNetworkAddress(address)) {
    throw new Error(`navigation to ${hostname} resolved to blocked private or internal address ${address}`);
  }
}
