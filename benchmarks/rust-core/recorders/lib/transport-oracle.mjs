// The MXT transport's one oracle: a fresh session with a scripted handshake and a scripted stimulus, driven through each product's own connector
// wiring (Node: the shim's socket and liveness modules on a context with nothing else installed; phone: `createRelayConnector`) -- no app boot, no
// view sync, no reads. Everything the stimulus is -- every record the PC sends and when, the confirmation, what the page sends, the PC's own
// controls, visibility changes -- is in the script below and is identical for both; everything that reaches the wire or the page is the trace:
// the ordered, decoded controls (ACK `through` and `ranges`, pings, pongs), the records, the cleartext pings, the sockets and closes, each with its
// virtual time. The trace is compared whole, so a missing, moved or extra ACK is a failure, and nothing here derives an expectation by rule.
//
// The two products differ in nothing the script can see except through this trace; what the script cannot reach on Node's side is stubbed on both
// (the context's `fire`, which carries Node's own `setForeground` report at ready, and `handleMessage`, which here only logs what the page received).
// The world is a plain browser tab, not an installed app: no background suspension runs, and with it no foreground report at hide or wake.

/** The PC's end for the oracle: it only reports what the phone sent it. */
export const oracleDialect = {
  readyFields: { hostName: 'Test PC' },
  stray: { oracle: 'stray' },
  onFrame(_leg, frame, log) {
    // A large message is logged by its size: its records are the trace, not its padding.
    log({ ev: 'pc-recv', frame: typeof frame.pad === 'string' ? { ...frame, pad: frame.pad.length } : frame });
  },
};

const IN = (n) => ({ oracle: 'in', n });
const OUT = (n) => ({ oracle: 'out', n });
/** A request frame of about 2 MB: three records (Node splits a message over 1 MiB into fragments of about 768 KiB). */
const BIG = (n) => ({ id: 7, method: 'oracle/big', oracle: 'big', n, pad: 'x'.repeat(2_000_000) });

export const ORACLE_SCENARIOS = {
  // A message of three records over a slow socket: the page's send of it completes when its last record has left (Node: transport.send() resolves after
  // the last record is sealed and admitted, remote-shim-calls.ts:148 -- the point a call's deadline restarts and its silence is measured), not at the
  // first. The three records leave 400 ms apart (short enough that no keepalive ping interleaves, so the trace's order is the products' and not a race between concurrent seals).
  'transport-large-message-slow-socket': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'mark', name: 'ready' },
    { op: 'hold-seal' },
    { op: 'out-big', n: 1 },
    { op: 'advance', ms: 400 },
    { op: 'release-seal', count: 1 },
    { op: 'mark', name: 'record-1-left' },
    { op: 'advance', ms: 400 },
    { op: 'release-seal', count: 1 },
    { op: 'mark', name: 'record-2-left' },
    { op: 'advance', ms: 400 },
    { op: 'release-seal', count: 1 },
    { op: 'mark', name: 'record-3-left' },
    { op: 'release-seal' },
    { op: 'advance', ms: 100 },
    { op: 'mark', name: 'done' },
  ],
  // Immediate-ACK opportunities (record pairs), an odd tail checked just before and exactly at the 25 ms delayed-ACK deadline, the page's own
  // sends answered by the PC's ack, the PC's ping, hiding with a tail outstanding, records arriving while hidden, and the wake.
  'transport-acks': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'mark', name: 'ready' },
    { op: 'send', n: 1 },
    { op: 'send', n: 2 },
    { op: 'advance', ms: 40 },
    { op: 'mark', name: 'pair-1' },
    { op: 'send', n: 3 },
    { op: 'send', n: 4 },
    { op: 'advance', ms: 40 },
    { op: 'mark', name: 'pair-2' },
    { op: 'send', n: 5 },
    { op: 'send', n: 6 },
    { op: 'send', n: 7 },
    { op: 'send', n: 8 },
    { op: 'advance', ms: 40 },
    { op: 'mark', name: 'quad' },
    { op: 'send', n: 9 },
    { op: 'advance', ms: 24 },
    { op: 'mark', name: 'tail-24ms' },
    { op: 'advance', ms: 1 },
    { op: 'mark', name: 'tail-25ms' },
    { op: 'advance', ms: 100 },
    { op: 'out', n: 1 },
    { op: 'out', n: 2 },
    { op: 'advance', ms: 5 },
    { op: 'pc-ack' },
    { op: 'advance', ms: 10 },
    { op: 'pc-ping', id: 9001 },
    { op: 'advance', ms: 10 },
    { op: 'mark', name: 'sends-acked-pinged' },
    { op: 'send', n: 10 },
    { op: 'advance', ms: 3 },
    { op: 'hide' },
    { op: 'advance', ms: 100 },
    { op: 'mark', name: 'hidden-with-tail' },
    { op: 'send', n: 11 },
    { op: 'send', n: 12 },
    { op: 'advance', ms: 50 },
    { op: 'mark', name: 'pair-while-hidden' },
    { op: 'send', n: 13 },
    { op: 'advance', ms: 50 },
    { op: 'mark', name: 'odd-while-hidden' },
    { op: 'send', n: 14 },
    { op: 'advance', ms: 50 },
    { op: 'mark', name: 'tail-while-hidden' },
    { op: 'show' },
    { op: 'advance', ms: 0 },
    { op: 'pong' },
    { op: 'advance', ms: 100 },
    { op: 'mark', name: 'woken' },
    { op: 'advance', ms: 3000 },
    { op: 'mark', name: 'quiet-after-wake' },
  ],
  // The stimulus of the phone dialect's boot (the PC's ready, the answers to `initialize` and the app feed, and the page's two requests) and
  // of the `mxt-negotiated` lifecycle scenario's visibility: the ACKs a lifecycle trace leaves out are pinned here, under that boot.
  'transport-boot-shaped': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'out', n: 1 },
    { op: 'send', n: 1 },
    { op: 'out', n: 2 },
    { op: 'send', n: 2 },
    { op: 'mark', name: 'booted' },
    { op: 'advance', ms: 7000 },
    { op: 'mark', name: 'quiet-visible' },
    { op: 'hide' },
    { op: 'send', n: 3 },
    { op: 'send', n: 4 },
    { op: 'send', n: 5 },
    { op: 'advance', ms: 10000 },
    { op: 'mark', name: 'hidden' },
    { op: 'show' },
    { op: 'pong' },
    { op: 'advance', ms: 5000 },
    { op: 'mark', name: 'woken' },
  ],
};

