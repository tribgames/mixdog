import assert from 'node:assert/strict';
import test from 'node:test';

import { ScreenInputRouter } from './screen-input-router.ts';

const keyDown = (vk, scan = 0x1e) => ({ op: 'key', vk, scan, extended: false, down: true });
const keyUp = (vk, scan = 0x1e) => ({ op: 'key', vk, scan, extended: false, down: false });

function backend(identity) {
  const state = { sent: [], reachable: true, gate: null, identity };
  return {
    state,
    identity: () => state.identity,
    send: async (command) => {
      if (state.gate) await state.gate;
      if (!state.reachable) throw new Error('unreachable');
      if (state.failText && command.op === 'text') throw new Error('text failed');
      state.sent.push(command);
    },
  };
}

const DEFAULT_1 = { session: 1, desktop: 'default' };
const WINLOGON_1 = { session: 1, desktop: 'winlogon' };

function build() {
  const desktop = backend(DEFAULT_1);
  const secure = backend(WINLOGON_1);
  const dropped = [];
  const router = new ScreenInputRouter({ desktop, secure }, (id, count) => dropped.push([id, count]));
  return { router, desktop: desktop.state, secure: secure.state, dropped };
}

const always = () => true;

test('releaseAll lifts every held press once and is idempotent', async () => {
  const env = build();
  await env.router.switchTo('desktop');
  await env.router.dispatch([keyDown(0x41)], always);
  await env.router.dispatch([{ op: 'button', button: 'left', down: true, at: { x: 1, y: 1 } }], always);
  env.desktop.sent.length = 0;
  await env.router.releaseAll();
  assert.equal(env.desktop.sent.length, 2);
  assert.ok(env.desktop.sent.every((command) => command.down === false));
  await env.router.releaseAll();
  assert.equal(env.desktop.sent.length, 2, 'a second release sends nothing');
  assert.equal(env.router.holdsInput(), false);
});

test('an up for a press this backend does not own is skipped', async () => {
  const env = build();
  await env.router.switchTo('desktop');
  assert.equal(await env.router.dispatch([keyUp(0x41)], always), 'applied');
  assert.deepEqual(env.desktop.sent, []);
});

test('a backend switch releases the old backend’s presses through it, before the switch', async () => {
  const env = build();
  await env.router.switchTo('desktop');
  await env.router.dispatch([keyDown(0xa2, 0x1d)], always);
  let releasedFirst = false;
  await env.router.switchTo('secure', {
    before: async () => {
      releasedFirst = env.desktop.sent.at(-1)?.down === false && env.router.activeBackend() === 'desktop';
    },
  });
  assert.ok(releasedFirst, 'released while the old backend was still active');
  assert.deepEqual(env.desktop.sent.at(-1), keyUp(0xa2, 0x1d));
  assert.deepEqual(env.secure.sent, [], 'the new backend never sees the old press’s release');
  assert.equal(env.router.activeBackend(), 'secure');
  assert.deepEqual(env.dropped, []);
});

test('a press its backend can’t release at the switch is dropped and counted, never carried', async () => {
  const env = build();
  await env.router.switchTo('desktop');
  await env.router.dispatch([keyDown(0x41)], always);
  env.desktop.reachable = false;
  await env.router.switchTo('secure');
  assert.deepEqual(env.dropped, [['desktop', 1]]);
  assert.equal(env.router.holdsInput(), false);
  assert.deepEqual(env.secure.sent, [], 'not sent through the other backend');

  // The desktop is reachable again: nothing is sent late.
  env.desktop.reachable = true;
  await env.router.switchTo('desktop');
  await env.router.releaseAll();
  assert.deepEqual(env.desktop.sent, [keyDown(0x41)]);
});

