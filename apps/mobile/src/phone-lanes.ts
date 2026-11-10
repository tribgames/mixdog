// Node's `setRemoteLanes`: the page names the push lanes it reads (terminal, files, editor, visualize) so the desktop stops sending
// the rest. The protocol has no lane registry: what a lane carries is a set of scoped feeds, opened with `feed/subscribe` and
// closed with `feed/unsubscribe`. The adapter that owns a lane declares its feed ids; this module keeps exactly the feeds of the
// lanes in use open, and opens them again on every new connection (a connection starts with none).
import type { ClientEvent, ProtocolClient, SessionFold } from '../../../packages/protocol-client/src/index.ts';

export type LaneClient = Pick<ProtocolClient<SessionFold>, 'call' | 'on' | 'status'>;

export interface LaneFeeds {
  /** The feeds a lane reads. Declared by the adapter that owns the lane, whenever its set changes. */
  declare(lane: string, feedIds: readonly string[]): void;
  /** The lanes the page reads now. */
  use(lanes: Iterable<string>): void;
  stop(): void;
}

export function createLaneFeeds(client: LaneClient): LaneFeeds {
  const declared = new Map<string, readonly string[]>();
  let used = new Set<string>();
  const open = new Set<string>();
  const sync = (): void => {
    if (client.status.state !== 'ready') return;
    const wanted = new Set([...used].flatMap((lane) => declared.get(lane) ?? []));
    for (const feedId of [...open]) {
      if (wanted.has(feedId)) continue;
      open.delete(feedId);
      void client.call('feed/unsubscribe', { feedId }).catch(() => undefined);
    }
    for (const feedId of wanted) {
      if (open.has(feedId)) continue;
      open.add(feedId);
      // A feed the core no longer holds is simply not followed; the next lane change asks again.
      void client.call('feed/subscribe', { feedId }).catch(() => open.delete(feedId));
    }
  };
  const off = client.on((event: ClientEvent) => {
    if (event.type !== 'status' || event.status.state !== 'ready') return;
    open.clear();
    sync();
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
    stop: off,
  };
}
