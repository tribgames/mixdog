// Relay client (stage 2 of the mobile companion): the desktop dials OUT to
// the relay server (apps/relay/server.mjs) and answers the same RPC frames
// the LAN bridge answers, so a phone anywhere on the internet reaches this
// machine without port forwarding. The phone-leg wire protocol is identical
// to remote-bridge.ts; the relay only adds a client-multiplexing envelope on
// this desktop leg.
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, statSync, type ReadStream } from 'node:fs';
import { join } from 'node:path';

import WebSocket from 'ws';

import { mediaResponsePlan } from '../../../relay/lib/media-http.mjs';
import { loadOrCreateToken } from './remote-bridge';
import {
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  isRelayE2EEHello,
  relayE2EEPairingMaterial,
  type RelayE2EEChannel,
  type RelayE2EEChallenge,
  type RelayE2EEPairingMaterial,
} from '../shared/remote-e2ee';
import { resolveMediaFileTarget } from './media-source';
import {
  createRemoteMethods,
  executeRemoteFrame,
  type RemoteMethodDependencies,
} from './remote-methods';
import { loadOrCreateRelayE2EEIdentity } from './remote-e2ee';
import { readSecretFile, writeSecretFile } from './secret-file';
import { createSnapshotDeltaEncoder, isStateResyncFrame } from './state-delta';

const MAX_WS_PAYLOAD_BYTES = 64 * 1024 * 1024;
const REVOKE_TIMEOUT_MS = 5_000;
const E2EE_HANDSHAKE_TIMEOUT_MS = 10_000;
// Media chunk size and the socket backlog that pauses the read. Bigger frames
// waste memory on the relay, smaller ones waste round trips; 256 KB keeps a
// clip flowing while a phone that stalls stops the pump within a few frames.
const MEDIA_CHUNK_BYTES = 256 * 1024;
const MEDIA_SOCKET_BACKLOG_BYTES = 4 * 1024 * 1024;

/** Packaged default: every install dials this relay so phone pairing works
 *  out of the box, with no VPS/env setup on the user side.
 *  MIXDOG_RELAY_URL=<wss url> overrides; 0/false/off disables. */
const DEFAULT_RELAY_URL = 'wss://192-255-139-161.sslip.io';

export function resolveRelayUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.MIXDOG_RELAY_URL || '').trim();
  const flag = raw.toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return null;
  return raw || DEFAULT_RELAY_URL;
}

export interface RemoteRelayOptions extends RemoteMethodDependencies {
  /** ws(s)://relay-host[:port] */
  relayUrl: string;
  userDataPath: string;
  subscribeTerminalData?: (listener: (event: { id: string; data: string }) => void) => () => void;
  onClientCountChanged?: () => void;
}

export interface RemoteRelayHandle {
  /** URL a phone opens (relay origin + pairing token). */
  clientUrl: string;
  token: string;
  pairing: RelayE2EEPairingMaterial;
  readonly clientCount: number;
  /** System resume: the socket is likely half-dead after sleep — drop it and
   *  redial immediately instead of waiting for the ping cycle to notice. */
  resume(): void;
  /** Delete this install's authenticated registration from the relay. */
  revoke(): Promise<void>;
  close(): Promise<void>;
}

interface DeviceIdentity {
  deviceId: string;
  deviceSecret: string;
}

const DEVICE_IDENTITY_FILE = 'relay-device.json';
const DEVICE_REVOCATIONS_FILE = 'relay-device-revocations.json';
let deviceFileMutation: Promise<void> = Promise.resolve();

function validDeviceIdentity(value: unknown): value is DeviceIdentity {
  const identity = value as Partial<DeviceIdentity> | null;
  return typeof identity?.deviceId === 'string' && /^[0-9a-f-]{8,64}$/.test(identity.deviceId)
    && typeof identity.deviceSecret === 'string' && identity.deviceSecret.length >= 16;
}

async function writeDeviceIdentity(path: string): Promise<DeviceIdentity> {
  const identity = { deviceId: randomUUID(), deviceSecret: randomBytes(24).toString('hex') };
  await writeSecretFile(path, JSON.stringify(identity, null, 2));
  return identity;
}

