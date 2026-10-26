/**
 * Service side of the whole-PC screen access the window process enforces
 * (screen-webrtc-sources.ts). Pairing is the approval: access is exactly
 * "this relay connection is a paired, E2EE-established client and still
 * connected", so every decision here is synchronous and reads nothing.
 *
 * Each message is bound to:
 * - its connection: an id minted per relay connection object, so a client id
 *   the relay reuses for a new connection never inherits the old one's access;
 * - a revision, monotonic within this publisher's epoch (one per service
 *   instance). The decisions are synchronous, but each message still crosses
 *   an asynchronous hop to the window; the window applies only a revision
 *   newer than the last it applied for that client, so a grant can never land
 *   after the deny that followed it, whatever the delivery order.
 *
 * A grant is sent before a client's screen `ready`, for the connection that
 * delivered it only; a deny is sent at once when the connection leaves the
 * relay registry (any path) or its credential is unpaired.
 *
 * Unpair: the record of it is the caller's (`unpaired`, in force until the
 * relay confirms the revoke or the device is paired again, across restarts).
 * While it is in force, every connection of that credential is refused at
 * authorization, and one entering the registry is revoked on admission. At
 * the unpair itself every live connection of it (whether or not it asked for
 * a screen) is revoked too. A revoked connection is refused for its lifetime.
 */
import { randomUUID } from 'node:crypto';

import type { RemoteScreenAccess } from './screen-webrtc-sources';

/** One relay connection: the same object for its lifetime, a new object for a
 *  new connection under a reused client id. */
export interface ScreenAccessClient {
  readonly credentialId: string;
  /** The E2EE channel; null until the handshake completes. */
  readonly channel: unknown;
}

export interface ScreenAccessPublisherDeps {
  client(clientId: string): ScreenAccessClient | undefined;
  /** Every connection in the relay registry. */
  clients(): Iterable<[string, ScreenAccessClient]>;
  /** An unpair of this credential is recorded and in force: the relay has
   *  not confirmed it, and the device was not paired again since. */
  unpaired(credentialId: string): boolean;
  /** What the on-PC indicator calls the device. */
  label(credentialId: string): string;
  /** To the window process; rejects when the window refuses (stale) or is gone. */
  send(clientId: string, access: RemoteScreenAccess): Promise<unknown>;
}

const ignore = (): void => undefined;

export function createScreenAccessPublisher(deps: ScreenAccessPublisherDeps) {
  const epoch = randomUUID();
  let revision = 0;
  /** The newest revision issued per client while it may hold access in the window. */
  const latest = new Map<string, number>();
  /** Clients the window may hold access for (pushed, not yet denied). */
  const known = new Set<string>();
  const connections = new WeakMap<ScreenAccessClient, string>();
  /** Connections refused for their lifetime: live at an unpair, or admitted
   *  while one was in force. */
  const revoked = new WeakSet<object>();

  /** The connection `origin` delivered the signal on is still the one under
   *  `clientId`, E2EE-established, not revoked, and its credential has no
   *  unpair in force. */
  const allowed = (clientId: string, origin: object): ScreenAccessClient | null => {
    const client = deps.client(clientId);
    return client === origin && client.channel && !revoked.has(client) && !deps.unpaired(client.credentialId)
      ? client
      : null;
  };

  const connectionOf = (client: ScreenAccessClient): string => {
    let id = connections.get(client);
    if (!id) {
      id = randomUUID();
      connections.set(client, id);
    }
    return id;
  };

  const issue = (clientId: string): number => {
    revision += 1;
    latest.set(clientId, revision);
    return revision;
  };

  /** No newer push or deny since `issued`, and `client` is still allowed. */
  const current = (clientId: string, issued: number, client: ScreenAccessClient): boolean =>
    latest.get(clientId) === issued && allowed(clientId, client) !== null;

  /** Sent before this returns. */
  function deny(clientId: string): Promise<void> {
    const issued = issue(clientId);
    latest.delete(clientId);
    known.delete(clientId);
    return deps.send(clientId, { epoch, revision: issued, connection: '', paired: false, label: '' }).then(ignore);
  }

  return {
    /** Authorization of a screen signal (or the display list) delivered on
     *  `origin`: synchronous, reads nothing. */
    allowed: (clientId: string, origin: object): boolean => allowed(clientId, origin) !== null,

    /**
     * Before the screen `ready` `origin` delivered: sends that connection's
     * access, issued synchronously. True when it was delivered and is still
     * current (no deny since, same connection, not unpaired), so the window
     * holds it; false, with nothing sent, when the id no longer names
     * `origin` or it is not allowed, and false when a deny followed while it
     * was delivered (the `ready` is then refused).
     */
    async publish(clientId: string, origin: object): Promise<boolean> {
      const client = allowed(clientId, origin);
      if (!client) return false;
      const issued = issue(clientId);
      known.add(clientId);
      await deps.send(clientId, {
        epoch,
        revision: issued,
        connection: connectionOf(client),
        paired: true,
        label: deps.label(client.credentialId),
      });
      return current(clientId, issued, client);
    },

    /** A connection entered the relay registry (synchronously, when it is
     *  admitted): one whose credential has an unpair in force is revoked for
     *  its lifetime, even if that unpair is confirmed or withdrawn later. */
    admitted(client: ScreenAccessClient): void {
      if (deps.unpaired(client.credentialId)) revoked.add(client);
    },

    /** The client's connection left the registry (any path). */
    removed(clientId: string): void {
      if (known.has(clientId)) void deny(clientId).catch(ignore);
    },

    /** The credential is being unpaired (its record already in force): each
     *  of its live connections is revoked for its lifetime and, if it may
     *  hold access, denied now, before this returns. */
    revokeCredential(credentialId: string): void {
      if (!credentialId) return;
      for (const [clientId, client] of [...deps.clients()]) {
        if (client.credentialId !== credentialId) continue;
        revoked.add(client);
        if (known.has(clientId)) void deny(clientId).catch(ignore);
      }
    },
  };
}

export type ScreenAccessPublisher = ReturnType<typeof createScreenAccessPublisher>;
