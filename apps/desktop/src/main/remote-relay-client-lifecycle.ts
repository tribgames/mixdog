// Lifecycle of a browser leg after the relay announces it: challenge and
// authenticate clients, establish their transport state, then process frames
// in order without holding up independent remote calls.
import {
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  isRelayClaimPublicKey,
  isRelayE2EEHello,
  relayE2EECompressionSupported,
  sealRelayE2EEPairingMaterial,
  type RelayE2EEServerIdentity,
  type RelayE2EEPairingMaterial,
} from '../shared/remote-e2ee';
import { hostname } from 'node:os';
import { createRemoteStateLane } from './remote-state-lane';
import { MIXDOG_DESKTOP_CLIENT_BROWSER } from '../shared/remote-trust';
import { REMOTE_WEBRTC_VERSION } from '../shared/remote-webrtc';
import type { RemoteClientClaim, RemoteClaimDecision } from './remote-relay-claim';
import type { RelayClientCallOutcome } from './remote-relay-client-calls';
import type { RelayClientRegistry, RelayClientState, SendEncryptedFrame } from './remote-relay-clients';
import type { RelayEncryptedDelivery } from './remote-relay-delivery';
import { noteLegLive } from './remote-transport/foreground';

export interface RelayClientLifecycleDeps {
  clients: RelayClientRegistry;
  e2eeIdentity: RelayE2EEServerIdentity;
  pairing: RelayE2EEPairingMaterial;
  relayBinaryFrames(): boolean;
  viewSyncSupported(): boolean;
  /** The relay announced it holds APNs/FCM credentials for this connection. */
  nativePushSupported?(): boolean;
  relayRoutingCapsPayload(): Record<string, unknown>;
  sendEnvelope(payload: unknown): void;
  sendEncryptedFrame: SendEncryptedFrame;
  dispatchClientCall(
    clientId: string,
    client: RelayClientState,
    clearPayload: unknown,
    frameBytes: number
  ): Promise<RelayClientCallOutcome>;
  resyncClient(clientId: string, state: RelayClientState): void;
  /** Frames each connection gets right after `e2ee-ready` (current global marks). */
  joinFrames?(): unknown[];
  onClientClaim?: (claim: RemoteClientClaim) => Promise<RemoteClaimDecision>;
  /** A redelivery of a pending claim carried another key: the original is
   *  settled as denied, because the transcript conflicts. */
  onClaimConflict?: (claimId: string) => void;
  /** The approval for this claim's `clientId` is about to be sent: the
   *  device is paired again. */
  onClaimApproved?: (clientId: string) => void;
  /** This PC's name as phones see it; the OS hostname when omitted. */
  hostName?(): string;
  /** Starts a negotiated transport session (remote-relay-delivery.ts). The
   *  challenge offers `transportWebrtc` only when this is wired AND
   *  `transportOffer` says a peer host exists. */
  openTransport?: RelayEncryptedDelivery['openTransport'];
  /** Whether to offer the direct transport. Absent: never offered. */
  transportOffer?(): boolean;
  /** One diagnostics line per transport offer: offered / negotiated. */
  transportLog?(line: string): void;
}

export interface RelayClientLifecycle {
  /** `credentialId` is the paired client the relay authenticated for this
   *  leg; '' from a relay that does not name it. */
  open(clientId: string, credentialId?: string): void;
  answerClaim(envelope: Record<string, unknown>): void;
  receive(clientId: string, client: RelayClientState, frame: string | ArrayBufferView): void;
}