async function loadQueuedRevocations(userDataPath: string): Promise<DeviceIdentity[]> {
  try {
    const parsed = JSON.parse(
      await readSecretFile(join(userDataPath, DEVICE_REVOCATIONS_FILE)) ?? '[]',
    ) as unknown;
    return Array.isArray(parsed) ? parsed.filter(validDeviceIdentity) : [];
  } catch {
    return [];
  }
}

async function writeQueuedRevocations(
  userDataPath: string,
  identities: DeviceIdentity[],
): Promise<void> {
  await writeSecretFile(
    join(userDataPath, DEVICE_REVOCATIONS_FILE),
    JSON.stringify(identities, null, 2),
  );
}

function mutateDeviceFiles<T>(operation: () => Promise<T>): Promise<T> {
  const result = deviceFileMutation.then(operation, operation);
  deviceFileMutation = result.then(() => undefined, () => undefined);
  return result;
}

// Stable per-install identity for the relay's trust-on-first-use device
// registration; the secret never leaves this machine except toward the relay.
// It authenticates this desktop's leg, so it lives in an owner-only file.
async function loadOrCreateDevice(userDataPath: string): Promise<DeviceIdentity> {
  const path = join(userDataPath, DEVICE_IDENTITY_FILE);
  try {
    const parsed = JSON.parse(await readSecretFile(path) ?? 'null') as unknown;
    if (validDeviceIdentity(parsed)) {
      return { deviceId: parsed.deviceId, deviceSecret: parsed.deviceSecret };
    }
  } catch { /* first run */ }
  return writeDeviceIdentity(path);
}

/** Queue the current identity for authenticated server-side deletion, then
 * replace it immediately so Unpair can refresh QRs even while the VPS is down. */
export async function rotateRemoteDevice(userDataPath: string): Promise<DeviceIdentity> {
  return mutateDeviceFiles(async () => {
    const previous = await loadOrCreateDevice(userDataPath);
    const queued = await loadQueuedRevocations(userDataPath);
    if (!queued.some((identity) => identity.deviceId === previous.deviceId)) {
      await writeQueuedRevocations(userDataPath, [...queued, previous]);
    }
    return writeDeviceIdentity(join(userDataPath, DEVICE_IDENTITY_FILE));
  });
}

async function removeQueuedRevocation(userDataPath: string, deviceId: string): Promise<void> {
  await mutateDeviceFiles(async () => {
    const queued = await loadQueuedRevocations(userDataPath);
    await writeQueuedRevocations(
      userDataPath,
      queued.filter((identity) => identity.deviceId !== deviceId),
    );
  });
}

function revokeIdentity(
  relayUrl: string,
  identity: DeviceIdentity,
  sockets: Set<WebSocket>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const target = new URL(relayUrl);
    target.pathname = '/desktop';
    target.search = `device=${encodeURIComponent(identity.deviceId)}&secret=${encodeURIComponent(identity.deviceSecret)}`;
    const ws = new WebSocket(target.toString(), {
      maxPayload: MAX_WS_PAYLOAD_BYTES,
      perMessageDeflate: true,
    });
    sockets.add(ws);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      sockets.delete(ws);
      try { ws.terminate(); } catch { /* already gone */ }
      resolve(ok);
    };
    const timeout = setTimeout(() => finish(false), REVOKE_TIMEOUT_MS);
    timeout.unref?.();
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'revoke-device' }), (error) => {
        if (error) finish(false);
      });
    });
    ws.on('message', (raw) => {
      let message: { type?: unknown; ok?: unknown };
      try {
        message = JSON.parse(String(raw)) as { type?: unknown; ok?: unknown };
      } catch {
        return;
      }
      if (message.type === 'device-revoked') finish(message.ok !== false);
    });
    ws.once('error', () => finish(false));
    ws.once('close', () => finish(false));
  });
}

function relayClientUrl(relayUrl: string, token: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/';
  url.search = `token=${encodeURIComponent(token)}`;
  url.hash = '';
  return url.toString();
}

