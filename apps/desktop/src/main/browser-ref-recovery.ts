import type {
  BrowserSnapshotElement,
  BrowserSnapshotPayload,
} from './browser-accessibility';

export interface BrowserRefFingerprint {
  ref: string;
  snapshotId: string;
  url: string;
  role: string;
  name: string;
  href: string;
}

export interface BrowserRefSet {
  snapshotId: string;
  url: string;
  viewportWidth: number;
  viewportHeight: number;
  refs: Map<string, BrowserRefFingerprint>;
}

export interface BrowserRefRecoveryResult {
  ref?: string;
  reason?: string;
}

function pageId(snapshotId: string): string {
  return snapshotId.replace(/-s\d+$/i, '');
}

function fingerprint(
  payload: BrowserSnapshotPayload,
  element: BrowserSnapshotElement,
): BrowserRefFingerprint {
  return {
    ref: element.ref,
    snapshotId: payload.snapshotId,
    url: payload.url,
    role: element.role,
    name: element.name,
    href: element.href || '',
  };
}

export function createBrowserRefSet(payload: BrowserSnapshotPayload): BrowserRefSet {
  return {
    snapshotId: payload.snapshotId,
    url: payload.url,
    viewportWidth: payload.viewportWidth,
    viewportHeight: payload.viewportHeight,
    refs: new Map(payload.elements.map((element) => [
      element.ref,
      fingerprint(payload, element),
    ])),
  };
}

export function recoverBrowserRef(
  source: BrowserRefFingerprint,
  fresh: BrowserRefSet,
): BrowserRefRecoveryResult {
  if (source.url !== fresh.url || pageId(source.snapshotId) !== pageId(fresh.snapshotId)) {
    return { reason: 'the page or URL changed' };
  }
  if (!source.name && !source.href) {
    return { reason: 'the original element has no stable semantic name or link target' };
  }
  const matches = [...fresh.refs.values()].filter((candidate) => (
    candidate.role === source.role
    && candidate.name === source.name
    && candidate.href === source.href
  ));
  if (matches.length === 1) return { ref: matches[0].ref };
  if (matches.length === 0) return { reason: 'no exact semantic match exists in the fresh snapshot' };
  return { reason: `${matches.length} exact semantic matches are ambiguous` };
}

export function isBrowserStaleRefError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:stale|detached)\b|no node with given id|could not find node|node[^\n]*not found|cannot find context with specified id/i
    .test(message);
}
