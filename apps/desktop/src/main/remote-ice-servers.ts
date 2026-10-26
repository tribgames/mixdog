// ICE servers for the phone ↔ PC WebRTC connection: this deployment's own STUN
// and TURN (coturn on the relay host), reached with short-lived credentials the
// relay issues over this PC's authenticated relay leg (relay: lib/ice-legs.mjs).
// No third-party STUN is ever named here.
//
// `resolveRemoteIceServers()` is what the connection code calls before it builds
// a peer connection. It never throws and never waits on anything but the relay's
// answer (bounded by the control request timeout):
//   - a credential is cached until `refreshMarginMs` before it expires, so a
//     session that starts on a cached credential still has that much validity
//     left; an expired one is never handed out;
//   - when the relay cannot issue (not connected, older relay, unpaired,
//     rate-limited, timeout, malformed answer) the list degrades to the relay's
//     STUN URL alone when one is known, else empty. Credentials already held
//     and still valid keep being served while a refresh is failing;
//   - the only waiting period is the one the relay names: a rate-limited answer
//     carries `retryAfterMs`, and no request is made before it has passed.
//
// Lifetimes are counted here, on two clocks at once. performance.now() cannot
// be moved by a clock change, but how it counts time the machine spends asleep
// differs by platform, so on its own it could keep a credential past its real
// expiry; the wall clock does advance across sleep but a user or NTP can move
// it. The elapsed time is the larger of the two, so a change in either clock can
// only make a cached credential expire sooner, never later.
//
// Two clocks still cannot see a sleep that one of them skips while the other is
// then set back, so the machine's own word is used too: `invalidate()` (wired to
// the OS suspend and resume events, see RemoteRelayHandle.suspend/resume) drops
// the cached credential and the retry wait and makes any answer still on its way
// worthless. Neither the clocks nor the event is trusted alone: an answer is also
// checked against the clocks at the moment it arrives, before it is returned.
import { MAX_ICE_SERVERS, MAX_ICE_URLS } from '../shared/remote-webrtc';

/** coturn `max-allocate-lifetime` default (turnserver.conf): 3600 s. A TURN
 *  allocation must be refreshed with a valid credential within that time, so a
 *  credential handed out with less than this left could not carry one
 *  allocation lifetime. This is the margin before expiry at which the cache
 *  stops serving a credential and fetches a new one. */
export const ICE_ALLOCATION_LIFETIME_MS = 3_600_000;

const ICE_URL = /^(stun|turn|turns):\S+$/u;

/** The relay's `ice-servers` envelope, or null when the connected relay does
 *  not offer issuance. Rejects when the relay cannot be asked. */
export type RemoteIceRequest = () => Promise<Record<string, unknown> | null>;

export interface IceClock {
  /** performance.now(): cannot be set by anyone. */
  monotonicMs(): number;
  /** Date.now(): follows sleep, can be set. */
  wallMs(): number;
}

export interface RemoteIceServers {
  /** Fresh-enough ICE servers; `[]` when nothing is available. Never throws. */
  resolve(): Promise<RTCIceServer[]>;
  /** The machine slept or woke: no age counted before this point can be trusted.
   *  Drops the cached credential and any wait, and an answer already on its way
   *  is discarded when it lands. */
  invalidate(): void;
}

interface Mark {
  monotonic: number;
  wall: number;
}

interface CachedIssue {
  servers: RTCIceServer[];
  /** When the request that produced it was sent. */
  issuedAt: Mark;
  /** How long the relay says the credential lives from its issue. */
  lifeMs: number;
  /** Elapsed time after which a new one is fetched. */
  refreshAfterMs: number;
}

/** How long before expiry a credential stops being served: one coturn
 *  allocation lifetime, but never more than half the credential's own life. */
export function refreshMarginMs(lifeMs: number): number {
  return Math.min(ICE_ALLOCATION_LIFETIME_MS, lifeMs / 2);
}

const systemClock: IceClock = { monotonicMs: () => performance.now(), wallMs: () => Date.now() };

const copy = (servers: RTCIceServer[]): RTCIceServer[] =>
  servers.map((server) => ({ ...server, urls: [...(server.urls as string[])] }));

function readUrls(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ICE_URLS) return null;
  return value.every((url) => typeof url === 'string' && ICE_URL.test(url)) ? (value as string[]) : null;
}

function readServer(row: unknown): RTCIceServer | null {
  if (!row || typeof row !== 'object') return null;
  const { urls: rawUrls, username, credential } = row as Record<string, unknown>;
  const urls = readUrls(rawUrls);
  if (!urls) return null;
  const relays = urls.some((url) => !url.startsWith('stun:'));
  if (!relays) return username === undefined && credential === undefined ? { urls } : null;
  return typeof username === 'string' && username && typeof credential === 'string' && credential
    ? { urls, username, credential }
    : null;
}

