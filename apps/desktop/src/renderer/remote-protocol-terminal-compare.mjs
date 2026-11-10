// How a replayed phone-terminal trace is compared with Node's recordings (apps/mobile/fixtures/phone-terminal/runs.json: every run the
// recorder made, none dropped). Every field of a run is compared: its three ordered lists `order`, `claims.order` and `immediate.order`.
// (golden.json's `replayWindow` is compared by mixdog-spawn tests/terminal.rs `the_replay_window_is_nodes_at_its_boundary` and
// remote-protocol-terminal-replay.test.mjs.) Values are compared by strict deep equality (null is not undefined, no field is ignored).
//
// What the script settles, and why (lib/phone-terminal-script.mjs): output that no answered call causes (a claim's resize re-render, a
// tab's prompt after its idle, a disposed tab's closing output against the next tab's dispose) is waited for before the next call. Its place
// among later calls is set by the calls' latency: Node's recorder calls in-process (0 ms), a real phone and this replay cross a socket,
// so the agreement of Node's runs there is the recorder's, not Node's. Settling is not a hidden difference: the output itself (the screen
// it ends in) and its place against the entries that cause or order it stay compared. Unsettled (`immediate`) are the sequences an answer orders:
// an ensure's answer before the new shell's first output, a dispose's answer before the killed shell's last output and exit line.
//
// The rule (decided 2026-11-11; MANIFEST.json `comparisonRule`). What Node guarantees is what the terminal shows, not its bytes or where
// its frames are cut: Node's own runs differ from each other there (each of the 50 compared with the other 49 under a rule that compared
// the screen states within each stretch between messages, at each stretch's end, or through each command failed in 49, 42 and 26 of
// them; under this rule none fails: MANIFEST.json `leaveOneOut`).
// Where Node's runs differ at a place, the units they differ on are named in `exemptions` with the runs that differ, and the trace must
// have there the whole of one run's state, entry or alternative (the runs do not show those units varying apart from each other, so a mix
// of two runs is not something Node showed).
//   - Every entry but output (answers, errors, activity changes, exits, tab list changes, pushes of every tab, fires, lane switches, clock
//     steps, checkpoints) is compared at its position among the others, field by field (every leaf of its value, and the shape of every
//     object and array): the non-output messages are compared in set, count and order among themselves.
//   - Output is compared by the state it puts the terminal the app renders with in (@xterm/xterm, TerminalPane.tsx, with the pane's cursor
//     options), parsing each tab's output and resized where the trace announces the tab's new size (a `sizeOwner` push with a size: Node
//     resizes the PTY before it announces, terminal-manager.ts:485-487; a new PTY starts at 80x24, :322-325). The state is everything the
//     terminal shows and holds (`stateOf`: both buffers cell by cell with every attribute, wrapped lines, cursors, viewport, scroll
//     regions, tab stops, saved cursors, modes, cursor visibility and style, current attributes and character sets, title and icon name,
//     bells, colour changes, every byte the terminal answered, and input the parser holds unfinished). Each tab's state is compared, whole,
//     before every entry that is not that tab's own activity change, and at the list's end: the output of a command (after its input,
//     around its own `running` and `finished`) is compared by the screen it ends in, not by the states on the way or the bytes.
//     An answer's `replay` is compared as the state it produces at the tab's size.
//   - Where a command's output stands against its own activity changes: for each such change, whether the tab's screen when it is sent
//     already differs from the one the command started from (some output before it) and still differs from the one it ends in (some
//     output after it). Where every Node run has one order, the trace must have it; where the runs show both, either passes.
//   - At every place where Node's runs differ (a screen, an entry, an exit code, a disposal pair's presence and place) the trace's
//     alternative is one some Node run shows, whole; each place is held on its own. Holding every two places to a run that shows both
//     (pairwise co-occurrence, the earlier rule) is not Node's contract either: with it, Node's own runs fail against the other 49 in 7
//     of 50, and in 1 of 50 with only the screens held pairwise (MANIFEST.json `leaveOneOut`).
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
// and each is named in `exemptions` with the runs that have it. Its place is compared too, among all entries, output included: the
// entries besides output before each of its changes and the state its tab's output had put the terminal in by then (`placedPairs`).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const FIXTURE = new URL('../../../mobile/fixtures/phone-terminal/', import.meta.url);

/** Node's runs as the fixture holds them (runs.json), refused unless they are exactly the runs MANIFEST.json's `runList` lists: the same
 *  number, in the same order, each with the content hash listed for it (sha256 of the run's JSON, as the recorder computes it). */
