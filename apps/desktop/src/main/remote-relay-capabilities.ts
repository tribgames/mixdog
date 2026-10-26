// What the relay told THIS desktop leg about itself, per connection: binary and
// text framing, its per-frame ceiling (declared, or proved smaller by a
// refusal), the uplink ceilings it published, and the native push platforms it
// can deliver to — and the one shape a browser is advertised from them.
import {
  RELAY_ROUTING_CAPS_EVENT,
  readRelayUplinkCeilings,
  relayUplinkCeilingFields,
  relayUplinkContract,
  resolveRelayFrameLimit,
  type RelayPayloadRejection,
  type RelayUplinkCeilings,
} from '../shared/remote-payload-limit';

export interface RelayConnectionCapsDeps {
  /** Phones attached right now; read at republish time. */
  clientCount(): number;
  /** Encrypted broadcast to every established channel. Resolved lazily, so it
   *  may name a sender created after this state. */
  broadcastEncrypted(payload: unknown, droppable: boolean): void;
  /** The relay can deliver native push again: bind the stored tokens. */
  rebindNativePush(): void;
}

export interface RelayConnectionCaps {
  relayBinaryFrames(): boolean;
  relayNativePlatforms(): readonly string[];
  /** The relay owns the Web Push sender identity (`webPush: 1`): browser push
   *  goes through it, never straight to the push service. */
  relayWebPush(): boolean;
  /** The relay can issue TURN credentials (`ice: 1`): ICE servers come from it. */
  relayIce(): boolean;
  resetRelayConnectionCaps(): void;
  relayFrameLimit(): number;
  relayUplinkLimits(): RelayUplinkCeilings;
  relayRoutingCapsPayload(uplink: RelayUplinkCeilings): Record<string, unknown>;
  republishRoutingCaps(): void;
  /** A `relay-capabilities` frame on the current connection. */
  handleRelayCapabilities(envelope: Record<string, unknown>): void;
  /** A `frame-too-large` notice proved the ceiling smaller than believed. */
  learnRefusedFrameLimit(rejection: Pick<RelayPayloadRejection, 'limit'>): void;
}

