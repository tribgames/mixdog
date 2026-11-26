import assert from 'node:assert/strict';
import test from 'node:test';
import type { TransportWriter } from '../../../packages/protocol-client/src/index.ts';
import {
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  generateRelayE2EEServerIdentity,
  relayE2EEPairingMaterial,
} from '../../desktop/src/shared/remote-e2ee.ts';
import type { RelayConnectorDeps, RelaySocket } from './relay-connector.ts';
import { RelaySession, type ConnectorState } from './relay-session.ts';

class RelayHoldingSocket implements RelaySocket {
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Array<string | Uint8Array> = [];
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
  private readonly sentWaiters: Array<(data: string | Uint8Array) => void> = [];

  send(data: string | Uint8Array): void {
    this.sent.push(data);
    for (const waiter of this.sentWaiters.splice(0)) waiter(data);
    if (data === '{"ping":1}') this.onmessage?.({ data: '{"pong":1}' });
  }

  waitForSend(match: (data: string | Uint8Array) => boolean): Promise<string | Uint8Array> {
    const existing = this.sent.find(match);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const check = (data: string | Uint8Array): void => {
        if (match(data)) resolve(data);
        else this.sentWaiters.push(check);
      };
      this.sentWaiters.push(check);
    });
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }
}

async function makeDeps(
  ws: RelaySocket,
  now: () => number,
  closed: Array<{ code: number; reason: string }>,
  onDesktopOffline?: () => void
): Promise<{
  deps: RelayConnectorDeps;
  identity: Awaited<ReturnType<typeof generateRelayE2EEServerIdentity>>;
  pairing: ReturnType<typeof relayE2EEPairingMaterial>;
}> {
  const identity = await generateRelayE2EEServerIdentity();
  const pairing = relayE2EEPairingMaterial(identity);
  return {
    identity,
    pairing,
    deps: {
      pairing: () => pairing,
      socketUrl: () => 'wss://relay.invalid/ws/device',
      createSocket: () => ws,
      now,
      ...(onDesktopOffline ? { desktopOffline: onDesktopOffline } : {}),
      closed: (code, reason) => closed.push({ code, reason }),
    },
  };
}

async function advance(
  mockTimers: { tick(ms: number): void },
  stepClock: (ms: number) => void,
  totalMs: number
): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0) {
    const step = Math.min(remaining, 5_000);
    stepClock(step);
    mockTimers.tick(step);
    await Promise.resolve();
    await Promise.resolve();
    remaining -= step;
  }
}

test('unannounced socket keeps the 10 s handshake deadline to detect a dead relay or network', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let clock = 1_000;
  const stepClock = (ms: number) => {
    clock += ms;
  };

  const ws = new RelayHoldingSocket();
  const closed: Array<{ code: number; reason: string }> = [];
  const { deps, pairing } = await makeDeps(ws, () => clock, closed);
  const state: ConnectorState = { active: null, current: null, parked: null };
  let rejected: Error | null = null;

  new RelaySession({
    state,
    deps,
    ws,
    pairing,
    reuse: null,
    sink: { frame: () => {}, closed: () => {} },
    resolve: () => assert.fail('must not resolve without a handshake'),
    reject: (error) => {
      rejected = error;
    },
  });

  ws.onopen?.();
  await advance(t.mock.timers, stepClock, 9_999);
  assert.equal(rejected, null);

  await advance(t.mock.timers, stepClock, 1);
  assert.deepEqual(ws.closes, [{ code: 4408, reason: 'relay handshake timed out' }]);
  assert.deepEqual(closed, [{ code: 4408, reason: 'relay handshake timed out' }]);
  assert.match(String(rejected), /4408 relay handshake timed out/);
});

