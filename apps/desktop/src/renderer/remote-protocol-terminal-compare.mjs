// How a replayed phone-terminal trace is compared with Node's recording: the whole ordered trace (every answer and every lane's push in
// the order the page saw them, the size-claim timeline too), entry by entry so a failure names the entry.
import assert from 'node:assert/strict';

export function compareTraces(got, golden) {
  for (const part of ['order', 'claims.order']) {
    const [mine, theirs] = [got, golden].map((trace) => part.split('.').reduce((value, key) => value[key], trace));
    assert.equal(mine.length, theirs.length, `${part}: the number of entries`);
    theirs.forEach((expected, i) => assert.deepEqual(mine[i], expected, `${part} entry ${i}`));
  }
  assert.deepEqual(got, golden);
}