/** The servers and the credential's real remaining life (`remainingMs`: the
 *  relay's own figure after it floored the expiry to a whole second, never more
 *  than the nominal `ttlSeconds`). */
function readIssue(envelope: Record<string, unknown>): { servers: RTCIceServer[]; lifeMs: number } | null {
  const { ok, servers: rows, ttlSeconds, remainingMs } = envelope;
  if (ok !== true || !Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ICE_SERVERS) return null;
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return null;
  if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  if (remainingMs > ttlSeconds * 1000) return null;
  const servers: RTCIceServer[] = [];
  for (const row of rows) {
    const server = readServer(row);
    if (!server) return null;
    servers.push(server);
  }
  return { servers, lifeMs: remainingMs };
}

export function createRemoteIceServers(deps: { request: RemoteIceRequest; clock?: IceClock }): RemoteIceServers {
  const clock = deps.clock ?? systemClock;
  const markNow = (): Mark => ({ monotonic: clock.monotonicMs(), wall: clock.wallMs() });
  const elapsedSince = (mark: Mark): number =>
    Math.max(clock.monotonicMs() - mark.monotonic, clock.wallMs() - mark.wall);
  let cache: CachedIssue | null = null;
  /** The relay's STUN-only list: learned from any answer, kept across failures. */
  let stunOnly: RTCIceServer[] = [];
  /** Set only by a rate-limited answer, from the retry-after the relay gave. */
  let retry: { from: Mark; afterMs: number } | null = null;
  let inflight: Promise<RTCIceServer[]> | null = null;
  /** Bumped by invalidate(): a request started in an earlier one is stale. */
  let epoch = 0;

  const degraded = (): RTCIceServer[] =>
    cache && elapsedSince(cache.issuedAt) < cache.lifeMs ? copy(cache.servers) : copy(stunOnly);
  const learnStun = (value: unknown): void => {
    const urls = readUrls(value);
    if (urls && urls.every((url) => url.startsWith('stun:'))) stunOnly = [{ urls }];
  };
  const refresh = async (): Promise<RTCIceServer[]> => {
    // Counted from when the request left: the answer's travel time only makes
    // the local expiry earlier than the real one.
    const requestedAt = markNow();
    const startedIn = epoch;
    try {
      const envelope = await deps.request();
      // The machine slept or woke while this was pending: what it brings was
      // issued before a gap whose length nothing here can vouch for.
      if (epoch !== startedIn) return degraded();
      if (envelope === null) return degraded();
      const issue = readIssue(envelope);
      if (issue) {
        const issued: CachedIssue = {
          servers: issue.servers,
          issuedAt: requestedAt,
          lifeMs: issue.lifeMs,
          refreshAfterMs: issue.lifeMs - refreshMarginMs(issue.lifeMs),
        };
        const stun = issue.servers.find((server) => (server.urls as string[]).every((url) => url.startsWith('stun:')));
        if (stun) stunOnly = [{ urls: [...(stun.urls as string[])] }];
        // A request can sit for longer than its life (a sleep the events did not
        // report, a stalled socket): hand out only what is still servable now.
        if (elapsedSince(issued.issuedAt) >= issued.refreshAfterMs) return degraded();
        cache = issued;
        retry = null;
        return copy(issue.servers);
      }
      learnStun(envelope.stun);
      const wait = envelope.error === 'rate-limited' ? envelope.retryAfterMs : undefined;
      if (typeof wait === 'number' && Number.isFinite(wait) && wait > 0) retry = { from: markNow(), afterMs: wait };
    } catch {
      // The relay could not be asked; degrade below.
    }
    return degraded();
  };

  return {
    async resolve() {
      try {
        if (cache && elapsedSince(cache.issuedAt) < cache.refreshAfterMs) return copy(cache.servers);
        if (retry && elapsedSince(retry.from) < retry.afterMs) return degraded();
        const pending = (inflight ??= refresh().finally(() => {
          if (inflight === pending) inflight = null;
        }));
        return copy(await pending);
      } catch {
        return [];
      }
    },
    invalidate() {
      epoch += 1;
      cache = null;
      retry = null;
      // The next caller asks afresh instead of joining a request from before.
      inflight = null;
    },
  };
}

let active: RemoteIceServers | null = null;

/** Makes `servers` the source `resolveRemoteIceServers()` reads, for as long as
 *  this relay client runs. Returns the call that detaches it. */
export function bindRemoteIceServers(servers: RemoteIceServers): () => void {
  active = servers;
  return () => {
    if (active === servers) active = null;
  };
}

/** ICE servers for a new phone ↔ PC peer connection: this deployment's STUN and
 *  TURN with a credential valid for at least the margin above, or what degrades
 *  from that (see the header). `[]` while no relay client runs. */
export function resolveRemoteIceServers(): Promise<RTCIceServer[]> {
  return active ? active.resolve() : Promise.resolve([]);
}
