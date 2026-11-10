// A relay the built `mixdogd` dials, and a paired phone behind it, for replaying what Node's host gave a phone over the relay.
// The relay is a scripted WebSocket peer of the desktop leg (it declares its capabilities, lists the paired devices, and reports every
// envelope the PC sends it); the phone is the app's own end of the E2EE channel (`createRelayE2EEClientHandshake`, shared/remote-e2ee.ts)
// under a protocol-client `Connector`, so the phone adapters run over it unchanged. Nothing waits on a clock: each step awaits the
// frame the product sends next.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** `http`, when given, answers the relay's plain HTTP requests (its `/feedback` endpoint) on the same port.
 *  @param {{ repoRoot: string, clients: object[], capabilities: object, http?: (req: object, res: object) => void }} options */
export async function startRelay({ repoRoot, clients, capabilities, http }) {
  const { WebSocketServer } = createRequire(join(repoRoot, 'apps', 'desktop', 'package.json'))('ws');
  const E2EE = await import(pathToFileURL(join(repoRoot, 'apps/desktop/src/shared/remote-e2ee.ts')).href);
  const web = http ? createServer(http) : null;
  const server = web ? new WebSocketServer({ server: web }) : new WebSocketServer({ port: 0, host: '127.0.0.1' });
  // A bind either succeeds or emits `error` at once; the error fails the start.
  const bound = web ?? server;
  await new Promise((resolve, reject) => {
    bound.once('error', reject);
    bound.once('listening', () => {
      bound.off('error', reject);
      resolve();
    });
    web?.listen(0, '127.0.0.1');
  });
  const state = { socket: null, caps: capabilities, envelopes: [], phones: new Map(), legs: 0, legWaiters: [], envelopeWaiters: [] };

  server.on('connection', (socket) => {
    state.socket = socket;
    state.legs += 1;
    socket.send(JSON.stringify({ type: 'relay-capabilities', ...state.caps }));
    for (const waiter of state.legWaiters.splice(0)) waiter();
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString('utf8'));
      if (frame.type === 'list-clients') return socket.send(JSON.stringify({ type: 'clients-list', requestId: frame.requestId, clients }));
      if (frame.type === 'revoke-client') return socket.send(JSON.stringify({ type: 'client-revoked', requestId: frame.requestId, ok: true }));
      if (frame.type === 'frame' || frame.type === 'close-client') return state.phones.get(frame.clientId)?.arrived(frame);
      state.envelopes.push(frame);
      for (const waiter of state.envelopeWaiters.splice(0)) waiter();
    });
  });

  /** One phone behind the relay: client-open, challenge, hello, ready; then a `Connector` over the sealed channel. */
  async function openPhone(clientId, credential, pairing) {
    const inbox = [];
    const waiting = [];
    const phone = {
      arrived(frame) {
        const next = waiting.shift();
        if (next) next(frame);
        else inbox.push(frame);
      },
    };
    const take = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve) => waiting.push(resolve)));
    state.phones.set(clientId, phone);
    state.socket.send(JSON.stringify({ type: 'client-open', clientId, browserClientId: credential }));
    const challenge = JSON.parse((await take()).data);
    const { hello, channel } = await E2EE.createRelayE2EEClientHandshake(pairing, challenge);
    state.socket.send(JSON.stringify({ type: 'frame', clientId, data: JSON.stringify(hello) }));
    const ready = await channel.decryptJson((await take()).data);
    if (ready?.type !== 'e2ee-ready') throw new Error(`the PC did not answer the hello with e2ee-ready: ${JSON.stringify(ready)}`);
    let sending = Promise.resolve();
    const connector = {
      async open(_target, sink) {
        // Frames are sealed and opened in order, one at a time: the channel's sequence numbers are the order.
        let receiving = Promise.resolve();
        const pump = async () => {
          for (;;) {
            const frame = await take();
            if (frame.type === 'close-client') return sink.closed(1000, frame.reason ?? '');
            receiving = receiving.then(async () => sink.frame(JSON.stringify(await channel.decryptJson(frame.data))));
          }
        };
        void pump();
        return {
          send(text) {
            sending = sending.then(async () => {
              const data = await channel.encryptJson(JSON.parse(text));
              state.socket.send(JSON.stringify({ type: 'frame', clientId, data }));
            });
          },
          close() {},
        };
      },
    };
    return connector;
  }

  return {
    port: (web ?? server).address().port,
    envelopes: state.envelopes,
    /** Resolves when the desktop leg is connected (immediately if it is). */
    leg: () => (state.socket ? Promise.resolve() : new Promise((resolve) => state.legWaiters.push(resolve))),
    /** The relay declares other capabilities on the connected leg; the PC reads them before any later frame. */
    declare(capabilities) {
      state.caps = capabilities;
      state.socket.send(JSON.stringify({ type: 'relay-capabilities', ...capabilities }));
    },
    /** Resolves once the PC has sent the relay `count` envelopes in all: the delivery signal, not a wait. */
    async envelopesReach(count) {
      while (state.envelopes.length < count) await new Promise((resolve) => state.envelopeWaiters.push(resolve));
    },
    /** The relay sends the PC a frame of its own (a webpush-subscriptions set, for one). */
    send: (frame) => state.socket.send(JSON.stringify(frame)),
    openPhone,
    close: () => {
      server.close();
      web?.close();
    },
  };
}
