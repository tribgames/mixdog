// An aggregate tool card holds its members' outputs joined as a rope over their strings. Finding a card equal to the one
// held must not flatten the ropes: each would become a copy of every member's text, kept as long as the card is.
import assert from 'node:assert/strict';
import test from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import { reconcileSessionProjection } from './state-delta.ts';

v8.setFlagsFromString('--expose-gc');
const collect = vm.runInNewContext('gc');
/** What stays held: weakly keyed entries go a collection after their keys, so it settles over a few turns. */
const heldBytes = async () => {
  for (let round = 0; round < 4; round += 1) {
    collect();
    await new Promise((turn) => setImmediate(turn));
  }
  return v8.getHeapStatistics().used_heap_size;
};

const MEMBERS = 16;
const TEXT_BYTES = 512 * 1024;
const outputs = Array.from({ length: MEMBERS }, (_, index) =>
  JSON.parse(JSON.stringify(`${String(index).padStart(8, '0')}:`.repeat(TEXT_BYTES / 9)))
);
/** A card as the client makes it: the join built by `+`, over the member strings. */
function card(extra = {}) {
  let rawResult = '';
  for (const [index, text] of outputs.entries()) rawResult += `${index ? '\n\n' : ''}${text}`;
  return {
    kind: 'tool',
    id: 't0',
    name: '__aggregate__',
    aggregate: true,
    completedCount: MEMBERS,
    toolMembers: outputs.map((text, index) => ({ id: `t${index}`, name: 'read', result: text, rawResult: text })),
    result: 'Read 16 files',
    rawResult,
    ...extra,
  };
}

test('a card equal to the held one is found so without a copy of the outputs of its members', async () => {
  const held = { sessionId: 's', items: [card()] };
  const brought = { sessionId: 's', items: [card()] };
  const before = await heldBytes();
  const merged = reconcileSessionProjection(held, brought);
  assert.equal(merged, held, 'the projection held stands');
  const grown = (await heldBytes()) - before;
  assert.ok(held.items[0].rawResult.length > MEMBERS * TEXT_BYTES * 0.9 && brought.items[0].rawResult.length > 0);
  assert.ok(
    grown < TEXT_BYTES,
    `comparing the cards held ${grown} more bytes (their joined outputs are ${MEMBERS * TEXT_BYTES})`
  );
});

test('a card whose member changed, or whose join differs in length, is not the held one', () => {
  const held = { sessionId: 's', items: [card()] };
  const longer = card();
  longer.rawResult += ' [cancelled]';
  assert.equal(reconcileSessionProjection(held, { sessionId: 's', items: [longer] }).items[0], longer);
  const changed = card();
  changed.toolMembers[3] = { ...changed.toolMembers[3], result: 'other', rawResult: 'other' };
  assert.equal(reconcileSessionProjection(held, { sessionId: 's', items: [changed] }).items[0], changed);
  // A row that is no aggregate compares its text whole.
  const plain = { sessionId: 's', items: [{ id: 'a', kind: 'tool', rawResult: 'same length A' }] };
  const other = { sessionId: 's', items: [{ id: 'a', kind: 'tool', rawResult: 'same length B' }] };
  assert.notEqual(reconcileSessionProjection(plain, other).items[0], plain.items[0]);
});
