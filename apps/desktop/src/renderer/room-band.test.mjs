// A room's band (roomTypingOf) draws the typing row the core supplied, with no memory of earlier rows: the core publishes a
// member's words together with the end of its typing, names nobody while its supervisor chooses (an unnamed typing row, so the
// band keeps its footprint) and drops the row only when the room finishes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

const user = (id) => ({ kind: 'user', id, text: 'hi' });
const speech = (id, speaker) => ({
  kind: 'notice',
  id,
  text: 'words',
  room: { kind: 'speech', speaker, name: speaker },
});
const typing = (id, speaker) => ({
  kind: 'notice',
  id,
  text: `${speaker}…`,
  room: { kind: 'typing', speaker, name: speaker.toUpperCase() },
});
const deciding = {
  kind: 'notice',
  id: 'room-deciding',
  text: '…',
  room: { kind: 'typing', speaker: '', name: '', deciding: true },
};

async function selector(t) {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['Element', 'HTMLElement', 'Node', 'Event', 'CustomEvent'],
  });
  t.after(restore);
  const { roomTypingOf } = await import('./use-conversation-row-renderer.ts');
  return roomTypingOf;
}

test('the band follows the supplied rows through an exchange: typing, hand-off, typing, finished', async (t) => {
  const bandOf = await selector(t);
  const u1 = user('u1');
  const a1 = speech('a1', 'alpha');
  const b1 = speech('b1', 'beta');
  const states = [
    [[u1, deciding], ''],
    [[u1, typing('t1', 'alpha')], 'alpha'],
    // Alpha's words and the end of its typing arrive in one state: its bubble is replaced by the hand-off band.
    [[u1, a1, deciding], ''],
    [[u1, a1, typing('t2', 'beta')], 'beta'],
    [[u1, a1, b1, deciding], ''],
    [[u1, a1, b1], null],
  ];
  const seen = states.map(([items]) => {
    const band = bandOf(true, items);
    return band ? band.speaker : null;
  });
  assert.deepEqual(
    seen,
    states.map(([, expected]) => expected)
  );
});

test('the band is read from the rows alone: the same rows give the same band whatever came before', async (t) => {
  const bandOf = await selector(t);
  const items = [user('u1'), typing('t1', 'alpha')];
  bandOf(true, [user('u1'), speech('a1', 'alpha'), typing('t1', 'alpha')]);
  assert.deepEqual(bandOf(true, items), { speaker: 'alpha', name: 'ALPHA', deciding: false });
  assert.deepEqual(
    bandOf(true, [user('u1'), deciding]),
    { speaker: '', name: '', deciding: true },
    'the hand-off is its own state'
  );
  assert.equal(bandOf(true, [user('u1'), speech('a1', 'alpha')]), null, 'no typing row, no band: nothing is held');
  assert.equal(bandOf(false, items), null, 'a conversation that is not a room has no room band');
});