export function createRelayClientLifecycle(deps: RelayClientLifecycleDeps): RelayClientLifecycle {
  const open = (clientId: string, credentialId = ''): void => openRelayClient(deps, clientId, credentialId);
  const bindings = new Map<string, ClaimBinding>();
  const answerClaim = (envelope: Record<string, unknown>): void => answerRelayClaim(deps, bindings, envelope);

  const receive = (clientId: string, client: RelayClientState, frame: string | ArrayBufferView): void => {
    if (client.transport) {
      // Carrier messages of the stream: bounded by the receiver's own budget
      // and counted against the frame budget once they form a message.
      if (typeof frame === 'string') deps.clients.close(clientId, 'invalid transport relay frame');
      else client.transport.receive('relay', new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
      return;
    }
    const frameBytes = typeof frame === 'string' ? Buffer.byteLength(frame) : frame.byteLength;
    if (!deps.clients.admitFrame(clientId, client, frameBytes)) return;
    let execution: Promise<void> | undefined;
    const processFrame = async (): Promise<void> => {
      if (!deps.clients.attached(clientId, client)) return;
      if (!client.channel) {
        await completeHandshake(deps, clientId, client, frame);
        return;
      }
      let clearPayload: unknown;
      try {
        clearPayload = await client.channel.decryptJson(frame);
      } catch {
        deps.clients.close(clientId, 'invalid encrypted relay frame');
        return;
      }
      noteLegLive(client);
      execution = (await deps.dispatchClientCall(clientId, client, clearPayload, frameBytes)).execution;
    };
    client.frameQueue = client.frameQueue.then(processFrame, processFrame).catch(() => {
      if (deps.clients.attached(clientId, client)) deps.clients.close(clientId, 'remote frame processing failed');
    });
    void client.frameQueue
      .then(() => execution)
      .catch(() => {
        if (deps.clients.attached(clientId, client)) deps.clients.close(clientId, 'remote call processing failed');
      })
      .finally(() => deps.clients.releaseFrame(client, frameBytes));
  };

  return { open, answerClaim, receive };
}

function openRelayClient(deps: RelayClientLifecycleDeps, clientId: string, credentialId: string): void {
  const challenge = {
    ...createRelayE2EEChallenge(),
    ...(deps.relayBinaryFrames() ? { binaryFrames: 1 as const } : {}),
    listDelta: 1 as const,
    ...(relayE2EECompressionSupported() ? { deflate: 1 as const } : {}),
    compactWire: 1 as const,
    transcriptPaging: 1 as const,
    transcriptPrepend: 1 as const,
    remoteParity: 1 as const,
    browserParity: 1 as const,
    browserDrive: 1 as const,
    browserSessionTabs: 1 as const,
    termSizeOwner: 1 as const,
    hostDirectories: 1 as const,
    projectRecovery: 1 as const,
    mediaE2ee: 1 as const,
    routeAutoEffort: 1 as const,
    visualize: 1 as const,
    fileDownloads: 1 as const,
    browserWebrtc: REMOTE_WEBRTC_VERSION,
    browserFit: 1 as const,
    // Direct transport (docs/remote-transport.md §6): offered by default; it
    // needs binary frames and a wired stream. This member is also how a phone
    // learns it may opt in: it never opts in to a challenge that does not
    // carry it.
    ...(deps.relayBinaryFrames() && deps.openTransport && deps.transportOffer?.()
      ? { transportWebrtc: 1 as const }
      : {}),
    // Only when the relay can deliver: a renderer calls registerNativePush
    // on hosts that advertise it.
    ...(deps.nativePushSupported?.() ? { nativePush: 1 as const } : {}),
  };
  if (!deps.clients.open(clientId, challenge, credentialId)) return;
  deps.sendEnvelope({
    type: 'frame',
    clientId,
    data: JSON.stringify(challenge),
  });
}

/** What a claim was first delivered with. Approval material is sealed to that
 *  key only, once: a redelivery with the same key shares the decision and
 *  sends nothing more; one with another key means the transcript conflicts and
 *  the claim is denied. */
interface ClaimBinding {
  publicKey: string;
  clientId: string;
  expiresAt: number;
  conflicted: boolean;
}

function answerRelayClaim(
  deps: RelayClientLifecycleDeps,
  bindings: Map<string, ClaimBinding>,
  envelope: Record<string, unknown>
): void {
  const claimId = String(envelope.claimId || '');
  const publicKey = envelope.publicKey;
  if (!claimId || !isRelayClaimPublicKey(publicKey)) return;
  const clientId = String(envelope.clientId || claimId).slice(0, 80);
  for (const [id, binding] of bindings) if (binding.expiresAt <= Date.now()) bindings.delete(id);
  const bound = bindings.get(claimId);
  if (bound) {
    if (bound.publicKey !== publicKey || bound.clientId !== clientId) {
      bound.conflicted = true;
      deps.onClaimConflict?.(claimId);
      deps.sendEnvelope({ type: 'claim-deny', claimId });
    }
    return;
  }
  const rawExpiresAt = Number(envelope.expiresAt);
  const expiresAt = Number.isFinite(rawExpiresAt) && rawExpiresAt > Date.now() ? rawExpiresAt : Date.now() + 300_000;
  const binding: ClaimBinding = { publicKey, clientId, expiresAt, conflicted: false };
  bindings.set(claimId, binding);
  void (async () => {
    let sealed: unknown = null;
    try {
      const browser = String(envelope.browser || '').slice(0, 80);
      const decision = await deps.onClientClaim?.({
        claimId,
        clientId,
        name: String(envelope.name || 'Web app').slice(0, 80),
        platform: String(envelope.platform || '').slice(0, 80),
        browser,
        desktop: browser === MIXDOG_DESKTOP_CLIENT_BROWSER,
        method: envelope.method === 'code' || envelope.method === 'retry' ? envelope.method : 'qr',
        requestedAt: Date.now(),
        expiresAt,
      });
      if (decision?.approved && !binding.conflicted) {
        sealed = await sealRelayE2EEPairingMaterial(deps.pairing, publicKey);
      }
    } catch {
      sealed = null;
    }
    if (binding.conflicted) sealed = null;
    if (sealed) deps.onClaimApproved?.(clientId);
    deps.sendEnvelope(sealed ? { type: 'claim-approve', claimId, sealed } : { type: 'claim-deny', claimId });
  })();
}

async function completeHandshake(
  deps: RelayClientLifecycleDeps,
  clientId: string,
  client: RelayClientState,
  frame: string | ArrayBufferView
): Promise<void> {
  // Before this leg's handshake, anything but a hello is traffic the phone
  // sent on the PREVIOUS leg's channel (text or binary ciphertext still in
  // flight when this PC redialed). It is never opened or acted on, and it is
  // not a pairing failure either: it is dropped, the phone's hello for this
  // leg's challenge follows it, and the handshake timer bounds the wait.
  if (typeof frame !== 'string') return;
  let hello: unknown;
  try {
    hello = JSON.parse(frame);
  } catch {
    return;
  }
  if (!isRelayE2EEHello(hello)) return;
  // A hello for a challenge this leg never sent answers the PREVIOUS leg's
  // challenge: the phone joined while the PC redialed, and its hello for the
  // new challenge is on its way. That is a race, not a failed authentication,
  // and closing on it would read to the phone as a revoked pairing.
  if (hello.challenge !== client.challenge.challenge) return;
  try {
    client.channel = await acceptRelayE2EEClientHello(deps.e2eeIdentity, client.challenge, hello);
    client.binaryFrames = hello.binaryFrames === 1;
    client.listDelta = hello.listDelta === 1;
    client.compactWire = hello.compactWire === 1;
    client.transcriptPaging = hello.transcriptPaging === 1;
    client.transcriptPrepend = hello.transcriptPrepend === 1;
    // Announced by the browser itself (like viewSync): its decoder applies
    // head and runs patches to the prompt history. A build announcing only
    // 1 decodes head patches but not runs, so it keeps the whole field.
    client.promptHistoryPatch = (hello as typeof hello & { promptHistoryPatch?: unknown }).promptHistoryPatch === 2;
    client.viewSync = hello.viewSync === 1 && deps.viewSyncSupported();
    // A view-sync phone receives no live lane before its first view sync.
    // Anything published in between (a streaming state tick, a roster flip)
    // went out as a FULL baseline from a fresh encoder — the whole roster and
    // prompt history — and, having emitted, kept that lane from resuming in
    // the sync that followed: a busy desktop paid a full open per reconnect.
    client.syncing = client.viewSync;
    logAnnouncedFeatures(clientId, client);
    // Only a PC that offered has anything to report: offered, and whether this
    // phone took it (an older phone, or a phone build without the opt-in, does not).
    if (client.challenge.transportWebrtc === 1) {
      deps.transportLog?.(
        `[mixdog-remote-transport] session=${client.challenge.challenge.slice(0, 8)} offered=1 negotiated=${
          client.channel.transportEnabled ? 1 : 0
        }`
      );
    }
    client.stateLane = createRemoteStateLane(
      client.compactWire,
      (payload, droppable) =>
        deps.clients.attached(clientId, client)
          ? deps.sendEncryptedFrame(clientId, payload, droppable, undefined, !droppable)
          : Promise.resolve(),
      client.promptHistoryPatch
    );
    clearTimeout(client.handshakeTimer);
    noteLegLive(client);
    if (client.channel.transportEnabled) {
      if (!deps.openTransport) throw new Error('Remote transport is not wired.');
      // Opened before anything is sent, so `e2ee-ready` is its record 1.
      deps.openTransport(clientId, client, {
        deliver: (payload, bytes) => deliverTransportMessage(deps, clientId, client, payload, bytes),
        authenticated: () => noteLegLive(client),
      });
    }
    const uplink = deps.relayRoutingCapsPayload();
    await deps.sendEncryptedFrame(clientId, {
      type: 'e2ee-ready',
      version: 1,
      // The transcript confirmation of a server that offered transport: the
      // first application message, authenticated by the channel.
      ...client.channel.handshakeConfirmation(),
      ...(client.viewSync ? { viewSync: 1 } : {}),
      // Pairing approval is the trust: this host serves the provider, MCP
      // and developer lanes to every paired client.
      remoteOpenAccess: 1,
      // The PC's own name, for the phone's PC card (a label, not a credential).
      hostName: (deps.hostName?.() ?? hostname()).slice(0, 80),
      ...uplink,
    });
    for (const frame of deps.joinFrames?.() ?? []) await deps.sendEncryptedFrame(clientId, frame, false);
    if (!client.viewSync) deps.resyncClient(clientId, client);
  } catch {
    deps.clients.close(clientId, 'relay encryption authentication failed');
  }
}

/** One application message of a transport session, in stream order: counted
 *  against the client's frame budget until its call finished, as a relay
 *  frame is on the legacy path. */
async function deliverTransportMessage(
  deps: RelayClientLifecycleDeps,
  clientId: string,
  client: RelayClientState,
  payload: unknown,
  bytes: number
): Promise<void> {
  if (!deps.clients.attached(clientId, client)) return;
  if (!deps.clients.admitFrame(clientId, client, bytes)) return;
  let execution: Promise<void> | undefined;
  try {
    execution = (await deps.dispatchClientCall(clientId, client, payload, bytes)).execution;
  } catch {
    deps.clients.releaseFrame(client, bytes);
    if (deps.clients.attached(clientId, client)) deps.clients.close(clientId, 'remote frame processing failed');
    return;
  }
  void Promise.resolve(execution)
    .catch(() => {
      if (deps.clients.attached(clientId, client)) deps.clients.close(clientId, 'remote call processing failed');
    })
    .finally(() => deps.clients.releaseFrame(client, bytes));
}

/** Which wire features this phone build announced: the only way to tell a
 *  stale cached build from a feature that fails on the live path. */
function logAnnouncedFeatures(clientId: string, client: RelayClientState): void {
  console.info(
    `[mixdog-remote-hello] client=${clientId.slice(0, 8)} features=` +
      [
        ['binaryFrames', client.binaryFrames],
        ['listDelta', client.listDelta],
        ['compactWire', client.compactWire],
        ['transcriptPaging', client.transcriptPaging],
        ['transcriptPrepend', client.transcriptPrepend],
        ['promptHistoryPatch', client.promptHistoryPatch],
        ['viewSync', client.viewSync],
      ]
        .filter(([, on]) => on)
        .map(([name]) => name)
        .join(',')
  );
}
