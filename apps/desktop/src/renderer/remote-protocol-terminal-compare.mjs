// How a replayed phone-terminal trace is compared with Node's recordings (apps/mobile/fixtures/phone-terminal/runs.json: every run the
// recorder made, none dropped). Every field of a run is compared: its three ordered lists `order`, `claims.order` and `immediate.order`.
// (golden.json's `replayWindow` is compared by mixdog-spawn tests/terminal.rs `the_replay_window_is_nodes_at_its_boundary` and
// remote-protocol-terminal-replay.test.mjs.) Values are compared by strict deep equality (null is not undefined, no field is ignored).
//
// What the script settles, and why (lib/phone-terminal-script.mjs): output that no answered call causes (a claim's resize re-render, a
// tab's prompt after its idle, a disposed tab's closing output against the next tab's dispose) is waited for before the next call. Its place
// among later calls is set by the calls' latency: Node's recorder calls in-process (0 ms), a real phone and this replay cross a socket,
// so the agreement of Node's runs there is the recorder's, not Node's. Settling is not a hidden difference: the output itself, its bytes,
// its place against the entries that cause or order it, all stay compared. Unsettled (`immediate`) are the sequences an answer orders:
// an ensure's answer before the new shell's first output, a dispose's answer before the killed shell's last output and exit line.
//
// One rule for each list, in its one global order:
//   - Output: consecutive output frames of one tab (all their fields but `data` equal) are one run, compared as one entry whose data is
//     the frames' bytes joined: where the frames are cut is the relay's 16 ms timing, which neither side decides here and which is proved
//     exactly by the scripted framing recording (apps/mobile/fixtures/relay-framing, mixdog-spawn service::relay_buffer
//     `the_frames_are_nodes_for_the_recorded_script`).
//   - Every other entry (answers, pushes of every tab, fires, lane switches, clock steps, checkpoints) is compared at its position.
//     An output frame's place against an activity change of its own tab that directly precedes it is the relay's 16 ms timing too (the
//     activity goes at once, the output when its 16 ms are up), so such a frame is compared as if sent before it (`ownActivityFirst`);
//     against every other entry its place is compared as recorded.
//   - Where Node's runs all agree, the trace must be theirs exactly: output's position among all entries and its bytes included.
//     Where they disagree, only the smallest disagreeing unit is left out and named in `leftOut`: one entry's value, or one tab's output
//     bytes in one stretch between two non-output entries (and then the order of the runs in that stretch). Each tab's whole output is
//     compared besides, wherever the runs agree on it.
//   - A tab that exits in every run ends its output with `[process exited with code N]\r\n`, N the recorded code (a code the runs
//     disagree on is named; the line is required all the same).
//
// The one variation in the entries themselves: a disposed PowerShell tab may report one `running` then one `null` activity after its
// dispose answer and before its exit line. The mechanism (Node, b6f10295a): Mixdog's PowerShell integration wraps PSConsoleHostReadLine
// and writes the `C` marker when the read returns (terminal-shell-integration.ts:38-41); a tab disposed while it waits at its prompt has
// its console closed (terminal-manager.ts:543), the read returns, and whether that `C` reaches the PTY before the console is gone is a race.
// When it does, the marker starts a command (terminal-activity.ts `marker`: running) and the exit then ends it
// (terminal-manager.ts:378-383: activity.exit(), null, then the exit line). Every tab below is PowerShell with that integration, disposed
// at its prompt, so the mechanism covers each of them alike; nothing else is accepted, and each pair taken out is named in `leftOut`.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

const PARTS = ['order', 'claims.order', 'immediate.order'];
const POWERSHELL_AT_PROMPT = new Set(['term_ph2a', 'term_ph2_l1', 'term_ph2_l2', 'term_ph2_l4', 'term_ph2_l5', 'term_ph2_l6', 'term_ph2_i1', 'term_ph2_i2']);
const EXIT_AT_END = /\[process exited with code (-?\d+)\]\r\n$/;
const EXIT_ANYWHERE = /\[process exited with code -?\d+\]\r\n/;

const isData = (entry) => entry.push === 'termData';
const pick = (trace, part) => part.split('.').reduce((value, key) => value?.[key], trace);
const show = (value) => JSON.stringify(value === undefined ? '<absent>' : value)?.slice(0, 600);
const withoutData = (entry) => ({ ...entry, event: { ...entry.event, data: undefined } });

/** The list without the PowerShell disposal pairs (named in `leftOut`); anything else around a disposal stays and is compared. */
function withoutDisposalPairs(list, part, leftOut) {
  const state = new Map();
  const text = new Map();
  const kept = [];
  for (const entry of list) {
    if (entry.call === 'termEnsure') {
      state.delete(entry.params[0]);
      text.delete(entry.params[0]);
    }
    if (entry.call === 'termDispose' && !('error' in entry)) state.set(entry.params[0], 'disposed');
    if (isData(entry)) {
      const id = entry.event.id;
      text.set(id, (text.get(id) ?? '') + entry.event.data);
      if (EXIT_ANYWHERE.test(text.get(id))) {
        assert.notEqual(state.get(id), 'running', `${part}: ${id} exited while running after its dispose answer (the exit's null was missing)`);
        if (state.has(id)) state.set(id, 'exited');
      }
    }
    if (entry.push === 'activity' && POWERSHELL_AT_PROMPT.has(entry.event.id)) {
      const { id, state: activity } = entry.event;
      if (activity === 'running' && state.get(id) === 'disposed') {
        state.set(id, 'running');
        leftOut.push(`${part}: ${id}'s running/null pair after its dispose answer`);
        continue;
      }
      if (activity === null && state.get(id) === 'running') {
        state.set(id, 'done');
        continue;
      }
    }
    kept.push(entry);
  }
  for (const [id, at] of state) assert.notEqual(at, 'running', `${part}: ${id}'s running after its dispose answer never ended`);
  return kept;
}