test('cancel drops queued input but the final release runs after the in-flight command', async () => {
  const env = build();
  await env.router.switchTo('desktop');
  let open;
  env.desktop.gate = new Promise((resolve) => {
    open = resolve;
  });
  const inFlight = env.router.dispatch([keyDown(0x41)], always);
  // Let its turn begin so it is truly in flight (waiting on the backend).
  await new Promise((resolve) => setTimeout(resolve, 0));
  const queued = env.router.dispatch([keyDown(0x42, 0x30)], always);
  env.router.cancel();
  const release = env.router.releaseAll();
  env.desktop.gate = null;
  open();
  assert.equal(await inFlight, 'applied');
  assert.equal(await queued, 'rejected');
  await release;
  assert.deepEqual(env.desktop.sent, [keyDown(0x41), keyUp(0x41)]);
  assert.equal(env.router.holdsInput(), false);
});

test('the gate is re-read between the commands of one plan', async () => {
  const env = build();
  await env.router.switchTo('desktop');
  // Allowed at the turn and for the first command, revoked before the second.
  let checks = 0;
  const outcome = env.router.dispatch([{ op: 'move', x: 1, y: 1 }, keyDown(0x41)], () => {
    checks += 1;
    return checks <= 2;
  });
  assert.equal(await outcome, 'rejected');
  assert.deepEqual(env.desktop.sent, [{ op: 'move', x: 1, y: 1 }]);
});

test('text is refused while a shortcut modifier is held, allowed with Shift', async () => {
  const env = build();
  await env.router.switchTo('desktop');
  await env.router.dispatch([keyDown(0xa0, 0x2a)], always);
  assert.equal(await env.router.dispatch([{ op: 'text', text: 'a' }], always), 'applied');
  await env.router.dispatch([keyDown(0xa2, 0x1d)], always);
  assert.equal(await env.router.dispatch([{ op: 'text', text: 'a' }], always), 'rejected');
  await env.router.dispatch([keyUp(0xa2, 0x1d)], always);
  assert.equal(await env.router.dispatch([{ op: 'text', text: 'a' }], always), 'applied');
});

test('AltGr text: the session-held AltGr keys are lifted around the text and pressed again', async () => {
  const env = build();
  await env.router.switchTo('desktop');
  const leftCtrl = keyDown(0xa2, 0x1d);
  const rightAlt = { op: 'key', vk: 0xa5, scan: 0x38, extended: true, down: true };
  await env.router.dispatch([leftCtrl, rightAlt], always);
  env.desktop.sent.length = 0;

  assert.equal(await env.router.dispatch([{ op: 'text', text: '€' }], always), 'applied');
  assert.deepEqual(env.desktop.sent, [
    { ...leftCtrl, down: false },
    { ...rightAlt, down: false },
    { op: 'text', text: '€' },
    leftCtrl,
    rightAlt,
  ]);
  // Still held as far as the session knows: a release lifts both once.
  env.desktop.sent.length = 0;
  await env.router.releaseAll();
  assert.deepEqual(env.desktop.sent.map((c) => [c.vk, c.down]).sort(), [
    [0xa2, false],
    [0xa5, false],
  ]);
});

test('Right Alt alone counts as AltGr; Ctrl+Left Alt and AltGr+Win stay shortcuts', async () => {
  const rightAlt = { op: 'key', vk: 0xa5, scan: 0x38, extended: true, down: true };
  const alone = build();
  await alone.router.switchTo('desktop');
  await alone.router.dispatch([rightAlt], always);
  assert.equal(await alone.router.dispatch([{ op: 'text', text: '@' }], always), 'applied');

  const ctrlAlt = build();
  await ctrlAlt.router.switchTo('desktop');
  await ctrlAlt.router.dispatch([keyDown(0xa2, 0x1d), keyDown(0xa4, 0x38)], always);
  ctrlAlt.desktop.sent.length = 0;
  assert.equal(await ctrlAlt.router.dispatch([{ op: 'text', text: 'a' }], always), 'rejected');
  assert.deepEqual(ctrlAlt.desktop.sent, [], 'refused text sends nothing and is not retried');

  const withWin = build();
  await withWin.router.switchTo('desktop');
  await withWin.router.dispatch([rightAlt, { op: 'key', vk: 0x5b, scan: 0x5b, extended: true, down: true }], always);
  assert.equal(await withWin.router.dispatch([{ op: 'text', text: 'a' }], always), 'rejected');
});

