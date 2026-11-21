// The page names the push lanes it reads (terminal, files, editor, visualize) so the desktop stops sending
// the rest. The protocol has no lane registry: what a lane carries is a set of scoped feeds, opened with `feed/subscribe` and
// closed with `feed/unsubscribe`. The adapter that owns a lane declares its feed ids; this module keeps exactly the feeds of the
// lanes in use open, and opens them again on every new connection (a connection starts with none).
import type { ClientEvent, ProtocolClient, SessionFold } from '../../../packages/protocol-client/src/index.ts';

export type LaneClient = Pick<ProtocolClient<SessionFold>, 'call' | 'on' | 'status'>;
const TERMINAL_FEED = 'process:relay';
type Position = { epoch: string; seq: number };

export interface LaneFeeds {
  /** The feeds a lane reads. Declared by the adapter that owns the lane, whenever its set changes. */
  declare(lane: string, feedIds: readonly string[]): void;
  /** The lanes the page reads now. */
  use(lanes: Iterable<string>): void;
  /** The terminal feed must be present even if its subscription failed or was lost. */
  expected(): readonly string[];
  stop(): void;
}

export function createLaneFeeds(client: LaneClient, terminal: { redraw(): void; retire(): void }): LaneFeeds {
  const declared = new Map<string, readonly string[]>();
  let used = new Set<string>();
  const open = new Map<string, { pending: boolean }>();
  const closing = new Map<string, object>();
  let position: Position | undefined;
  let redrawOnSnapshot = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 250;
  const wantedFeeds = (): Set<string> => new Set([...used].flatMap((lane) => declared.get(lane) ?? []));
  const clearRetry = (): void => {
    clearTimeout(retry);
    retry = undefined;
    retryDelay = 250;
  };
  const sync = (): void => {
    if (client.status.state !== 'ready') return;
    const wanted = wantedFeeds();
    if (!wanted.has(TERMINAL_FEED)) {
      position = undefined;
      redrawOnSnapshot = false;
      clearRetry();
    }
    for (const [feedId, entry] of open) {
      if (wanted.has(feedId) || entry.pending) continue;
      open.delete(feedId);
      const claim = {};
      closing.set(feedId, claim);
      const isTerminal = feedId === TERMINAL_FEED;
      const closed = (): void => {
        if (closing.get(feedId) !== claim) return;
        closing.delete(feedId);
        sync();
      };
      void client
        .call('feed/unsubscribe', { feedId }, isTerminal ? { timeoutMs: 10_000 } : undefined)
        .then(closed, () => {
          if (closing.get(feedId) !== claim) return;
          if (isTerminal) terminal.retire();
          else closed();
        });
    }
    for (const feedId of wanted) {
      const isTerminal = feedId === TERMINAL_FEED;
      if (open.has(feedId) || closing.has(feedId) || (isTerminal && retry !== undefined)) continue;
      const claim = { pending: true };
      open.set(feedId, claim);
      const resumeFrom = isTerminal ? position : undefined;
      void client
        .call(
          'feed/subscribe',
          { feedId, ...(resumeFrom ? { resumeFrom } : {}) },
          isTerminal ? { timeoutMs: 10_000 } : undefined
        )
        .then(
          () => {
            if (open.get(feedId) !== claim) return;
            claim.pending = false;
            if (isTerminal) clearRetry();
            if (!wantedFeeds().has(feedId)) sync();
          },
          (error: unknown) => {
            if (open.get(feedId) !== claim) return;
            open.delete(feedId);
            if (!isTerminal) return;
            // A timed-out request might still attach; only a new connection may safely replace it.
            if ((error as { detail?: { kind?: string } } | null)?.detail?.kind === 'requestTimeout') {
              terminal.retire();
              return;
            }
            if (!wantedFeeds().has(feedId)) return;
            if ((error as { detail?: { reason?: string } } | null)?.detail?.reason === 'cursorInvalidated') {
              redrawOnSnapshot = position !== undefined || redrawOnSnapshot;
              position = undefined;
            }
            retry = setTimeout(() => {
              retry = undefined;
              sync();
            }, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 10_000);
          }
        );
    }
  };
  const off = client.on((event: ClientEvent) => {
    if (event.type === 'status') {
      if (event.status.state === 'ready') sync();
      else {
        open.clear();
        closing.clear();
        clearRetry();
      }
    } else if (event.type === 'notification') {
      const feed = event.notification.feed;
      // Count only dispatched frames, not frames received but still awaiting delivery when the link ended.
      if (feed?.id === TERMINAL_FEED && open.has(TERMINAL_FEED) && used.has('terminal')) {
        const redraw = event.notification.method === 'feed/snapshot' && (position !== undefined || redrawOnSnapshot);
        position = { epoch: feed.epoch, seq: feed.seq };
        if (redraw) {
          redrawOnSnapshot = false;
          terminal.redraw();
        }
      }
    }
  });
  return {
    declare(lane, feedIds) {
      declared.set(lane, [...feedIds]);
      sync();
    },
    use(lanes) {
      used = new Set(lanes);
      sync();
    },
    expected: () => (wantedFeeds().has(TERMINAL_FEED) ? [TERMINAL_FEED] : []),
    stop() {
      off();
      clearRetry();
      open.clear();
      closing.clear();
    },
  };
}
