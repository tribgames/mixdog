// The desktop's own leg to the relay: one socket at a time, its heartbeat, the
// redial schedule (backoff, stalled-handshake redials, stable-leg reset), the
// wire decode of what arrives on it, and the sends that ride it. What a leg
// announces, and what its loss means for phones, belongs to the caller.
import WebSocket from 'ws';

// @ts-expect-error Relay framing is shared with the plain-ESM VPS server.
import { decodeRelayBinaryFrame } from '../../../relay/lib/relay-binary-frame.mjs';
import { DESKTOP_HANDSHAKE_STALLED_CLOSE } from '../../../relay/lib/relay-close-codes.mjs';
import { relayDeviceSocketOptions, type DeviceIdentity } from './remote-relay-device';

/** Idle NAT paths silently kill this leg; protocol pings keep it warm and
 *  detect a half-dead socket so the reconnect loop restores it long before a
 *  phone RPC would hang on it. Any traffic counts as proof of life, so a busy
 *  leg is never terminated for missing a pong. */
const RELAY_HEARTBEAT_MS = 10_000;
/** A dial younger than this is not replaced by a resume or network change. */
const RELAY_DIAL_GRACE_MS = 5_000;
/** Reconnect backoff: the first delay after a drop, doubling up to the cap. */
const RELAY_RETRY_MIN_MS = 1_000;
const RELAY_RETRY_MAX_MS = 30_000;
/** How many DESKTOP_HANDSHAKE_STALLED_CLOSE closes in a row redial at once before the backoff applies. */
const RELAY_STALLED_IMMEDIATE_REDIALS = 2;
/** A leg that stays up this long is a recovery: the stall record and the
 *  backoff start over. */
const RELAY_STABLE_LEG_MS = 30_000;

export function startRelayHeartbeat(
  ws: WebSocket,
  intervalMs = RELAY_HEARTBEAT_MS
): { markAlive(): void; stop(): void } {
  let alive = true;
  ws.on('pong', () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!alive) {
      try {
        ws.terminate();
      } catch {
        /* close handler reconnects */
      }
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      /* close handler reconnects */
    }
  }, intervalMs);
  heartbeat.unref?.();
  return {
    markAlive(): void {
      alive = true;
    },
    stop(): void {
      clearInterval(heartbeat);
    },
  };
}

/** One relay message as an envelope. A binary frame is unwrapped into the same
 *  shape the JSON form carries, so everything downstream reads one shape; a
 *  message that decodes into neither is dropped. */
