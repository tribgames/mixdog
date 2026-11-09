// The phone lifecycle scenarios. One script per scenario, played against the Node shim (recorder) and against the protocol client
// (replay test); `play` returns the trace both must produce. A trace holds only what the user, or the core, can tell apart:
// the connection indicator's states and its outage/clear transitions, the sockets the page closes or pings (with the virtual time
// since the last checkpoint), what the core knows of the phone, how a pending call ends, and the pairing reset.
import { effectiveCore } from './phone-world.mjs';

export const SCENARIOS = {
  // Boot, handshake, the first reports and the view of the last visit; then the page changes what it shows.
  'cold-connect-and-reports': [
    { op: 'boot', visible: ['restored-1'] },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true, view: ['restored-1'] } },
    { op: 'screen', ids: ['s1', 's2'] },
    { op: 'check', name: 'screen', expect: { foreground: true, screen: ['s1', 's2'] } },
    { op: 'panels', ids: ['s1'] },
    { op: 'visible', ids: ['s1', 's3'] },
    { op: 'lane', name: 'terminal' },
    { op: 'check', name: 'visible-panels-lanes', expect: { panels: ['s1'], view: ['s1', 's3'], lanes: ['terminal'] } },
  ],
  // The live leg is closed by the relay: the first redial is spread over 0..1500 ms.
  'live-leg-closed': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'random', value: 0 },
    { op: 'drop', code: 1006 },
    { op: 'advance', ms: 0 },
    { op: 'mark', name: 'spread-0' },
    { op: 'accept' },
    { op: 'check', name: 'reconnected', expect: { foreground: true } },
    { op: 'random', value: 0.5 },
    { op: 'drop', code: 1006 },
    { op: 'advance', ms: 1500 },
    { op: 'mark', name: 'spread-half' },
  ],
  // The relay says the PC is offline again and again: redials back off up to 60 s.
  'pc-offline': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'random', value: 1 },
    { op: 'drop', code: 1006 },
    { op: 'offline-redials', rounds: 14 },
  ],
  'pairing-revoked': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'drop', code: 4003 },
    { op: 'advance', ms: 70000 },
    { op: 'mark', name: 'after-revoke' },
  ],
  'registration-refused': [{ op: 'boot', paired: false, registration: 401 }, { op: 'advance', ms: 70000 }, { op: 'mark', name: 'refused' }],
  // Silence: ping after 25 s, recycle 10 s after an unanswered ping; an answered one is kept.
  keepalive: [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'advance', ms: 24999 },
    { op: 'mark', name: 'quiet-just-under-25s' },
    { op: 'advance', ms: 1 },
    { op: 'mark', name: 'first-ping' },
    { op: 'pong' },
    { op: 'advance', ms: 25000 },
    { op: 'mark', name: 'answered-then-silent-pings-again' },
    { op: 'advance', ms: 9999 },
    { op: 'mark', name: 'unanswered-just-under-10s' },
    { op: 'advance', ms: 1 },
    { op: 'mark', name: 'unanswered-recycled' },
  ],
  // Back in the foreground after a short hide: the socket is probed; unanswered within 2.5 s it is recycled.
  'wake-probe': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'hide' },
    { op: 'check', name: 'hidden', expect: { foreground: false } },
    { op: 'advance', ms: 10000 },
    { op: 'show' },
    { op: 'check', name: 'shown', expect: { foreground: true } },
    { op: 'advance', ms: 2499 },
    { op: 'mark', name: 'probe-waiting' },
    { op: 'advance', ms: 1 },
    { op: 'mark', name: 'probe-unanswered' },
  ],
  'wake-probe-answered': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'hide' },
    { op: 'advance', ms: 10000 },
    { op: 'show' },
    { op: 'pong' },
    { op: 'advance', ms: 5000 },
    { op: 'mark', name: 'probe-answered' },
  ],
  // Hidden past the grace: the socket is released with 1000 `background`, nothing redials, and the page coming back dials again.
  background: [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'hide' },
    { op: 'check', name: 'hidden', expect: { foreground: false } },
    { op: 'advance', ms: 29999 },
    { op: 'mark', name: 'within-grace' },
    { op: 'advance', ms: 1 },
    { op: 'mark', name: 'suspended' },
    { op: 'advance', ms: 120000 },
    { op: 'mark', name: 'still-suspended' },
    { op: 'show' },
    { op: 'accept' },
    { op: 'check', name: 'back', expect: { foreground: true } },
  ],
  // The relay kept the socket while the desktop leg was replaced: a challenge after ready. Calls in flight fail as interrupted.
  'leg-replaced': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'call' },
    { op: 'rechallenge' },
    { op: 'advance', ms: 250 },
    { op: 'check', name: 'rekeyed', expect: { foreground: true } },
    { op: 'mark', name: 'after-replaced' },
  ],
  'desktop-gone': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'call' },
    { op: 'gone' },
    { op: 'mark', name: 'parked' },
    { op: 'rechallenge' },
    { op: 'advance', ms: 250 },
    { op: 'check', name: 'returned', expect: { foreground: true } },
    { op: 'mark', name: 'after-return' },
  ],
};

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
      wire: slice
        .filter((e) => e.ev === 'ping' || e.ev === 'close' || e.ev === 'socket')
        .map((e) => `${e.ev}${e.ev === 'close' ? `(${e.code},${e.reason})` : ''}@${e.at - since}`),
      pairingInvalid: slice.filter((e) => e.ev === 'pairing-invalid').map((e) => e.message),
      reconnected: slice.filter((e) => e.ev === 'reconnected').length,
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
        if (op.visible) world.store.set('mixdog.remote-visible-sessions', JSON.stringify(op.visible));
        await driver.boot(world, op);
        break;
      case 'accept':
        await world.waitFor((e, i) => e.ev === 'socket' && world.sockets[e.n - 1] && !world.accepted(world.sockets[e.n - 1]));
        lastSocket = await world.accept(op.flags);
        awaitingConnected = true;
        break;
      case 'check': {
        await world.until(() => world.core() !== null && deepMatch(effectiveCore(world.core()), op.expect) && (!awaitingConnected || world.events.slice(cursor).some((e) => e.ev === 'state' && e.state === 'connected')));
        awaitingConnected = false;
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
      case 'pong':
        world.pongTo(lastSocket);
        await world.advance(0);
        break;
      case 'screen':
        driver.api().reportScreenSessions(op.ids);
        break;
      case 'panels':
        world.window.dispatchEvent(new CustomEvent(driver.visualizePanelsEvent, { detail: op.ids }));
        break;
      case 'visible':
        void driver.api().setVisibleSessions(op.ids);
        break;
      case 'lane':
        driver.api().subscribeTermData(() => {});
        break;
      case 'call':
        driver.api().deleteSession('s1').then(
          () => calls.push('resolved'),
          (error) => calls.push(error?.code === 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED' ? 'interrupted' : `error: ${error?.message}`)
        );
        await world.advance(0);
        break;
      case 'offline-redials': {
        // Each round: wait for the redial's socket, let the relay close it before the handshake with "PC offline" (4002).
        const delays = [];
        let last = world.clock.now;
        for (let i = 0; i < op.rounds; i += 1) {
          const before = world.sockets.length;
          let guard = 0;
          while (world.sockets.length === before && guard++ < 200) await world.advance(1000);
          const ws = world.sockets[world.sockets.length - 1];
          // The delay is read from the socket's creation event, not from the polling step.
          const created = world.events.findLast((e) => e.ev === 'socket' && e.n === world.sockets.length);
          delays.push(created.at - last);
          ws.readyState = 1;
          ws.onopen?.();
          world.peerClose(ws, 4002);
          last = world.clock.now;
          await world.advance(0);
        }
        checkpoint('offline', { maxRedialDelayMs: Math.max(...delays), offlineSeen: true });
        break;
      }
      default:
        throw new Error(`unknown op ${op.op}`);
    }
  }
  return trace;
}