test('AltGr keys are pressed again even when the text itself fails', async () => {
  const env = build();
  await env.router.switchTo('desktop');
  const rightAlt = { op: 'key', vk: 0xa5, scan: 0x38, extended: true, down: true };
  await env.router.dispatch([rightAlt], always);
  env.desktop.sent.length = 0;
  env.desktop.failText = true;
  assert.equal(await env.router.dispatch([{ op: 'text', text: 'x' }], always), 'rejected');
  assert.deepEqual(env.desktop.sent, [{ ...rightAlt, down: false }, rightAlt]);
});

test('abandon cuts an in-flight send and every later one; the releases are dropped and counted', async () => {
  const env = build();
  await env.router.switchTo('desktop');
  await env.router.dispatch([keyDown(0x41)], always);
  env.desktop.gate = new Promise(() => {});
  const hung = env.router.dispatch([keyDown(0x42, 0x30)], always);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const release = env.router.releaseAll();
  env.router.abandon();
  assert.equal(await hung, 'rejected');
  await release;
  // The held press and the one cut off mid-delivery.
  assert.deepEqual(env.dropped, [['desktop', 2]]);
  assert.equal(env.router.holdsInput(), false);
  assert.equal(await env.router.dispatch([{ op: 'move', x: 1, y: 1 }], always), 'rejected');
});

test('a cancel during the AltGr lift: no text, no re-press, nothing left held', async () => {
  const env = build();
  await env.router.switchTo('desktop');
  const leftCtrl = keyDown(0xa2, 0x1d);
  const rightAlt = { op: 'key', vk: 0xa5, scan: 0x38, extended: true, down: true };
  await env.router.dispatch([leftCtrl, rightAlt], always);
  env.desktop.sent.length = 0;
  let open;
  env.desktop.gate = new Promise((resolve) => {
    open = resolve;
  });
  const typing = env.router.dispatch([{ op: 'text', text: '€' }], always);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // A stop lands while the first lift is in flight.
  env.router.cancel();
  env.desktop.gate = null;
  open();
  assert.equal(await typing, 'rejected');
  assert.deepEqual(env.desktop.sent, [
    { ...leftCtrl, down: false },
    { ...rightAlt, down: false },
  ]);
  // Both are up and no longer held: the release that follows sends nothing.
  await env.router.releaseAll();
  assert.equal(env.desktop.sent.length, 2);
  assert.equal(env.router.holdsInput(), false);
});

test('the backend moves to another session during the AltGr lift: no further lift, text or re-press there', async () => {
  const env = build();
  await env.router.switchTo('desktop');
  const leftCtrl = keyDown(0xa2, 0x1d);
  const rightAlt = { op: 'key', vk: 0xa5, scan: 0x38, extended: true, down: true };
  // Left Ctrl + Right Alt held in session 1.
  await env.router.dispatch([leftCtrl, rightAlt], always);
  env.desktop.sent.length = 0;
  let open;
  env.desktop.gate = new Promise((resolve) => {
    open = resolve;
  });
  const typing = env.router.dispatch([{ op: 'text', text: '€' }], always);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // While the first modifier-up's ack is pending, the backend now lands in session 2.
  env.desktop.identity = { session: 2, desktop: 'default' };
  env.desktop.gate = null;
  open();
  assert.equal(await typing, 'rejected');
  // Only the Left Ctrl up already in flight to session 1 went out: no Right Alt
  // up, no text and no re-press reached session 2.
  assert.deepEqual(env.desktop.sent, [{ ...leftCtrl, down: false }]);
  // Right Alt can't be released on session 1 now: dropped and counted.
  assert.deepEqual(env.dropped, [['desktop', 1]]);
  assert.equal(env.router.holdsInput(), false);
  await env.router.releaseAll();
  assert.equal(env.desktop.sent.length, 1, 'nothing is sent later');
});

