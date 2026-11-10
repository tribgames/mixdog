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
// One rule for each list, in its one global order. Where Node's runs differ at a place, the units they differ on are named in
// `exemptions` with the runs that differ, and the trace must have there the whole of one run's state, entry, sequence of states or order
// of tabs (the runs do not show those units varying apart from each other, so a mix of two runs is not something Node showed).
//   - Every entry but output (answers, pushes of every tab, fires, lane switches, clock steps, checkpoints) is compared at its position,
//     field by field (every leaf of its value, and the shape of every object and array).
//   - Output is a real PTY's, and its bytes are not what either product decides: the console host cuts its frames by its own render timing
//     (where the cursor-show code falls against a prompt, whether PowerShell draws a typed command at once or in pieces, both varying among
//     Node's own runs and with the machine's load). So output is compared by the state it puts the terminal the app renders with in
//     (@xterm/xterm, TerminalPane.tsx, with the pane's cursor options), parsing each tab's output frame by frame and resized where the trace
//     announces the tab's new size (a `sizeOwner` push with a size: Node resizes the PTY before it announces, terminal-manager.ts:485-487; a
//     new PTY starts at 80x24, :322-325). The state is everything the terminal shows and holds (`stateOf`: both buffers cell by cell with
//     every attribute, wrapped lines, cursors, viewport, scroll regions, tab stops, saved cursors, modes, cursor visibility and style,
//     current attributes and character sets, title and icon name, bells, colour changes, every byte the terminal answered, and input the
//     parser holds unfinished; a state with such input pending makes no step of a sequence, its effect shows in the next). A stretch
//     runs from one entry to the next (an activity change paired with its own output does not end it). For each tab in each stretch, the
//     sequence of distinct states its output went through (and its paired activity changes among them) must be Node's, and so must the
//     order in which the stretch's tabs changed; where Node's runs differ in those, the stretch's intermediate states (or its tab order)
//     are exempt, named, and its last state is still compared unit by unit. An answer's `replay` is compared as the state it produces at
//     the tab's size.
//   - A tab's output frame and its own activity change that every Node run sends directly next to each other (that frame on one side, not
//     both, and nothing between them) are one place: the framing recording proves that exactly this pair flips with when the write lands
//     against the relay's 16 ms window (RELAY_FRAMING_PROOF), which in a replay is call latency (0 ms in the recorder, a socket for a
//     phone). Here the change must still be directly next to a frame of its own tab carrying output on one side only, as in Node's runs,
//     it does not end the stretch, and in
//     the stretch's sequence it counts as after its frame; each such place is named in `sets`. No other change may move against output.
//   - A tab that exits in every run ends its output with `[process exited with code N]\r\n`, N the recorded code (a code the runs
//     disagree on is exempt as above; the line is required all the same).
//
// The one variation in the entries themselves: a disposed PowerShell tab may report one `running` then one `null` activity after its
// dispose answer and before its exit line. The mechanism (Node, b6f10295a): Mixdog's PowerShell integration wraps PSConsoleHostReadLine
// and writes the `C` marker when the read returns (terminal-shell-integration.ts:38-41); a tab disposed while it waits at its prompt has
// its console closed (terminal-manager.ts:543), the read returns, and whether that `C` reaches the PTY before the console is gone is a race.
// When it does, the marker starts a command (terminal-activity.ts `marker`: running) and the exit then ends it
// (terminal-manager.ts:378-383: activity.exit(), null, then the exit line). Every tab below is PowerShell with that integration, disposed
// at its prompt, so the mechanism covers each of them alike; nothing else is accepted. A pair is taken out at a disposal only where Node's
// runs vary on it there (some run has it, some does not; where every run has it the trace must too, where none has it the trace may not),
// and each is named in `exemptions` with the runs that have it.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

const PARTS = ['order', 'claims.order', 'immediate.order'];
const POWERSHELL_AT_PROMPT = new Set(['term_ph2a', 'term_ph2_l1', 'term_ph2_l2', 'term_ph2_l4', 'term_ph2_l5', 'term_ph2_l6', 'term_ph2_i1', 'term_ph2_i2']);
const EXIT_AT_END = /\[process exited with code (-?\d+)\]\r\n$/;
const EXIT_ANYWHERE = /\[process exited with code -?\d+\]\r\n/;

