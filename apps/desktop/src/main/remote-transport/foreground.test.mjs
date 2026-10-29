import assert from 'node:assert/strict';
import test from 'node:test';

import { legIsLive, legShowsSession, noteLegLive, someLegShowsSession } from './foreground.ts';

const leg = (extra = {}) => ({ background: false, screenSessionIds: new Set(['s1']), ...extra });

test('a frozen phone is foreground at 34 999 ms and not at 35 000 ms while its leg stays registered', () => {
  let clock = 1_000;
  const legs = new Map([['leg-1', leg()]]);
  noteLegLive(legs.get('leg-1'), clock);
  const shows = () => someLegShowsSession(legs.values(), 's1', undefined, clock);
  assert.equal(shows(), true);
  clock = 1_000 + 34_999;
  assert.equal(shows(), true);
  clock = 1_000 + 35_000;
  assert.equal(shows(), false);
  assert.equal(legs.size, 1);
  assert.equal(legs.get('leg-1').background, false);
  // Authenticated liveness returns it to foreground.
  noteLegLive(legs.get('leg-1'), clock);
  assert.equal(shows(), true);
});

test('each authenticated liveness restarts the window', () => {
  const frozen = leg();
  noteLegLive(frozen, 0);
  noteLegLive(frozen, 30_000);
  assert.equal(legShowsSession(frozen, 's1', 64_999), true);
  assert.equal(legShowsSession(frozen, 's1', 65_000), false);
});

test('a hidden report removes eligibility at once', () => {
  const phone = leg();
  noteLegLive(phone, 0);
  assert.equal(legShowsSession(phone, 's1', 1), true);
  phone.background = true;
  noteLegLive(phone, 2);
  assert.equal(legShowsSession(phone, 's1', 3), false);
  phone.background = false;
  assert.equal(legShowsSession(phone, 's1', 3), true);
});

test('a leg with no authenticated liveness yet is not foreground', () => {
  assert.equal(legIsLive({}, 0), false);
  assert.equal(legShowsSession(leg(), 's1', 0), false);
});

test('only a session the leg reports on screen counts, and match narrows the legs', () => {
  const a = leg({ credentialId: 'a' });
  const b = leg({ credentialId: 'b', screenSessionIds: new Set(['s2']) });
  const none = leg({ screenSessionIds: undefined });
  for (const l of [a, b, none]) noteLegLive(l, 0);
  assert.equal(legShowsSession(none, 's1', 1), false);
  assert.equal(legShowsSession(a, 's2', 1), false);
  const legs = [a, b];
  assert.equal(
    someLegShowsSession(legs, 's2', (l) => l.credentialId === 'b', 1),
    true
  );
  assert.equal(
    someLegShowsSession(legs, 's2', (l) => l.credentialId === 'a', 1),
    false
  );
});
