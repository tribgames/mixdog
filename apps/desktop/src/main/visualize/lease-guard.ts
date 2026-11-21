import type { VisualizePaneView, VisualizeProblem } from '../../shared/visualize';
import { blockedNetworkMessage, isOutsideNetworkUrl } from '../../shared/visualize-network-policy';
import { leasePrefixOf } from './page-problems';

/** A frame that made a request or navigation: its URL and, when known, its
 *  stable id (`frameTreeNodeId`). A bare string is a URL with no frame. */
export type RequesterFrame = string | { url: string; id?: number };

/** What a lease's network policy reads of the tab that owns it. */
interface LeaseOwner {
  allowNetwork?: boolean;
}

const MAX_TRACKED_LEASES = 4096;
const MAX_TRACKED_FRAMES = 4096;

const frameEntry = (entry: RequesterFrame): { url: string; id?: number } =>
  typeof entry === 'string' ? { url: entry } : entry;

/** `onBlocked` hears every refused navigation or request, with the owned lease
 *  of the page that made it. */
export function createLeaseGuard(
  onBlocked: (lease: string, kind: Extract<VisualizeProblem['kind'], `blocked-${string}`>, message: string) => void
) {
  /** Every page-server lease a tab's HTML panes were ever served from, so a
   *  page that outlives its reload (or its tab) is still held to the tab's
   *  network policy. Bounded; the oldest leases fall out first. */
  const leaseOwners = new Map<string, LeaseOwner>();
  const claimLeases = (tab: LeaseOwner, panes: VisualizePaneView[]) => {
    for (const pane of panes) {
      const prefix = pane.kind === 'html' ? leasePrefixOf(pane.url) : '';
      if (!prefix) continue;
      leaseOwners.delete(prefix);
      leaseOwners.set(prefix, tab);
    }
    while (leaseOwners.size > MAX_TRACKED_LEASES) leaseOwners.delete(leaseOwners.keys().next().value as string);
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
