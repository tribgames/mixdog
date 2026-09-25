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
import { createRemoteStateLane } from './remote-state-lane';
import type { RemoteClientClaim } from './remote-relay';
import type { RelayClientCallOutcome } from './remote-relay-client-calls';
import type { RelayClientRegistry, RelayClientState } from './remote-relay-clients';

export interface RelayClientLifecycleDeps {
  clients: RelayClientRegistry;
  e2eeIdentity: RelayE2EEServerIdentity;
  pairing: RelayE2EEPairingMaterial;
  relayBinaryFrames(): boolean;
  viewSyncSupported(): boolean;
  relayRoutingCapsPayload(): Record<string, unknown>;
  sendEnvelope(payload: unknown): void;
  sendEncryptedFrame(
    clientId: string,
    payload: unknown,
    droppable?: boolean,
    onSent?: (bytes: number) => void,
    requireDelivery?: boolean
  ): Promise<void>;
  dispatchClientCall(
    clientId: string,
    client: RelayClientState,
    clearPayload: unknown,
    frameBytes: number
  ): Promise<RelayClientCallOutcome>;
  resyncClient(clientId: string, state: RelayClientState): void;
  onClientClaim?: (claim: RemoteClientClaim) => Promise<boolean>;
}

const HANDSHAKE_REQUIRED = 'relay encryption handshake required';

export interface RelayClientLifecycle {
  open(clientId: string): void;
  answerClaim(envelope: Record<string, unknown>): void;
  receive(clientId: string, client: RelayClientState, frame: string | ArrayBufferView): void;
}

export function createRelayClientLifecycle(deps: RelayClientLifecycleDeps): RelayClientLifecycle {
  const open = (clientId: string): void => {
    const challenge = {
      ...createRelayE2EEChallenge(),
      ...(deps.relayBinaryFrames() ? { binaryFrames: 1 as const } : {}),
      listDelta: 1 as const,
      ...(relayE2EECompressionSupported() ? { deflate: 1 as const } : {}),
      compactWire: 1 as const,
      transcriptPaging: 1 as const,
    };
    if (!deps.clients.open(clientId, challenge)) return;
    deps.sendEnvelope({
      type: 'frame',
      clientId,
      data: JSON.stringify(challenge),
    });
  };

  const answerClaim = (envelope: Record<string, unknown>): void => {
    const claimId = String(envelope.claimId || '');
    const publicKey = envelope.publicKey;
    if (!claimId || !isRelayClaimPublicKey(publicKey)) return;
    const clientId = String(envelope.clientId || claimId).slice(0, 80);
    const rawExpiresAt = Number(envelope.expiresAt);
    const expiresAt = Number.isFinite(rawExpiresAt) && rawExpiresAt > Date.now() ? rawExpiresAt : Date.now() + 300_000;
    void (async () => {
      let sealed: unknown = null;
      try {
        const approved = await deps.onClientClaim?.({
          claimId,
          clientId,
          name: String(envelope.name || 'Web app').slice(0, 80),
          platform: String(envelope.platform || '').slice(0, 80),
          browser: String(envelope.browser || '').slice(0, 80),
          expiresAt,
        });
        if (approved) sealed = await sealRelayE2EEPairingMaterial(deps.pairing, publicKey);
      } catch {
        sealed = null;
      }
      deps.sendEnvelope(sealed ? { type: 'claim-approve', claimId, sealed } : { type: 'claim-deny', claimId });
    })();
  };

  const completeHandshake = async (
    clientId: string,
    client: RelayClientState,
    frame: string | ArrayBufferView
  ): Promise<void> => {
    if (typeof frame !== 'string') {
      deps.clients.close(clientId, HANDSHAKE_REQUIRED);
      return;
    }
    let hello: unknown;
    try {
      hello = JSON.parse(frame);
    } catch {
      deps.clients.close(clientId, HANDSHAKE_REQUIRED);
      return;
    }
    if (!isRelayE2EEHello(hello)) {
      deps.clients.close(clientId, HANDSHAKE_REQUIRED);
      return;
    }
    try {
      client.channel = await acceptRelayE2EEClientHello(deps.e2eeIdentity, client.challenge, hello);
      client.binaryFrames = hello.binaryFrames === 1;
      client.listDelta = hello.listDelta === 1;
      client.compactWire = hello.compactWire === 1;
      client.transcriptPaging = hello.transcriptPaging === 1;
      client.viewSync = hello.viewSync === 1 && deps.viewSyncSupported();
      client.stateLane = createRemoteStateLane(client.compactWire, (payload, droppable) =>
        deps.clients.attached(clientId, client)
          ? deps.sendEncryptedFrame(clientId, payload, droppable, undefined, !droppable)
          : Promise.resolve()
      );
      clearTimeout(client.handshakeTimer);
      const uplink = deps.relayRoutingCapsPayload();
      await deps.sendEncryptedFrame(clientId, {
        type: 'e2ee-ready',
        version: 1,
        ...(client.viewSync ? { viewSync: 1 } : {}),
        ...uplink,
      });
      if (!client.viewSync) deps.resyncClient(clientId, client);
    } catch {
      deps.clients.close(clientId, 'relay encryption authentication failed');
    }
  };

  const receive = (clientId: string, client: RelayClientState, frame: string | ArrayBufferView): void => {
    const frameBytes = typeof frame === 'string' ? Buffer.byteLength(frame) : frame.byteLength;
    if (!deps.clients.admitFrame(clientId, client, frameBytes)) return;
    let execution: Promise<void> | undefined;
    const processFrame = async (): Promise<void> => {
      if (!deps.clients.attached(clientId, client)) return;
      if (!client.channel) {
        await completeHandshake(clientId, client, frame);
        return;
      }
      let clearPayload: unknown;
      try {
        clearPayload = await client.channel.decryptJson(frame);
      } catch {
        deps.clients.close(clientId, 'invalid encrypted relay frame');
        return;
      }
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
