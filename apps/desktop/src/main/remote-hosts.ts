// "Connect to another PC": the rules of a saved host's dedicated remote window (its storage partition, title, user
// agent, which links stay inside it) and the watch on the core's host lists. The hosts themselves (the saved list, the
// pairing code, presence) are the core's `remoteHosts/*`; remote-host-windows.ts owns the windows. Pure and
// Electron-free so every rule is testable.

/** Each host gets its own persistent storage container, so its pairing
 *  credential and E2EE keys never mix with another host or the local app. */
export function remoteHostPartition(id: string): string {
  return `persist:remote-host-${id}`;
}

/** The window title; the in-app indicator reads the same name. */
export function remoteWindowTitle(name: string): string {
  return `Connected to ${name} — Mixdog`;
}

/** The page must see an ordinary browser (no Electron token), because that is
 *  what makes it install the relay shim instead of expecting a local bridge. */
export function remoteWindowUserAgent(defaultUserAgent: string, appName: string): string {
  const escaped = appName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const stripped = defaultUserAgent
    .replace(/\sElectron\/\S+/gu, '')
    .replace(new RegExp(`\\s${escaped}\\/\\S+`, 'gu'), '');
  return `${stripped} MixdogDesktop/1`;
}

/** Same relay origin: stays in the remote window. Anything else is a link the
 *  user's default browser should handle. */
export function isRemoteHostNavigation(hostUrl: string, target: string): boolean {
  try {
    return new URL(target).origin === new URL(hostUrl).origin;
  } catch {
    return false;
  }
}

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** The target of a link click that may be handed to the OS, or null. */
export function externalLinkTarget(target: string): string | null {
  try {
    const url = new URL(target);
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The core client's raw events (`ProtocolConnection.onEvent`) and calls. */
export interface HostListsFeedSource {
  call(method: string, params: unknown): Promise<unknown>;
  onEvent(listener: (event: { type: string; status?: { state: string }; notification?: unknown }) => void): () => void;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** Whether a `connections` feed notification (`connections/updated`, or the sections of a snapshot) touches the
 *  saved-hosts list (the `hosts` key). */
export function touchesHostLists(notification: unknown): boolean {
  const note = asRecord(notification);
  const params = asRecord(note.params);
  const updates =
    note.method === 'feed/snapshot'
      ? asRecord(params.state).sections
      : note.method === 'connections/updated'
        ? [params]
        : [];
  return Array.isArray(updates) && updates.some((update) => {
    const row = asRecord(update);
    return row.section === 'connections' && row.key === 'hosts';
  });
}

/** Follows the core's `connections` feed and calls `notify` when the saved hosts change (a rename, a forget or a code
 *  redeemed from another window), so every window reads its lists again; subscribes again after the link comes back.
 *  Returns the stop. A refused subscription is reported through `log` and leaves the lists to the changes main makes. */
export function watchHostListsFeed(source: HostListsFeedSource, notify: () => void, log: (message: string) => void): () => void {
  let subscription: string | null = null;
  let ready = true;
  let stopped = false;
  const subscribe = (): void => {
    source
      .call('connections/subscribe', {})
      .then((reply) => {
        const id = asRecord(reply).id;
        if (typeof id !== 'string') return;
        if (stopped) void source.call('connections/unsubscribe', { subscriptionId: id }).catch(() => undefined);
        else subscription = id;
      })
      .catch((error: unknown) => log(`connections feed: ${error instanceof Error ? error.message : String(error)}`));
  };
  const detach = source.onEvent((event) => {
    if (event.type === 'status') {
      const now = event.status?.state === 'ready';
      // A new connection to the core holds no feed.
      if (now && !ready) {
        subscription = null;
        subscribe();
      }
      ready = now;
      return;
    }
    if (event.type === 'notification' && touchesHostLists(event.notification)) notify();
  });
  subscribe();
  return () => {
    stopped = true;
    detach();
    if (subscription !== null) void source.call('connections/unsubscribe', { subscriptionId: subscription }).catch(() => undefined);
    subscription = null;
  };
}