export function loadRuns() {
  const runs = JSON.parse(readFileSync(new URL('runs.json', FIXTURE), 'utf8'));
  const { runList } = JSON.parse(readFileSync(new URL('MANIFEST.json', FIXTURE), 'utf8'));
  return checkedRuns(runs, runList);
}

/** `runs` when they are exactly the runs `runList` lists; throws naming the first that is not. */
export function checkedRuns(runs, runList) {
  assert.ok(Array.isArray(runList), "MANIFEST.json lists no runs (runList)");
  assert.ok(Array.isArray(runs), 'runs.json is not a list of runs');
  assert.equal(runs.length, runList.length, `runs.json has ${runs.length} runs; MANIFEST.json's runList lists ${runList.length}`);
  runs.forEach((run, index) => {
    const sha256 = createHash('sha256').update(JSON.stringify(run)).digest('hex');
    assert.equal(runList[index].run, index, `MANIFEST.json's runList entry ${index} names run ${runList[index].run}`);
    assert.equal(sha256, runList[index].sha256, `runs.json run ${index} is not the run MANIFEST.json's runList lists (sha256 ${sha256})`);
  });
  return runs;
}

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
  // Each pair's place among all entries, output included: how many entries besides output were kept before its `running` and before
  // its `null`, and the output its tab had sent by then (made a screen state by `placedPairs`).
  const pairs = new Map();
  let entries = 0;
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
        pairs.set(`${id} dispose ${disposals.get(id)}`, { tab: id, at: [[entries, text.get(id) ?? '']] });
        continue;
      }
      if (activity === null && state.get(id) === 'running') {
        state.set(id, 'done');
        pairs.get(`${id} dispose ${disposals.get(id)}`).at.push([entries, text.get(id) ?? '']);
        continue;
      }
    }
    if (!isData(entry)) entries += 1;
    kept.push(entry);
  }
  for (const [id, at] of state) assert.notEqual(at, 'running', `${part}: ${id}'s running after its dispose answer never ended`);
  return { kept, pairs };
}

/** Each disposal pair's place as one comparable value: per change, the entries besides output before it and the state its tab's output
 *  so far puts an 80x24 terminal in (the same function of the output on both sides, so a pair before or after a frame that changes
 *  the tab's state is a different place; a frame that changes nothing is no boundary). */
