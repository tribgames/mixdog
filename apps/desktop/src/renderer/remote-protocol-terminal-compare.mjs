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
//   - Every entry but output (answers, pushes of every tab, fires, lane switches, clock steps, checkpoints) is compared at its position,
//     exactly, where Node's runs agree on it; one they disagree on is left out and named in `leftOut`.
//   - Output is a real PTY's, and its bytes are not what either product decides: the console host cuts its frames by its own render timing
//     (where the cursor-show code falls against a prompt, whether PowerShell draws a typed command at once or in pieces, both varying among
//     Node's own runs and with the machine's load). So output is compared by the screen it produces in the terminal the app renders with
//     (@xterm/xterm, TerminalPane.tsx), parsing each tab's output in order and resized where the trace announces the tab's new size (a
//     `sizeOwner` push with a size: Node resizes the PTY before it announces, terminal-manager.ts:485-487; a new PTY starts at 80x24,
//     :322-325). At each point where a tab's output ends before the next entry, that tab's screen (every line of the active buffer with
//     its scrollback, the cursor's place and whether it shows) must be Node's, where Node's runs agree on it; where they do not, the point
//     is named in `leftOut` with the runs that differ. An answer's `replay` (the tab's output so far) is compared the same way, as the
//     screen it produces at the tab's size.
//   - A tab's output frame and its own activity change that every Node run sends next to each other are one place: which of the two goes
//     first is the relay's 16 ms window against the moment the output arrives (Node's activity goes at once, remote-relay-push-lanes.ts:
//     148-150; its output when its window allows, :82-89), and that is call latency in a replay (0 ms in the recorder, a socket for a
//     phone). Their order is proved where time is controlled: the scripted framing recording (apps/mobile/fixtures/relay-framing, mixdog-
//     spawn service::relay_buffer `the_frames_are_nodes_for_the_recorded_script`). Here the change must still be next to its tab's output
//     (nothing between them), and it does not end the stretch whose screen is compared; each such place is named in `sets`.
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

/** The non-output positions k of `list` that are an activity change next to an output frame of its own tab, with nothing between them
 *  but other activity changes of that tab (a command's `running` and `finished` can both fall inside one relay window). */
function ownPairs(list) {
  const out = new Set();
  let k = -1;
  list.forEach((entry, at) => {
    if (isData(entry)) return;
    k += 1;
    if (entry.push !== 'activity') return;
    const ownChange = (other) => other?.push === 'activity' && other.event.id === entry.event.id;
    const ownOutput = (other) => other !== undefined && isData(other) && other.event.id === entry.event.id;
    let before = at - 1;
    while (ownChange(list[before])) before -= 1;
    let after = at + 1;
    while (ownChange(list[after])) after += 1;
    if (ownOutput(list[before]) || ownOutput(list[after])) out.add(k);
  });
  return out;
}

/** Per position of `list`: the stretch an output frame belongs to (the k of the non-output entry that opened it, -1 before the first),
 *  `undefined` for the other entries. The changes in `paired` do not open a stretch. */
export function stretchesOf(list, paired) {
  let k = -1;
  let stretch = -1;
  return list.map((entry) => {
    if (isData(entry)) return stretch;
    k += 1;
    if (!paired.has(k)) stretch = k;
    return undefined;
  });
}

let emulatorClass = null;
/** The renderer's terminal (TerminalPane.tsx's `@xterm/xterm`), parsing without an element: loading it reads `window` and `document`,
 *  which the renderer suites take from jsdom; a process that has no DOM gets one here (its console unread: xterm probes a canvas). */
async function emulator() {
  if (emulatorClass) return emulatorClass;
  if (globalThis.window === undefined) {
    const { JSDOM, VirtualConsole } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { virtualConsole: new VirtualConsole() });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
  }
  const xterm = await import('@xterm/xterm');
  emulatorClass = xterm.Terminal ?? xterm.default.Terminal;
  return emulatorClass;
}

/** What a terminal shows: every line of its active buffer (scrollback included), the cursor's place in it and whether it shows. */
function screenOf(term) {
  const buffer = term.buffer.active;
  const lines = [];
  // A line's trailing blanks are not shown: a cell the console host wrote a space into and one it erased look the same, and which of the
  // two it does is its own render timing (Node's runs differ there).
  for (let y = 0; y < buffer.length; y += 1) lines.push(buffer.getLine(y).translateToString(true).replace(/ +$/, ''));
  // xterm keeps DECTCEM (`ESC [?25l/h`) in its core service; the public API has no reader for it.
  const hidden = term._core.coreService.isCursorHidden;
  assert.equal(typeof hidden, 'boolean', "the emulator's cursor visibility is readable");
  return { size: [term.cols, term.rows], buffer: buffer.type, lines, cursor: [buffer.cursorX, buffer.baseY + buffer.cursorY], visible: !hidden };
}

/** Each tab's terminal, fed its output in order; `parsed` settles when everything written so far is parsed (xterm's write callback). */
class Screens {
  constructor(Terminal) {
    this.Terminal = Terminal;
    this.tabs = new Map();
  }

