/**
 * Whether a URL may be opened at all. A name that passes the policy is
 * resolved and checked again against the address it actually points at, so a
 * host that answers with a private address cannot slip through the name
 * check. Concurrent resolutions are coalesced, but completed answers are never
 * cached: a later request must detect DNS rebinding to a private address.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import {
  assertResolvedAddressAllowed,
  normalizeAgentUrl,
  normalizePageUrl,
  type BrowserUrlPolicy,
} from './host-policy';

export interface BrowserUrlAdmissionHost {
  /** The allow-list and private-network stance this host runs under. */
  policy: BrowserUrlPolicy;
  lookupAddresses?: (hostname: string) => Promise<Array<{ address: string }>>;
  maxPendingResolutions?: number;
}

export function createBrowserUrlAdmission(host: BrowserUrlAdmissionHost) {
  const { policy: browserUrlPolicy } = host;
  const maxPendingResolutions = Math.max(1, host.maxPendingResolutions || 256);
  const lookupAddresses = host.lookupAddresses
    || ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  const pendingResolutions = new Map<string, Promise<void>>();
  async function assertResolvedUrlAllowed(url: string, pageGenerated = false): Promise<void> {
    const parsed = new URL(pageGenerated
      ? normalizePageUrl(url, browserUrlPolicy)
      : normalizeAgentUrl(url, browserUrlPolicy));
    if (!parsed.hostname || parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost')) return;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname)) {
      assertResolvedAddressAllowed(hostname, hostname, browserUrlPolicy);
      return;
    }
    const pending = pendingResolutions.get(hostname);
    if (pending) return pending;
    if (pendingResolutions.size >= maxPendingResolutions) {
      throw new Error('too many concurrent browser DNS validations');
    }
    const promise = (async () => {
      let addresses: Array<{ address: string }>;
      try {
        addresses = await lookupAddresses(hostname);
      } catch {
        throw new Error(
          `navigation to ${hostname} could not be resolved for private-network validation`,
        );
      }
      if (!addresses.length) {
        throw new Error(
          `navigation to ${hostname} returned no addresses for private-network validation`,
        );
      }
      if (addresses.length > 64) {
        throw new Error(`navigation to ${hostname} returned too many resolved addresses`);
      }
      for (const { address } of addresses) {
        assertResolvedAddressAllowed(address, hostname, browserUrlPolicy);
      }
    })();
    pendingResolutions.set(hostname, promise);
    try {
      await promise;
    } finally {
      if (pendingResolutions.get(hostname) === promise) {
        pendingResolutions.delete(hostname);
      }
    }
  }

  async function validatedAgentUrl(raw: string): Promise<string> {
    const normalized = normalizeAgentUrl(raw, browserUrlPolicy);
    await assertResolvedUrlAllowed(normalized, true);
    return normalized;
  }

  async function assertResolvedResourceUrlAllowed(raw: string): Promise<void> {
    const parsed = new URL(raw);
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`unsupported browser network protocol ${parsed.protocol}`);
    }
    await assertResolvedUrlAllowed(parsed.href, true);
  }

  return {
    assertResolvedUrlAllowed,
    assertResolvedResourceUrlAllowed,
    validatedAgentUrl,
  };
}