test('a revoke after the text, before the re-press: AltGr is never pressed again', async () => {
  const env = build();
  await env.router.switchTo('desktop');
  const rightAlt = { op: 'key', vk: 0xa5, scan: 0x38, extended: true, down: true };
  await env.router.dispatch([rightAlt], always);
  env.desktop.sent.length = 0;
  // Authorization is lost the moment the text has gone out.
  const allowed = () => !env.desktop.sent.some((c) => c.op === 'text');
  assert.equal(await env.router.dispatch([{ op: 'text', text: '@' }], allowed), 'applied');
  assert.deepEqual(env.desktop.sent, [{ ...rightAlt, down: false }, { op: 'text', text: '@' }]);
  await env.router.releaseAll();
  assert.equal(env.desktop.sent.length, 2, 'nothing held: the key is up');
});

test('a revoke before the text: the lifted keys stay up and the text is not sent', async () => {
  const env = build();
  await env.router.switchTo('desktop');
  const rightAlt = { op: 'key', vk: 0xa5, scan: 0x38, extended: true, down: true };
  await env.router.dispatch([rightAlt], always);
  env.desktop.sent.length = 0;
  // Allowed at the turn and for the text command check, gone once lifting began.
  const allowed = () => env.desktop.sent.length === 0;
  assert.equal(await env.router.dispatch([{ op: 'text', text: '@' }], allowed), 'rejected');
  assert.deepEqual(env.desktop.sent, [{ ...rightAlt, down: false }]);
});

test('no key-up reaches another session or desktop: it is dropped, not sent later', async () => {
  for (const elsewhere of [
    { session: 2, desktop: 'winlogon' },
    { session: 1, desktop: 'default' },
  ]) {
    const env = build();
    await env.router.switchTo('secure');
    await env.router.dispatch([keyDown(0x41)], always);
    // The helper reconnected to another session, or moved to another desktop.
    env.secure.identity = elsewhere;
    env.secure.sent.length = 0;
    await env.router.releaseAll();
    assert.deepEqual(env.secure.sent, [], 'never sent there');
    assert.deepEqual(env.dropped, [['secure', 1]]);
    // Back on the press's desktop: nothing is carried over.
    env.secure.identity = WINLOGON_1;
    await env.router.releaseAll();
    assert.deepEqual(env.secure.sent, []);
  }
});

test('each origin’s press of the same key is released only on its own desktop', async () => {
  const env = build();
  await env.router.switchTo('secure');
  await env.router.dispatch([keyDown(0x41)], always);
  env.secure.identity = { session: 1, desktop: 'locked' };
  await env.router.dispatch([keyDown(0x41)], always);
  env.secure.sent.length = 0;
  // The phone lifts A while on `locked`: that press is released here; the
  // winlogon one is not lifted on `locked`.
  assert.equal(await env.router.dispatch([keyUp(0x41)], always), 'applied');
  assert.deepEqual(env.secure.sent, [keyUp(0x41)]);
  assert.equal(env.router.holdsInput(), true);
  // At the next release point, still on `locked`, the winlogon press is dropped.
  await env.router.releaseAll();
  assert.deepEqual(env.secure.sent, [keyUp(0x41)]);
  assert.deepEqual(env.dropped, [['secure', 1]]);
  assert.equal(env.router.holdsInput(), false);
});

test('no press is made where the landing desktop is unknown', async () => {
  const env = build();
  await env.router.switchTo('desktop');
  env.desktop.identity = null;
  assert.equal(await env.router.dispatch([keyDown(0x41)], always), 'rejected');
  assert.deepEqual(env.desktop.sent, []);
  assert.equal(env.router.holdsInput(), false);
});

test('abandon also cuts a switch hook that never settles', async () => {
  const env = build();
  const switching = env.router.switchTo('secure', { before: () => new Promise(() => {}) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  env.router.abandon();
  await switching;
  await env.router.releaseAll();
});

test('a switch to no backend releases first, then input is rejected', async () => {
  const env = build();
  await env.router.switchTo('desktop');
  await env.router.dispatch([keyDown(0x41)], always);
  await env.router.switchTo(null);
  assert.deepEqual(env.desktop.sent.at(-1), keyUp(0x41));
  assert.equal(await env.router.dispatch([{ op: 'move', x: 1, y: 1 }], always), 'rejected');
  assert.equal(env.router.holdsInput(), false);
});
