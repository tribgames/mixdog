import {
  DESKTOP_TRANSCRIPT_ITEM_LIMIT,
  DESKTOP_TRANSCRIPT_PAGE_BYTES,
  DESKTOP_TRANSCRIPT_TAIL_BYTES,
  DESKTOP_TRANSCRIPT_TAIL_ITEMS,
} from './desktop-support';

/** What a session read/subscribe asks the daemon for. */
export interface TranscriptWindowRequest {
  transcriptItemLimit: number;
  transcriptByteBudget?: number;
  /** Newest items the reader already holds: the byte budget bounds only the
   *  older rows a page reveals above them. */
  transcriptPageBase?: number;
}

/**
 * One daemon transcript window per session, shared by every source (desktop
 * window, each phone) that shows it — the host holds one projection per
 * session. Paging views open on a byte-budgeted tail and page older history
 * in byte-budgeted pages; a legacy source (an old phone build that cannot
 * page from `transcriptHasOlder`) raises the window to the 512-item page it
 * expects and pages by count, unbudgeted. Reading older history only ever
 * grows it.
 */
export class SessionTranscriptWindows {
  private readonly grown = new Map<string, { limit: number; held: number }>();
  private readonly legacySources = new Set<string>();
  private readonly sent = new Map<string, string>();

  constructor(private readonly sources: ReadonlyMap<string, ReadonlySet<string>>) {}

  setLegacySource(sourceId: string, legacy: boolean): void {
    if (legacy) this.legacySources.add(sourceId);
    else this.legacySources.delete(sourceId);
  }

  request(sessionId: string): TranscriptWindowRequest {
    let legacy = false;
    for (const source of this.legacySources) {
      if (this.sources.get(source)?.has(sessionId)) legacy = true;
    }
    const grown = this.grown.get(sessionId);
    // A legacy source counts pages by item count, so its windows are never cut.
    if (legacy) return { transcriptItemLimit: Math.max(grown?.limit ?? 0, DESKTOP_TRANSCRIPT_ITEM_LIMIT) };
    if (grown && grown.limit > DESKTOP_TRANSCRIPT_TAIL_ITEMS) {
      return {
        transcriptItemLimit: grown.limit,
        transcriptByteBudget: DESKTOP_TRANSCRIPT_PAGE_BYTES,
        transcriptPageBase: grown.held,
      };
    }
    return { transcriptItemLimit: DESKTOP_TRANSCRIPT_TAIL_ITEMS, transcriptByteBudget: DESKTOP_TRANSCRIPT_TAIL_BYTES };
  }

  /** A reader holding `held` items reached the top: widen the window to
   *  `limit`. False when it already covers `limit`. */
  grow(sessionId: string, limit: number, held: number): boolean {
    if (limit <= this.request(sessionId).transcriptItemLimit) return false;
    this.grown.set(sessionId, { limit, held: Math.max(0, Math.min(limit, Math.floor(held) || 0)) });
    return true;
  }

  /** The request that goes on the wire now, remembered per session. */
  send(sessionId: string): TranscriptWindowRequest {
    const request = this.request(sessionId);
    this.sent.set(sessionId, windowKey(request));
    return request;
  }

  /** Whether the held projection was read with a different window. */
  stale(sessionId: string): boolean {
    return this.sent.get(sessionId) !== windowKey(this.request(sessionId));
  }

  /** A session no source shows starts from the tail again. */
  prune(visible: ReadonlySet<string>): void {
    for (const map of [this.grown, this.sent]) {
      for (const sessionId of map.keys()) if (!visible.has(sessionId)) map.delete(sessionId);
    }
  }
}

function windowKey(request: TranscriptWindowRequest): string {
  return `${request.transcriptItemLimit}:${request.transcriptByteBudget ?? ''}:${request.transcriptPageBase ?? ''}`;
}