/** Events that reach the wire or the page; everything else the world logs (indicator states, the core's record) is not traffic. */
const TRAFFIC = new Set(['send-complete', 'socket', 'close', 'ping', 'xcontrol', 'xrecord', 'pc-recv', 'pc-send', 'deliver', 'ready', 'out', 'fetch', 'hello', 'mark', 'pc-control']);

/** driver: { boot(), send(payload) }. Returns the whole ordered trace, each entry with its virtual time since the script began. */
export async function playOracle(world, driver, ops) {
  const t0 = world.clock.now;
  let socket = null;
  for (const op of ops) {
    switch (op.op) {
      case 'boot':
        await driver.boot();
        break;
      case 'accept':
        await world.waitFor((e) => e.ev === 'socket');
        socket = await world.accept({ transportWebrtc: 1, binaryFrames: 1 });
        await world.until(() => world.events.some((e) => e.ev === 'ready'));
        await world.advance(0);
        break;
      case 'send':
        world.log({ ev: 'pc-send', n: op.n });
        await world.legOf(socket).toPhone(IN(op.n));
        await world.advance(0);
        break;
      case 'out':
        world.log({ ev: 'out', n: op.n });
        driver.send(OUT(op.n));
        await world.advance(0);
        break;
      case 'out-big':
        world.log({ ev: 'out', n: `big-${op.n}` });
        driver.sendTracked(BIG(op.n), () => world.log({ ev: 'send-complete' }));
        await world.advance(0);
        break;
      case 'hold-seal':
        world.holdSeal();
        break;
      case 'release-seal':
        await world.releaseSeal(op.count);
        break;
      case 'pc-ack':
        world.log({ ev: 'pc-control', t: 'ack' });
        await world.pcAck(socket);
        await world.advance(0);
        break;
      case 'pc-ping':
        world.log({ ev: 'pc-control', t: 'ping', id: op.id });
        await world.pcPing(socket, op.id);
        await world.advance(0);
        break;
      case 'pong':
        world.pongTo(socket);
        await world.advance(0);
        break;
      case 'hide':
        world.setVisibility('hidden');
        await world.advance(0);
        break;
      case 'show':
        world.setVisibility('visible');
        await world.advance(0);
        break;
      case 'advance':
        await world.advance(op.ms);
        break;
      case 'mark':
        world.log({ ev: 'mark', name: op.name });
        break;
      default:
        throw new Error(`unknown oracle op ${op.op}`);
    }
  }
  return world.events.filter((e) => TRAFFIC.has(e.ev)).map(({ at, ...rest }) => ({ t: at - t0, ...rest }));
}