export async function startRemoteRelay(options: RemoteRelayOptions): Promise<RemoteRelayHandle> {
  const token = await loadOrCreateToken(options.userDataPath);
  const { deviceId, deviceSecret } = await loadOrCreateDevice(options.userDataPath);
  const e2eeIdentity = await loadOrCreateRelayE2EEIdentity(options.userDataPath);
  const pairing = relayE2EEPairingMaterial(e2eeIdentity);
  const methods = createRemoteMethods(options);
  let socket: WebSocket | null = null;
  let closed = false;
  let retryMs = 1_000;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let drainingRevocations = false;
  const revocationSockets = new Set<WebSocket>();
  // The relay fans one broadcast lane out to every phone, so ONE shared
  // encoder tracks the delta stream; any client join or resync request
  // resets it, which downgrades the next push to a full snapshot for all.
  const deltaEncoder = createSnapshotDeltaEncoder();
  // Phones currently attached through the relay (client-open/-close
  // envelopes). With zero phones the relay would drop every broadcast on
  // the floor anyway, so the desktop goes quiet instead of streaming state
  // upstream 24/7 — the relay lane then costs keepalive bytes only. Each
  // join restarts the delta lane with a full snapshot, so nothing is lost.
  interface RelayClientState {
    challenge: RelayE2EEChallenge;
    channel: RelayE2EEChannel | null;
    handshakeTimer: NodeJS.Timeout;
  }
  const activeClients = new Map<string, RelayClientState>();
  const notifyClientCount = (): void => options.onClientCountChanged?.();
  // Media streams currently pumping to the relay, keyed by request id: an
  // aborted phone request (scrolled away, closed tab) must stop the read.
  // Two independent stalls can pause a pump — this socket's backlog, and the
  // relay's flow control for a phone that stopped draining (the local
  // backlog never sees that one, because the relay reads eagerly) — so the
  // read only resumes once BOTH are clear.
  interface MediaPump { stream: ReadStream; relayPaused: boolean; socketFull: boolean }
  const mediaStreams = new Map<string, MediaPump>();
  const resumeMedia = (id: string): void => {
    const pump = mediaStreams.get(id);
    if (!pump || pump.relayPaused || pump.socketFull) return;
    pump.stream.resume();
  };

  const sendEnvelope = (payload: unknown): void => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify(payload)); } catch { /* relay vanished */ }
    }
  };
  const removeClient = (clientId: string): boolean => {
    const state = activeClients.get(clientId);
    if (!state) return false;
    clearTimeout(state.handshakeTimer);
    activeClients.delete(clientId);
    return true;
  };
  const closeClient = (clientId: string, reason: string): void => {
    if (removeClient(clientId)) notifyClientCount();
    sendEnvelope({ type: 'close-client', clientId, reason });
  };
  const sendEncryptedFrame = async (
    clientId: string,
    payload: unknown,
    droppable = false,
  ): Promise<void> => {
    const state = activeClients.get(clientId);
    if (!state?.channel) return;
    try {
      const data = await state.channel.encryptJson(payload);
      sendEnvelope({ type: 'frame', clientId, data, ...(droppable ? { droppable: true } : {}) });
    } catch {
      closeClient(clientId, 'relay encryption failed');
    }
  };
  const broadcastEncrypted = (payload: unknown, droppable: boolean): void => {
    for (const [clientId, state] of activeClients) {
      if (state.channel) void sendEncryptedFrame(clientId, payload, droppable);
    }
  };
  // `critical` marks a FULL snapshot (join / resync answer). The relay drops
  // ordinary pushes for a congested phone; dropping the recovery frame itself
  // would leave that phone stranded on a transcript missing the answer.
  const broadcastState = (snapshot: unknown, critical = false): void => {
    if (activeClients.size === 0) return;
    broadcastEncrypted(
      { event: 'state', payload: deltaEncoder.encode(snapshot) },
      !critical,
    );
  };
  const drainQueuedRevocations = async (): Promise<void> => {
    if (closed || drainingRevocations) return;
    drainingRevocations = true;
    try {
      const queued = await loadQueuedRevocations(options.userDataPath);
      for (const identity of queued) {
        if (closed) break;
        // A failed identity-file rotation may leave the current identity in the
        // queue. Never let cleanup revoke the live registration in that case.
        if (identity.deviceId === deviceId) continue;
        const removed = await revokeIdentity(options.relayUrl, identity, revocationSockets);
        if (removed) await removeQueuedRevocation(options.userDataPath, identity.deviceId);
      }
    } finally {
      drainingRevocations = false;
    }
  };

  // Media byte lane: the relay proxies a phone's HTTP request here and this
  // leg answers with a plan (status + headers) followed by raw chunks. Media
  // never becomes an RPC payload again, so a clip cannot stall the UI socket
  // and the phone keeps browser caching and Range seeking.
  const serveRelayMedia = async (media: {
    id: string;
    assetId: string;
    variant: string;
    method: string;
    range: string;
    ifNoneMatch: string;
  }): Promise<void> => {
    const { id } = media;
    const fail = (status: number): void => {
      sendEnvelope({ type: 'media-head', id, status, headers: {} });
      sendEnvelope({ type: 'media-end', id });
    };
    let target: { path: string; mime: string } | null;
    try {
      target = await resolveMediaFileTarget(options.host, media.assetId, media.variant);
    } catch {
      fail(500);
      return;
    }
    if (!target) {
      fail(404);
      return;
    }
    let size: number;
    try {
      size = statSync(target.path).size;
    } catch {
      fail(404);
      return;
    }
    const plan = mediaResponsePlan({
      size,
      mime: target.mime,
      assetId: media.assetId,
      variant: media.variant,
      rangeHeader: media.range,
      ifNoneMatch: media.ifNoneMatch,
    });
    sendEnvelope({ type: 'media-head', id, status: plan.status, headers: plan.headers });
    if (plan.status >= 300 || media.method === 'HEAD') {
      sendEnvelope({ type: 'media-end', id });
      return;
    }
    const stream = createReadStream(target.path, {
      start: plan.start,
      end: plan.end,
      highWaterMark: MEDIA_CHUNK_BYTES,
    });
    const pump: MediaPump = { stream, relayPaused: false, socketFull: false };
    mediaStreams.set(id, pump);
    stream.on('data', (chunk) => {
      sendEnvelope({ type: 'media-chunk', id, data: (chunk as Buffer).toString('base64') });
      // Backpressure: without it a phone on a slow link buffers the whole clip
      // in this process and again in the relay.
      if ((socket?.bufferedAmount ?? 0) <= MEDIA_SOCKET_BACKLOG_BYTES) return;
      pump.socketFull = true;
      stream.pause();
      const resume = setInterval(() => {
        if (!mediaStreams.has(id)) {
          clearInterval(resume);
          return;
        }
        if ((socket?.bufferedAmount ?? 0) > MEDIA_SOCKET_BACKLOG_BYTES) return;
        clearInterval(resume);
        pump.socketFull = false;
        resumeMedia(id);
      }, 50);
      resume.unref?.();
    });
    stream.on('error', () => {
      mediaStreams.delete(id);
      sendEnvelope({ type: 'media-error', id });
    });
    stream.on('end', () => {
      mediaStreams.delete(id);
      sendEnvelope({ type: 'media-end', id });
    });
  };
  // Retained for a future encrypted byte lane. The active relay protocol
  // rejects media requests before this plaintext implementation can run.
  void serveRelayMedia;

  const connect = (): void => {
    if (closed) return;
    const target = new URL(options.relayUrl);
    target.pathname = '/desktop';
    target.search = `device=${encodeURIComponent(deviceId)}&secret=${encodeURIComponent(deviceSecret)}`;
    const ws = new WebSocket(target.toString(), {
      maxPayload: MAX_WS_PAYLOAD_BYTES,
      perMessageDeflate: true,
    });
    socket = ws;
    // Idle NAT paths silently kill this leg; protocol pings keep it warm and
    // detect a half-dead socket so the reconnect loop restores it long
    // before a phone RPC would hang on it.
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        try { ws.terminate(); } catch { /* close handler reconnects */ }
        return;
      }
      alive = false;
      try { ws.ping(); } catch { /* close handler reconnects */ }
    }, 25_000);
    heartbeat.unref?.();
    ws.on('open', () => {
      retryMs = 1_000;
      deltaEncoder.reset();
      // A fresh desktop leg supersedes the old one and the relay closed its
      // phone legs; phones re-open and re-announce themselves.
      if (activeClients.size > 0) {
        for (const state of activeClients.values()) clearTimeout(state.handshakeTimer);
        activeClients.clear();
        notifyClientCount();
      }
      // Announce the lanes this build serves BEFORE the pairing token, so the
      // relay can answer a phone's media request the moment a client leg
      // binds. An older relay ignores the frame; a newer one stops proxying
      // media to desktops that would never answer.
      // HTTP media is disabled until its byte protocol is encrypted. Remote
      // galleries fall back to the encrypted RPC payload.
      sendEnvelope({ type: 'desktop-lanes', media: false, e2ee: 1 });
      // Register the phone pairing token before any client leg can bind.
      sendEnvelope({ type: 'set-client-token', token });
      // Unpair is local-first so it also works offline. Once any new relay leg
      // opens, dispose the owner-authenticated registrations queued while down.
      void drainQueuedRevocations();
    });
    ws.on('message', (raw) => {
      alive = true;
      void (async () => {
        let envelope: { type?: unknown; clientId?: unknown; data?: unknown };
        try {
          envelope = JSON.parse(String(raw)) as { type?: unknown; clientId?: unknown; data?: unknown };
        } catch {
          return;
        }
        if (envelope.type === 'client-open') {
          if (typeof envelope.clientId === 'string') {
            removeClient(envelope.clientId);
            const challenge = createRelayE2EEChallenge();
            const handshakeTimer = setTimeout(() => {
              closeClient(envelope.clientId as string, 'relay encryption handshake timed out');
            }, E2EE_HANDSHAKE_TIMEOUT_MS);
            handshakeTimer.unref?.();
            activeClients.set(envelope.clientId, {
              challenge,
              channel: null,
              handshakeTimer,
            });
            notifyClientCount();
            sendEnvelope({
              type: 'frame',
              clientId: envelope.clientId,
              data: JSON.stringify(challenge),
            });
          }
          return;
        }
        if (envelope.type === 'client-close') {
          if (typeof envelope.clientId === 'string' && removeClient(envelope.clientId)) {
            notifyClientCount();
          }
          return;
        }
        // Relay flow control for the phone leg: its HTTP response filled up,
        // so stop reading until it drains. An older relay never sends these.
        if (typeof envelope.type === 'string' && envelope.type.startsWith('media-')) {
          const id = String((envelope as Record<string, unknown>).id ?? '');
          if (id) sendEnvelope({ type: 'media-error', id });
          return;
        }
        if (envelope.type !== 'frame' || typeof envelope.clientId !== 'string') return;
        const client = activeClients.get(envelope.clientId);
        if (!client) return;
        const frame = String(envelope.data ?? '');
        if (!client.channel) {
          let hello: unknown;
          try { hello = JSON.parse(frame); } catch {
            closeClient(envelope.clientId, 'relay encryption handshake required');
            return;
          }
          if (!isRelayE2EEHello(hello)) {
            closeClient(envelope.clientId, 'relay encryption handshake required');
            return;
          }
          try {
            client.channel = await acceptRelayE2EEClientHello(
              e2eeIdentity,
              client.challenge,
              hello,
            );
            clearTimeout(client.handshakeTimer);
            await sendEncryptedFrame(
              envelope.clientId,
              { type: 'e2ee-ready', version: 1 },
            );
            deltaEncoder.reset();
            broadcastState(options.host.getSnapshot(), true);
          } catch {
            closeClient(envelope.clientId, 'relay encryption authentication failed');
          }
          return;
        }
        let clearFrame: string;
        try {
          clearFrame = JSON.stringify(await client.channel.decryptJson(frame));
        } catch {
          closeClient(envelope.clientId, 'invalid encrypted relay frame');
          return;
        }
        if (isStateResyncFrame(clearFrame)) {
          deltaEncoder.reset();
          broadcastState(options.host.getSnapshot(), true);
          return;
        }
        const response = await executeRemoteFrame(methods, clearFrame);
        if (response !== undefined) {
          await sendEncryptedFrame(envelope.clientId, response);
        }
      })();
    });
    ws.on('error', () => { /* connection errors surface as close */ });
    ws.on('close', () => {
      clearInterval(heartbeat);
      if (activeClients.size > 0) {
        for (const state of activeClients.values()) clearTimeout(state.handshakeTimer);
        activeClients.clear();
        notifyClientCount();
      }
      // The relay dropped every waiting response with this leg; stop pumping.
      for (const pump of mediaStreams.values()) {
        try { pump.stream.destroy(); } catch { /* already gone */ }
      }
      mediaStreams.clear();
      if (socket === ws) socket = null;
      if (closed) return;
      reconnectTimer = setTimeout(connect, retryMs);
      reconnectTimer.unref?.();
      retryMs = Math.min(30_000, retryMs * 2);
    });
  };
  connect();

  // Engine pushes stay droppable: the subscriber must not forward its own
  // extra arguments as the `critical` flag.
  const unsubscribeState = options.host.subscribe((snapshot) => broadcastState(snapshot));
  const unsubscribeSessionStates = options.host.subscribeSessionStates((update) => {
    if (activeClients.size === 0) return;
    broadcastEncrypted({ event: 'sessionState', payload: update }, true);
  });
  const unsubscribeTerminals = options.subscribeTerminalData?.((event) => {
    if (activeClients.size === 0) return;
    broadcastEncrypted({ event: 'termData', payload: event }, true);
  }) ?? (() => {});

  return {
    clientUrl: relayClientUrl(options.relayUrl, token),
    token,
    pairing,
    get clientCount() { return activeClients.size; },
    resume: (): void => {
      if (closed) return;
      retryMs = 1_000;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        connect();
        return;
      }
      if (socket) {
        // The close handler reconnects with the freshly reset backoff.
        try { socket.terminate(); } catch { /* already gone */ }
        return;
      }
      connect();
    },
    revoke: (): Promise<void> => new Promise((resolve, reject) => {
      let retryTimer: NodeJS.Timeout | null = null;
      let target: WebSocket | null = null;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        if (retryTimer) clearTimeout(retryTimer);
        target?.off('message', onMessage);
        target?.off('close', onClose);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onMessage = (raw: WebSocket.RawData) => {
        let message: { type?: unknown; ok?: unknown };
        try {
          message = JSON.parse(String(raw)) as { type?: unknown; ok?: unknown };
        } catch {
          return;
        }
        if (message.type !== 'device-revoked') return;
        if (message.ok === false) {
          fail(new Error('Relay registration was not found.'));
          return;
        }
        succeed();
      };
      const onClose = () => fail(new Error('Relay disconnected before confirming revocation.'));
      const send = () => {
        if (closed) {
          fail(new Error('Relay client is closed.'));
          return;
        }
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          retryTimer = setTimeout(send, 50);
          retryTimer.unref?.();
          return;
        }
        target = socket;
        target.on('message', onMessage);
        target.once('close', onClose);
        target.send(JSON.stringify({ type: 'revoke-device' }), (error) => {
          if (error) fail(error);
        });
      };
      const timeout = setTimeout(() => {
        fail(new Error('Timed out waiting for relay revocation.'));
      }, REVOKE_TIMEOUT_MS);
      timeout.unref?.();
      send();
    }),
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      unsubscribeState();
    unsubscribeSessionStates();
      unsubscribeTerminals();
      for (const pending of revocationSockets) {
        try { pending.terminate(); } catch { /* already gone */ }
      }
      revocationSockets.clear();
      if (socket) {
        try { socket.terminate(); } catch { /* already gone */ }
        socket = null;
      }
      if (activeClients.size > 0) {
        for (const state of activeClients.values()) clearTimeout(state.handshakeTimer);
        activeClients.clear();
        notifyClientCount();
      }
    },
  };
}
