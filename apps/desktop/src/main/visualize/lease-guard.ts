import type { VisualizePaneView, VisualizeProblem } from '../../shared/visualize';
import { blockedNetworkMessage, isOutsideNetworkUrl } from '../../shared/visualize-network-policy';
import { leasePrefixOf } from './page-problems';

/** A frame that made a request or navigation: its URL and, when known, its
 *  stable id (`frameTreeNodeId`). A bare string is a URL with no frame. */
export type RequesterFrame = string | { url: string; id?: number };

/** What a lease's network policy reads of the tab that owns it. */
interface LeaseOwner {
  id: string;
  allowNetwork?: boolean;
}

/** Minimal policy state retained per stable (sessionId, tabId) so parked tabs can be garbage-collected. */
interface LeasePolicy {
  key: string;
  allowNetwork: boolean;
  refCount: number;
}

const MAX_TRACKED_LEASES = 4096;
const MAX_TRACKED_FRAMES = 4096;

const frameEntry = (entry: RequesterFrame): { url: string; id?: number } =>
  typeof entry === 'string' ? { url: entry } : entry;

const policyKeyOf = (sessionId: string, tabId: string): string => `${sessionId}\0${tabId}`;

/** `onBlocked` hears every refused navigation or request, with the owned lease
 *  of the page that made it. */
export function createLeaseGuard(
  onBlocked: (lease: string, kind: Extract<VisualizeProblem['kind'], `blocked-${string}`>, message: string) => void
) {
  /** Every page-server lease a tab's HTML panes were ever served from, so a
   *  page that outlives its reload (or its tab) is still held to the tab's
   *  network policy. Bounded; the oldest leases fall out first. */
  const leaseOwners = new Map<string, LeasePolicy>();
  /** Shared mutable policy boxes keyed by `${sessionId}\0${tabId}` (never strongly retaining `TabState`). */
  const tabPolicies = new Map<string, LeasePolicy>();
  const releasePolicyRef = (policy: LeasePolicy): void => {
    policy.refCount -= 1;
    if (policy.refCount <= 0 && tabPolicies.get(policy.key) === policy) {
      tabPolicies.delete(policy.key);
    }
  };
  const policyOf = (sessionId: string, tab: LeaseOwner): LeasePolicy => {
    const key = policyKeyOf(sessionId, tab.id);
    let policy = tabPolicies.get(key);
    if (!policy) {
      policy = { key, allowNetwork: tab.allowNetwork === true, refCount: 0 };
      tabPolicies.set(key, policy);
    } else {
      policy.allowNetwork = tab.allowNetwork === true;
    }
    return policy;
  };
  const claimLeases = (sessionId: string, tab: LeaseOwner, panes: VisualizePaneView[]) => {
    const prefixes: string[] = [];
    for (const pane of panes) {
      const prefix = pane.kind === 'html' ? leasePrefixOf(pane.url) : '';
      if (prefix) prefixes.push(prefix);
    }
    if (!prefixes.length) return;
    const policy = policyOf(sessionId, tab);
    for (const prefix of prefixes) {
      const prev = leaseOwners.get(prefix);
      if (prev) {
        leaseOwners.delete(prefix);
        if (prev !== policy) releasePolicyRef(prev);
      }
      leaseOwners.set(prefix, policy);
      if (prev !== policy) policy.refCount += 1;
    }
    while (leaseOwners.size > MAX_TRACKED_LEASES) {
      const oldest = leaseOwners.keys().next().value as string;
      const evicted = leaseOwners.get(oldest);
      leaseOwners.delete(oldest);
      if (evicted) releasePolicyRef(evicted);
    }
  };
  const updatePolicy = (sessionId: string, tab: LeaseOwner) => {
    const policy = tabPolicies.get(policyKeyOf(sessionId, tab.id));
    if (policy) policy.allowNetwork = tab.allowNetwork === true;
  };
  const forgetSession = (sessionId: string) => {
    const prefix = `${sessionId}\0`;
    for (const key of [...tabPolicies.keys()]) {
      if (key.startsWith(prefix)) tabPolicies.delete(key);
    }
  };
  const clearPolicies = () => {
    tabPolicies.clear();
  };

  const paneFrames = new Map<number, string>();
  const setPaneFrame = (id: number, lease: string) => {
    paneFrames.delete(id);
    paneFrames.set(id, lease);
    while (paneFrames.size > MAX_TRACKED_FRAMES) paneFrames.delete(paneFrames.keys().next().value as number);
  };
  /** The owned lease of the first frame in `chain` (the requesting frame, then
   *  its ancestors) that is, or was, a displayed lease page; '' when none. */
  const ownerLease = (chain: RequesterFrame[]): string => {
    for (const entry of chain) {
      const { url, id } = frameEntry(entry);
      const own = leasePrefixOf(url);
      if (own && leaseOwners.has(own)) {
        if (id !== undefined) setPaneFrame(id, own);
        return own;
      }
      const remembered = id === undefined ? undefined : paneFrames.get(id);
      if (remembered && leaseOwners.has(remembered)) return remembered;
    }
    return '';
  };
  /** The owned lease of `chain` when its tab still blocks network; '' else. */
  const blockingLease = (chain: RequesterFrame[]): string => {
    const owned = ownerLease(chain);
    const owner = owned ? leaseOwners.get(owned) : undefined;
    return !owned || !owner || owner.allowNetwork ? '' : owned;
  };

  return {
    claimLeases,
    updatePolicy,
    forgetSession,
    clearPolicies,
    ownerLease,
    guardNavigation(chain: RequesterFrame[], url: string, appInitiated: boolean): boolean {
      const first = chain.length ? frameEntry(chain[0]) : undefined;
      if (appInitiated) {
        if (first?.id !== undefined) {
          const target = leasePrefixOf(url);
          if (target && leaseOwners.has(target)) setPaneFrame(first.id, target);
          else paneFrames.delete(first.id);
        }
        return false;
      }
      const owned = blockingLease(chain);
      if (!owned) return false;
      if (url.startsWith(owned) || /^about:(?:blank|srcdoc)$/.test(url)) return false;
      onBlocked(owned, 'blocked-navigation', /^data:[^,]*/.exec(url)?.[0] ?? url.slice(0, 120));
      return true;
    },
    guardRequest(chain: RequesterFrame[], request: { url: string; resourceType: string }): boolean {
      const owned = blockingLease(chain);
      if (!owned) return false;
      let target: URL;
      try {
        target = new URL(request.url);
      } catch {
        // An unparsable address from an owned page is refused outright.
        return true;
      }
      if (!isOutsideNetworkUrl(target)) return false;
      if (target.host === new URL(owned).host) return false;
      onBlocked(owned, 'blocked-network', blockedNetworkMessage(target.host, request.resourceType));
      return true;
    },
  };
}

export type LeaseGuard = ReturnType<typeof createLeaseGuard>;
