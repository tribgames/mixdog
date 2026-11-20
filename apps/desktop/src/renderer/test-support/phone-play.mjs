// Plays a lifecycle script against the phone's world (test-support/phone-world.mjs) and returns its checkpoints. A trace holds only what
// the user, or the core, can tell apart: the connection indicator's states and its outage/clear transitions, the sockets the page closes
// or pings (with the virtual time since the last checkpoint), what the core knows of the phone, how a pending call ends, and the pairing
// reset.
import { effectiveCore } from './phone-world.mjs';

/** The text ceiling the world's relay publishes at the handshake (uplinkTextCeilingBytes): a payload of one byte per char past it is refused by the page before it leaves. */
export const PAYLOAD_CEILING_CHARS = 4_000_000;
const OUTAGE = new Set(['connecting', 'reconnecting']);
const deepMatch = (actual, want) =>
  Object.entries(want).every(([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value));

/**
 * driver: { boot(world, options), api() -> DesktopApi, pending() }.
 * Returns [{ name, ... }] checkpoints.
 */
export async function play(world, driver, ops) {
  const trace = [];
  let cursor = world.mark();
  let since = world.clock.now;
  let lastSocket = null;
  // A connection the script accepted counts as up for a check only once the indicator said connected since.
  let awaitingConnected = false;
  const calls = [];
  let hellos = 0;
  const refused = new Set();
  const traceReads = ops[0].reads === true;
  const checkpoint = (name, extra = {}) => {
    const slice = world.events.slice(cursor);
    cursor = world.events.length;
    const states = [];
    for (const e of slice) if (e.ev === 'state' && states.at(-1) !== e.state) states.push(e.state);
    const banner = [];
    for (const state of states) {
      const outage = OUTAGE.has(state);
      if (banner.at(-1) !== outage) banner.push(outage);
    }
    const entry = {
      name,
      states,
      banner,
      offline: slice.some((e) => e.ev === 'state' && e.desktop === 'offline'),
      // One log in the order things happened: a ping and a request at the same virtual time keep the order they occurred in.
      log: slice
        .filter(
          (e) =>
            e.ev === 'ping' ||
            e.ev === 'close' ||
            e.ev === 'socket' ||
            e.ev === 'resync' ||
            (e.ev === 'xcontrol' && e.kind !== 'ack') ||
            (traceReads && (e.ev === 'request' || e.ev === 'settled'))
        )
        .map((e) => {
          if (e.ev === 'request') return `request:${e.name}@${e.at - since}`;
          if (e.ev === 'settled')
            return `settled:${e.as}:${e.ok ? `ok=${JSON.stringify(e.value)}` : `err(${e.code})`}@${e.at - since}`;
          return `${e.ev === 'xcontrol' ? `x:${e.kind}` : e.ev}${e.ev === 'close' ? `(${e.code},${e.reason})` : ''}@${e.at - since}`;
        }),
      pairingInvalid: slice.filter((e) => e.ev === 'pairing-invalid').map((e) => e.message),
      reconnected: slice.filter((e) => e.ev === 'reconnected').length,
      // The order of the two notices a page acts on when a connection is whole again: the indicator saying connected, and the reconnected event.
      notices: slice
        .filter((e) => (e.ev === 'state' && e.state === 'connected') || e.ev === 'reconnected')
        .map((e) => (e.ev === 'reconnected' ? 'reconnected' : 'connected')),
      calls: calls.splice(0),
      core: world.core() ? effectiveCore(world.core()) : null,
      ...extra,
    };
    since = world.clock.now;
    trace.push(entry);
  };
  for (const op of ops) {
    switch (op.op) {
      case 'boot':
        world.throwNext = op.socketThrows ?? 0;
        for (const name of op.hold ?? []) world.holds.add(name);
        for (const name of op.refuse ?? []) world.refusals.add(name);
        if (op.visible) world.store.set('mixdog.remote-visible-sessions', JSON.stringify(op.visible));
        await driver.boot(world, op);
        break;
      case 'accept':
        await world.waitFor(
          (e) => e.ev === 'socket' && world.sockets[e.n - 1] && !world.accepted(world.sockets[e.n - 1])
        );
        lastSocket = await world.accept(op.flags);
        awaitingConnected = true;
        break;
      case 'check': {
        await world.until(
          () =>
            world.core() !== null &&
            deepMatch(effectiveCore(world.core()), op.expect) &&
            (!awaitingConnected || world.events.slice(cursor).some((e) => e.ev === 'state' && e.state === 'connected'))
        );
        awaitingConnected = false;
        // What the product does in answer to the last thing it saw (its reply landing, the indicator following) happens before the checkpoint.
        await world.advance(0);
        checkpoint(op.name);
        break;
      }
      case 'mark':
        checkpoint(op.name);
        break;
      case 'advance':
        await world.advance(op.ms);
        break;
      case 'random':
        world.setRandom(() => op.value);
        break;
      case 'hide':
        world.setVisibility('hidden');
        break;
      case 'show':
        world.setVisibility('visible');
        break;
      case 'drop':
        world.peerClose(lastSocket, op.code);
        break;
      case 'rechallenge':
        await world.handshake(lastSocket);
        break;
      case 'gone':
        world.legOf(lastSocket).clear({ resync: 'desktop-gone' });
        await world.advance(0);
        break;
      case 'event': {
        const target = op.target === 'document' ? world.document : world.window;
        target.dispatchEvent(new Event(op.type));
        await world.advance(0);
        break;
      }
      case 'thaw':
        // The page thaws with its state already visible and the close queued while it was frozen runs before any visibility event.
        world.document.visibilityState = 'visible';
        break;
      case 'stray':
        await world.stray(lastSocket);
        await world.advance(0);
        break;
      case 'relay-hint':
        world.legOf(lastSocket).clear({ resync: 1 });
        await world.advance(0);
        break;
      case 'fail-sync':
        world.failViewSync = op.times;
        break;
      case 'refuse-syncs':
        world.refuseSyncs = op.times;
        break;
      case 'hold-hello':
        world.holdHello = true;
        break;
      case 'hello': {
        hellos += 1;
        const want = hellos;
        await world.until(() => world.events.filter((e) => e.ev === 'hello').length >= want);
        break;
      }
      case 'pong':
        world.pongTo(lastSocket);
        await world.advance(0);
        break;
      case 'await-request': {
        await world.until(() => world.events.some((e) => e.ev === 'request' && e.name === op.name));
        break;
      }
      case 'read':
        driver
          .api()
          [op.name]()
          .then(
            (value) => world.log({ ev: 'settled', as: op.as, ok: true, value }),
            (error) => world.log({ ev: 'settled', as: op.as, ok: false, code: error?.code })
          );
        break;
      case 'oversize':
        driver
          .api()
          .deleteSession('x'.repeat(PAYLOAD_CEILING_CHARS + 1))
          .then(
            (value) => world.log({ ev: 'settled', as: op.as, ok: true, value }),
            (error) => world.log({ ev: 'settled', as: op.as, ok: false, code: error?.code })
          );
        await world.advance(0);
        break;
      case 'unhold':
        world.holds.delete(op.name);
        world.held = world.held.filter((h) => h.name !== op.name);
        break;
      case 'hold':
        world.holds.add(op.name);
        break;
      case 'hold-seal':
        world.holdSeal();
        break;
      case 'release-seal':
        await world.releaseSeal(op.count);
        break;
      case 'release':
        await world.release(op.name);
        break;
      case 'screen':
        driver.api().reportScreenSessions(op.ids);
        break;
      case 'panels':
        world.window.dispatchEvent(new CustomEvent(driver.visualizePanelsEvent, { detail: op.ids }));
        break;
      case 'visible':
        driver
          .api()
          .setVisibleSessions(op.ids)
          .then(
            (value) => world.log({ ev: 'settled', as: op.as ?? 'visible', ok: true, value }),
            (error) => world.log({ ev: 'settled', as: op.as ?? 'visible', ok: false, code: error?.code })
          );
        break;
      case 'lane':
        driver.api().subscribeTermData(() => {});
        break;
      case 'call':
        driver
          .api()
          .deleteSession('s1')
          .then(
            () => calls.push('resolved'),
            (error) =>
              calls.push(
                error?.code === 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED' ? 'interrupted' : `error: ${error?.message}`
              )
          );
        await world.advance(0);
        break;
      case 'offline-redials': {
        // Each round: wait for the redial's socket, let the relay close it (by default before the handshake with "PC offline", 4002).
        const delays = [];
        let last = world.clock.now;
        for (let i = 0; i < op.rounds; i += 1) {
          const pending = () => world.sockets.find((s) => !refused.has(s) && !world.accepted(s));
          await world.advanceUntil(() => pending() !== undefined);
          const ws = pending();
          refused.add(ws);
          // The delay is read from the socket's creation event.
          const created = world.events.findLast((e) => e.ev === 'socket' && e.n === world.sockets.indexOf(ws) + 1);
          delays.push(created.at - last);
          ws.readyState = 1;
          ws.onopen?.();
          world.peerClose(ws, op.code ?? 4002);
          last = world.clock.now;
          await world.advance(0);
        }
        checkpoint(op.name ?? 'offline', { maxRedialDelayMs: Math.max(...delays), redialDelaysMs: delays });
        break;
      }
      default:
        throw new Error(`unknown op ${op.op}`);
    }
  }
  return trace;
}
