// Relay client (stage 2 of the mobile companion): the desktop dials OUT to
// the relay server (apps/relay/server.mjs) and answers the same RPC frames
// the LAN bridge answers, so a phone anywhere on the internet reaches this
// machine without port forwarding. The phone-leg wire protocol is identical
// to remote-bridge.ts; the relay only adds a client-multiplexing envelope on
// this desktop leg.
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import WebSocket from 'ws';

import { loadOrCreateToken } from './remote-bridge';
import {
  createRemoteMethods,
  executeRemoteFrame,
  type RemoteMethodDependencies,
} from './remote-methods';

const MAX_WS_PAYLOAD_BYTES = 64 * 1024 * 1024;

export interface RemoteRelayOptions extends RemoteMethodDependencies {
  /** ws(s)://relay-host[:port] */
  relayUrl: string;
  userDataPath: string;
  subscribeTerminalData?: (listener: (event: { id: string; data: string }) => void) => () => void;
}

export interface RemoteRelayHandle {
  /** URL a phone opens (relay origin + pairing token). */
  clientUrl: string;
  token: string;
  close(): Promise<void>;
}

interface DeviceIdentity {
  deviceId: string;
  deviceSecret: string;
}

// Stable per-install identity for the relay's trust-on-first-use device
// registration; the secret never leaves this machine except toward the relay.
async function loadOrCreateDevice(userDataPath: string): Promise<DeviceIdentity> {
  const path = join(userDataPath, 'relay-device.json');
  try {
    const parsed = JSON.parse(await fsp.readFile(path, 'utf8')) as Partial<DeviceIdentity>;
    if (typeof parsed.deviceId === 'string' && /^[0-9a-f-]{8,64}$/.test(parsed.deviceId)
      && typeof parsed.deviceSecret === 'string' && parsed.deviceSecret.length >= 16) {
      return { deviceId: parsed.deviceId, deviceSecret: parsed.deviceSecret };
    }
  } catch { /* first run */ }
  const identity = { deviceId: randomUUID(), deviceSecret: randomBytes(24).toString('hex') };
  await fsp.mkdir(userDataPath, { recursive: true });
  await fsp.writeFile(path, JSON.stringify(identity, null, 2), 'utf8');
  return identity;
}

export function relayClientUrl(relayUrl: string, token: string): string {
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
  const methods = createRemoteMethods(options);
  let socket: WebSocket | null = null;
  let closed = false;
  let retryMs = 1_000;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const sendEnvelope = (payload: unknown): void => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify(payload)); } catch { /* relay vanished */ }
    }
  };

  const connect = (): void => {
    if (closed) return;
    const target = new URL(options.relayUrl);
    target.pathname = '/desktop';
    target.search = `device=${encodeURIComponent(deviceId)}&secret=${encodeURIComponent(deviceSecret)}`;
    const ws = new WebSocket(target.toString(), {
      maxPayload: MAX_WS_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
    socket = ws;
    ws.on('open', () => {
      retryMs = 1_000;
      // Register the phone pairing token before any client leg can bind.
      sendEnvelope({ type: 'set-client-token', token });
    });
    ws.on('message', (raw) => {
      void (async () => {
        let envelope: { type?: unknown; clientId?: unknown; data?: unknown };
        try {
          envelope = JSON.parse(String(raw)) as { type?: unknown; clientId?: unknown; data?: unknown };
        } catch {
          return;
        }
        if (envelope.type !== 'frame' || typeof envelope.clientId !== 'string') return;
        const response = await executeRemoteFrame(methods, String(envelope.data ?? ''));
        if (response !== undefined) {
          sendEnvelope({ type: 'frame', clientId: envelope.clientId, data: JSON.stringify(response) });
        }
      })();
    });
    ws.on('error', () => { /* connection errors surface as close */ });
    ws.on('close', () => {
      if (socket === ws) socket = null;
      if (closed) return;
      reconnectTimer = setTimeout(connect, retryMs);
      reconnectTimer.unref?.();
      retryMs = Math.min(30_000, retryMs * 2);
    });
  };
  connect();

  const unsubscribeState = options.host.subscribe((snapshot) =>
    sendEnvelope({ type: 'broadcast', data: JSON.stringify({ event: 'state', payload: snapshot }) }));
  const unsubscribeTerminals = options.subscribeTerminalData?.((event) =>
    sendEnvelope({ type: 'broadcast', data: JSON.stringify({ event: 'termData', payload: event }) })) ?? (() => {});

  return {
    clientUrl: relayClientUrl(options.relayUrl, token),
    token,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      unsubscribeState();
      unsubscribeTerminals();
      if (socket) {
        try { socket.terminate(); } catch { /* already gone */ }
        socket = null;
      }
    },
  };
}