export function createRelayConnectionCaps(deps: RelayConnectionCapsDeps): RelayConnectionCaps {
  let relayBinaryFrames = false;
  // Echoed by the relay when it accepts this leg's `textFrames` request. Reset
  // per connection with the capabilities frame that sets it.
  let relayTextFrames = false;
  // Platforms the relay announced it can deliver to (APNs/FCM credentials are
  // its to hold). Empty — and `nativePush` unadvertised — on an older relay or
  // one without credentials. Per connection, like every learned relay cap.
  let relayNativePlatforms: readonly string[] = [];
  // Relay-owned Web Push. False on an older relay, which leaves this desktop
  // on its legacy direct send. Per connection, like every learned relay cap.
  let relayWebPush = false;
  // The relay issues TURN credentials (a self-operated coturn is provisioned
  // beside it). False on an older relay or one without coturn.
  let relayIce = false;
  // The relay's per-frame ceiling as this desktop knows it. `relay-capabilities`
  // declares it at handshake; a `frame-too-large` notice proves a smaller one.
  // The effective limit is the smallest known value, so this leg's own check is
  // never more permissive than the relay's.
  let declaredFrameLimit: number | null = null;
  let noticedFrameLimit: number | null = null;
  const relayFrameLimit = (): number => resolveRelayFrameLimit(declaredFrameLimit, noticedFrameLimit);
  /** The ceilings the relay PUBLISHED for this connection: the effective
   *  capacity of this leg and the largest frame each wire form may carry to it
   *  (server.mjs `relayCapabilities`). They are the relay's to know — it clamps
   *  what this leg declared, discounts a receiver it has seen refuse, and wraps
   *  a phone frame in a route id only it can see — so they are consumed, never
   *  recomputed. null while no capabilities frame has carried them, and null
   *  again on a relay that publishes none: per connection, like every other
   *  learned cap. */
  let relayPublishedCeilings: RelayUplinkCeilings | null = null;
  /** The last caps every attached phone has been told, so a republication that
   *  changes nothing costs no frames. Connection-scoped like the caps
   *  themselves. */
  let advertisedRoutingCaps = '';
  /** Every cap here describes ONE connection. A relay leg that omits its
   *  capabilities frame — or sends it after a phone has already been announced
   *  — must find this leg holding NOTHING, not the previous connection's
   *  ceilings: a stale 4400-byte capacity applied to a new 64 MiB relay
   *  strands traffic, and a stale 64 MiB one applied to a new 4400-byte relay
   *  promises a browser room that does not exist. Called on every open, so the
   *  only thing that can populate these is a `relay-capabilities` frame on the
   *  connection they belong to. */
  const resetRelayConnectionCaps = (): void => {
    relayBinaryFrames = false;
    relayTextFrames = false;
    relayPublishedCeilings = null;
    declaredFrameLimit = null;
    noticedFrameLimit = null;
    advertisedRoutingCaps = '';
    relayNativePlatforms = [];
    relayWebPush = false;
    relayIce = false;
  };
  /** What a phone may put on the wire for this connection, as advertised to
   *  the browser: the relay's published ceilings, bounded by any smaller
   *  policy ceiling a refusal notice has proved since. */
  const relayUplinkLimits = (): RelayUplinkCeilings =>
    relayUplinkContract(relayPublishedCeilings, { policy: relayFrameLimit(), textFrames: relayTextFrames });
  /** Everything a browser needs to admit exactly what this relay admits, in
   *  ONE shape — handed over in the handshake, and re-issued unchanged
   *  whenever the relay republishes different numbers, so both frames can
   *  never drift apart:
   *    maxFrameBytes  — the relay's policy ceiling, applied to the phone's OWN
   *                     frame exactly as it is sent;
   *    maxRoutedBytes — the relay's capacity for this leg. Legacy field, for a
   *                     browser that predates the published ceilings and
   *                     derives its own; never this desktop's transport
   *                     constant, which belongs to no relay and is larger than
   *                     every ceiling on this path;
   *    uplink*        — the ceilings the relay published, forwarded verbatim;
   *    textFrames     — only when the relay ECHOED the text envelope for this
   *                     connection, so a text frame rides the fixed-size
   *                     wrapper instead of being JSON-escaped. Without the
   *                     echo the browser keeps JSON pricing. */
  const relayRoutingCapsPayload = (uplink: RelayUplinkCeilings): Record<string, unknown> => ({
    maxFrameBytes: relayFrameLimit(),
    maxRoutedBytes: uplink.capacity,
    ...relayUplinkCeilingFields(uplink),
    ...(relayTextFrames ? { textFrames: 1 as const } : {}),
  });
  /** The relay republishes `relay-capabilities` whenever this leg's numbers
   *  change. A phone that is ALREADY attached was told its ceilings once, in
   *  its handshake: without this it goes on sending at the old ones, and the
   *  first frame past the new ceiling is refused AT THE RELAY, where nothing
   *  can say which call it belonged to — that call waits out its deadline and
   *  closes the socket, and a fire-and-forget publish disappears with no error
   *  at all. Re-issued to every established channel, and only when the numbers
   *  really changed. */
  const republishRoutingCaps = (): void => {
    const payload = relayRoutingCapsPayload(relayUplinkLimits());
    const signature = JSON.stringify(payload);
    if (signature === advertisedRoutingCaps) return;
    advertisedRoutingCaps = signature;
    if (deps.clientCount() === 0) return;
    // Never droppable: losing this frame IS the failure it exists to prevent.
    deps.broadcastEncrypted({ event: RELAY_ROUTING_CAPS_EVENT, payload }, false);
  };
  const handleRelayCapabilities = (envelope: Record<string, unknown>): void => {
    relayBinaryFrames = envelope.binaryFrames === 1;
    // ACKNOWLEDGEMENT, not inference: `desktop-lanes.textFrames` is only
    // a request, and a binary-capable relay that predates the flag still
    // JSON-wraps text. Pricing text as fixed without this echo promises a
    // browser room the relay does not have.
    relayTextFrames = envelope.textFrames === 1;
    // The relay declares its per-frame ceiling here (server.mjs
    // runDesktopLeg). Learning it is what lets this leg refuse an
    // oversize frame itself instead of discovering it after the fact.
    if (typeof envelope.maxFrameBytes === 'number') {
      declaredFrameLimit = resolveRelayFrameLimit(envelope.maxFrameBytes);
    }
    // …and the authoritative ceilings that go with it, for THIS
    // connection: the relay clamped its own capacity for this leg and
    // priced the routing envelope with the id it actually wraps a phone
    // frame in. Consuming them is what makes the browser refuse exactly
    // what the relay refuses; a relay that publishes none reads as null
    // and the conservative fallback stands in.
    relayPublishedCeilings = readRelayUplinkCeilings(envelope);
    // The relay can deliver native push only when it holds credentials.
    relayNativePlatforms =
      envelope.nativePush === 1 && Array.isArray(envelope.nativePushPlatforms)
        ? envelope.nativePushPlatforms.filter((name): name is 'apns' | 'fcm' => name === 'apns' || name === 'fcm')
        : [];
    if (relayNativePlatforms.length > 0) deps.rebindNativePush();
    relayWebPush = envelope.webPush === 1;
    relayIce = envelope.ice === 1;
    // The relay republishes on change; a phone already attached is held
    // to whatever it was told in its handshake until this reaches it.
    republishRoutingCaps();
  };
  /** A frame slipped past the pre-send check, so the ceiling this leg
   *  believed in was too generous: tighten it permanently (for this
   *  connection). */
  const learnRefusedFrameLimit = (rejection: Pick<RelayPayloadRejection, 'limit'>): void => {
    if (rejection.limit !== null) {
      noticedFrameLimit = resolveRelayFrameLimit(rejection.limit, noticedFrameLimit);
    }
  };
  return {
    relayBinaryFrames: () => relayBinaryFrames,
    relayNativePlatforms: () => relayNativePlatforms,
    relayWebPush: () => relayWebPush,
    relayIce: () => relayIce,
    resetRelayConnectionCaps,
    relayFrameLimit,
    relayUplinkLimits,
    relayRoutingCapsPayload,
    republishRoutingCaps,
    handleRelayCapabilities,
    learnRefusedFrameLimit,
  };
}