function readRelayEnvelope(raw: WebSocket.RawData, isBinary: boolean): Record<string, unknown> | null {
  if (isBinary) {
    const frame = decodeRelayBinaryFrame(raw);
    if (!frame) return null;
    return {
      type: 'frame',
      clientId: frame.clientId,
      // A text-flagged frame carries UTF-8 that must be handed on as a
      // STRING, exactly like a JSON envelope's `data` — the handshake and
      // the E2EE box readers below distinguish the two by type. An old
      // frame has no flag and stays bytes.
      data: frame.text ? Buffer.from(frame.data).toString('utf8') : frame.data,
    };
  }
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface RelayDeviceConnectionDeps {
  relayUrl: string;
  identity: DeviceIdentity;
  /** Transport cap for one message on this leg. */
  maxPayload: number;
  /** Every open, including each redial, after the backoff bookkeeping. */
  onOpen(): void;
  /** One decoded envelope. A throw ends the leg; the redial starts clean. */
  onEnvelope(envelope: Record<string, unknown>): void;
  /** The current leg closed, also after `beginClose()`. */
  onLegEnded(): void;
  /** The current leg closed while the relay client still runs; a redial follows. */
  onLegLost(): void;
}

export interface RelayDeviceConnection {
  connect(): void;
  /** System resume: drop a likely half-dead leg and redial now. */
  resume(): void;
  closed(): boolean;
  currentSocket(): WebSocket | null;
  connected(): boolean;
  bufferedAmount(): number;
  sendEnvelope(payload: unknown): boolean;
  /** Sends an ALREADY serialized frame. */
  sendRawAndWait(frame: string | Uint8Array): Promise<void>;
  /** Marks the client closed: nothing redials or reconnects from now on. */
  beginClose(): void;
  /** Clears the pending redial and the stable-leg timer. */
  cancelTimers(): void;
  /** Terminates the current leg without running its close bookkeeping. */
  terminate(): void;
}

export function createRelayDeviceConnection(deps: RelayDeviceConnectionDeps): RelayDeviceConnection {
  let socket: WebSocket | null = null;
  let closed = false;
  let retryMs = RELAY_RETRY_MIN_MS;
  // Consecutive legs the relay closed as unresponsive, and the timer that
  // clears that record once a leg holds.
  let stalledStreak = 0;
  let stableTimer: NodeJS.Timeout | undefined;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let connectStartedAt = 0;

  const sendEnvelope = (payload: unknown): boolean => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(payload));
        return true;
      } catch {
        /* relay vanished */
      }
    }
    return false;
  };
  /** Sends an ALREADY serialized frame, so callers that must know the exact
   *  wire size the relay will measure can compute it once instead of
   *  re-serializing a multi-megabyte payload to find out. */
  const sendRawAndWait = (frame: string | Uint8Array): Promise<void> =>
    new Promise((resolve, reject) => {
      const target = socket;
      if (!target || target.readyState !== WebSocket.OPEN) {
        reject(new Error('Relay is not connected.'));
        return;
      }
      try {
        target.send(frame, (error: Error | undefined) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });

  const connect = (): void => {
    // One live connection attempt at a time: a pending redial is replaced by
    // this call, and an existing socket is never shadowed by a second one.
    if (closed || socket) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connectStartedAt = Date.now();
    const connection = relayDeviceSocketOptions(deps.relayUrl, deps.identity);
    const ws = new WebSocket(connection.url, {
      headers: connection.headers,
      maxPayload: deps.maxPayload,
      // Frames on this leg are E2EE ciphertext (incompressible) or small
      // control envelopes; payload compression happens inside the encrypted
      // envelope instead. Transport deflate only cost CPU on both ends.
      perMessageDeflate: false,
    });
    socket = ws;
    const heartbeat = startRelayHeartbeat(ws);
    ws.on('open', () => {
      // An open after ordinary drops restarts the backoff, as it always has.
      // After stalled-handshake closes it does not: the leg must HOLD first.
      if (stalledStreak === 0) retryMs = RELAY_RETRY_MIN_MS;
      clearTimeout(stableTimer);
      stableTimer = setTimeout(() => {
        stalledStreak = 0;
        retryMs = RELAY_RETRY_MIN_MS;
      }, RELAY_STABLE_LEG_MS);
      stableTimer.unref?.();
      deps.onOpen();
    });
    ws.on('message', (raw, isBinary) => {
      heartbeat.markAlive();
      try {
        const envelope = readRelayEnvelope(raw, isBinary);
        if (!envelope) return;
        deps.onEnvelope(envelope);
      } catch {
        // A frame this leg cannot process ends the leg; the close handler
        // redials with a clean state.
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
      }
    });
    ws.on('error', () => {
      /* connection errors surface as close */
    });
    ws.on('close', (code) => {
      heartbeat.stop();
      // A superseded socket owns none of the shared state and schedules nothing.
      if (socket !== ws) return;
      socket = null;
      deps.onLegEnded();
      if (closed) return;
      deps.onLegLost();
      clearTimeout(stableTimer);
      // The relay judged this leg dead while a joining phone waited on it.
      // That phone is still inside its own handshake budget, so the first
      // few replacements dial at once. A leg that keeps getting closed this
      // way is not recovering, though: past the limit it waits out the
      // ordinary backoff, which only a leg that holds resets.
      const stalled = code === DESKTOP_HANDSHAKE_STALLED_CLOSE;
      if (stalled) stalledStreak += 1;
      const immediate = stalled && stalledStreak <= RELAY_STALLED_IMMEDIATE_REDIALS;
      reconnectTimer = setTimeout(
        () => {
          reconnectTimer = null;
          connect();
        },
        immediate ? 0 : retryMs
      );
      reconnectTimer.unref?.();
      if (!immediate) retryMs = Math.min(RELAY_RETRY_MAX_MS, retryMs * 2);
    });
  };

  const resume = (): void => {
    if (closed) return;
    retryMs = RELAY_RETRY_MIN_MS;
    if (reconnectTimer) {
      connect();
      return;
    }
    if (socket) {
      // An attempt that is still dialing is the fresh connection already.
      if (socket.readyState === WebSocket.CONNECTING && Date.now() - connectStartedAt < RELAY_DIAL_GRACE_MS) return;
      // The close handler reconnects with the freshly reset backoff.
      try {
        socket.terminate();
      } catch {
        /* already gone */
      }
      return;
    }
    connect();
  };

  return {
    connect,
    resume,
    closed: () => closed,
    currentSocket: () => socket,
    connected: () => socket !== null && socket.readyState === WebSocket.OPEN,
    bufferedAmount: () => socket?.bufferedAmount ?? 0,
    sendEnvelope,
    sendRawAndWait,
    beginClose: () => {
      closed = true;
    },
    cancelTimers: () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearTimeout(stableTimer);
    },
    terminate: () => {
      if (socket) {
        try {
          socket.terminate();
        } catch {
          /* already gone */
        }
        socket = null;
      }
    },
  };
}