  write(id, data) {
    let tab = this.tabs.get(id);
    if (!tab) {
      tab = { term: new this.Terminal({ cols: 80, rows: 24 }), parsed: Promise.resolve(), text: '' };
      this.tabs.set(id, tab);
    }
    tab.text += data;
    tab.parsed = new Promise((resolve) => tab.term.write(data, resolve));
  }

  /** A new ensure of a tab whose shell exited starts a new PTY (and screen). */
  ensured(id) {
    const tab = this.tabs.get(id);
    if (tab && EXIT_ANYWHERE.test(tab.text)) {
      tab.term.dispose();
      this.tabs.delete(id);
    }
  }

  /** Resizes the tab's terminal; true when it has one (its screen changed). */
  async resize(id, cols, rows) {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    await tab.parsed;
    tab.term.resize(cols, rows);
    return true;
  }

  async screen(id) {
    const tab = this.tabs.get(id);
    await tab.parsed;
    return screenOf(tab.term);
  }

  /** The screen an answer's replay produces at the tab's size. */
  async replay(id, replay) {
    const tab = this.tabs.get(id);
    const term = new this.Terminal(tab ? { cols: tab.term.cols, rows: tab.term.rows } : { cols: 80, rows: 24 });
    await new Promise((resolve) => term.write(replay, resolve));
    const screen = screenOf(term);
    term.dispose();
    return screen;
  }

  dispose() {
    for (const tab of this.tabs.values()) tab.term.dispose();
  }
}

/** A list's entries besides output (an answer's replay as its screen) and, per stretch, the screen of each tab whose output it holds. */
async function analyse(list, paired) {
  const screens = new Screens(await emulator());
  const entries = [];
  const stretches = new Map();
  let touched = new Set();
  let stretch = -1;
  const close = async () => {
    if (touched.size === 0) return;
    const at = new Map();
    for (const id of touched) at.set(id, await screens.screen(id));
    stretches.set(stretch, at);
    touched = new Set();
  };
  for (const entry of list) {
    if (isData(entry)) {
      screens.write(entry.event.id, entry.event.data);
      touched.add(entry.event.id);
      continue;
    }
    // Every other entry opens the next stretch, ending the one before; a change in `paired` does not.
    if (!paired.has(entries.length)) {
      await close();
      stretch = entries.length;
    }
    if (entry.call === 'termEnsure') screens.ensured(entry.params[0]);
    // A resize changes the screen: it is compared at the end of the stretch this entry opens, like output.
    if (entry.push === 'sizeOwner' && entry.event.cols > 0 && (await screens.resize(entry.event.id, entry.event.cols, entry.event.rows))) touched.add(entry.event.id);
    entries.push(typeof entry.value?.replay === 'string' ? { ...entry, value: { ...entry.value, replay: await screens.replay(entry.value.id, entry.value.replay) } } : entry);
  }
  await close();
  screens.dispose();
  return { entries, stretches };
}

/** The tab's screen as it stood at the end of stretch `k`: its last stretch with output up to there; null before its first output. */
function screenAt(analysis, k, tab) {
  let found = null;
  for (const [at, screens] of analysis.stretches) {
    if (at > k) break;
    if (screens.has(tab)) found = screens.get(tab);
  }
  return found;
}

/** The lines, cursor and visibility where two screens differ. */
function screenDifference(got, node) {
  if (got === null || node === null) return `got ${got === null ? 'no output' : 'a screen'}, Node ${node === null ? 'no output' : 'a screen'}`;
  const out = [];
  for (const key of ['size', 'buffer', 'cursor', 'visible']) {
    if (!isDeepStrictEqual(got[key], node[key])) out.push(`${key}: got ${JSON.stringify(got[key])}, Node ${JSON.stringify(node[key])}`);
  }
  const lines = Math.max(got.lines.length, node.lines.length);
  for (let y = 0, shown = 0; y < lines && shown < 12; y += 1) {
    if (got.lines[y] === node.lines[y]) continue;
    out.push(`line ${y}: got ${JSON.stringify(got.lines[y] ?? '<no line>')}, Node ${JSON.stringify(node.lines[y] ?? '<no line>')}`);
    shown += 1;
  }
  return out.join('\n  ');
}

const nodeViews = new WeakMap();
/** Node's runs of one part as the comparison reads them: the lists without the disposal pairs, the own-tab pairs every run has, and each
 *  run's analysis (computed once per recording). */
export async function nodeView(runs, part) {
  if (!nodeViews.has(runs)) nodeViews.set(runs, new Map());
  const views = nodeViews.get(runs);
  if (!views.has(part)) {
    const lists = runs.map((run) => withoutDisposalPairs(pick(run, part) ?? [], `Node's ${part}`, []));
    const entries = (list) => list.filter((entry) => !isData(entry)).length;
    const lengths = lists.map(entries);
    assert.equal(new Set(lengths).size, 1, `Node's runs differ in ${part} beyond the recorded variation (${lengths.join(', ')} entries besides output)`);
    const pairs = lists.map(ownPairs);
    const paired = new Set([...pairs[0]].filter((k) => pairs.every((set) => set.has(k))));
    views.set(part, { lists, paired, analyses: await Promise.all(lists.map((list) => analyse(list, paired))) });
  }
  return views.get(part);
}

