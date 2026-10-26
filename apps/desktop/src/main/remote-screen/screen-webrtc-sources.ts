/**
 * The window process's whole-PC screen sources for the WebRTC host: at most
 * one live session per display, owned by the paired client that opened it.
 *
 * - Access: pairing is the approval, so a paired, connected E2EE client may
 *   view and control. The service owns the relay and the pairing, so it pushes
 *   each client's `RemoteScreenAccess` (screen-access-publisher.ts): a grant
 *   before forwarding that client's screen `ready`, a deny when its connection
 *   leaves or is unpaired. Each carries the service's epoch, a revision and
 *   the relay connection it was decided for. Only a revision newer than the
 *   last one applied for that client is applied (a stale one is rejected); a
 *   new epoch retires the previous one and withdraws all its access. A session
 *   is bound to the connection it was opened for and reads the access live
 *   through `ScreenViewerAuthorization`: a deny, or access for another
 *   connection under the same client id, stops it at once.
 * - Resolve: a client's `ready` for a display nobody holds creates a session
 *   and starts it at once (the viewer's
 *   offer waits for the geometry the start locks). Its later signals reach the
 *   same session; another client's are refused while it lives. Any other
 *   signal never creates one.
 * - Close (`stopForQuit`, `dispose`): latched synchronously and permanently.
 *   Every session still running or releasing is stopped within
 *   `SCREEN_QUIT_BUDGET_MS` (`stopScreenSourcesForQuit`), the cached access is
 *   cleared, and every later resolve or access update is refused. Once every
 *   session released, the secure-desktop client (owned here) is disposed.
 */
import type { RemoteScreenDisplaySummary, RemoteWebrtcClientSignal, RemoteWebrtcSource } from '../../shared/remote-webrtc';
import { remoteWebrtcSourceKey } from '../../shared/remote-webrtc';
import type { RemoteWebrtcSourceSink, RemoteWebrtcVideoSource } from '../remote-webrtc/source';
import { summarizeScreenDisplay } from './screen-geometry';
import type { ScreenInputHost } from './screen-input-host';
import {
  createRemoteScreenSource,
  stopScreenSourcesForQuit,
  type RemoteScreenSource,
  type ScreenDisplayProvider,
  type ScreenIndicator,
  type ScreenSourceEvent,
} from './screen-source';
import { createScreenWebrtcSource } from './screen-webrtc-source';
import type { SecureDesktopHelper } from './secure-desktop-helper';

/** One relay client's screen access, as the service decides it. */
export interface RemoteScreenAccess {
  /** The service instance that decided it. */
  epoch: string;
  /** Monotonic within the epoch; only a newer one replaces the last applied. */
  revision: number;
  /** The relay connection it was decided for; '' on a deny. */
  connection: string;
  /** That connection is a paired, E2EE-established client and still
   *  connected (a grant); false on a deny. */
  paired: boolean;
  /** What the on-PC indicator calls the phone. */
  label: string;
}

const MAX_LABEL = 120;
const MAX_ID = 64;

const isId = (value: unknown, allowEmpty: boolean): value is string =>
  typeof value === 'string' && value.length <= MAX_ID && (allowEmpty || value.length > 0);

/** Validates access crossing from the service (every cross-process input is). */
export function parseRemoteScreenAccess(value: unknown): RemoteScreenAccess {
  const access = value as Partial<RemoteScreenAccess> | null;
  if (
    !access ||
    typeof access !== 'object' ||
    !isId(access.epoch, false) ||
    !Number.isSafeInteger(access.revision) ||
    (access.revision as number) < 1 ||
    typeof access.paired !== 'boolean' ||
    // A grant names its connection; only a deny may leave it empty.
    !isId(access.connection, !access.paired) ||
    typeof access.label !== 'string'
  ) {
    throw new TypeError('remote screen access is invalid.');
  }
  return {
    epoch: access.epoch,
    revision: access.revision as number,
    connection: access.connection,
    paired: access.paired,
    label: access.label.slice(0, MAX_LABEL),
  };
}

export interface RemoteScreenSourcesDeps {
  /** The displays, with a refresh of their capture source ids. */
  displays: ScreenDisplayProvider & { refresh(): Promise<void>; dispose?(): void };
  createInputHost(): ScreenInputHost;
  /** Shared by every session, each through its own lease (one holds the
   *  helper at a time); owned here, disposed at close once every session
   *  released (their releases may go through it). */
  secureDesktop: SecureDesktopHelper;
  /** A fresh on-PC indicator per session. */
  indicator(): ScreenIndicator;
  /** The WebRTC host (geometry, capture renewal, end of a session). */
  sink: RemoteWebrtcSourceSink;
  log(event: ScreenSourceEvent | { type: 'start-failed'; clientId: string; screenId: string; error: string }): void;
}

interface Session {
  clientId: string;
  video: RemoteWebrtcVideoSource;
}

