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
  // A wake after a long offline backoff redials at once and restarts the backoff from the minimum.
  'wake-after-offline': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'random', value: 1 },
    { op: 'drop', code: 1006 },
    { op: 'offline-redials', rounds: 8, name: 'offline-backed-off' },
    { op: 'event', target: 'window', type: 'focus' },
    { op: 'advance', ms: 0 },
    { op: 'mark', name: 'wake-dials' },
    { op: 'offline-redials', rounds: 3, name: 'offline-again' },
  ],
  // A failure that is not "PC offline" brings the 10 s ceiling back after a grown offline backoff.
  'other-failure-after-offline': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'random', value: 1 },
    { op: 'drop', code: 1006 },
    { op: 'offline-redials', rounds: 6, name: 'offline-backed-off' },
    { op: 'offline-redials', rounds: 6, code: 1006, name: 'other-failures' },
  ],
  // The relay's older resync hint asks for a resync on a live leg.
  'relay-resync-hint': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'relay-hint' },
    { op: 'mark', name: 'hint' },
  ],
  // Closes that are not a revoked pairing keep reconnecting by themselves and never ask the user.
  'transient-closes': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'random', value: 0.5 },
    { op: 'drop', code: 1001 },
    { op: 'advance', ms: 1500 },
    { op: 'accept' },
    { op: 'check', name: 'after-1001', expect: { foreground: true } },
    { op: 'drop', code: 1011 },
    { op: 'advance', ms: 1500 },
    { op: 'accept' },
    { op: 'check', name: 'after-1011', expect: { foreground: true } },
    { op: 'drop', code: 1012 },
    { op: 'advance', ms: 1500 },
    { op: 'accept' },
    { op: 'check', name: 'after-1012', expect: { foreground: true } },
    { op: 'drop', code: 4004 },
    { op: 'advance', ms: 1500 },
    { op: 'mark', name: 'after-4004' },
  ],
  // A wake while the page is still frozen waits for resume before dialing.
  'frozen-wake': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'hide' },
    { op: 'advance', ms: 30000 },
    { op: 'mark', name: 'suspended' },
    { op: 'event', target: 'document', type: 'freeze' },
    { op: 'show' },
    { op: 'event', target: 'window', type: 'focus' },
    { op: 'advance', ms: 1000 },
    { op: 'mark', name: 'frozen-no-dial' },
    { op: 'event', target: 'document', type: 'resume' },
    { op: 'advance', ms: 0 },
    { op: 'mark', name: 'resumed-dials' },
    { op: 'accept' },
    { op: 'check', name: 'thawed', expect: { foreground: true } },
  ],
  // The resync a wake asks for leaves only once the relay has answered the probe.
  'wake-late-pong': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'hide' },
    { op: 'advance', ms: 10000 },
    { op: 'show' },
    { op: 'advance', ms: 1000 },
    { op: 'mark', name: 'probe-waiting' },
    { op: 'pong' },
    { op: 'mark', name: 'late-pong' },
    { op: 'advance', ms: 5000 },
    { op: 'mark', name: 'quiet-after' },
  ],
  // A backgrounded leg found dead on resume redials silently, even with a call in flight.
  'dead-on-resume': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'call' },
    { op: 'hide' },
    { op: 'advance', ms: 10000 },
    { op: 'show' },
    { op: 'stray' },
    { op: 'advance', ms: 2500 },
    { op: 'mark', name: 'recycled' },
    { op: 'advance', ms: 1500 },
    { op: 'accept' },
    { op: 'check', name: 'redialed', expect: { foreground: true } },
  ],
  // A close delivered as the page thaws redials silently.
  'close-on-thaw': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'hide' },
    { op: 'thaw' },
    { op: 'drop', code: 1006 },
    { op: 'advance', ms: 0 },
    { op: 'mark', name: 'thaw-close' },
    { op: 'accept' },
    { op: 'check', name: 'redialed', expect: { foreground: true } },
  ],
  // A leg still delivering its backlog well after the probe is kept, and its resync goes out.
  'backlog-kept': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'hide' },
    { op: 'advance', ms: 10000 },
    { op: 'show' },
    { op: 'advance', ms: 1500 },
    { op: 'stray' },
    { op: 'advance', ms: 1000 },
    { op: 'mark', name: 'kept' },
  ],
  // A proven leg that drops in view takes the visible reconnect path.
  'proven-drop-visible': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'hide' },
    { op: 'advance', ms: 10000 },
    { op: 'show' },
    { op: 'pong' },
    { op: 'random', value: 0 },
    { op: 'drop', code: 1006 },
    { op: 'advance', ms: 0 },
    { op: 'mark', name: 'dropped' },
    { op: 'accept' },
    { op: 'check', name: 'redialed', expect: { foreground: true } },
  ],
  // Handshake restarts on one joining socket are bounded: the first challenge and two more are answered, the fourth ends the socket.
  'restarts-bounded': [
    { op: 'boot' },
    { op: 'hold-hello' },
    { op: 'accept' },
    { op: 'hello' },
    { op: 'rechallenge' },
    { op: 'hello' },
    { op: 'rechallenge' },
    { op: 'hello' },
    { op: 'mark', name: 'three-answered' },
    { op: 'rechallenge' },
    { op: 'advance', ms: 0 },
    { op: 'mark', name: 'fourth-refused' },
  ],
  // A resync the desktop refuses is retried after 250 ms (remote-view-sync.ts:24) and the indicator stays on syncing until it completes.
  'resync-fails-once': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'fail-sync', times: 1 },
    { op: 'relay-hint' },
    { op: 'mark', name: 'refused' },
    { op: 'advance', ms: 249 },
    { op: 'mark', name: 'waiting' },
    { op: 'advance', ms: 1 },
    { op: 'mark', name: 'retried' },
  ],
  // Three refusals in a row: retries after 250 and 500 ms, then the connection is recycled (remote-view-sync.ts:16, :56-59) and redialed.
  'resync-fails-repeatedly': [
    { op: 'boot' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'fail-sync', times: 3 },
    { op: 'relay-hint' },
    { op: 'mark', name: 'first-refused' },
    { op: 'advance', ms: 250 },
    { op: 'mark', name: 'second-refused' },
    { op: 'advance', ms: 499 },
    { op: 'mark', name: 'before-third' },
    { op: 'advance', ms: 1 },
    { op: 'mark', name: 'recycled' },
    { op: 'accept' },
    { op: 'check', name: 'recovered', expect: { foreground: true } },
  ],
  // The PC offers the MXT transport and the phone (a browser with WebRTC) opts in: the hello carries the opt-in, the PC's ready carries the
  // transcript and the session runs over sealed records on the relay lane. Hidden, the transport's timers stop; each wake pings the relay lane.
  'mxt-negotiated': [
    { op: 'boot', mxt: true },
    { op: 'accept', flags: { transportWebrtc: 1, binaryFrames: 1 } },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'screen', ids: ['s1'] },
    { op: 'check', name: 'reports-over-records', expect: { foreground: true, screen: ['s1'] } },
    { op: 'advance', ms: 7000 },
    { op: 'mark', name: 'quiet-visible' },
    { op: 'hide' },
    { op: 'advance', ms: 10000 },
    { op: 'mark', name: 'hidden' },
    { op: 'show' },
    { op: 'pong' },
    { op: 'advance', ms: 5000 },
    { op: 'mark', name: 'woken' },
  ],
  // Hidden past the grace with a transport: the transport says it is suspended, then the socket is released with 1000 background.
  'mxt-background': [
    { op: 'boot', mxt: true },
    { op: 'accept', flags: { transportWebrtc: 1, binaryFrames: 1 } },
    { op: 'check', name: 'connected', expect: { foreground: true } },
    { op: 'hide' },
    { op: 'advance', ms: 30000 },
    { op: 'mark', name: 'suspended' },
    { op: 'show' },
    { op: 'accept', flags: { transportWebrtc: 1, binaryFrames: 1 } },
    { op: 'check', name: 'back', expect: { foreground: true } },
  ],
  // The relay stripped the PC's transport offer from the challenge the phone saw, yet the PC's ready carries the transcript: refused, never a
  // silent legacy session.
  'mxt-stripped-offer': [
    { op: 'boot', mxt: true },
    { op: 'accept', flags: { transportWebrtc: 1, binaryFrames: 1, stripOffer: 1 } },
    { op: 'advance', ms: 0 },
    { op: 'mark', name: 'refused' },
  ],
  // A browser that refuses to construct a socket does not pin the connection to the rejected attempt.
  'socket-ctor-throws': [
    { op: 'boot', socketThrows: 1 },
    { op: 'advance', ms: 0 },
    { op: 'mark', name: 'refused' },
    { op: 'accept' },
    { op: 'check', name: 'connected', expect: { foreground: true } },
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
  let hellos = 0;
  const refused = new Set();
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
        .filter((e) => e.ev === 'ping' || e.ev === 'close' || e.ev === 'socket' || e.ev === 'resync' || e.ev === 'xcontrol')
        .map((e) => `${e.ev === 'xcontrol' ? `x:${e.kind}` : e.ev}${e.ev === 'close' ? `(${e.code},${e.reason})` : ''}@${e.at - since}`),
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
        world.throwNext = op.socketThrows ?? 0;
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
        // Each round: wait for the redial's socket, let the relay close it (by default before the handshake with "PC offline", 4002).
        const delays = [];
        let last = world.clock.now;
        for (let i = 0; i < op.rounds; i += 1) {
          const pending = () => world.sockets.find((s) => !refused.has(s) && !world.accepted(s));
          let guard = 0;
          while (!pending() && guard++ < 400) await world.advance(250);
          const ws = pending();
          refused.add(ws);
          // The delay is read from the socket's creation event, not from the polling step.
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