/** The list as the comparison reads it: without the PowerShell disposal pairs (the entries kept are the list's own objects). */
export const comparedList = (list, part) => withoutDisposalPairs(list, part, []);

export const RELAY_FRAMING_PROOF =
  'apps/mobile/fixtures/relay-framing (an activity change inside an open window, after a quiet window, and after a re-render at 15, 16, 17 ms)';

const streamOf = (list, tab) => list.filter((entry) => isData(entry) && entry.event.id === tab).map((entry) => entry.event.data).join('');

/** Returns what was left out (each place Node's runs disagree, each disposal pair taken out) and each own-tab pair compared as one place;
 *  throws on the first difference. */
export async function compareTraces(got, runs) {
  const leftOut = [];
  const sets = [];
  /** `value` must be Node's where all runs agree; a disagreement is named and left out. */
  const agreed = (value, recorded, what) => {
    const differing = recorded.flatMap((other, run) => (isDeepStrictEqual(other, recorded[0]) ? [] : [run]));
    if (differing.length > 0) {
      leftOut.push(`${what} (Node's runs ${differing.join(', ')} differ from run 0)`);
      return;
    }
    if (isDeepStrictEqual(value, recorded[0])) return;
    const screens = value?.value?.replay?.lines && recorded[0]?.value?.replay?.lines;
    const detail = screens ? `replay screen:\n  ${screenDifference(value.value.replay, recorded[0].value.replay)}` : `got:  ${show(value)}\n  Node: ${show(recorded[0])}`;
    assert.fail(`${what}\n  ${detail}`);
  };
  const extra = Object.keys(got).filter((key) => !['order', 'claims', 'immediate', 'replayWindow'].includes(key));
  assert.deepEqual(extra, [], 'the trace has fields the comparison does not know');
  for (const part of PARTS) {
    const node = await nodeView(runs, part);
    const mine = withoutDisposalPairs(pick(got, part) ?? [], part, leftOut);
    // An output entry is compared by its data alone, so it may carry nothing else.
    for (const entry of mine.filter(isData)) {
      assert.ok(isDeepStrictEqual(Object.keys(entry), ['push', 'event']) && isDeepStrictEqual(Object.keys(entry.event), ['id', 'data']), `${part}: an output entry with other fields: ${show(entry)}`);
    }
    const entries = mine.filter((entry) => !isData(entry));
    const count = node.analyses[0].entries.length;
    assert.equal(entries.length, count, `${part}: ${entries.length} entries besides output; Node: ${count}`);
    const mineOwn = ownPairs(mine);
    for (const k of node.paired) {
      const { id } = entries[k].event ?? {};
      assert.ok(mineOwn.has(k), `${part} entry ${k}: ${id}'s activity change is not next to its own output, as in every Node run (${show(entries[k])})`);
      sets.push(`${part} entry ${k}: ${id}'s activity change and its output, their order proved by ${RELAY_FRAMING_PROOF}`);
    }
    const analysis = await analyse(mine, node.paired);
    analysis.entries.forEach((entry, i) => agreed(entry, node.analyses.map((run) => run.entries[i]), `${part} entry ${i}`));
    const both = [analysis, ...node.analyses];
    const points = [...new Set(both.flatMap((run) => [...run.stretches.keys()]))].sort((a, b) => a - b);
    for (const k of points) {
      const where = k < 0 ? 'before the first entry' : `after entry ${k}`;
      const tabs = [...new Set(both.flatMap((run) => [...(run.stretches.get(k)?.keys() ?? [])]))].sort();
      for (const tab of tabs) {
        const recorded = node.analyses.map((run) => screenAt(run, k, tab));
        const what = `${part}: ${tab}'s screen ${where}`;
        const differing = recorded.flatMap((screen, run) => (isDeepStrictEqual(screen, recorded[0]) ? [] : [run]));
        if (differing.length > 0) {
          leftOut.push(`${what} (Node's runs ${differing.join(', ')} differ from run 0)`);
          continue;
        }
        const screen = screenAt(analysis, k, tab);
        if (!isDeepStrictEqual(screen, recorded[0])) assert.fail(`${what}\n  ${screenDifference(screen, recorded[0])}`);
      }
    }
    const tabs = [...new Set([mine, ...node.lists].flatMap((list) => list.filter(isData).map((entry) => entry.event.id)))].sort();
    for (const tab of tabs) {
      const codes = node.lists.map((list) => EXIT_AT_END.exec(streamOf(list, tab))?.[1]);
      if (codes.every((code) => code !== undefined)) {
        const code = EXIT_AT_END.exec(streamOf(mine, tab))?.[1];
        assert.notEqual(code, undefined, `${part}: ${tab}'s output does not end with its exit line: ${show(streamOf(mine, tab).slice(-200))}`);
        agreed(code, codes, `${part}: ${tab}'s exit code`);
      }
    }
  }
  return { leftOut, sets };
}
