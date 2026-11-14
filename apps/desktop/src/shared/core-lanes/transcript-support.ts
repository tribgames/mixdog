// The transcript sizes and the provider-model normaliser the core lanes share: the pieces of desktop-support.ts that
// name no path, so the lanes (and the phone's web bundle) import them without node:path.
export { DESKTOP_TRANSCRIPT_TAIL_ITEMS, REMOTE_TRANSCRIPT_TAIL_BYTES, normalizedProviderModels } from '../desktop-transcript-limits';

/** Items a runtime restores on resume, and the page an old (non-paging)
 *  remote client keeps receiving. */
export const DESKTOP_TRANSCRIPT_ITEM_LIMIT = 512;
/** First-open tail for a session only remote (relay) views show: a phone's
 *  ~700px transcript paints about 12 rows plus overscan, so 20 items cover its
 *  first screen and older rows page in as it scrolls up. Fewer bytes cross the
 *  relay and fewer rows mount before the first paint. */
export const REMOTE_TRANSCRIPT_TAIL_ITEMS = 20;
export const DESKTOP_TRANSCRIPT_TAIL_BYTES = 1_000_000;
/** Serialized bytes of the older rows one history page reveals (the page adds
 *  up to 64 items, the renderer's TRANSCRIPT_TAIL_PAGE_ITEMS); the daemon
 *  always reveals at least 8 (TRANSCRIPT_WINDOW_MIN_ITEMS) so paging progresses. */
export const DESKTOP_TRANSCRIPT_PAGE_BYTES = 1_000_000;
