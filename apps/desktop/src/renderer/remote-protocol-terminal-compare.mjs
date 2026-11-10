// How a replayed phone-terminal trace is compared with Node's recording: the whole ordered trace (every answer and every lane's push in
// the order the relay sent them to the phone, the size-claim timeline and its clock advances too), entry by entry so a failure names the entry.
//
// Terminal output (`termData`) is in that list as the phone received it. Its chunking and its place between two answers are timing (the
// shell's, ConPTY's, the relay's 16 ms buffer): variance.json, written by the recorder from several recordings of Node, shows the slots
// where Node itself disagrees with itself. The entries that are not output were identical in every Node run, so they are compared in full
// and in order; the output is compared by:
//   1. which tabs streamed output;
//   2. that a tab Node killed at two columns ends with an exit line (its last bytes are the kill's timing; the code is the host's).
//   3. for a tab of the Command Prompt profile (`termEnsure(id, cwd, 'cmd')`, a profile a phone names as the desktop's picker does), the
//      bytes it streamed before its dispose was answered, byte for byte: Node's own runs gave one byte stream (variance.json,
//      `bytesBeforeDisposeDistinct`), and the comparison refuses to run if they did not.
// What a PowerShell tab's bytes were is not compared: PSReadLine redraws the typed line per run (Node's own runs: 3 distinct byte streams for
// the same screens). The screen at every checkpoint, which the other entries hold, is what is compared for it.
import assert from 'node:assert/strict';
import { bytesBeforeDispose } from '../../../../benchmarks/rust-core/recorders/lib/trace-variance.mjs';

/** Tabs whose output is compared byte for byte (the `cmd` profile's). */
const BYTE_EXACT = new Set(['term_ph2c']);

// A tab whose output is not compared byte for byte, and why: the clamp tab's shell is killed at 2 columns while ConPTY redraws it, so what it
// wrote in its last moments is the kill's timing (Node's own bytes were the same in 5 runs, the core's differ in where the redraw is cut),
// and its exit line carries the kill's code (Node -1073741510, the core 137). That it streamed and that it ended with an
// exit line is compared; the code is open (see the report).
const KILLED_AT_TWO_COLUMNS = new Set(['term_ph2b']);
const EXIT_LINE = /\r\n\[process exited with code -?\d+\]\r\n$/;

const isData = (entry) => entry.push === 'termData';
const withoutData = (list) => list.filter((entry) => !isData(entry));
/** Per tab: its output, joined in the order it arrived. */
function outputOf(list) {
  const output = {};
  for (const entry of list) if (isData(entry)) output[entry.event.id] = (output[entry.event.id] ?? '') + entry.event.data;
  return output;
}

/** The entries up to and with the last dispose answer, and the rest. */
function splitAtLastDispose(list, part) {
  const at = part === 'claims.order' ? list.map((entry) => entry.call).lastIndexOf('termDispose') + 1 : list.length;
  return [list.slice(0, at), list.slice(at)];
}

function assertLateActivity(tail, what) {
  const last = tail.at(-1);
  assert.deepEqual(last, { lane: 'terminal', on: false }, `${what}: the lane goes off last`);
  const open = new Set();
  for (const entry of tail.slice(0, -1)) {
    const { id, state } = entry.event ?? {};
    assert.equal(entry.push, 'activity', `${what}: only activity, got ${JSON.stringify(entry)}`);
    if (state === 'running') assert.ok(!open.has(id) && open.add(id), `${what}: ${id} runs once`);
    else assert.ok(state === null && open.delete(id), `${what}: ${id} ends only after it ran`);
  }
  assert.equal(open.size, 0, `${what}: every late run ends`);
}

const tabsWithData = (list) => [...new Set(list.filter(isData).map((entry) => entry.event.id))].sort();

export function compareTraces(got, golden, variance) {
  for (const part of ['order', 'claims.order']) {
    const [mine, theirs] = [got, golden].map((trace) => part.split('.').reduce((value, key) => value[key], trace));
    assert.deepEqual(tabsWithData(mine), tabsWithData(theirs), `${part}: the tabs that streamed output`);
    const [mineKept, theirsKept] = [mine, theirs].map(withoutData);
    // Everything but the stretch after the last dispose answer is compared entry by entry. In that stretch Node's killed shells read late
    // output after the dispose (variance.json: some runs have it, some not, for any tab): each disposed tab may show `running` then its end,
    // before the lane goes off, and nothing else.
    const [mineHead, mineTail] = splitAtLastDispose(mineKept, part);
    const [theirsHead, theirsTail] = splitAtLastDispose(theirsKept, part);
    assert.equal(mineHead.length, theirsHead.length, `${part}: the number of entries`);
    theirsHead.forEach((expected, i) => assert.deepEqual(mineHead[i], expected, `${part} entry ${i}`));
    if (part === 'claims.order') for (const tail of [mineTail, theirsTail]) assertLateActivity(tail, `${part}: after the last dispose`);
    // Where the exit line stands against the end of the tab's activity is not timing: in Node the activity ends first (dispose calls
    // `activity.exit()` before the kill), and the exit line reaches the phone after it. Both lists are held to that.
    for (const list of [mine, theirs]) {
      list.forEach((entry, i) => {
        if (!isData(entry) || !/\[process exited with code/.test(entry.event.data)) return;
        const ended = list.findIndex((other) => other.push === 'activity' && other.event.id === entry.event.id && other.event.state === null);
        assert.ok(ended >= 0 && ended < i, `${part}: the exit line of ${entry.event.id} comes after the end of its activity`);
      });
    }
    const [mineOutput, theirOutput] = [mine, theirs].map(outputOf);
    for (const tab of tabsWithData(theirs)) {
      if (BYTE_EXACT.has(tab)) {
        const stable = variance[part].perTab[tab]?.bytesBeforeDisposeDistinct;
        assert.equal(stable, 1, `${part}: Node's ${variance.runs} runs gave ${stable} byte streams for ${tab}; record again before comparing bytes`);
        assert.equal(bytesBeforeDispose(mine, tab), bytesBeforeDispose(theirs, tab), `${part}: the bytes ${tab} streamed before its dispose`);
      }
      if (KILLED_AT_TWO_COLUMNS.has(tab)) {
        for (const output of [mineOutput, theirOutput]) assert.match(output[tab], EXIT_LINE, `${part}: ${tab} ends with an exit line`);
      }
    }
  }
}