async function placedPairs(pairs) {
  const Terminal = await emulator();
  const placed = new Map();
  for (const [key, { at }] of pairs) {
    const steps = [];
    for (const [entries, text] of at) {
      const tab = new Tab(Terminal, 80, 24);
      await tab.write(text);
      steps.push(`entry ${entries}, its tab's state ${intern(stateOf(tab))}`);
      tab.term.dispose();
    }
    placed.set(key, steps.join(' and '));
  }
  return placed;
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

/** The kind of a non-output entry as the output rule reads it: `activity <tab>` for a tab's activity change, `other` for the rest. */
const kindOf = (entry) => (entry.push === 'activity' ? `activity ${entry.event.id}` : 'other');

/** A list as the comparison reads it: its entries besides output (as units; an answer's replay as the state it produces) and their kinds,
 *  and per position k from 0 to the number of those entries (the last: the list's end): each tab's state after all output before entry k
 *  (`before`, by id; a tab without output yet is absent) and each tab's output between entry k-1 and entry k (`output`). */
async function analyse(list) {
  const Terminal = await emulator();
  const tabs = new Map();
  const current = new Map();
  const entries = [];
  const kinds = [];
  const before = [];
  const output = [];
  let since = new Map();
  const boundary = () => {
    const at = new Map();
    for (const [id, tab] of tabs) {
      if (!current.has(id)) current.set(id, intern(stateOf(tab)));
      at.set(id, current.get(id));
    }
    before.push(at);
    output.push(since);
    since = new Map();
  };
  for (const entry of list) {
    if (isData(entry)) {
      const { id, data } = entry.event;
      if (!tabs.has(id)) tabs.set(id, new Tab(Terminal, 80, 24));
      await tabs.get(id).write(data);
      current.delete(id);
      since.set(id, (since.get(id) ?? '') + data);
      continue;
    }
    boundary();
    kinds.push(kindOf(entry));
    // A new ensure of a tab whose shell exited starts a new PTY (and terminal).
    if (entry.call === 'termEnsure' && EXIT_ANYWHERE.test(tabs.get(entry.params[0])?.text ?? '')) {
      tabs.get(entry.params[0]).term.dispose();
      tabs.delete(entry.params[0]);
      current.delete(entry.params[0]);
    }
    // A resize changes the tab's state from this entry on, as output after it would.
    if (entry.push === 'sizeOwner' && entry.event.cols > 0 && tabs.has(entry.event.id)) {
      tabs.get(entry.event.id).term.resize(entry.event.cols, entry.event.rows);
      current.delete(entry.event.id);
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
  boundary();
  for (const tab of tabs.values()) tab.term.dispose();
  return { entries, kinds, before, output };
}

/** The id of the tab's state before entry `k` (k = the number of entries: at the list's end); null before its first output. */
const stateIdAt = (analysis, k, tab) => analysis.before[k].get(tab) ?? null;

/** The tab's state before entry `k`; null before its first output. */
export function stateAt(analysis, k, tab) {
  const id = stateIdAt(analysis, k, tab);
  return id === null ? null : states[id];
}

/** A tab's commands in a list of entry kinds: each position where its state is compared (`end`: before an entry that is not the tab's own
 *  activity change, or the list's end), the one before it (`from`, -1 at the start) and the tab's own activity changes between them. */
export function windowsOf(kinds, tab) {
  const windows = [];
  let changes = [];
  let from = -1;
  for (let k = 0; k <= kinds.length; k += 1) {
    if (k < kinds.length && kinds[k] === `activity ${tab}`) {
      changes.push(k);
      continue;
    }
    windows.push({ from, end: k, changes });
    changes = [];
    from = k;
  }
  return windows;
}

/** Where a tab's output between positions `from` and `end` stands against its activity change at `change`: whether the tab's state when
 *  the change is sent differs from its state at `from` (output before it) and from its state at `end` (output after it). */
function sidesOf(analysis, tab, from, change, end) {
  const at = stateIdAt(analysis, change, tab);
  const start = from < 0 ? null : stateIdAt(analysis, from, tab);
  return `${at === start ? 'no' : 'some'} output before, ${at === stateIdAt(analysis, end, tab) ? 'none' : 'some'} after`;
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

const nodeViews = new Map();
/** Node's runs of one part as the comparison reads them: the lists without the disposal pairs, each pair's place, and each run's
 *  analysis (computed once per recording). The runs have one sequence of entry kinds (which entry is which tab's activity change). */
export async function nodeView(runs, part) {
  if (!nodeViews.has(runs)) nodeViews.set(runs, new Map());
  const views = nodeViews.get(runs);
  const key = part;
  if (!views.has(key)) {
    const read = runs.map((run) => withoutDisposalPairs(pick(run, part) ?? [], `Node's ${part}`));
    const lists = read.map(({ kept }) => kept);
    const pairs = await Promise.all(read.map((run) => placedPairs(run.pairs)));
    const analyses = await Promise.all(lists.map(analyse));
    const lengths = analyses.map((run) => run.entries.length);
    assert.equal(new Set(lengths).size, 1, `Node's runs differ in ${part} beyond the recorded variation (${lengths.join(', ')} entries besides output)`);
    const kinds = analyses.map((run) => run.kinds.join(','));
    assert.equal(new Set(kinds).size, 1, `Node's runs differ in ${part} in which entry is which tab's activity change`);
    views.set(key, { lists, pairs, analyses });
  }
  return views.get(key);
}

/** The list as the comparison reads it: without the PowerShell disposal pairs (the entries kept are the list's own objects). */
export const comparedList = (list, part) => withoutDisposalPairs(list, part).kept;

const streamOf = (list, tab) => list.filter((entry) => isData(entry) && entry.event.id === tab).map((entry) => entry.event.data).join('');
const stateOrNull = (id) => (id === null ? null : states[id]);

/** Compares a replayed trace with Node's runs; throws on the first part that differs. Returns: `exemptions`, each unit or line order left
 *  to one of Node's values because Node's runs differ on it (named with the runs) and each disposal pair taken out; `bytes`, per tab and
 *  command (the output between two compared positions) whether the trace's output bytes equal one Node run's exactly or it passed on its
 *  screen only. */
export async function compareTraces(got, runs) {
  const exemptions = [];
  const bytes = [];
  const extra = Object.keys(got).filter((key) => !['order', 'claims', 'immediate', 'replayWindow'].includes(key));
  assert.deepEqual(extra, [], 'the trace has fields the comparison does not know');
  for (const part of PARTS) {
    const node = await nodeView(runs, part);
    const { kept: mine, pairs: rawPairs } = withoutDisposalPairs(pick(got, part) ?? [], part);
    const minePairs = await placedPairs(rawPairs);
    // A disposal pair is taken out only where Node's runs vary on it: some run has it at that disposal and some does not; where every
    // run has it, the trace must too, and where none has it, the trace may not.
    // Its place too: where every run that has it puts it the same way (and every run has it or none does), the trace must match.
    const disposals = [...new Set([...minePairs.keys(), ...node.pairs.flatMap((pairs) => [...pairs.keys()])])];
    for (const disposal of disposals) {
      const values = node.pairs.map((pairs) => pairs.get(disposal) ?? 'absent');
      const here = minePairs.get(disposal) ?? 'absent';
      const what = `${part}: the running/null pair after ${disposal}'s answer`;
      if (values.every((value) => value === values[0])) {
        assert.equal(here, values[0], `${what}: got ${here}, every Node run ${values[0]}`);
        continue;
      }
      assert.ok(values.includes(here), `${what}: got ${here}, which no Node run has (${[...new Set(values)].join(' | ')})`);
      const having = values.flatMap((value, run) => (value === 'absent' ? [] : [run]));
      exemptions.push(`${what} (Node's runs ${having.join(', ')} have it; here ${here})`);
    }
    // An output entry is compared by its data alone, so it may carry nothing else.
    for (const entry of mine.filter(isData)) {
      assert.ok(isDeepStrictEqual(Object.keys(entry), ['push', 'event']) && isDeepStrictEqual(Object.keys(entry.event), ['id', 'data']), `${part}: an output entry with other fields: ${show(entry)}`);
    }
    const analysis = await analyse(mine);
    const count = node.analyses[0].entries.length;
    assert.equal(analysis.entries.length, count, `${part}: ${analysis.entries.length} entries besides output; Node: ${count}`);
    analysis.entries.forEach((units, i) => compareUnits(units, node.analyses.map((run) => run.entries[i]), `${part} entry ${i}`, exemptions));
    // With every entry one of Node's, the trace has Node's kinds of entries, so its commands are where Node's are.
    const { kinds } = node.analyses[0];
    const both = [analysis, ...node.analyses];
    const tabs = [...new Set(both.flatMap((run) => run.before.flatMap((at) => [...at.keys()])))].sort();
    for (const tab of tabs) {
      for (const { from, end, changes } of windowsOf(kinds, tab)) {
        const where = end === kinds.length ? 'at the end' : `before entry ${end}`;
        // The screen the command ends in, whole.
        const recorded = node.analyses.map((run) => stateIdAt(run, end, tab));
        const here = stateIdAt(analysis, end, tab);
        if (!recorded.every((id) => id === here)) compareUnits(stateOrNull(here), recorded.map(stateOrNull), `${part}: ${tab}'s screen ${where}`, exemptions);
        // Its output against each of the tab's own activity changes it sent: an order every Node run has is required; where the runs show
        // both, either passes (not held to the other places: the order is the console's timing, decided 2026-11-11).
        for (const change of changes) {
          const values = node.analyses.map((run) => sidesOf(run, tab, from, change, end));
          const value = sidesOf(analysis, tab, from, change, end);
          const what = `${part}: ${tab}'s output ${where} against its ${show(analysis.entries[change]['event.state'])} change (entry ${change})`;
          if (values.every((other) => other === values[0])) {
            assert.equal(value, values[0], `${what}: ${value}, every Node run: ${values[0]}`);
            continue;
          }
          const runsOf = (order) => values.flatMap((other, run) => (other === order ? [run] : []));
          assert.ok(values.includes(value), `${what}: ${value}, which no Node run has (${[...new Set(values)].map((order) => `${order}: ${runsOf(order).length} runs`).join(' | ')})`);
          exemptions.push(`${what}: here ${value} (Node: ${[...new Set(values)].map((order) => `${order} in ${runsOf(order).length} runs`).join(', ')})`);
        }
        const output = (run) => run.output.slice(from + 1, end + 1).map((at) => at.get(tab) ?? '').join('');
        if (both.some((run) => output(run) !== '')) bytes.push({ part, where, tab, exact: node.analyses.some((run) => output(run) === output(analysis)) });
      }
    }
    for (const tab of tabs) {
      const codes = node.lists.map((list) => EXIT_AT_END.exec(streamOf(list, tab))?.[1]);
      if (codes.every((code) => code !== undefined)) {
        const code = EXIT_AT_END.exec(streamOf(mine, tab))?.[1];
        assert.notEqual(code, undefined, `${part}: ${tab}'s output does not end with its exit line: ${show(streamOf(mine, tab).slice(-200))}`);
        compareUnits({ code }, codes.map((recorded) => ({ code: recorded })), `${part}: ${tab}'s exit`, exemptions);
      }
    }
  }
  return { exemptions, bytes };
}
