import {
  DESKTOP_TRANSCRIPT_ITEM_LIMIT,
  DESKTOP_TRANSCRIPT_TAIL_BYTES,
  DESKTOP_TRANSCRIPT_TAIL_ITEMS,
} from './desktop-support';

/** What a session read/subscribe asks the daemon for. */
export interface TranscriptWindowRequest {
  transcriptItemLimit: number;
  transcriptByteBudget?: number;
}

/**
 * One daemon transcript window per session, shared by every source (desktop
 * window, each phone) that shows it — the host holds one projection per
 * session. Paging views open on a byte-budgeted tail; a legacy source (an old
 * phone build that cannot page from `transcriptHasOlder`) raises the window to
 * the 512-item page it expects. Reading older history only ever grows it.
 */
export class SessionTranscriptWindows {
  private readonly grown = new Map<string, number>();
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
    const grown = this.grown.get(sessionId) ?? 0;
    const base = legacy ? DESKTOP_TRANSCRIPT_ITEM_LIMIT : DESKTOP_TRANSCRIPT_TAIL_ITEMS;
    if (grown > base) return { transcriptItemLimit: grown };
    return legacy
      ? { transcriptItemLimit: DESKTOP_TRANSCRIPT_ITEM_LIMIT }
      : { transcriptItemLimit: DESKTOP_TRANSCRIPT_TAIL_ITEMS, transcriptByteBudget: DESKTOP_TRANSCRIPT_TAIL_BYTES };
  }

  /** A reader reached the top: widen the window. False when it already covers `limit`. */
  grow(sessionId: string, limit: number): boolean {
    if (limit <= this.request(sessionId).transcriptItemLimit) return false;
    this.grown.set(sessionId, limit);
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
  return `${request.transcriptItemLimit}:${request.transcriptByteBudget ?? ''}`;
}