export function createRemoteScreenSources(deps: RemoteScreenSourcesDeps) {
  const access = new Map<string, RemoteScreenAccess>();
  const accessListeners = new Map<string, Set<() => void>>();
  /** Live sessions by source key. */
  const sessions = new Map<string, Session>();
  /** Every session not yet released, for the quit budget. */
  const unreleased = new Set<RemoteScreenSource>();
  /** The service instance whose access applies; earlier ones are retired. */
  let epoch: string | null = null;
  const retiredEpochs = new Set<string>();
  /** The newest revision applied per client in this epoch. Kept after a deny,
   *  so a grant issued before it can never land after it. */
  const revisions = new Map<string, number>();
  /** Set once by `close`, never cleared. */
  let closing = false;
  let closed: Promise<void> | null = null;

  const notify = (clientId: string): void => {
    for (const listener of [...(accessListeners.get(clientId) ?? [])]) listener();
  };

  /** A client's access is gone: its sessions see it, then stop. */
  const withdraw = (clientId: string): void => {
    if (!access.delete(clientId)) return;
    notify(clientId);
  };

  function create(clientId: string, source: Extract<RemoteWebrtcSource, { kind: 'screen' }>): RemoteWebrtcVideoSource | null {
    const granted = access.get(clientId);
    if (!granted?.paired) return null;
    // The session belongs to the connection its access was decided for: the
    // access of any other connection under the same client id is none of its.
    const connection = granted.connection;
    const accessOf = (): RemoteScreenAccess | null => {
      const current = access.get(clientId);
      return current?.connection === connection ? current : null;
    };
    const key = remoteWebrtcSourceKey(source);
    // The session's hold on the shared helper; let go once it released (its
    // releases may go through the helper), or when it never started.
    const lease = deps.secureDesktop.lease();
    const screen = createRemoteScreenSource({
      clientId,
      clientLabel: granted.label,
      screenId: source.screenId,
      displays: deps.displays,
      authorization: {
        paired: () => accessOf()?.paired === true,
        onChange(listener) {
          let listeners = accessListeners.get(clientId);
          if (!listeners) accessListeners.set(clientId, (listeners = new Set()));
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0 && accessListeners.get(clientId) === listeners) accessListeners.delete(clientId);
          };
        },
      },
      createInputHost: deps.createInputHost,
      secureDesktop: lease,
      indicator: deps.indicator(),
      log: deps.log,
      sampleCursor: true,
    });
    const session: Session = {
      clientId,
      video: createScreenWebrtcSource(screen, {
        screenId: source.screenId,
        sink: deps.sink,
        onStartError: (error) => {
          forget();
          void screen.released().finally(() => lease.dispose());
          deps.log({ type: 'start-failed', clientId, screenId: source.screenId, error: String(error) });
        },
      }),
    };
    const forget = (): void => {
      if (sessions.get(key) === session) sessions.delete(key);
    };
    sessions.set(key, session);
    unreleased.add(screen);
    screen.onStop(() => {
      forget();
      // `released()` is the running stop once this listener has returned.
      void Promise.resolve()
        .then(() => screen.released())
        .finally(() => {
          unreleased.delete(screen);
          lease.dispose();
        });
    });
    session.video.start();
    return session.video;
  }

  /** Latches closed (synchronously, before the shutdown snapshot), stops every
   *  session under the quit budget, clears the cached access, and disposes
   *  the secure-desktop client once every session released. */
  function close(): Promise<void> {
    if (!closing) {
      // Latched before the snapshot: nothing a stop triggers can open a session.
      closing = true;
      closed = stopScreenSourcesForQuit(unreleased).finally(() => deps.secureDesktop.dispose());
      sessions.clear();
      access.clear();
      accessListeners.clear();
    }
    return closed ?? Promise.resolve();
  }

  return {
    /**
     * The service's access for a client, applied at once when it is newer
     * than the last one applied (see the header); throws on a stale or
     * retired one, and after close. Resolves once the displays' capture ids
     * are fresh for a client that may open a session (a failed refresh leaves
     * the display out, so its start is refused).
     */
    setAccess(clientId: string, value: RemoteScreenAccess): Promise<void> {
      if (closing) throw new Error('remote screen sources are closed.');
      if (retiredEpochs.has(value.epoch)) throw new TypeError('remote screen access is stale.');
      if (value.epoch !== epoch) {
        // A new service instance: the previous one's connections are gone.
        if (epoch !== null) retiredEpochs.add(epoch);
        epoch = value.epoch;
        revisions.clear();
        for (const id of [...access.keys()]) withdraw(id);
      }
      if (value.revision <= (revisions.get(clientId) ?? 0)) throw new TypeError('remote screen access is stale.');
      revisions.set(clientId, value.revision);
      if (!value.paired) {
        withdraw(clientId);
        return Promise.resolve();
      }
      access.set(clientId, value);
      notify(clientId);
      return deps.displays.refresh().catch(() => undefined);
    },

    /** The WebRTC host's resolver for screen sources (see the header). */
    resolve(
      source: RemoteWebrtcSource,
      viewer: { clientId: string; signal: RemoteWebrtcClientSignal['type'] }
    ): RemoteWebrtcVideoSource | null {
      if (closing || source.kind !== 'screen') return null;
      const current = sessions.get(remoteWebrtcSourceKey(source));
      if (current) return current.clientId === viewer.clientId ? current.video : null;
      return viewer.signal === 'ready' ? create(viewer.clientId, source) : null;
    },

    /** The displays a phone may choose, with fresh capture ids. */
    async displays(): Promise<RemoteScreenDisplaySummary[]> {
      await deps.displays.refresh();
      return deps.displays.list().map(summarizeScreenDisplay);
    },

    /** App quit: closes (see `close`); resolves once every session released,
     *  within the quit budget. */
    stopForQuit: close,

    /** The host goes away: closes as at quit, then the display watch ends. */
    async dispose(): Promise<void> {
      await close();
      deps.displays.dispose?.();
    },
  };
}

export type RemoteScreenSources = ReturnType<typeof createRemoteScreenSources>;