/** Each output frame placed before the activity pushes of its own tab that directly precede it. Node's relay sends a tab's activity at once
 *  (remote-relay-push-lanes.ts:148-150) and its output up to 16 ms later (:82-89), so whether a frame lands before or after an activity
 *  change of the same tab that came within those 16 ms is the frame's timing, the property the scripted framing recording proves; the
 *  frame's place against every other entry (another tab's events, any answer, fire, lane switch, clock step, checkpoint) is unchanged. */
export function ownActivityFirst(list) {
  const out = [];
  for (const entry of list) {
    let at = out.length;
    if (isData(entry)) {
      while (at > 0 && out[at - 1].push === 'activity' && out[at - 1].event.id === entry.event.id) at -= 1;
    }
    out.splice(at, 0, entry);
  }
  return out;
}

/** Consecutive frames of one tab with the same fields but `data` are one run, its data the frames' joined. */
function runsOf(list) {
  const out = [];
  for (const entry of list) {
    const last = out.at(-1);
    if (isData(entry) && last && isData(last) && isDeepStrictEqual(withoutData(last), withoutData(entry))) {
      out[out.length - 1] = { ...last, event: { ...last.event, data: last.event.data + entry.event.data } };
    } else {
      out.push(entry);
    }
  }
  return out;
}

/** Stretch k (after the k-th non-output entry; -1 before the first) -> its output runs in order. */
function stretches(list) {
  const out = new Map([[-1, []]]);
  let k = -1;
  for (const entry of list) {
    if (isData(entry)) out.get(k).push(entry);
    else out.set(++k, []);
  }
  return out;
}

const streamOf = (list, tab) => list.filter((entry) => isData(entry) && entry.event.id === tab).map((entry) => entry.event.data).join('');

/** Returns what was left out (each place Node's runs disagree, each disposal pair taken out); throws on the first difference. */
export function compareTraces(got, runs) {
  const leftOut = [];
  /** `value` must be Node's where all runs agree; a disagreement is named and left out. */
  const agreed = (value, recorded, what) => {
    if (recorded.some((other) => !isDeepStrictEqual(other, recorded[0]))) {
      leftOut.push(what);
      return;
    }
    if (!isDeepStrictEqual(value, recorded[0])) assert.fail(`${what}\n  got:  ${show(value)}\n  Node: ${show(recorded[0])}`);
  };
  const extra = Object.keys(got).filter((key) => !['order', 'claims', 'immediate', 'replayWindow'].includes(key));
  assert.deepEqual(extra, [], 'the trace has fields the comparison does not know');
  for (const part of PARTS) {
    const mine = runsOf(ownActivityFirst(withoutDisposalPairs(pick(got, part) ?? [], part, leftOut)));
    const nodeLeft = [];
    const all = runs.map((run) => runsOf(ownActivityFirst(withoutDisposalPairs(pick(run, part) ?? [], `Node's ${part}`, nodeLeft))));
    const entries = (list) => list.filter((entry) => !isData(entry));
    const lengths = all.map((list) => entries(list).length);
    assert.equal(new Set(lengths).size, 1, `Node's runs differ in ${part} beyond the recorded variation (${lengths.join(', ')} entries besides output)`);
    assert.equal(entries(mine).length, lengths[0], `${part}: ${entries(mine).length} entries besides output; Node: ${lengths[0]}`);
    entries(mine).forEach((entry, i) => agreed(entry, all.map((list) => entries(list)[i]), `${part} entry ${i}`));
    const [mineAt, nodeAt] = [stretches(mine), all.map(stretches)];
    for (const k of nodeAt[0].keys()) {
      const where = k < 0 ? 'before the first entry' : `after entry ${k}`;
      const nodeRuns = nodeAt.map((at) => at.get(k));
      if (nodeRuns.every((runs) => isDeepStrictEqual(runs, nodeRuns[0]))) {
        agreed(mineAt.get(k), nodeRuns, `${part}: the output ${where}`);
        continue;
      }
      // Node's runs disagree in this stretch: each tab's bytes here where they agree on them, the order of the runs named.
      const tabs = [...new Set([mineAt.get(k), ...nodeRuns].flat().map((entry) => entry.event.id))].sort();
      for (const tab of tabs) {
        const bytes = (runs) => runs.filter((entry) => entry.event.id === tab).map((entry) => entry.event.data).join('');
        agreed(bytes(mineAt.get(k)), nodeRuns.map(bytes), `${part}: ${tab}'s output ${where}`);
      }
      leftOut.push(`${part}: the order of the output runs ${where}`);
    }
    const tabs = [...new Set([mine, ...all].flatMap((list) => list.filter(isData).map((entry) => entry.event.id)))].sort();
    for (const tab of tabs) {
      agreed(streamOf(mine, tab), all.map((list) => streamOf(list, tab)), `${part}: the whole output of ${tab}`);
      const codes = all.map((list) => EXIT_AT_END.exec(streamOf(list, tab))?.[1]);
      if (codes.every((code) => code !== undefined)) {
        const code = EXIT_AT_END.exec(streamOf(mine, tab))?.[1];
        assert.notEqual(code, undefined, `${part}: ${tab}'s output does not end with its exit line: ${show(streamOf(mine, tab).slice(-200))}`);
        agreed(code, codes, `${part}: ${tab}'s exit code`);
      }
    }
  }
  return { leftOut };
}
