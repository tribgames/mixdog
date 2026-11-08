// The sign-in flows' scoped feeds, `login:<flowId>` (desktop-services.md §5.4, §15 P8): the core opens one per
// GitHub CLI, provider OAuth and MCP OAuth flow and publishes its progress on it as `login/updated {flowId, state}`;
// a subscriber's first frame is `feed/snapshot {feedId, state}`, the flow's current status. A feed is delivered only
// to a connection that subscribed (`feed/subscribe`), so the connection follows the feed of every flow it starts.

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
