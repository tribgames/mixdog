// How a replayed phone-terminal trace is compared with Node's recordings (apps/mobile/fixtures/phone-terminal/runs.json: every run the
// recorder made, none dropped). Each of the two ordered lists (`order`, `claims.order`) is compared whole:
//   1. its entries that are not output (answers, pushes, fires, lane switches, clock steps, screen checkpoints), position by position
//      with each of Node's runs: where the runs agree on an entry it must be theirs exactly, where they recorded different values (a
//      replay's bytes) that one entry is left out and named;
//   2. per tab and per slot (the stretch after one of those entries), the output frames the phone got there: their place and their
//      boundaries, exactly where the runs agree; and per slot, which tab's frame came after which, where the runs agree;
//   3. per tab, the whole output stream where the runs agree, and its exit line with the recorded code whenever the tab exits.
// The one variation Node recorded in the entries themselves: a disposed tab's shell, ending, may report one more command, a `running`
// then a `null` activity after the dispose answer and before the exit line (four of the five claim tabs did, in some of five runs; the
// five are disposed by the same calls at the same moment, so that variation is accepted for each of them, once, at that place, and
// nothing else is). The replay window's boundary cases (`trace.replayWindow`) are compared by mixdog-spawn tests/terminal.rs
// `the_replay_window_is_nodes_at_its_boundary`.
import assert from 'node:assert/strict';

const isData = (entry) => entry.push === 'termData';
const pick = (trace, part) => part.split('.').reduce((value, key) => value[key], trace);
const key = (value) => JSON.stringify(value ?? null);
const EXIT_LINE = /\[process exited with code -?\d+\]/;

/** The list without the variation Node recorded: a `running` activity of a tab after its dispose answer, and the `null` that must follow
 *  it before the tab's exit line, are taken out (once per disposal); every other entry stays and is compared. */
function withoutDisposalActivity(list, part) {
  // tab -> 'disposed' | 'running' (the extra pair is open) | 'done' (it was taken once)
  const state = new Map();
  const kept = [];
  for (const entry of list) {
    if (entry.call === 'termEnsure') state.delete(entry.params[0]);
    if (entry.call === 'termDispose' && !('error' in entry)) state.set(entry.params[0], 'disposed');
    if (entry.push === 'activity') {
      const { id, state: activity } = entry.event;
      if (activity === 'running' && state.get(id) === 'disposed') {
        state.set(id, 'running');
        continue;
      }
      if (activity === null && state.get(id) === 'running') {
        state.set(id, 'done');
        continue;
      }
    }
    if (isData(entry) && EXIT_LINE.test(entry.event.data)) {
      assert.ok(state.get(entry.event.id) !== 'running', `${part}: ${entry.event.id} exited while running after its dispose answer; Node: a running after the dispose ends (null) before the exit line`);
    }
    kept.push(entry);
  }
  for (const [id, at] of state) assert.ok(at !== 'running', `${part}: ${id}'s running after its dispose answer never ended`);
  return kept;
}

/** Whether a non-output entry belongs to `tab`'s own stream: its pushes, its calls, its screen checkpoints. */
const ownEntry = (entry, tab) =>
  entry.event?.id === tab || (entry.call !== undefined && entry.params?.[0] === tab) || entry.screen === tab || (entry.snap !== undefined && tab in (entry.screens ?? {}));

/** `tab`'s output per gap of its own stream: own entry index (among all non-output entries; -1 before the first) -> the frames between
 *  it and the tab's next own entry. Every own entry has its gap, empty when no frame came there. */
function framesByGap(list, tab) {
  const gaps = new Map([[-1, []]]);
  let index = -1;
  let gap = gaps.get(-1);
  for (const entry of list) {
    if (isData(entry)) {
      if (entry.event.id === tab) gap.push(entry.event.data);
      continue;
    }
    index += 1;
    if (!ownEntry(entry, tab)) continue;
    gaps.set(index, (gap = []));
  }
  return gaps;
}

const streamOf = (list, tab) => list.filter((entry) => isData(entry) && entry.event.id === tab).map((entry) => entry.event.data).join('');

/** Returns what was left out (each place Node's runs recorded different values); throws on the first difference. */
export function compareTraces(got, runs) {
  const leftOut = [];
  const agreed = (value, recorded, what) => {
    const values = [...new Set(recorded.map(key))];
    if (values.length > 1) {
      leftOut.push(what);
      return;
    }
    if (key(value) !== values[0]) assert.fail(`${what}\n  got:  ${key(value)}\n  Node: ${values[0]}`);
  };
  for (const part of ['order', 'claims.order']) {
    const mine = withoutDisposalActivity(pick(got, part), part);
    const all = runs.map((run) => withoutDisposalActivity(pick(run, part), `Node's ${part}`));
    const entries = (list) => list.filter((entry) => !isData(entry));
    const lengths = all.map((list) => entries(list).length);
    assert.equal(new Set(lengths).size, 1, `Node's runs differ in ${part} beyond the recorded variation (${lengths.join(', ')} entries)`);
    assert.equal(entries(mine).length, lengths[0], `${part}: ${entries(mine).length} entries besides output; Node: ${lengths[0]}`);
    entries(mine).forEach((entry, i) => agreed(entry, all.map((list) => entries(list)[i]), `${part} entry ${i}`));
    const tabs = [...new Set([mine, ...all].flatMap((list) => list.filter(isData).map((entry) => entry.event.id)))].sort();
    for (const tab of tabs) {
      // Where the tab's output sits among its own entries, and how it is cut: gap by gap, exactly where Node's runs agree on that gap.
      const [mineGaps, nodeGaps] = [framesByGap(mine, tab), all.map((list) => framesByGap(list, tab))];
      for (const at of nodeGaps[0].keys()) {
        const where = at < 0 ? 'before its first entry' : `after entry ${at}`;
        agreed(mineGaps.get(at), nodeGaps.map((gaps) => gaps.get(at)), `${part}: the output frames of ${tab} ${where}`);
      }
      agreed(streamOf(mine, tab), all.map((list) => streamOf(list, tab)), `${part}: the whole output of ${tab}`);
      const exits = [...new Set(all.map((list) => streamOf(list, tab).match(EXIT_LINE)?.[0] ?? null))];
      if (exits.length === 1 && exits[0] !== null) {
        const stream = streamOf(mine, tab);
        assert.ok(stream.trimEnd().endsWith(exits[0]), `${part}: ${tab}'s output does not end with its exit line ${exits[0]}: ${key(stream.slice(-200))}`);
      }
    }
  }
  return { leftOut };
}
