// How a replayed phone-terminal trace is compared with Node's recording: the whole ordered trace (every answer and every lane's push in
// the order the relay sent them to the phone, the size-claim timeline too), entry by entry so a failure names the entry.
//
// Terminal output (`termData`) is in that list as the phone received it, but its chunking and its bytes are not Node's to fix: the relay's
// 16 ms buffer cuts chunks by time, and the shell and ConPTY redraw the typed line and the screen in a different number of frames from run to
// run. Three recordings of Node gave the same order of every other entry, the same screens, and different chunks (96, 99 and 113 entries), different
// bytes per tab and, in 4 of 211 places between two other entries, data on the other side of an entry. So the data chunks are not compared
// one by one: the other entries are compared in full, the tabs that streamed output must be the same, and the text itself is compared as the
// screen it draws at every checkpoint (`screen` and `snap` entries, the points the script waits for).
import assert from 'node:assert/strict';

const isData = (entry) => entry.push === 'termData';
const withoutData = (list) => list.filter((entry) => !isData(entry));
const tabsWithData = (list) => [...new Set(list.filter(isData).map((entry) => entry.event.id))].sort();

export function compareTraces(got, golden) {
  for (const part of ['order', 'claims.order']) {
    const [mine, theirs] = [got, golden].map((trace) => part.split('.').reduce((value, key) => value[key], trace));
    assert.deepEqual(tabsWithData(mine), tabsWithData(theirs), `${part}: the tabs that streamed output`);
    const [mineKept, theirsKept] = [mine, theirs].map(withoutData);
    assert.equal(mineKept.length, theirsKept.length, `${part}: the number of entries`);
    theirsKept.forEach((expected, i) => assert.deepEqual(mineKept[i], expected, `${part} entry ${i}`));
  }
}
