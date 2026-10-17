import {
  DESKTOP_TRANSCRIPT_ITEM_LIMIT,
  DESKTOP_TRANSCRIPT_PAGE_BYTES,
  DESKTOP_TRANSCRIPT_TAIL_BYTES,
  DESKTOP_TRANSCRIPT_TAIL_ITEMS,
  REMOTE_TRANSCRIPT_TAIL_ITEMS,
} from './desktop-support';

/** Visible-session sources the relay registers (`remote:<clientId>`). */
const REMOTE_SOURCE_PREFIX = 'remote:';

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
    let remoteView = false;
    let localView = false;
    for (const [source, sessions] of this.sources) {
      if (!sessions.has(sessionId)) continue;
      if (this.legacySources.has(source)) legacy = true;
      if (source.startsWith(REMOTE_SOURCE_PREFIX)) remoteView = true;
      else localView = true;
    }
    const grown = this.grown.get(sessionId);
    // A legacy source counts pages by item count, so its windows are never cut.
    if (legacy) return { transcriptItemLimit: Math.max(grown?.limit ?? 0, DESKTOP_TRANSCRIPT_ITEM_LIMIT) };
    // Shown by remote (relay) views only: the shorter tail crosses the relay
    // and paints first, and older rows page in as the reader scrolls up.
    const tail = remoteView && !localView ? REMOTE_TRANSCRIPT_TAIL_ITEMS : DESKTOP_TRANSCRIPT_TAIL_ITEMS;
    if (grown && grown.limit > tail) {
      return {
        transcriptItemLimit: grown.limit,
        transcriptByteBudget: DESKTOP_TRANSCRIPT_PAGE_BYTES,
        transcriptPageBase: grown.held,
      };
    }
    return { transcriptItemLimit: tail, transcriptByteBudget: DESKTOP_TRANSCRIPT_TAIL_BYTES };
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
