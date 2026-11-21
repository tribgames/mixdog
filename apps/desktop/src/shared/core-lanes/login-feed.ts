// Protocol: feed `login:<flowId>` carries `login/updated {flowId, state}`; a subscriber's first frame is
// `feed/snapshot {feedId, state}`. A feed reaches only a connection that sent `feed/subscribe`.

export interface LoginUpdate {
  flowId: string;
  state: unknown;
}

const FEED_PREFIX = 'login:';

/** The requests whose reply names a flow, `{ flowId }`, whose feed the caller follows. */
export const LOGIN_START_METHODS: ReadonlySet<string> = new Set([
  'mcp/beginMcpOAuthLogin',
  'account/beginOAuthProviderLogin',
  'github/login/start',
]);

/** The requests that end a flow, naming it as `flowId`: its feed ends with it. */
export const LOGIN_CANCEL_METHODS: ReadonlySet<string> = new Set([
  'mcp/cancelMcpOAuthLogin',
  'account/cancelOAuthProviderLogin',
  'github/login/cancel',
]);

export const loginFeedId = (flowId: string): string => `${FEED_PREFIX}${flowId}`;

/** The update a notification of the connection carries for a login feed: a `login/updated`, or the `feed/snapshot` of
 *  a `login:<flowId>` feed. Any other notification is not one. */
export function loginUpdateOf(method: string, params: unknown): LoginUpdate | null {
  const body = (params ?? {}) as { flowId?: unknown; feedId?: unknown; state?: unknown };
  if (method === 'login/updated' && typeof body.flowId === 'string') return { flowId: body.flowId, state: body.state };
  if (method === 'feed/snapshot' && typeof body.feedId === 'string' && body.feedId.startsWith(FEED_PREFIX)) {
    return { flowId: body.feedId.slice(FEED_PREFIX.length), state: body.state };
  }
  return null;
}

/** The most sign-in flow feeds one connection keeps once flows have ended; the oldest ended one is let go first. A
 *  flow still pending (or whose first frame has not arrived) is never let go: a status read answers for any
 *  live flow, and a dialog waiting on it would never be told. */
export const MAX_FOLLOWED_LOGINS = 32;

/** What the connection holds of a followed sign-in flow's feed. */
export interface LoginFeedState {
  /** The last state the feed delivered; null before the first frame. */
  state: unknown;
  lost: boolean;
}

/** A held login state that has left `pending` (complete, failed, cancelled, expired): nothing more will arrive. */
const isFinalLoginState = (state: unknown): boolean => {
  const name = (state as { state?: unknown } | null)?.state;
  return typeof name === 'string' && name !== 'pending';
};

/** The sign-in flows a connection follows. A scoped feed reaches only its subscriber and does not survive the socket,
 *  so a followed feed whose subscription failed, or whose link went down, is lost for good: the flow goes on in the
 *  core, but its progress will not arrive, and `onLost` tells the windows. */
export function createLoginFollower({
  onLost,
  unsubscribe,
}: {
  onLost(flowId: string): void;
  unsubscribe(feedId: string): void;
}) {
  const feeds = new Map<string, LoginFeedState>();
  const lose = (flowId: string, feed: LoginFeedState): void => {
    if (feed.lost) return;
    feed.lost = true;
    onLost(flowId);
  };
  const unfollow = (flowId: string): void => {
    if (feeds.delete(flowId)) unsubscribe(loginFeedId(flowId));
  };
  return {
    unfollow,
    async follow(live: { call(method: string, params: unknown): Promise<unknown> }, flowId: string): Promise<void> {
      const feed: LoginFeedState = { state: null, lost: false };
      feeds.set(flowId, feed);
      for (const [oldest, held] of [...feeds]) {
        if (feeds.size <= MAX_FOLLOWED_LOGINS) break;
        if (isFinalLoginState(held.state)) unfollow(oldest);
      }
      try {
        await live.call('feed/subscribe', { feedId: loginFeedId(flowId) });
      } catch {
        lose(flowId, feed);
      }
    },
    loseAll(): void {
      for (const [flowId, feed] of feeds) lose(flowId, feed);
    },
    record(flowId: string, state: unknown): void {
      const feed = feeds.get(flowId);
      if (feed) feed.state = state;
    },
    read(flowId: string): LoginFeedState {
      const feed = feeds.get(flowId);
      return feed ? { ...feed } : { state: null, lost: true };
    },
    clear(): void {
      feeds.clear();
    },
  };
}