test('fresh socket told desktop-gone marks PC offline and waits past 45 s for 4002 with no racing 4408', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let clock = 1_000;
  const stepClock = (ms: number) => {
    clock += ms;
  };

  const ws = new RelayHoldingSocket();
  const closed: Array<{ code: number; reason: string }> = [];
  let offlineCount = 0;
  const { deps, pairing } = await makeDeps(
    ws,
    () => clock,
    closed,
    () => {
      offlineCount += 1;
    }
  );
  const state: ConnectorState = { active: null, current: null, parked: null };
  let rejected: Error | null = null;

  new RelaySession({
    state,
    deps,
    ws,
    pairing,
    reuse: null,
    sink: { frame: () => {}, closed: () => {} },
    resolve: () => assert.fail('must not resolve without a handshake'),
    reject: (error) => {
      rejected = error;
    },
  });

  ws.onopen?.();
  ws.onmessage?.({ data: '{"resync":"desktop-gone"}' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(offlineCount, 1, 'PC is shown offline as soon as the relay parks the socket');

  // Survives both the 10 s handshake window and the 45 s relay hold without a client-side 4408 racing 4002.
  await advance(t.mock.timers, stepClock, 50_000);
  assert.equal(rejected, null);
  assert.equal(ws.closes.length, 0);

  // Relay expires the hold with 4002 desktop offline.
  ws.onclose?.({ code: 4002, reason: 'desktop offline' });
  assert.deepEqual(closed, [{ code: 4002, reason: 'desktop offline' }]);
  assert.match(String(rejected), /4002 desktop offline/);
});

test('reused socket parked on desktop-gone waits without racing 4002 and re-arms 10 s deadline once challenged', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let clock = 1_000;
  const stepClock = (ms: number) => {
    clock += ms;
  };

  const ws = new RelayHoldingSocket();
  const closed: Array<{ code: number; reason: string }> = [];
  let offlineCount = 0;
  const { deps, pairing } = await makeDeps(
    ws,
    () => clock,
    closed,
    () => {
      offlineCount += 1;
    }
  );
  const state: ConnectorState = { active: null, current: null, parked: null };
  let rejected: Error | null = null;

  new RelaySession({
    state,
    deps,
    ws,
    pairing,
    reuse: { ws, inbox: [], offline: true },
    sink: { frame: () => {}, closed: () => {} },
    resolve: () => assert.fail('must not resolve while desktop stalls after challenge'),
    reject: (error) => {
      rejected = error;
    },
  });

  assert.equal(offlineCount, 1);
  await advance(t.mock.timers, stepClock, 30_000);
  assert.equal(rejected, null, 'parked socket waits for the returning desktop');
  assert.equal(ws.closes.length, 0);

  // Desktop returns and sends a challenge, then stalls before e2ee-ready: the 10 s handshake deadline catches it.
  const challenge = createRelayE2EEChallenge();
  const helloSent = ws.waitForSend((frame) => typeof frame === 'string' && frame.includes('e2ee-hello'));
  ws.onmessage?.({ data: JSON.stringify(challenge) });
  await helloSent;
  await advance(t.mock.timers, stepClock, 9_999);
  assert.equal(rejected, null);

  await advance(t.mock.timers, stepClock, 1);
  assert.deepEqual(ws.closes, [{ code: 4408, reason: 'relay handshake timed out' }]);
  assert.deepEqual(closed, [{ code: 4408, reason: 'relay handshake timed out' }]);
  assert.match(String(rejected), /4408 relay handshake timed out/);
});

test('a ready session parked on desktop-gone marks parked.offline so takeover waits for return and completes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let clock = 1_000;
  const stepClock = (ms: number) => {
    clock += ms;
  };

  const ws = new RelayHoldingSocket();
  const closed: Array<{ code: number; reason: string }> = [];
  let offlineCount = 0;
  const { deps, identity, pairing } = await makeDeps(
    ws,
    () => clock,
    closed,
    () => {
      offlineCount += 1;
    }
  );
  const state: ConnectorState = { active: null, current: null, parked: null };

  const firstReady = new Promise<TransportWriter>((resolve, reject) => {
    new RelaySession({
      state,
      deps,
      ws,
      pairing,
      reuse: null,
      sink: { frame: () => {}, closed: () => {} },
      resolve,
      reject,
    });
  });

  const completeHandshake = async (): Promise<void> => {
    const challenge = createRelayE2EEChallenge();
    const helloSent = ws.waitForSend((frame) => typeof frame === 'string' && frame.includes('e2ee-hello'));
    ws.onmessage?.({ data: JSON.stringify(challenge) });
    const helloRaw = await helloSent;
    assert.equal(typeof helloRaw, 'string');
    const server = await acceptRelayE2EEClientHello(identity, challenge, JSON.parse(helloRaw as string));
    const readyFrame = await server.encryptJson({
      type: 'e2ee-ready',
      version: 1,
      hostName: 'PC',
      ...server.handshakeConfirmation(),
    });
    ws.onmessage?.({ data: readyFrame });
  };

  ws.onopen?.();
  await completeHandshake();
  const firstWriter = await firstReady;

  // Desktop drops: ready session parks with offline=true and reports PC offline immediately.
  ws.onmessage?.({ data: '{"resync":"desktop-gone"}' });
  await firstWriter.settled?.();
  assert.equal(offlineCount, 1);
  assert.equal(state.parked?.offline, true);

  // Connector takes over the parked socket; PC returns 25 s later and reconnects cleanly.
  const parked = state.parked!;
  state.parked = null;
  ws.sent.length = 0;
  const secondReady = new Promise<void>((resolve, reject) => {
    new RelaySession({
      state,
      deps,
      ws: parked.ws,
      pairing,
      reuse: parked,
      sink: { frame: () => {}, closed: () => {} },
      resolve: () => resolve(),
      reject,
    });
  });

  await advance(t.mock.timers, stepClock, 25_000);
  await completeHandshake();
  await secondReady;
  assert.equal(ws.closes.length, 0);
});