const isData = (entry) => entry.push === 'termData';
const pick = (trace, part) => part.split('.').reduce((value, key) => value?.[key], trace);
const show = (value) => JSON.stringify(value === undefined ? '<absent>' : value)?.slice(0, 600);

/** The list without the PowerShell disposal pairs, and which disposals had one (`<tab> dispose <n>`, n counting the tab's disposals in
 *  the list); anything else around a disposal stays and is compared. */
function withoutDisposalPairs(list, part) {
  const state = new Map();
  const text = new Map();
  const disposals = new Map();
  const kept = [];
  const pairs = [];
  for (const entry of list) {
    if (entry.call === 'termEnsure') {
      state.delete(entry.params[0]);
      text.delete(entry.params[0]);
    }
    if (entry.call === 'termDispose' && !('error' in entry)) {
      state.set(entry.params[0], 'disposed');
      disposals.set(entry.params[0], (disposals.get(entry.params[0]) ?? 0) + 1);
    }
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
        pairs.push(`${id} dispose ${disposals.get(id)}`);
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
  return { kept, pairs };
}

/** Per non-output position k of `list` that is an activity change with an output frame of its own tab (one that carries output) directly
 *  next to it: on which side, `before` (the frame, then the change), `after` (the change, then the frame) or `both`. */
function ownSides(list) {
  const sides = new Map();
  let k = -1;
  list.forEach((entry, at) => {
    if (isData(entry)) return;
    k += 1;
    if (entry.push !== 'activity') return;
    const own = (other) => other !== undefined && isData(other) && other.event.id === entry.event.id && other.event.data !== '';
    const [before, after] = [own(list[at - 1]), own(list[at + 1])];
    if (before || after) sides.set(k, before && after ? 'both' : before ? 'before' : 'after');
  });
  return sides;
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

/** The terminal options of the app's pane that are terminal state (TerminalPane.tsx:239-247; its font and theme only draw). */
const PANE_OPTIONS = { cursorBlink: true, cursorStyle: 'bar', cursorInactiveStyle: 'bar' };

const HAS_EXTENDED = 0x10000000;
const DEFAULT_CELL = '1.0.0';

/** A cell's or attribute set's attributes as xterm holds them: foreground and background words (colour, its mode and every flag: bold,
 *  dim, italic, underline, blink, inverse, invisible, strikethrough, overline) and, when set, the extended ones (underline style and
 *  colour, the OSC 8 hyperlink's target). */
function attrOf(attr, core) {
  if (!(attr.bg & HAS_EXTENDED)) return `${attr.fg}.${attr.bg}`;
  const { underlineStyle, underlineColor, urlId } = attr.extended;
  const link = urlId ? core._oscLinkService.getLinkData(urlId) : undefined;
  return `${attr.fg}.${attr.bg}.${underlineStyle}.${underlineColor}.${link ? JSON.stringify(link) : ''}`;
}

const charsetName = (charset) => (charset ? Object.entries(charset).map(([from, to]) => `${from}${to}`).join('') : 'ascii');

/** A cell's own content written so that nothing a cell can hold reads as another: its code points with the four marks this form uses
 *  (`«`, `»`, `␀`, `\`, and `⏎`) escaped by `\`; an empty cell (erased, or a wide character's second cell) is the unescaped `␀`. */
const cellText = (chars) => (chars === '' ? '␀' : chars.replace(/[«»␀⏎\\]/g, (mark) => `\\${mark}`));

/** One buffer line, every cell: whether it continues the line before (wrapped, a leading `⏎`), and each cell's content (`cellText`)
 *  with its width and attributes, written as a change of attributes where they change (`«width.fg.bg…»`). Nothing is trimmed: a blank
 *  is a cell like any other. */
function lineOf(line, core, cell) {
  let out = line.isWrapped ? '⏎' : '';
  let attrs = DEFAULT_CELL;
  for (let x = 0; x < line.length; x += 1) {
    line.getCell(x, cell);
    const cellAttrs = `${cell.getWidth()}.${attrOf(cell, core)}`;
    if (cellAttrs !== attrs) {
      out += `«${cellAttrs}»`;
      attrs = cellAttrs;
    }
    out += cellText(cell.getChars());
  }
  return out;
}

/** What the parser holds of input it has not finished reading (xterm 5.5's EscapeSequenceParser and its decoders): its state, the
 *  sequence's parameters and intermediates so far, an OSC or DCS string being collected (its identifier and the data its handlers hold),
 *  and a split character waiting for its other half; null when nothing is pending (the ground state, nothing collected). The next input
 *  is read on from here. */
function parserOf(core) {
  const input = core._inputHandler;
  const parser = input._parser;
  const osc = parser._oscParser;
  const dcs = parser._dcsParser;
  const pending = {
    state: parser.currentState,
    params: parser._params.toArray(),
    collect: parser._collect,
    osc: osc._state === 0 ? null : [osc._state, osc._id, osc._active.map((handler) => handler._data ?? null)],
    dcs: dcs._active.length === 0 ? null : [dcs._ident, dcs._active.map((handler) => handler._data ?? null)],
    split: [input._stringDecoder._interim, ...Array.from(input._utf8Decoder.interim)].filter((unit) => unit !== 0),
  };
  // In the ground state the parameters and intermediates are what the last sequence left; the next sequence clears them first.
  const ground = pending.state === 0 && pending.osc === null && pending.dcs === null && pending.split.length === 0;
  return ground ? null : pending;
}

/** Everything the phone's terminal shows and holds, as named units: its size and active buffer; for the normal and the alternate buffer
 *  every line (scrollback included), the cursor, the viewport, the scroll region, the tab stops and the saved cursor; every mode the
 *  input depends on (application cursor keys and keypad, bracketed paste, mouse reporting, focus reports, insert, origin, wraparound),
 *  the cursor's visibility, style and blink; the current attributes and character sets; the window title, icon name and their stacks;
 *  how many bells rang; every byte the terminal answered back (`onData`: DSR and other reports); every colour change it was asked for.
 *  The internals read are xterm 5.5's own (the public API has no reader for them). */
function stateOf(tab) {
  const { term } = tab;
  const core = term._core;
  const cell = term.buffer.active.getNullCell();
  const state = { size: [term.cols, term.rows], 'active buffer': term.buffer.active.type };
  for (const name of ['normal', 'alternate']) {
    const api = term.buffer[name];
    const inner = core._bufferService.buffers[name === 'normal' ? 'normal' : 'alt'];
    assert.ok(inner?.lines, `the emulator's ${name} buffer is readable`);
    state[`${name} lines`] = api.length;
    for (let y = 0; y < api.length; y += 1) state[`${name} line ${y}`] = lineOf(api.getLine(y), core, cell);
    state[`${name} cursor`] = [api.cursorX, api.baseY + api.cursorY];
    state[`${name} viewport`] = [api.viewportY, api.baseY];
    state[`${name} scroll region`] = [inner.scrollTop, inner.scrollBottom];
    state[`${name} tab stops`] = Object.keys(inner.tabs).filter((x) => inner.tabs[x]).join(',');
    state[`${name} saved cursor`] = [inner.savedX, inner.savedY, attrOf(inner.savedCurAttrData, core), charsetName(inner.savedCharset)];
  }
  const { coreService, optionsService, coreMouseService, _inputHandler: input, _charsetService: charsets } = core;
  for (const [mode, on] of Object.entries(coreService.decPrivateModes)) state[`mode ${mode}`] = on;
  for (const [mode, on] of Object.entries(coreService.modes)) state[`mode ${mode}`] = on;
  assert.equal(typeof coreService.isCursorHidden, 'boolean', "the emulator's cursor visibility is readable");
  state['cursor hidden'] = coreService.isCursorHidden;
  state['cursor style'] = [optionsService.rawOptions.cursorStyle, optionsService.rawOptions.cursorBlink];
  state['mouse reporting'] = [coreMouseService.activeProtocol, coreMouseService.activeEncoding];
  state['current attributes'] = attrOf(input._curAttrData, core);
  state['character sets'] = [charsets.glevel, ...charsets._charsets.map(charsetName)];
  state.title = tab.title;
  state['icon name'] = input._iconName;
  state['title stacks'] = [input._windowTitleStack, input._iconNameStack];
  state.bells = tab.bells;
  state.answers = tab.answers;
  state['colour changes'] = tab.colours;
  state['parser pending'] = parserOf(core);
  return state;
}

/** States by id: equal states have one id (across runs, so a sequence of screens compares as ids). */
const states = [];
const stateIds = new Map();
function intern(state) {
  const key = JSON.stringify(state);
  let id = stateIds.get(key);
  if (id === undefined) {
    id = states.length;
    states.push(state);
    stateIds.set(key, id);
  }
  return id;
}

/** One tab's terminal, with what it reports through events (title, bell, answers, colour changes). */
class Tab {
  constructor(Terminal, cols, rows) {
    this.term = new Terminal({ cols, rows, ...PANE_OPTIONS });
    this.title = '';
    this.bells = 0;
    this.answers = '';
    this.colours = [];
    this.text = '';
    this.last = null;
    this.term.onTitleChange((title) => {
      this.title = title;
    });
    this.term.onBell(() => {
      this.bells += 1;
    });
    this.term.onData((data) => {
      this.answers += data;
    });
    this.term.onBinary((data) => {
      this.answers += data;
    });
    this.term._core._inputHandler.onColor((event) => this.colours.push(JSON.stringify(event)));
  }

  write(data) {
    this.text += data;
    return new Promise((resolve) => this.term.write(data, resolve));
  }
}

/** An entry's fields as units (`a.b.0`), with an answer's replay as the state it produces at the tab's size (`value.replay: <unit>`). */
function unitsOf(value, path = '', out = {}) {
  if (value !== null && typeof value === 'object') {
    out[`${path}<${Array.isArray(value) ? `array ${value.length}` : 'object'}>`] = true;
    for (const [key, inner] of Object.entries(value)) unitsOf(inner, path ? `${path}.${key}` : key, out);
  } else {
    out[path] = value;
  }
  return out;
}

/** A list's entries besides output (as units; an answer's replay as the state it produces) and, per stretch: the bytes and last state of
 *  each tab whose output it holds, and its events in order: each change of a tab's state (`screen`, an id) and each change of activity
 *  paired with its own output (`activity`). A paired change directly before its frame is put after it: those two are one place, their
 *  order proved by the framing recording. */
async function analyse(list, paired) {
  const Terminal = await emulator();
  const tabs = new Map();
  const entries = [];
  const stretches = new Map();
  let stretch = -1;
  const here = () => {
    if (!stretches.has(stretch)) stretches.set(stretch, { events: [], finals: new Map(), bytes: new Map() });
    return stretches.get(stretch);
  };
  // A state with input pending in the parser (a frame cut inside a sequence) is the stretch's last state if nothing follows, but makes
  // no step of the sequence: the input after it is read on from there, and what it does shows in the next state.
  const changed = (id, tab) => {
    const state = intern(stateOf(tab));
    const at = here();
    at.finals.set(id, state);
    if (state !== tab.last && states[state]['parser pending'] === null) {
      at.events.push({ tab: id, screen: state });
      tab.last = state;
    }
  };
  let deferred = null;
  for (const [i, entry] of list.entries()) {
    if (isData(entry)) {
      const { id, data } = entry.event;
      if (!tabs.has(id)) tabs.set(id, new Tab(Terminal, 80, 24));
      const tab = tabs.get(id);
      await tab.write(data);
      here().bytes.set(id, (here().bytes.get(id) ?? '') + data);
      changed(id, tab);
      if (deferred) here().events.push(deferred);
      deferred = null;
      continue;
    }
    const k = entries.length;
    if (paired.has(k)) {
      const event = { tab: entry.event.id, activity: entry.event.state };
      const next = list[i + 1];
      if (next !== undefined && isData(next) && next.event.id === entry.event.id && next.event.data !== '') deferred = event;
      else here().events.push(event);
    } else {
      stretch = k;
    }
    // A new ensure of a tab whose shell exited starts a new PTY (and terminal).
    if (entry.call === 'termEnsure' && EXIT_ANYWHERE.test(tabs.get(entry.params[0])?.text ?? '')) {
      tabs.get(entry.params[0]).term.dispose();
      tabs.delete(entry.params[0]);
    }
    // A resize changes the tab's state in the stretch this entry opens, like output.
    if (entry.push === 'sizeOwner' && entry.event.cols > 0 && tabs.has(entry.event.id)) {
      tabs.get(entry.event.id).term.resize(entry.event.cols, entry.event.rows);
      changed(entry.event.id, tabs.get(entry.event.id));
    }
    if (typeof entry.value?.replay === 'string') {
      const shown = tabs.get(entry.value.id)?.term;
      const replay = new Tab(Terminal, shown?.cols ?? 80, shown?.rows ?? 24);
      await replay.write(entry.value.replay);
      const units = unitsOf({ ...entry, value: { ...entry.value, replay: null } });
      delete units['value.replay'];
      for (const [unit, value] of Object.entries(stateOf(replay))) units[`value.replay: ${unit}`] = value;
      replay.term.dispose();
      entries.push(units);
    } else {
      entries.push(unitsOf(entry));
    }
  }
  for (const tab of tabs.values()) tab.term.dispose();
  return { entries, stretches };
}

/** The id of the tab's state as it stood at the end of stretch `k` (from its last stretch with output up to there); null before its
 *  first output. */
function stateIdAt(analysis, k, tab) {
  let found = null;
  for (const [at, stretch] of analysis.stretches) {
    if (at > k) break;
    if (stretch.finals.has(tab)) found = stretch.finals.get(tab);
  }
  return found;
}

/** The tab's state as it stood at the end of stretch `k`; null before its first output. */
export function stateAt(analysis, k, tab) {
  const id = stateIdAt(analysis, k, tab);
  return id === null ? null : states[id];
}

const showUnit = (value) => (value === undefined ? '<absent>' : JSON.stringify(value).slice(0, 400));

/** The units in which `got` differs from `node` (either may be null: nothing drawn yet), as message lines. */
function unitDifferences(got, node) {
  if (got === null || node === null) return got === node ? [] : [`drawn: got ${got === null ? 'no output' : 'output'}, Node ${node === null ? 'no output' : 'output'}`];
  const keys = [...new Set([...Object.keys(got), ...Object.keys(node)])];
  return keys.filter((key) => !isDeepStrictEqual(got[key], node[key])).map((key) => `${key}: got ${showUnit(got[key])}, Node ${showUnit(node[key])}`);
}

/** Compares a whole state or entry (its units, or null) at one place. Where Node's runs agree on all of it, it must be theirs, and every
 *  unit that differs is named. Where they differ, the units they differ on are named in `exemptions` with the runs that differ from run
 *  0, and `got` must be the whole of one run's: the runs do not show their differing units varying apart, so a mix of two runs' units
 *  is not one Node showed. Throws naming the units that fail (against the closest run). */
function compareUnits(got, recorded, what, exemptions) {
  const differing = recorded.flatMap((units, run) => (isDeepStrictEqual(units, recorded[0]) ? [] : [run]));
  if (differing.length === 0) {
    const failures = unitDifferences(got, recorded[0]);
    if (failures.length > 0) assert.fail(`${what}\n  ${failures.slice(0, 16).join('\n  ')}`);
    return;
  }
  const units = [...new Set(differing.flatMap((run) => unitDifferences(recorded[run], recorded[0]).map((line) => line.split(': got ')[0])))];
  const matched = recorded.flatMap((units, run) => (isDeepStrictEqual(units, got) ? [run] : []));
  if (matched.length === 0) {
    const [closest] = recorded.map((units, run) => [run, unitDifferences(got, units)]).sort((a, b) => a[1].length - b[1].length);
    assert.fail(`${what}: no Node run has this whole (they differ on ${units.join(', ')}); against run ${closest[0]}, the closest:\n  ${closest[1].slice(0, 16).join('\n  ')}`);
  }
  exemptions.push(`${what}: ${units.join(', ')} (Node's runs ${differing.join(', ')} differ from run 0; here the whole of run ${matched.join('/')})`);
}

/** Where a stretch's events of one tab differ, for a message: the first state that differs, shown by the units in which it differs from
 *  Node's (a side that has no such state shows its last one); or, with the same states, where the activity changes fall among them. */
function eventsDifference(got, node, gotBefore, nodeBefore) {
  const screensOf = (events) => events.filter((event) => 'screen' in event).map((event) => event.screen);
  const [mine, theirs] = [screensOf(got), screensOf(node)];
  const last = (screens, before) => screens.at(-1) ?? before ?? undefined;
  const at = Array.from({ length: Math.max(mine.length, theirs.length) }, (_, i) => i).find((i) => mine[i] !== theirs[i]);
  const describe = (events) => events.map((event) => ('activity' in event ? `activity ${JSON.stringify(event.activity)}` : `state ${screensOf(events).indexOf(event.screen) + 1}`)).join(', ');
  if (at === undefined) return `the same ${theirs.length} states; the activity changes among them: got ${describe(got)}; Node ${describe(node)}`;
  const lines = [`state ${at + 1}: got ${mine.length} states, Node ${theirs.length}${mine[at] === undefined ? ' (got: its last)' : ''}${theirs[at] === undefined ? ' (Node: its last)' : ''}`];
  const [left, right] = [mine[at] ?? last(mine, gotBefore), theirs[at] ?? last(theirs, nodeBefore)];
  if (left === undefined || right === undefined) return `${lines[0]}: ${left === undefined ? 'got none' : 'Node none'}`;
  for (const key of new Set([...Object.keys(states[left]), ...Object.keys(states[right])])) {
    if (!isDeepStrictEqual(states[left][key], states[right][key])) lines.push(`${key}: got ${showUnit(states[left][key])}, Node ${showUnit(states[right][key])}`);
  }
  return lines.slice(0, 16).join('\n  ');
}

const nodeViews = new Map();
/** Node's runs of one part as the comparison reads them: the lists without the disposal pairs, the activity changes every run sends with
 *  its own output on one side (`paired`), and each run's analysis (computed once per recording). */
export async function nodeView(runs, part) {
  if (!nodeViews.has(runs)) nodeViews.set(runs, new Map());
  const views = nodeViews.get(runs);
  const key = part;
  if (!views.has(key)) {
    const read = runs.map((run) => withoutDisposalPairs(pick(run, part) ?? [], `Node's ${part}`));
    const lists = read.map(({ kept }) => kept);
    const pairs = read.map((run) => new Set(run.pairs));
    const entries = (list) => list.filter((entry) => !isData(entry)).length;
    const lengths = lists.map(entries);
    assert.equal(new Set(lengths).size, 1, `Node's runs differ in ${part} beyond the recorded variation (${lengths.join(', ')} entries besides output)`);
    const sides = lists.map(ownSides);
    const single = (side) => side === 'before' || side === 'after';
    const paired = new Set([...sides[0].keys()].filter((k) => sides.every((run) => single(run.get(k)))));
    views.set(key, { lists, pairs, paired, sides, analyses: await Promise.all(lists.map((list) => analyse(list, paired))) });
  }
  return views.get(key);
}

/** The list as the comparison reads it: without the PowerShell disposal pairs (the entries kept are the list's own objects). */
export const comparedList = (list, part) => withoutDisposalPairs(list, part).kept;

/** What the framing recording (apps/mobile/fixtures/relay-framing/golden.json, Node's relay lane on a virtual clock) shows of a tab's
 *  output against its own activity change, and so the one pair whose order a replay may flip:
 *    - output, then a change, inside a window the lane opened (tab E: frame at 300 ms, `e1` and `running` at 305): the change goes at once
 *      (305), the frame when the window ends (316);
 *    - output and its change with no window open (tab F, 300 ms): the frame goes at once, the change right after it;
 *    - a write with its change after a re-render frame sent at 400 ms (tabs G15, G16, G17): at 415 ms (inside the window) the change
 *      goes first and the frame at 416; at 416 and 417 ms (the window over) the frame goes first.
 *  So a chunk's frame and its own change flip with when the write lands against the lane's 16 ms window, and nothing else does: a later
 *  change (E's `finished` at 310) keeps its place against everything the replay compares. */
export const RELAY_FRAMING_PROOF =
  'apps/mobile/fixtures/relay-framing (G15 against G16/G17: a write and its change 15 ms after a frame go change first, 16 or 17 ms after it frame first)';

const streamOf = (list, tab) => list.filter((entry) => isData(entry) && entry.event.id === tab).map((entry) => entry.event.data).join('');
const eventKey = (event) => ('activity' in event ? `a${event.tab}:${event.activity}` : `s${event.tab}:${event.screen}`);
/** The order in which a stretch's tabs change (one tab's consecutive changes as one). */
const tabOrder = (events) => events.map((event) => event.tab).filter((tab, i, all) => tab !== all[i - 1]);

/** Compares a replayed trace with Node's runs; throws on the first part that differs. Returns:
 *  `exemptions`, each unit left to one of Node's values because Node's runs differ on it (named with the runs) and each disposal pair
 *  taken out; `sets`, each activity change compared with its own output as one place; `bytes`, per tab and stretch whether the trace's
 *  output bytes equal one Node run's exactly or the stretch passed on its states only. */
export async function compareTraces(got, runs) {
  const exemptions = [];
  const sets = [];
  const bytes = [];
  const extra = Object.keys(got).filter((key) => !['order', 'claims', 'immediate', 'replayWindow'].includes(key));
  assert.deepEqual(extra, [], 'the trace has fields the comparison does not know');
  for (const part of PARTS) {
    const node = await nodeView(runs, part);
    const { kept: mine, pairs: minePairs } = withoutDisposalPairs(pick(got, part) ?? [], part);
    // A disposal pair is taken out only where Node's runs vary on it: some run has it at that disposal and some does not; where every
    // run has it, the trace must too, and where none has it, the trace may not.
    const disposals = [...new Set([...minePairs, ...node.pairs.flatMap((pairs) => [...pairs])])];
    for (const disposal of disposals) {
      const having = node.pairs.flatMap((pairs, run) => (pairs.has(disposal) ? [run] : []));
      const here = minePairs.includes(disposal);
      assert.ok(having.length > 0 || !here, `${part}: a running/null pair after ${disposal}'s answer, which no Node run has`);
      assert.ok(having.length < runs.length || here, `${part}: no running/null pair after ${disposal}'s answer, which every Node run has`);
      exemptions.push(`${part}: the running/null pair after ${disposal}'s answer (Node's runs ${having.join(', ')} have it; here ${here ? 'present' : 'absent'})`);
    }
    // An output entry is compared by its data alone, so it may carry nothing else.
    for (const entry of mine.filter(isData)) {
      assert.ok(isDeepStrictEqual(Object.keys(entry), ['push', 'event']) && isDeepStrictEqual(Object.keys(entry.event), ['id', 'data']), `${part}: an output entry with other fields: ${show(entry)}`);
    }
    const entries = mine.filter((entry) => !isData(entry));
    const count = node.analyses[0].entries.length;
    assert.equal(entries.length, count, `${part}: ${entries.length} entries besides output; Node: ${count}`);
    const mineSides = ownSides(mine);
    for (const k of node.paired) {
      const { id } = entries[k].event ?? {};
      const side = mineSides.get(k);
      assert.ok(side === 'before' || side === 'after', `${part} entry ${k}: ${id}'s activity change is not next to its own output on one side, as in every Node run (here: ${side ?? 'neither'}; ${show(entries[k])})`);
      const recorded = [...new Set(node.sides.map((sides) => sides.get(k)))].join('/');
      sets.push(`${part} entry ${k}: ${id}'s activity change with its own frame (Node: frame ${recorded} it; here: ${mineSides.get(k)}), proved by ${RELAY_FRAMING_PROOF}`);
    }
    const analysis = await analyse(mine, node.paired);
    analysis.entries.forEach((units, i) => compareUnits(units, node.analyses.map((run) => run.entries[i]), `${part} entry ${i}`, exemptions));
    const both = [analysis, ...node.analyses];
    const points = [...new Set(both.flatMap((run) => [...run.stretches.keys()]))].sort((a, b) => a - b);
    for (const k of points) {
      const where = k < 0 ? 'before the first entry' : `after entry ${k}`;
      const stretch = (run) => run.stretches.get(k) ?? { events: [], finals: new Map(), bytes: new Map() };
      const tabs = [...new Set(both.flatMap((run) => [...stretch(run).finals.keys(), ...stretch(run).events.map((event) => event.tab)]))].sort();
      for (const tab of tabs) {
        // Every state the tab went through in the stretch, in order, with its paired activity changes among them.
        const sequences = node.analyses.map((run) => stretch(run).events.filter((event) => event.tab === tab));
        const mineSequence = stretch(analysis).events.filter((event) => event.tab === tab);
        const differing = sequences.flatMap((sequence, run) => (isDeepStrictEqual(sequence.map(eventKey), sequences[0].map(eventKey)) ? [] : [run]));
        if (differing.length === 0) {
          if (!isDeepStrictEqual(mineSequence.map(eventKey), sequences[0].map(eventKey))) {
            const before = (run) => stateIdAt(run, k - 1, tab) ?? undefined;
            assert.fail(`${part}: ${tab}'s states within the stretch ${where}\n  ${eventsDifference(mineSequence, sequences[0], before(analysis), before(node.analyses[0]))}`);
          }
        } else {
          const matched = sequences.flatMap((sequence, run) => (isDeepStrictEqual(mineSequence.map(eventKey), sequence.map(eventKey)) ? [run] : []));
          if (matched.length === 0) {
            const before = (run) => stateIdAt(run, k - 1, tab) ?? undefined;
            assert.fail(`${part}: ${tab}'s states within the stretch ${where} are no Node run's (the runs differ there: ${differing.join(', ')} from run 0); against run 0:\n  ${eventsDifference(mineSequence, sequences[0], before(analysis), before(node.analyses[0]))}`);
          }
          exemptions.push(`${part}: ${tab}'s states within the stretch ${where} (Node's runs ${differing.join(', ')} differ from run 0; here run ${matched.join('/')}'s)`);
        }
        // Its state at the end of the stretch.
        compareUnits(stateAt(analysis, k, tab), node.analyses.map((run) => stateAt(run, k, tab)), `${part}: ${tab}'s screen ${where}`, exemptions);
        const mineBytes = stretch(analysis).bytes.get(tab) ?? '';
        const exact = node.analyses.some((run) => (stretch(run).bytes.get(tab) ?? '') === mineBytes);
        bytes.push({ part, where, tab, exact });
      }
      // The order in which the tabs changed.
      const orders = node.analyses.map((run) => tabOrder(stretch(run).events));
      const differing = orders.flatMap((order, run) => (isDeepStrictEqual(order, orders[0]) ? [] : [run]));
      if (differing.length === 0) {
        const mineOrder = tabOrder(stretch(analysis).events);
        assert.ok(isDeepStrictEqual(mineOrder, orders[0]), `${part}: the order of the tabs' output in the stretch ${where}: got ${mineOrder.join(', ')}, Node ${orders[0].join(', ')}`);
      } else {
        const mineOrder = tabOrder(stretch(analysis).events);
        const matched = orders.flatMap((order, run) => (isDeepStrictEqual(order, mineOrder) ? [run] : []));
        assert.ok(matched.length > 0, `${part}: the order of the tabs' output in the stretch ${where}: got ${mineOrder.join(', ')}, which no Node run has: ${orders.map((order) => order.join(', ')).join(' | ')}`);
        exemptions.push(`${part}: the order of the tabs' output in the stretch ${where} (Node's runs ${differing.join(', ')} differ from run 0; here run ${matched.join('/')}'s)`);
      }
    }
    const tabs = [...new Set([mine, ...node.lists].flatMap((list) => list.filter(isData).map((entry) => entry.event.id)))].sort();
    for (const tab of tabs) {
      const codes = node.lists.map((list) => EXIT_AT_END.exec(streamOf(list, tab))?.[1]);
      if (codes.every((code) => code !== undefined)) {
        const code = EXIT_AT_END.exec(streamOf(mine, tab))?.[1];
        assert.notEqual(code, undefined, `${part}: ${tab}'s output does not end with its exit line: ${show(streamOf(mine, tab).slice(-200))}`);
        compareUnits({ code }, codes.map((recorded) => ({ code: recorded })), `${part}: ${tab}'s exit`, exemptions);
      }
    }
  }
  return { exemptions, sets, bytes };
}
